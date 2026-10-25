import { randomBytes, randomUUID } from "node:crypto";
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Post, Put, Query } from "@nestjs/common";
import { credentialKeyHint, type Consumer, type KeyAuthCredential } from "@gromesh/compiler";
import { and, asc, eq, gt, ilike, or, sql, type SQL } from "drizzle-orm";
import type { ConsumerWrite, KeyAuthCredentialWrite } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredRole, type RequestContext } from "../auth/auth.js";
import { contractBody, inlineBody } from "../common/contract.js";
import { decodeCursor, parseLimit, toPage } from "../common/pagination.js";
import { conflict, notFound, unprocessable } from "../common/problem.js";
import { credentialContext, ENCRYPTOR, Encryptor } from "../crypto/crypto.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { consumers, keyAuthCredentials, type ConsumerRow, type KeyAuthCredentialRow } from "../db/schema.js";
import { markDraftChanged, requireEnvironment, uuidParam } from "../environments/environments.js";
import { CredentialsController, CredentialsService } from "./credentials.js";
import { usedAsAnonymous } from "../workspaces/anonymous.js";
import { admit, type ConflictLimit, conflictLimit, guardedUniqueWrite, lockTablesForWrite, lockUnique, refuse, takenElsewhere } from "../workspaces/instance-uniqueness.js";
import { APP_CONFIG, type AppConfig } from "../config.js";

/* ---------------- mapping ---------------- */

export function toConsumer(r: ConsumerRow) {
  return {
    id: r.id,
    username: r.username,
    customId: r.customId,
    tags: r.tags,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The only shape a credential leaves the service in, except the creation response. */
/** `plainKey` is the opened key: the row holds the sealed one. */
export function toKeyAuthCredential(r: KeyAuthCredentialRow, plainKey: string) {
  return { id: r.id, consumerId: r.consumerId, keyHint: credentialKeyHint(plainKey), tags: r.tags, createdAt: r.createdAt.toISOString() };
}

export function consumerValues(body: ConsumerWrite | Consumer) {
  return { username: body.username ?? null, customId: body.customId ?? null, tags: body.tags ?? [] };
}

/** Column values for a credential whose `key` is in clear: sealed, plus its fingerprint for uniqueness. */
export function keyAuthValues(c: KeyAuthCredential, enc: Encryptor) {
  return { id: c.id, consumerId: c.consumerId, key: enc.seal(c.key, credentialContext(c.id)), keyHash: enc.fingerprint(c.key), tags: c.tags ?? [] };
}

/** Sort and search key: username, or customId for consumers without one. */
const consumerName = sql<string>`coalesce(${consumers.username}, ${consumers.customId})`;

/* ---------------- service ---------------- */

@Injectable()
export class ConsumersService {
  private readonly conflicts: ConflictLimit;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENCRYPTOR) private readonly enc: Encryptor,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.conflicts = conflictLimit(config);
  }

  async list(envId: string, query: Record<string, unknown>) {
    await requireEnvironment(this.db, envId);
    const limit = parseLimit(query.limit);
    const parts: (SQL | undefined)[] = [eq(consumers.environmentId, envId)];
    if (typeof query.q === "string" && query.q.trim()) {
      const like = `%${query.q.trim().replace(/[%_\\]/g, "\\$&")}%`;
      parts.push(or(ilike(consumers.username, like), ilike(consumers.customId, like)));
    }
    const c = decodeCursor(query.cursor);
    if (c) parts.push(or(gt(consumerName, c.k), and(eq(consumerName, c.k), gt(consumers.id, c.id))));
    const rows = await this.db
      .select()
      .from(consumers)
      .where(and(...parts))
      .orderBy(asc(consumerName), asc(consumers.id))
      .limit(limit + 1);
    return toPage(rows, limit, (r) => r.username ?? r.customId ?? "", toConsumer);
  }

  async get(envId: string, consumerId: string) {
    return toConsumer(await requireConsumer(this.db, envId, consumerId));
  }

  async create(ctx: RequestContext, envId: string, body: ConsumerWrite) {
    checkConsumer(body);
    return this.db.transaction(async (tx) => {
      await requireEnvironment(tx, envId);
      const [row] = await tx.insert(consumers).values({ environmentId: envId, ...consumerValues(body) }).returning();
      const after = toConsumer(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "consumer.create", entityType: "consumer", entityId: after.id, environmentId: envId, after });
      return after;
    });
  }

  async replace(ctx: RequestContext, envId: string, consumerId: string, body: ConsumerWrite) {
    checkConsumer(body);
    return this.db.transaction(async (tx) => {
      const before = toConsumer(await requireConsumer(tx, envId, consumerId));
      const values = consumerValues(body);
      // A plugin naming this consumer as anonymous by its username would lose it.
      if (before.username != null && values.username !== before.username && (await usedAsAnonymous(tx, envId, { username: before.username }))) {
        throw conflict("The consumer is used as anonymous by a plugin");
      }
      const [row] = await tx
        .update(consumers)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(consumers.id, consumerId))
        .returning();
      const after = toConsumer(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "consumer.update", entityType: "consumer", entityId: consumerId, environmentId: envId, before, after });
      return after;
    });
  }

  /** Credentials (key-auth, JWT, basic-auth) and consumer-scoped plugins go with it (FK cascade). */
  async remove(ctx: RequestContext, envId: string, consumerId: string) {
    await this.db.transaction(async (tx) => {
      const before = toConsumer(await requireConsumer(tx, envId, consumerId));
      if (await usedAsAnonymous(tx, envId, { id: consumerId, username: before.username })) throw conflict("The consumer is used as anonymous by a plugin");
      await tx.delete(consumers).where(eq(consumers.id, consumerId));
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "consumer.delete", entityType: "consumer", entityId: consumerId, environmentId: envId, before });
    });
  }

  /* key-auth */

  async listKeyAuth(envId: string, consumerId: string) {
    await requireConsumer(this.db, envId, consumerId);
    const rows = await this.db
      .select()
      .from(keyAuthCredentials)
      .where(eq(keyAuthCredentials.consumerId, consumerId))
      .orderBy(asc(keyAuthCredentials.createdAt), asc(keyAuthCredentials.id));
    return { items: rows.map((r) => toKeyAuthCredential(r, this.enc.open(r.key, credentialContext(r.id)))) };
  }

  async createKeyAuth(ctx: RequestContext, envId: string, consumerId: string, body: KeyAuthCredentialWrite) {
    return guardedUniqueWrite(this.db, ctx, "key-auth-key", this.conflicts, () => this.db.transaction(async (tx) => {
      await lockTablesForWrite(tx, ["key-auth-key"]);
      await requireConsumer(tx, envId, consumerId);
      const key = body.key ?? randomBytes(32).toString("base64url");
      // Kong looks a key up across the whole node: unique in the instance (decision H-5). The environment's row
      // first, then the lock: the order of every writer of these values (rollback, import, certificates).
      await requireEnvironment(tx, envId, true);
      await lockUnique(tx, ["key-auth-key"]);
      await admit(tx, ctx);
      if ((await takenElsewhere(tx, "key-auth-key", envId, [this.enc.fingerprint(key)])).size > 0) return refuse(tx, ctx, "key-auth-key", this.conflicts);
      const [row] = await tx
        .insert(keyAuthCredentials)
        .values({ environmentId: envId, ...keyAuthValues({ id: randomUUID(), consumerId, key, tags: body.tags ?? [] }, this.enc) })
        .returning();
      const after = toKeyAuthCredential(row!, key);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "keyauth.create", entityType: "keyauth_credential", entityId: after.id, environmentId: envId, after });
      return { ...after, key };
    }));
  }

  async removeKeyAuth(ctx: RequestContext, envId: string, consumerId: string, credentialId: string) {
    await this.db.transaction(async (tx) => {
      await requireConsumer(tx, envId, consumerId);
      const [row] = await tx
        .select()
        .from(keyAuthCredentials)
        .where(and(eq(keyAuthCredentials.id, credentialId), eq(keyAuthCredentials.consumerId, consumerId)));
      if (!row) throw notFound("Credential");
      await tx.delete(keyAuthCredentials).where(eq(keyAuthCredentials.id, credentialId));
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, {
        action: "keyauth.delete",
        entityType: "keyauth_credential",
        entityId: credentialId,
        environmentId: envId,
        before: toKeyAuthCredential(row, this.enc.open(row.key, credentialContext(row.id))),
      });
    });
  }
}

export async function requireConsumer(tx: Executor, envId: string, consumerId: string): Promise<ConsumerRow> {
  const [row] = await tx
    .select()
    .from(consumers)
    .where(and(eq(consumers.id, consumerId), eq(consumers.environmentId, envId)));
  if (!row) throw notFound("Consumer");
  return row;
}

/** Rule the contract states in prose: username or customId is required. */
function checkConsumer(body: ConsumerWrite): void {
  if (!body.username && !body.customId) throw unprocessable("Invalid consumer", [{ path: "(body)", message: "must define username or customId" }]);
}

/* ---------------- controller ---------------- */

const KEY_AUTH_BODY = inlineBody("/environments/{envId}/consumers/{consumerId}/key-auth", "post");

@Controller("environments/:envId/consumers")
export class ConsumersController {
  constructor(private readonly consumers: ConsumersService) {}

  @Get()
  @RequiredRole("viewer")
  list(@Param("envId", uuidParam()) envId: string, @Query() query: Record<string, unknown>) {
    return this.consumers.list(envId, query);
  }

  @Post()
  @RequiredRole("editor")
  create(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Body(contractBody("ConsumerWrite")) body: ConsumerWrite) {
    return this.consumers.create(ctx, envId, body);
  }

  @Get(":consumerId")
  @RequiredRole("viewer")
  get(@Param("envId", uuidParam()) envId: string, @Param("consumerId", uuidParam()) consumerId: string) {
    return this.consumers.get(envId, consumerId);
  }

  @Put(":consumerId")
  @RequiredRole("editor")
  replace(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("consumerId", uuidParam()) consumerId: string,
    @Body(contractBody("ConsumerWrite")) body: ConsumerWrite,
  ) {
    return this.consumers.replace(ctx, envId, consumerId, body);
  }

  @Delete(":consumerId")
  @HttpCode(204)
  @RequiredRole("editor")
  async remove(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Param("consumerId", uuidParam()) consumerId: string) {
    await this.consumers.remove(ctx, envId, consumerId);
  }

  @Get(":consumerId/key-auth")
  @RequiredRole("viewer")
  listKeyAuth(@Param("envId", uuidParam()) envId: string, @Param("consumerId", uuidParam()) consumerId: string) {
    return this.consumers.listKeyAuth(envId, consumerId);
  }

  @Post(":consumerId/key-auth")
  @RequiredRole("editor")
  createKeyAuth(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("consumerId", uuidParam()) consumerId: string,
    @Body(contractBody(KEY_AUTH_BODY)) body: KeyAuthCredentialWrite,
  ) {
    return this.consumers.createKeyAuth(ctx, envId, consumerId, body);
  }

  @Delete(":consumerId/key-auth/:credentialId")
  @HttpCode(204)
  @RequiredRole("editor")
  async removeKeyAuth(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("consumerId", uuidParam()) consumerId: string,
    @Param("credentialId", uuidParam()) credentialId: string,
  ) {
    await this.consumers.removeKeyAuth(ctx, envId, consumerId, credentialId);
  }
}

@Module({ controllers: [ConsumersController, CredentialsController], providers: [ConsumersService, CredentialsService] })
export class ConsumersModule {}
