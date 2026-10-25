import { createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, Post, Put } from "@nestjs/common";
import { basicAuthPasswordHash, type BasicAuthCredential, type JwtCredential } from "@gromesh/compiler";
import { and, asc, eq, sql } from "drizzle-orm";
import type { AclGroups, BasicAuthCredentialCreate, JwtCredentialCreate } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredRole, type RequestContext } from "../auth/auth.js";
import { contractBody } from "../common/contract.js";
import { notFound, unprocessable } from "../common/problem.js";
import { basicAuthHashContext, ENCRYPTOR, Encryptor, jwtSecretContext } from "../crypto/crypto.js";
import { DB, type Db } from "../db/db.js";
import { basicAuthCredentials, consumers, jwtCredentials, type BasicAuthCredentialRow, type JwtCredentialRow } from "../db/schema.js";
import { markDraftChanged, requireEnvironment, uuidParam } from "../environments/environments.js";
import { requireConsumer } from "./consumers.js";
import { admit, type ConflictLimit, conflictLimit, guardedUniqueWrite, lockTablesForWrite, lockUnique, refuse, takenElsewhere } from "../workspaces/instance-uniqueness.js";
import { APP_CONFIG, type AppConfig } from "../config.js";

/* ---------------- mapping ---------------- */

/** The only shape a JWT credential leaves the service in, except the creation response: never the secret. */
export function toJwtCredential(r: JwtCredentialRow) {
  return {
    id: r.id,
    consumerId: r.consumerId,
    key: r.key,
    algorithm: r.algorithm as JwtCredential["algorithm"],
    ...(r.rsaPublicKey ? { rsaPublicKey: r.rsaPublicKey } : {}),
    tags: r.tags,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Never the password nor its hash. */
export function toBasicAuthCredential(r: BasicAuthCredentialRow) {
  return { id: r.id, consumerId: r.consumerId, username: r.username, tags: r.tags, createdAt: r.createdAt.toISOString() };
}

/** Column values for a credential whose secret is in clear: sealed to its row. */
export function jwtValues(j: JwtCredential, enc: Encryptor) {
  return {
    id: j.id,
    consumerId: j.consumerId,
    key: j.key,
    algorithm: j.algorithm,
    secret: j.secret ? enc.seal(j.secret, jwtSecretContext(j.id)) : null,
    rsaPublicKey: j.rsaPublicKey ?? null,
    tags: j.tags ?? [],
  };
}

export function jwtState(r: JwtCredentialRow, enc: Encryptor): JwtCredential {
  return {
    id: r.id,
    consumerId: r.consumerId,
    key: r.key,
    algorithm: r.algorithm as JwtCredential["algorithm"],
    secret: r.secret === null ? null : enc.open(r.secret, jwtSecretContext(r.id)),
    rsaPublicKey: r.rsaPublicKey,
    tags: r.tags,
  };
}

/** The hash is a secret too: sealed to its row. */
export function basicAuthValues(b: BasicAuthCredential, enc: Encryptor) {
  return { id: b.id, consumerId: b.consumerId, username: b.username, passwordHash: enc.seal(b.passwordHash, basicAuthHashContext(b.id)), tags: b.tags ?? [] };
}

export function basicAuthState(r: BasicAuthCredentialRow, enc: Encryptor): BasicAuthCredential {
  return { id: r.id, consumerId: r.consumerId, username: r.username, passwordHash: enc.open(r.passwordHash, basicAuthHashContext(r.id)), tags: r.tags };
}

/** The contract's 422 rules for a JWT credential that its schema cannot express. */
export function checkJwt(body: JwtCredentialCreate): void {
  const errors: { path: string; message: string }[] = [];
  if (body.algorithm === "HS256") {
    if (body.rsaPublicKey !== undefined) errors.push({ path: "rsaPublicKey", message: "only applies to RS256 and ES256" });
  } else {
    if (body.secret !== undefined) errors.push({ path: "secret", message: "only applies to HS256" });
    if (body.rsaPublicKey === undefined) errors.push({ path: "rsaPublicKey", message: `is required for ${body.algorithm}` });
    else {
      const problem = publicKeyProblem(body.rsaPublicKey, body.algorithm);
      if (problem) errors.push({ path: "rsaPublicKey", message: problem });
    }
  }
  if (errors.length > 0) throw unprocessable("Invalid JWT credential", errors);
}

function publicKeyProblem(pem: string, algorithm: "RS256" | "ES256"): string | null {
  // createPublicKey also derives a public key from a private one: only a PEM public key is accepted here.
  if (!/^-----BEGIN (RSA )?PUBLIC KEY-----/.test(pem.trim()) || pem.includes("PRIVATE KEY")) return "must be a PEM public key";
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    return "must be a PEM public key";
  }
  if (algorithm === "RS256" && key.asymmetricKeyType !== "rsa") return "must be an RSA key for RS256";
  if (algorithm === "ES256" && (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")) return "must be an EC P-256 key for ES256";
  return null;
}

/* ---------------- service ---------------- */

@Injectable()
export class CredentialsService {
  private readonly conflicts: ConflictLimit;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENCRYPTOR) private readonly enc: Encryptor,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.conflicts = conflictLimit(config);
  }

  /* jwt */

  async listJwt(envId: string, consumerId: string) {
    await requireConsumer(this.db, envId, consumerId);
    const rows = await this.db
      .select()
      .from(jwtCredentials)
      .where(eq(jwtCredentials.consumerId, consumerId))
      .orderBy(asc(jwtCredentials.createdAt), asc(jwtCredentials.id));
    return { items: rows.map(toJwtCredential) };
  }

  async createJwt(ctx: RequestContext, envId: string, consumerId: string, body: JwtCredentialCreate) {
    checkJwt(body);
    return guardedUniqueWrite(this.db, ctx, "jwt-key", this.conflicts, () => this.db.transaction(async (tx) => {
      await lockTablesForWrite(tx, ["jwt-key"]);
      await requireConsumer(tx, envId, consumerId);
      const secret = body.algorithm === "HS256" ? (body.secret ?? randomBytes(32).toString("base64url")) : null;
      const credential: JwtCredential = {
        id: randomUUID(),
        consumerId,
        key: body.key ?? randomBytes(16).toString("hex"),
        algorithm: body.algorithm,
        secret,
        rsaPublicKey: body.rsaPublicKey ?? null,
        tags: body.tags ?? [],
      };
      // Kong finds the credential by its key across the whole node: unique in the instance (decision H-5). The
      // environment's row first, then the lock, as every writer of these values does.
      await requireEnvironment(tx, envId, true);
      await lockUnique(tx, ["jwt-key"]);
      await admit(tx, ctx);
      if ((await takenElsewhere(tx, "jwt-key", envId, [credential.key])).size > 0) return refuse(tx, ctx, "jwt-key", this.conflicts);
      const [row] = await tx.insert(jwtCredentials).values({ environmentId: envId, ...jwtValues(credential, this.enc) }).returning();
      const after = toJwtCredential(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "jwt.create", entityType: "jwt_credential", entityId: after.id, environmentId: envId, after });
      return secret === null ? after : { ...after, secret };
    }));
  }

  async removeJwt(ctx: RequestContext, envId: string, consumerId: string, credentialId: string) {
    await this.db.transaction(async (tx) => {
      await requireConsumer(tx, envId, consumerId);
      const [row] = await tx.select().from(jwtCredentials).where(and(eq(jwtCredentials.id, credentialId), eq(jwtCredentials.consumerId, consumerId)));
      if (!row) throw notFound("Credential");
      await tx.delete(jwtCredentials).where(eq(jwtCredentials.id, credentialId));
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "jwt.delete", entityType: "jwt_credential", entityId: credentialId, environmentId: envId, before: toJwtCredential(row) });
    });
  }

  /* basic-auth */

  async listBasicAuth(envId: string, consumerId: string) {
    await requireConsumer(this.db, envId, consumerId);
    const rows = await this.db
      .select()
      .from(basicAuthCredentials)
      .where(eq(basicAuthCredentials.consumerId, consumerId))
      .orderBy(asc(basicAuthCredentials.createdAt), asc(basicAuthCredentials.id));
    return { items: rows.map(toBasicAuthCredential) };
  }

  async createBasicAuth(ctx: RequestContext, envId: string, consumerId: string, body: BasicAuthCredentialCreate) {
    return guardedUniqueWrite(this.db, ctx, "basic-auth-username", this.conflicts, () => this.db.transaction(async (tx) => {
      await lockTablesForWrite(tx, ["basic-auth-username"]);
      await requireConsumer(tx, envId, consumerId);
      await requireEnvironment(tx, envId, true);
      await lockUnique(tx, ["basic-auth-username"]);
      await admit(tx, ctx);
      if ((await takenElsewhere(tx, "basic-auth-username", envId, [body.username])).size > 0) return refuse(tx, ctx, "basic-auth-username", this.conflicts);
      // Only Kong's hash is kept: the password itself is never stored, logged or returned.
      const credential: BasicAuthCredential = { id: randomUUID(), consumerId, username: body.username, passwordHash: basicAuthPasswordHash(consumerId, body.password), tags: body.tags ?? [] };
      const [row] = await tx.insert(basicAuthCredentials).values({ environmentId: envId, ...basicAuthValues(credential, this.enc) }).returning();
      const after = toBasicAuthCredential(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "basicauth.create", entityType: "basicauth_credential", entityId: after.id, environmentId: envId, after });
      return after;
    }));
  }

  async removeBasicAuth(ctx: RequestContext, envId: string, consumerId: string, credentialId: string) {
    await this.db.transaction(async (tx) => {
      await requireConsumer(tx, envId, consumerId);
      const [row] = await tx
        .select()
        .from(basicAuthCredentials)
        .where(and(eq(basicAuthCredentials.id, credentialId), eq(basicAuthCredentials.consumerId, consumerId)));
      if (!row) throw notFound("Credential");
      await tx.delete(basicAuthCredentials).where(eq(basicAuthCredentials.id, credentialId));
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "basicauth.delete", entityType: "basicauth_credential", entityId: credentialId, environmentId: envId, before: toBasicAuthCredential(row) });
    });
  }

  /* acl groups */

  async getAclGroups(envId: string, consumerId: string): Promise<AclGroups> {
    return { groups: (await requireConsumer(this.db, envId, consumerId)).aclGroups };
  }

  async replaceAclGroups(ctx: RequestContext, envId: string, consumerId: string, body: AclGroups): Promise<AclGroups> {
    return this.db.transaction(async (tx) => {
      const before = { groups: (await requireConsumer(tx, envId, consumerId)).aclGroups };
      const groups = [...body.groups].sort();
      await tx.update(consumers).set({ aclGroups: groups, updatedAt: sql`now()` }).where(eq(consumers.id, consumerId));
      const after = { groups };
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "consumer.acl_groups.replace", entityType: "consumer", entityId: consumerId, environmentId: envId, before, after });
      return after;
    });
  }
}

/* ---------------- controller ---------------- */

@Controller("environments/:envId/consumers/:consumerId")
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Get("jwt")
  @RequiredRole("viewer")
  listJwt(@Param("envId", uuidParam()) envId: string, @Param("consumerId", uuidParam()) consumerId: string) {
    return this.credentials.listJwt(envId, consumerId);
  }

  @Post("jwt")
  @RequiredRole("editor")
  createJwt(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("consumerId", uuidParam()) consumerId: string,
    @Body(contractBody("JwtCredentialCreate")) body: JwtCredentialCreate,
  ) {
    return this.credentials.createJwt(ctx, envId, consumerId, body);
  }

  @Delete("jwt/:credentialId")
  @HttpCode(204)
  @RequiredRole("editor")
  async removeJwt(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("consumerId", uuidParam()) consumerId: string,
    @Param("credentialId", uuidParam()) credentialId: string,
  ) {
    await this.credentials.removeJwt(ctx, envId, consumerId, credentialId);
  }

  @Get("basic-auth")
  @RequiredRole("viewer")
  listBasicAuth(@Param("envId", uuidParam()) envId: string, @Param("consumerId", uuidParam()) consumerId: string) {
    return this.credentials.listBasicAuth(envId, consumerId);
  }

  @Post("basic-auth")
  @RequiredRole("editor")
  createBasicAuth(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("consumerId", uuidParam()) consumerId: string,
    @Body(contractBody("BasicAuthCredentialCreate")) body: BasicAuthCredentialCreate,
  ) {
    return this.credentials.createBasicAuth(ctx, envId, consumerId, body);
  }

  @Delete("basic-auth/:credentialId")
  @HttpCode(204)
  @RequiredRole("editor")
  async removeBasicAuth(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("consumerId", uuidParam()) consumerId: string,
    @Param("credentialId", uuidParam()) credentialId: string,
  ) {
    await this.credentials.removeBasicAuth(ctx, envId, consumerId, credentialId);
  }

  @Get("acl-groups")
  @RequiredRole("viewer")
  getAclGroups(@Param("envId", uuidParam()) envId: string, @Param("consumerId", uuidParam()) consumerId: string) {
    return this.credentials.getAclGroups(envId, consumerId);
  }

  @Put("acl-groups")
  @RequiredRole("editor")
  replaceAclGroups(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("consumerId", uuidParam()) consumerId: string,
    @Body(contractBody("AclGroups")) body: AclGroups,
  ) {
    return this.credentials.replaceAclGroups(ctx, envId, consumerId, body);
  }
}
