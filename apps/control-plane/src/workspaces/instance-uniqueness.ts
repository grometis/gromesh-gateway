import { HttpStatus } from "@nestjs/common";
import type { GatewayState } from "@gromesh/compiler";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { audit } from "../audit/audit.js";
import type { RequestContext } from "../auth/auth.js";
import type { AppConfig } from "../config.js";
import { conflict, ProblemException } from "../common/problem.js";
import type { Encryptor } from "../crypto/crypto.js";
import type { Db, Executor } from "../db/db.js";
import { basicAuthCredentials, certificateSnis, jwtCredentials, keyAuthCredentials, loginAttempts } from "../db/schema.js";

/**
 * What Kong looks up across the whole node, so it must be unique in the instance, across workspaces (decision H-5):
 * the key-auth key (by its fingerprint), the JWT key (issuer), the basic-auth username and the SNI. A conflict never
 * names the other workspace.
 */
export type UniqueKind = "key-auth-key" | "jwt-key" | "basic-auth-username" | "sni";
export const UNIQUE_KINDS: readonly UniqueKind[] = ["key-auth-key", "jwt-key", "basic-auth-username", "sni"];

const COLUMNS = {
  "key-auth-key": { table: keyAuthCredentials, value: keyAuthCredentials.keyHash, env: keyAuthCredentials.environmentId, entity: keyAuthCredentials.id },
  "jwt-key": { table: jwtCredentials, value: jwtCredentials.key, env: jwtCredentials.environmentId, entity: jwtCredentials.id },
  "basic-auth-username": { table: basicAuthCredentials, value: basicAuthCredentials.username, env: basicAuthCredentials.environmentId, entity: basicAuthCredentials.id },
  sni: { table: certificateSnis, value: certificateSnis.name, env: certificateSnis.environmentId, entity: certificateSnis.certificateId },
} as const;

/**
 * The instance-wide unique indexes. They exist only once no value is repeated across workspaces (the migration report
 * lists the blockers until then), so they are created here and not by a migration; until then the service checks
 * every write under a lock per kind.
 */
const INSTANCE_INDEXES: Record<UniqueKind, { name: string; ddl: string; constraintsOfWorkspace: string[] }> = {
  "key-auth-key": { name: "keyauth_key_hash_instance_uq", ddl: `create unique index if not exists keyauth_key_hash_instance_uq on keyauth_credentials (key_hash)`, constraintsOfWorkspace: ["keyauth_env_key_hash_uq"] },
  "jwt-key": { name: "jwt_key_instance_uq", ddl: `create unique index if not exists jwt_key_instance_uq on jwt_credentials (key)`, constraintsOfWorkspace: ["jwt_env_key_uq"] },
  "basic-auth-username": { name: "basicauth_username_instance_uq", ddl: `create unique index if not exists basicauth_username_instance_uq on basicauth_credentials (username)`, constraintsOfWorkspace: ["basicauth_env_username_uq"] },
  sni: { name: "certificate_snis_name_instance_uq", ddl: `create unique index if not exists certificate_snis_name_instance_uq on certificate_snis (name)`, constraintsOfWorkspace: ["certificate_snis_pkey"] },
};
const UNIQUE_CONSTRAINTS = new Set(Object.values(INSTANCE_INDEXES).flatMap((i) => [i.name, ...i.constraintsOfWorkspace]));

const LOCK_CLASS = 0x6772_7563; // "gruc"

/** Serializes the writers of these kinds across replicas while an instance index may not exist yet. */
export async function lockUnique(tx: Executor, kinds: readonly UniqueKind[]): Promise<void> {
  for (const kind of [...new Set(kinds)].sort()) await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_CLASS}, ${UNIQUE_KINDS.indexOf(kind)})`);
}

/** Values of other workspaces only: what a workspace's own unique indexes cannot see. */
export async function takenElsewhere(tx: Executor, kind: UniqueKind, envId: string, values: readonly string[]): Promise<Set<string>> {
  if (values.length === 0) return new Set();
  const c = COLUMNS[kind];
  const rows = await tx.selectDistinct({ value: c.value }).from(c.table).where(and(inArray(c.value, [...values]), ne(c.env, envId)));
  return new Set(rows.map((r) => r.value));
}

export const inUse = () => conflict("Already in use in this instance");

/** The unique values a gateway state holds, by kind (key-auth keys by their fingerprint). */
export function uniqueValues(state: Pick<GatewayState, "keyAuthCredentials" | "jwtCredentials" | "basicAuthCredentials" | "certificates">, enc: Encryptor): Record<UniqueKind, string[]> {
  return {
    "key-auth-key": state.keyAuthCredentials.map((k) => enc.fingerprint(k.key)),
    "jwt-key": (state.jwtCredentials ?? []).map((j) => j.key),
    "basic-auth-username": (state.basicAuthCredentials ?? []).map((b) => b.username),
    sni: (state.certificates ?? []).flatMap((c) => c.snis),
  };
}

/** Refuses a state (rollback, import) holding a value another workspace already holds. */
export async function assertStateFree(tx: Executor, envId: string, state: GatewayState, enc: Encryptor): Promise<void> {
  const values = uniqueValues(state, enc);
  await lockUnique(tx, UNIQUE_KINDS);
  for (const kind of UNIQUE_KINDS) if ((await takenElsewhere(tx, kind, envId, values[kind])).size > 0) throw inUse();
}

/**
 * Puts in force the instance-wide index of every kind no two drafts repeat; returns the kinds still blocked. An index
 * already there is found without touching the table; a missing one is built under a short lock timeout, so a busy
 * table (a re-seal on another replica, say) only postpones it to the next start or report instead of stalling writers.
 */
export async function enforceInstanceUniqueness(tx: Executor): Promise<UniqueKind[]> {
  const candidates = await unenforcedKinds(tx);
  if (candidates.length === 0) return [];
  const blocked: UniqueKind[] = [];
  // The tables first (the order of every writer of them), and only them: SHARE ROW EXCLUSIVE keeps writers out while
  // the repetition is checked and the index built, and another replica doing the same waits (CREATE INDEX IF NOT
  // EXISTS is not safe when two run at once). Read again once held: the other one may have built some meanwhile.
  await tx.execute(sql`set local lock_timeout = '2s'`);
  await tx.execute(sql.raw(`lock table ${tablesOf(candidates).join(", ")} in share row exclusive mode`));
  const missing = (await unenforcedKinds(tx)).filter((kind) => candidates.includes(kind));
  for (const kind of missing) {
    const c = COLUMNS[kind];
    const [repeated] = await tx.select({ value: c.value }).from(c.table).groupBy(c.value).having(sql`count(distinct ${c.env}) > 1`).limit(1);
    // A key-auth fingerprint not filled in yet (another replica runs crypto/at-rest) could hide a repetition.
    const [unknown] = kind === "key-auth-key" ? await tx.select({ id: keyAuthCredentials.id }).from(keyAuthCredentials).where(isNull(keyAuthCredentials.keyHash)).limit(1) : [];
    if (repeated || unknown) blocked.push(kind);
    else await tx.execute(sql.raw(INSTANCE_INDEXES[kind].ddl));
  }
  return blocked;
}

/** The kinds whose instance index is not in force yet (read from the catalog, without touching the tables). */
export async function unenforcedKinds(db: Executor): Promise<UniqueKind[]> {
  const present = new Set((await db.execute<{ name: string }>(sql`select indexname as name from pg_indexes where schemaname = 'public'`)).rows.map((r) => r.name));
  return UNIQUE_KINDS.filter((kind) => !present.has(INSTANCE_INDEXES[kind].name));
}

const TABLE: Record<UniqueKind, string> = { "key-auth-key": "keyauth_credentials", "jwt-key": "jwt_credentials", "basic-auth-username": "basicauth_credentials", sni: "certificate_snis" };
const tablesOf = (kinds: readonly UniqueKind[]) => [...new Set(kinds.map((k) => TABLE[k]))].sort();

/**
 * The lock order of every writer of instance-unique values: these tables first, then the environment's row, then
 * the kind's lock, then the actor's. A writer takes ROW EXCLUSIVE (what its INSERT takes anyway, compatible with
 * every other writer) as its first statement, so it never holds the environment's row while waiting for a table.
 */
export async function lockTablesForWrite(tx: Executor, kinds: readonly UniqueKind[]): Promise<void> {
  await tx.execute(sql.raw(`lock table ${tablesOf(kinds).join(", ")} in row exclusive mode`));
}

/**
 * For a serializable (or repeatable read) transaction: as its first statement, the tables of the kinds without an
 * instance index, against concurrent writers. A table lock does not freeze the snapshot (a SELECT would), so the
 * transaction then sees every value committed before it; later writers wait for it.
 */
export async function lockUnenforcedTables(tx: Executor, kinds: readonly UniqueKind[]): Promise<void> {
  if (kinds.length > 0) await tx.execute(sql.raw(`lock table ${tablesOf(kinds).join(", ")} in share row exclusive mode`));
}

/** At start: like enforceInstanceUniqueness, but a lock timeout leaves the indexes for later instead of failing. */
export async function enforceInstanceUniquenessSoon(db: Db): Promise<void> {
  try {
    await db.transaction((tx) => enforceInstanceUniqueness(tx));
  } catch (error) {
    let cur: unknown = error;
    for (let i = 0; i < 3 && cur && typeof cur === "object"; i++, cur = (cur as { cause?: unknown }).cause) if ((cur as { code?: string }).code === "55P03") return;
    throw error;
  }
}

/* ---------------- failed attempts: audited and limited (a 409 must not become an existence oracle) ---------------- */

/** The limit of conflicting writes per actor, and the window that both counts them and locks the actor. */
export interface ConflictLimit {
  max: number;
  windowMs: number;
}
export const conflictLimit = (config: Pick<AppConfig, "uniqueConflictMax" | "loginLockoutMs">): ConflictLimit => ({ max: config.uniqueConflictMax, windowMs: config.loginLockoutMs });

function isUniqueConflict(error: unknown): boolean {
  if (error instanceof ProblemException) return error.getStatus() === HttpStatus.CONFLICT && (error.getResponse() as { detail?: string }).detail === "Already in use in this instance";
  let cur: unknown = error;
  for (let i = 0; i < 3 && cur && typeof cur === "object"; i++) {
    const pg = cur as { code?: string; constraint?: string };
    if (pg.code === "23505" && pg.constraint !== undefined && UNIQUE_CONSTRAINTS.has(pg.constraint)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** What collided: a value of a kind, an import or a rollback. */
export type ConflictKind = UniqueKind | "import" | "rollback";
const ACTOR_LOCK_CLASS = 0x6772_6163; // "grac"

/** 429 while the actor's conflicting writes are over the limit. */
async function assertNotLimited(tx: Executor, ctx: RequestContext): Promise<void> {
  const [row] = await tx.select().from(loginAttempts).where(eq(loginAttempts.key, `conflict:${ctx.actor.id}`));
  const lockedFor = row?.lockedUntil ? row.lockedUntil.getTime() - Date.now() : 0;
  if (lockedFor > 0) throw new ProblemException(HttpStatus.TOO_MANY_REQUESTS, "Too many conflicting writes", undefined, undefined, { "Retry-After": String(Math.ceil(lockedFor / 1000)) });
}

/**
 * Right before the existence check of a write: the actor's lock (after the environment row and the kind's lock, the
 * order of every writer) and the limit read again under it, so concurrent requests of one actor cannot all pass the
 * limit and then all probe. Held until the write commits; other actors are not affected.
 */
export async function admit(tx: Executor, ctx: RequestContext): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ACTOR_LOCK_CLASS}, hashtext(${ctx.actor.id}))`);
  await assertNotLimited(tx, ctx);
}

/**
 * Counts one conflicting attempt against the actor, atomically, and audits it (the kind only, never the value). The
 * clock is the current one, not the transaction's start (now()): an import counts after waiting in its queue.
 */
export async function countConflict(tx: Executor, ctx: RequestContext, kind: ConflictKind, limit: ConflictLimit): Promise<void> {
  const window = sql`make_interval(secs => ${limit.windowMs / 1000})`;
  const fresh = sql`${loginAttempts.windowStartedAt} > clock_timestamp() - ${window}`;
  const failures = sql`case when ${fresh} then ${loginAttempts.failures} + 1 else 1 end`;
  {
    await tx
      .insert(loginAttempts)
      .values({ key: `conflict:${ctx.actor.id}`, failures: 1, windowStartedAt: sql`clock_timestamp()`, lockedUntil: limit.max <= 1 ? sql`clock_timestamp() + ${window}` : null })
      .onConflictDoUpdate({
        target: loginAttempts.key,
        set: {
          failures,
          windowStartedAt: sql`case when ${fresh} then ${loginAttempts.windowStartedAt} else clock_timestamp() end`,
          lockedUntil: sql`case when ${failures} >= ${limit.max} then clock_timestamp() + ${window} else null end`,
        },
      });
    await audit(tx, ctx, { action: "uniqueness.conflict", entityType: kind, after: { kind } });
  }
}

/** The same in a transaction of its own: after a write that failed (an import, a unique violation). */
export const recordConflict = (db: Db, ctx: RequestContext, kind: ConflictKind, limit: ConflictLimit) => db.transaction((tx) => countConflict(tx, ctx, kind, limit));

/** What a write's transaction returns when it refuses: it commits only the count of the conflict, then the 409. */
export const REFUSED: unique symbol = Symbol("refused");
/**
 * Inside the write's transaction, still under the actor's lock (admit): counts and audits the conflict there, so the
 * next request of the actor, waiting for that lock, already sees it.
 */
export async function refuse(tx: Executor, ctx: RequestContext, kind: ConflictKind, limit: ConflictLimit): Promise<typeof REFUSED> {
  await countConflict(tx, ctx, kind, limit);
  return REFUSED;
}

/**
 * A write that may collide on an instance-unique value: refused up front while the actor is over the limit; every
 * collision answers the same generic 409, is audited and counts against the actor, so a 409 is no oracle.
 */
export async function guardedUniqueWrite<T>(db: Db, ctx: RequestContext, kind: ConflictKind, limit: ConflictLimit, work: () => Promise<T | typeof REFUSED>): Promise<T> {
  await assertNotLimited(db, ctx);
  let result: T | typeof REFUSED;
  try {
    result = await work();
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    await recordConflict(db, ctx, kind, limit);
    throw inUse();
  }
  if (result === REFUSED) throw inUse();
  return result;
}

/** Whether a state (a version to restore) holds a value another workspace holds; the caller holds the kinds' locks. */
export async function stateCollides(tx: Executor, envId: string, state: GatewayState, enc: Encryptor): Promise<boolean> {
  const values = uniqueValues(state, enc);
  for (const kind of UNIQUE_KINDS) if ((await takenElsewhere(tx, kind, envId, values[kind])).size > 0) return true;
  return false;
}
