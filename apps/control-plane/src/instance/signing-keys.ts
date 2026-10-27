import { Body, Controller, Get, HttpCode, Inject, Injectable, Logger, Module, Param, Post } from "@nestjs/common";
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lte, ne, sql } from "drizzle-orm";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredPermission, type RequestContext, SessionOnly } from "../auth/auth.js";
import { contractBodyV2, inlineBody } from "../common/contract.js";
import { conflict, notFound, unprocessable } from "../common/problem.js";
import { ENCRYPTOR, type Encryptor, instanceSigningKeyContext } from "../crypto/crypto.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { instanceSigningKeys, type InstanceSigningKeyRow, isolationAdmissions } from "../db/schema.js";

/** Serializes creating, retiring and revoking keys across replicas: the count of active keys is decided under it. */
export const SIGNING_KEYS_LOCK_KEY = 0x6772_736b; // "grsk"
const MAX_ACTIVE = 2;
const KID = /^[A-Za-z0-9_-]{43}$/;

export type SignedTyp = "gromesh-admission+json" | "gromesh-isolation-release+json";
/** JWS JSON flattened serialization with attached payload (agent-protocol-v2, Jws). */
export interface Jws {
  protected: string;
  payload: string;
  signature: string;
}

/** No active key covers the signing time: the caller refuses (no-signing-key) instead of signing. */
export class NoSigningKeyError extends Error {
  constructor() {
    super("No active instance signing key covers now");
  }
}

/** RFC 7638 thumbprint of an Ed25519 public key (base64url x). */
export const thumbprint = (x: string) => createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest("base64url");

const status = (k: InstanceSigningKeyRow) => (k.revokedAt ? "revoked" : k.retiredAt ? "retired" : "active");
/** contract: InstanceSigningKey. Public data only. */
const toKey = (k: InstanceSigningKeyRow) => ({
  kid: k.kid,
  publicKey: k.publicKey,
  status: status(k),
  validFrom: k.validFrom.toISOString(),
  validUntil: k.validUntil.toISOString(),
  retiredAt: k.retiredAt?.toISOString() ?? null,
  revokedAt: k.revokedAt?.toISOString() ?? null,
  createdAt: k.createdAt.toISOString(),
});
const auditView = (k: InstanceSigningKeyRow) => ({ kid: k.kid, status: status(k), validFrom: k.validFrom.toISOString(), validUntil: k.validUntil.toISOString() });

/**
 * Signs instance documents for server code only. The key is the active one with the latest validFrom whose validity
 * covers the database's clock at signing; its row stays share-locked until the caller's transaction ends, so a
 * revocation (which locks it for update) either commits before (the key is skipped) or waits for this commit.
 */
@Injectable()
export class InstanceSigner {
  constructor(@Inject(ENCRYPTOR) private readonly enc: Encryptor) {}

  async sign(tx: Executor, typ: SignedTyp, claims: Record<string, unknown>): Promise<{ jws: Jws; kid: string }> {
    const key = await this.usableKey(tx);
    const d = this.enc.open(key.privateKey, instanceSigningKeyContext(key.kid));
    const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: key.publicKey, d }, format: "jwk" });
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: key.kid, typ })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = sign(null, Buffer.from(`${header}.${payload}`, "ascii"), privateKey).toString("base64url");
    return { jws: { protected: header, payload, signature }, kid: key.kid };
  }

  /**
   * The filter runs before the share lock is granted: a key that expired (or was retired) while the lock was awaited
   * is checked again on the clock read after it, and then skipped for the next one.
   */
  private async usableKey(tx: Executor) {
    const usable = and(isNull(instanceSigningKeys.revokedAt), isNull(instanceSigningKeys.retiredAt), lte(instanceSigningKeys.validFrom, sql`clock_timestamp()`), gt(instanceSigningKeys.validUntil, sql`clock_timestamp()`));
    for (;;) {
      const [key] = await tx
        .select({ kid: instanceSigningKeys.kid, publicKey: instanceSigningKeys.publicKey, privateKey: instanceSigningKeys.privateKey })
        .from(instanceSigningKeys)
        .where(usable)
        .orderBy(desc(instanceSigningKeys.validFrom), asc(instanceSigningKeys.kid))
        .limit(1)
        .for("share");
      if (!key) throw new NoSigningKeyError();
      const [still] = await tx.select({ kid: instanceSigningKeys.kid }).from(instanceSigningKeys).where(and(eq(instanceSigningKeys.kid, key.kid), usable));
      if (still) return key;
    }
  }
}

@Injectable()
export class SigningKeysService {
  private readonly logger = new Logger("InstanceSigningKeys");

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENCRYPTOR) private readonly enc: Encryptor,
  ) {}

  async list() {
    const rows = await this.db.select().from(instanceSigningKeys).orderBy(desc(instanceSigningKeys.createdAt), asc(instanceSigningKeys.kid));
    return { items: rows.map(toKey) };
  }

  async create(ctx: RequestContext, validUntil: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SIGNING_KEYS_LOCK_KEY})`);
      // Every instant here is the clock after the lock, never now() (when the transaction began, before any wait).
      const [range] = await tx
        .execute<{ ok: boolean }>(sql`select (${validUntil}::timestamptz > clock_timestamp() + interval '1 day' and ${validUntil}::timestamptz <= clock_timestamp() + interval '730 days') as ok`)
        .then((r) => r.rows);
      if (!range?.ok) throw unprocessable("validUntil out of range", [{ path: "validUntil", message: "must be more than 1 day and at most 730 days from now" }]);
      const [active] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(instanceSigningKeys)
        .where(and(isNull(instanceSigningKeys.retiredAt), isNull(instanceSigningKeys.revokedAt), gt(instanceSigningKeys.validUntil, sql`clock_timestamp()`)));
      // An active key past its validUntil signs nothing again and no longer takes a place.
      if ((active?.n ?? 0) >= MAX_ACTIVE) throw conflict(`At most ${MAX_ACTIVE} instance signing keys are active at a time`);
      const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
      const kid = thumbprint(jwk.x!);
      const [row] = await tx
        .insert(instanceSigningKeys)
        .values({ kid, publicKey: jwk.x!, privateKey: this.enc.seal(jwk.d!, instanceSigningKeyContext(kid)), validFrom: sql`clock_timestamp()`, validUntil: sql`${validUntil}::timestamptz` })
        .returning();
      await audit(tx, ctx, { action: "instance.signing-key.create", entityType: "instance-signing-key", entityId: kid, after: auditView(row!) });
      return toKey(row!);
    });
  }

  async retire(ctx: RequestContext, kid: string, justification: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SIGNING_KEYS_LOCK_KEY})`);
      const key = await this.locked(tx, kid);
      if (status(key) !== "active") throw conflict("Only an active key can be retired");
      const [covers] = await tx
        .select({ yes: sql<boolean>`${instanceSigningKeys.validFrom} <= clock_timestamp() and ${instanceSigningKeys.validUntil} > clock_timestamp()` })
        .from(instanceSigningKeys)
        .where(eq(instanceSigningKeys.kid, kid));
      // Read on the clock after both locks (now() is when the transaction began, maybe before a key expired while it
      // waited). A key past its validUntil signs nothing any more: retiring it never leaves the instance unable to sign.
      if (covers?.yes) {
        const [other] = await tx
          .select({ kid: instanceSigningKeys.kid })
          .from(instanceSigningKeys)
          .where(and(ne(instanceSigningKeys.kid, kid), isNull(instanceSigningKeys.retiredAt), isNull(instanceSigningKeys.revokedAt), lte(instanceSigningKeys.validFrom, sql`clock_timestamp()`), gt(instanceSigningKeys.validUntil, sql`clock_timestamp()`)))
          .limit(1);
        if (!other) throw conflict("No other active key covers now: retiring this one would leave the instance unable to sign");
      }
      const [row] = await tx.update(instanceSigningKeys).set({ retiredAt: sql`clock_timestamp()` }).where(eq(instanceSigningKeys.kid, kid)).returning();
      await audit(tx, ctx, { action: "instance.signing-key.retire", entityType: "instance-signing-key", entityId: kid, before: auditView(key), after: { ...auditView(row!), retiredAt: row!.retiredAt!.toISOString(), justification } });
      return toKey(row!);
    });
  }

  async revoke(ctx: RequestContext, kid: string, justification: string) {
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SIGNING_KEYS_LOCK_KEY})`);
      // For update: waits for every signature still holding the key (share lock), and no later one finds it usable.
      const key = await this.locked(tx, kid);
      if (key.revokedAt) throw conflict("The key is already revoked");
      const [row] = await tx.update(instanceSigningKeys).set({ revokedAt: sql`clock_timestamp()` }).where(eq(instanceSigningKeys.kid, kid)).returning();
      const openAdmissions = await this.openAdmissions(tx, kid);
      await audit(tx, ctx, { action: "instance.signing-key.revoke", entityType: "instance-signing-key", entityId: kid, before: auditView(key), after: { ...auditView(row!), revokedAt: row!.revokedAt!.toISOString(), justification, openAdmissions } });
      return { key: toKey(row!), openAdmissions };
    });
    this.logger.warn(`Instance signing key ${kid} revoked; ${result.openAdmissions} open isolation admissions were signed with it`);
    return result;
  }

  /** Open isolation admissions it signed, on every cluster: the pods keep them until the chart drops the key. */
  private async openAdmissions(tx: Executor, kid: string): Promise<number> {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(isolationAdmissions).where(and(eq(isolationAdmissions.kid, kid), eq(isolationAdmissions.state, "open")));
    return row?.n ?? 0;
  }

  private async locked(tx: Executor, kid: string): Promise<InstanceSigningKeyRow> {
    const [key] = KID.test(kid) ? await tx.select().from(instanceSigningKeys).where(eq(instanceSigningKeys.kid, kid)).for("update") : [];
    if (!key) throw notFound("Signing key");
    return key;
  }
}

const JUSTIFIED = (action: "retire" | "revoke") => inlineBody(`/instance/signing-keys/{kid}/${action}`, "post");

/** control-plane-v2: the instance's own signing keys. Mutations need a session with CSRF, never an API token. */
@Controller("api/v2/instance/signing-keys")
export class SigningKeysController {
  constructor(private readonly keys: SigningKeysService) {}

  @Get()
  @RequiredPermission("platform.admin", "instance")
  list() {
    return this.keys.list();
  }

  @Post()
  @SessionOnly()
  @RequiredPermission("platform.admin", "instance")
  create(@Ctx() ctx: RequestContext, @Body(contractBodyV2(inlineBody("/instance/signing-keys", "post"))) body: { validUntil: string }) {
    return this.keys.create(ctx, body.validUntil);
  }

  @Post(":kid/retire")
  @HttpCode(200)
  @SessionOnly()
  @RequiredPermission("platform.admin", "instance")
  retire(@Ctx() ctx: RequestContext, @Param("kid") kid: string, @Body(contractBodyV2(JUSTIFIED("retire"))) body: { justification: string }) {
    return this.keys.retire(ctx, kid, body.justification);
  }

  @Post(":kid/revoke")
  @HttpCode(200)
  @SessionOnly()
  @RequiredPermission("platform.admin", "instance")
  revoke(@Ctx() ctx: RequestContext, @Param("kid") kid: string, @Body(contractBodyV2(JUSTIFIED("revoke"))) body: { justification: string }) {
    return this.keys.revoke(ctx, kid, body.justification);
  }
}

@Module({
  controllers: [SigningKeysController],
  providers: [SigningKeysService, InstanceSigner],
  exports: [InstanceSigner],
})
export class SigningKeysModule {}
