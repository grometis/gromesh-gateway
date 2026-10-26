import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type pg from "pg";
import { DB, PG_POOL, type Db } from "../db/db.js";
import { basicAuthCredentials, certificates, instanceSigningKeys, jwtCredentials, keyAuthCredentials, plugins, snapshots } from "../db/schema.js";
import { PluginCatalog } from "../plugin-catalog/catalog.js";
import { basicAuthHashContext, certificateKeyContext, credentialContext, ENCRYPTOR, Encryptor, instanceSigningKeyContext, isLegacySealed, isSealed, isSealedJson, jwtSecretContext, pluginSecretContext, snapshotContext } from "./crypto.js";

export interface AtRestReport {
  credentials: number;
  plugins: number;
  snapshots: number;
  certificates: number;
  jwtSecrets: number;
  basicAuthHashes: number;
  signingKeys: number;
  /** Another replica held the lock: nothing was done here. */
  skipped: boolean;
}

/** Test hook: runs before each row is written back, so a concurrent edit can be interposed deterministically. */
export interface AtRestHooks {
  beforeWrite?: (table: "credentials" | "plugins" | "snapshots" | "certificates" | "jwtSecrets" | "basicAuthHashes" | "signingKeys", id: string) => Promise<void>;
}

/** One replica re-seals at a time: the others skip. */
export const LOCK_KEY = 0x6772_6d73; // "grms"
const MAX_ATTEMPTS = 5;

/**
 * Seals what is stored in clear (first start after the encryption migration) or with an older key (rotation),
 * on a live system: one row per statement, each written only if the row is still what was read, otherwise re-read
 * and retried, so an edit landing in between is never overwritten.
 */
@Injectable()
export class AtRestService {
  private readonly logger = new Logger("AtRest");

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PG_POOL) private readonly created: { pool: pg.Pool },
    @Inject(ENCRYPTOR) private readonly enc: Encryptor,
    private readonly catalog: PluginCatalog,
  ) {}

  /**
   * Seals rows still in clear or in the previous format (v1 → v2, bound to the row) and finishes migration 0005
   * (fingerprints, NOT NULL, index swap). Idempotent. Rows sealed as v2 with an older key are left to `rotate`.
   */
  encryptExisting(hooks: AtRestHooks = {}): Promise<AtRestReport> {
    return this.locked(async () => {
      const report = await this.reseal(
        (stored) => !isSealed(stored) || isLegacySealed(stored),
        (doc) => !isSealedJson(doc) || isLegacySealed(doc.$enc),
        hooks,
      );
      await this.finishKeyHashMigration();
      return report;
    });
  }

  /** Re-seals everything not sealed with the current write key. */
  rotate(hooks: AtRestHooks = {}): Promise<AtRestReport> {
    return this.locked(() => this.reseal((stored) => !this.enc.current(stored), (doc) => !this.enc.currentJson(doc), hooks));
  }

  private async locked(work: () => Promise<Omit<AtRestReport, "skipped">>): Promise<AtRestReport> {
    // Session-level advisory lock on one dedicated connection; the rows themselves go through the pool.
    const client = await this.created.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [LOCK_KEY]);
      if (!rows[0]?.locked) return { credentials: 0, plugins: 0, snapshots: 0, certificates: 0, jwtSecrets: 0, basicAuthHashes: 0, signingKeys: 0, skipped: true };
      try {
        return { ...(await work()), skipped: false };
      } finally {
        await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  private async reseal(needsText: (stored: string) => boolean, needsDoc: (doc: unknown) => boolean, hooks: AtRestHooks): Promise<Omit<AtRestReport, "skipped">> {
    const report = { credentials: 0, plugins: 0, snapshots: 0, certificates: 0, jwtSecrets: 0, basicAuthHashes: 0, signingKeys: 0 };

    for (const { id } of await this.db.select({ id: keyAuthCredentials.id }).from(keyAuthCredentials).where(or(isNull(keyAuthCredentials.keyHash), sql`true`))) {
      await this.retry("credentials", id, async () => {
        const [row] = await this.db.select().from(keyAuthCredentials).where(eq(keyAuthCredentials.id, id));
        if (!row || (!needsText(row.key) && row.keyHash !== null)) return true;
        const plain = this.enc.open(row.key, credentialContext(id));
        await hooks.beforeWrite?.("credentials", id);
        const written = await this.db
          .update(keyAuthCredentials)
          .set({ key: this.enc.seal(plain, credentialContext(id)), keyHash: this.enc.fingerprint(plain) })
          .where(and(eq(keyAuthCredentials.id, id), eq(keyAuthCredentials.key, row.key)))
          .returning({ id: keyAuthCredentials.id });
        if (written.length === 0) return false;
        report.credentials++;
        return true;
      });
    }

    for (const { id } of await this.db.select({ id: plugins.id }).from(plugins)) {
      await this.retry("plugins", id, async () => {
        // updated_at as text: a JS Date drops PostgreSQL's microseconds and would never compare equal.
        const [row] = await this.db
          .select({ name: plugins.name, config: plugins.config, updatedAt: sql<string>`${plugins.updatedAt}::text` })
          .from(plugins)
          .where(eq(plugins.id, id));
        if (!row) return true;
        let touched = false;
        const sealed = this.catalog.mapSecrets(row.name, row.config, (value, path) => {
          if (!needsText(value)) return value;
          touched = true;
          const ctx = pluginSecretContext(id, path);
          return this.enc.seal(this.enc.open(value, ctx), ctx);
        });
        if (!touched) return true;
        await hooks.beforeWrite?.("plugins", id);
        // config and updated_at as read: a PUT in between changes both and makes this a no-op, then we re-read.
        const written = await this.db
          .update(plugins)
          .set({ config: sealed })
          .where(and(eq(plugins.id, id), sql`${plugins.config} = ${JSON.stringify(row.config)}::jsonb`, sql`${plugins.updatedAt}::text = ${row.updatedAt}`))
          .returning({ id: plugins.id });
        if (written.length === 0) return false;
        report.plugins++;
        return true;
      });
    }

    for (const { environmentId, version } of await this.db.select({ environmentId: snapshots.environmentId, version: snapshots.version }).from(snapshots)) {
      await this.retry("snapshots", `${environmentId}:${version}`, async () => {
        const [row] = await this.db
          .select()
          .from(snapshots)
          .where(and(eq(snapshots.environmentId, environmentId), eq(snapshots.version, version)));
        if (!row || (!needsDoc(row.config) && !needsDoc(row.state))) return true;
        await hooks.beforeWrite?.("snapshots", `${environmentId}:${version}`);
        const written = await this.db
          .update(snapshots)
          .set({
            config: this.enc.sealJson(this.enc.openJson(row.config, snapshotContext(environmentId, version, "config")), snapshotContext(environmentId, version, "config")),
            state: this.enc.sealJson(this.enc.openJson(row.state, snapshotContext(environmentId, version, "state")), snapshotContext(environmentId, version, "state")),
          })
          .where(and(eq(snapshots.environmentId, environmentId), eq(snapshots.version, version), sql`${snapshots.config} = ${JSON.stringify(row.config)}::jsonb`))
          .returning({ version: snapshots.version });
        if (written.length === 0) return false;
        report.snapshots++;
        return true;
      });
    }

    for (const { id } of await this.db.select({ id: certificates.id }).from(certificates)) {
      await this.retry("certificates", id, async () => {
        const [row] = await this.db.select({ key: certificates.key }).from(certificates).where(eq(certificates.id, id));
        if (!row || !needsText(row.key)) return true;
        const ctx = certificateKeyContext(id);
        await hooks.beforeWrite?.("certificates", id);
        const written = await this.db
          .update(certificates)
          .set({ key: this.enc.seal(this.enc.open(row.key, ctx), ctx) })
          .where(and(eq(certificates.id, id), eq(certificates.key, row.key)))
          .returning({ id: certificates.id });
        if (written.length === 0) return false;
        report.certificates++;
        return true;
      });
    }

    for (const { id } of await this.db.select({ id: jwtCredentials.id }).from(jwtCredentials)) {
      await this.retry("jwtSecrets", id, async () => {
        const [row] = await this.db.select({ secret: jwtCredentials.secret }).from(jwtCredentials).where(eq(jwtCredentials.id, id));
        if (!row || row.secret === null || !needsText(row.secret)) return true;
        const ctx = jwtSecretContext(id);
        await hooks.beforeWrite?.("jwtSecrets", id);
        const written = await this.db
          .update(jwtCredentials)
          .set({ secret: this.enc.seal(this.enc.open(row.secret, ctx), ctx) })
          .where(and(eq(jwtCredentials.id, id), eq(jwtCredentials.secret, row.secret)))
          .returning({ id: jwtCredentials.id });
        if (written.length === 0) return false;
        report.jwtSecrets++;
        return true;
      });
    }

    for (const { id } of await this.db.select({ id: basicAuthCredentials.id }).from(basicAuthCredentials)) {
      await this.retry("basicAuthHashes", id, async () => {
        const [row] = await this.db.select({ hash: basicAuthCredentials.passwordHash }).from(basicAuthCredentials).where(eq(basicAuthCredentials.id, id));
        if (!row || !needsText(row.hash)) return true;
        const ctx = basicAuthHashContext(id);
        await hooks.beforeWrite?.("basicAuthHashes", id);
        const written = await this.db
          .update(basicAuthCredentials)
          .set({ passwordHash: this.enc.seal(this.enc.open(row.hash, ctx), ctx) })
          .where(and(eq(basicAuthCredentials.id, id), eq(basicAuthCredentials.passwordHash, row.hash)))
          .returning({ id: basicAuthCredentials.id });
        if (written.length === 0) return false;
        report.basicAuthHashes++;
        return true;
      });
    }

    for (const { kid } of await this.db.select({ kid: instanceSigningKeys.kid }).from(instanceSigningKeys)) {
      await this.retry("signingKeys", kid, async () => {
        const [row] = await this.db.select({ privateKey: instanceSigningKeys.privateKey }).from(instanceSigningKeys).where(eq(instanceSigningKeys.kid, kid));
        if (!row || !needsText(row.privateKey)) return true;
        const ctx = instanceSigningKeyContext(kid);
        await hooks.beforeWrite?.("signingKeys", kid);
        const written = await this.db
          .update(instanceSigningKeys)
          .set({ privateKey: this.enc.seal(this.enc.open(row.privateKey, ctx), ctx) })
          .where(and(eq(instanceSigningKeys.kid, kid), eq(instanceSigningKeys.privateKey, row.privateKey)))
          .returning({ kid: instanceSigningKeys.kid });
        if (written.length === 0) return false;
        report.signingKeys++;
        return true;
      });
    }

    if (Object.values(report).some((n) => n > 0)) {
      this.logger.log(
        `Sealed ${report.credentials} credentials, ${report.plugins} plugin configs, ${report.snapshots} snapshots, ${report.certificates} certificate keys, ${report.jwtSecrets} JWT secrets, ${report.basicAuthHashes} basic-auth hashes, ${report.signingKeys} instance signing keys`,
      );
    }
    return report;
  }

  /** `attempt` returns false when the row changed under it; it is then re-read, a few times. */
  private async retry(table: string, id: string, attempt: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < MAX_ATTEMPTS; i++) if (await attempt()) return;
    throw new Error(`Could not re-seal ${table} ${id}: the row kept changing`);
  }

  /**
   * Fails while migration 0005 is unfinished (another replica is completing it): a key without a fingerprint is
   * invisible to the uniqueness check, and before keyauth_env_key_hash_uq nothing stops a repetition in a workspace.
   */
  async assertKeyHashMigrated(waitMs = 30_000): Promise<void> {
    for (const deadline = Date.now() + waitMs; ; await new Promise((r) => setTimeout(r, 200))) {
      const [row] = await this.db.select({ pending: sql<number>`count(*)::int` }).from(keyAuthCredentials).where(isNull(keyAuthCredentials.keyHash));
      if ((row?.pending ?? 0) === 0 && (await this.keyHashMigrated())) return;
      if (Date.now() > deadline) throw new Error("key-auth fingerprints not in force yet (another replica is completing migration 0005): start again later");
    }
  }

  /** Read from the catalog: NOT NULL, the fingerprint index per environment, and the old index gone. */
  private async keyHashMigrated(): Promise<boolean> {
    const [state] = await this.db
      .execute<{ done: boolean }>(
        sql`select exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'keyauth_credentials' and column_name = 'key_hash' and is_nullable = 'NO')
          and exists (select 1 from pg_indexes where schemaname = current_schema() and indexname = 'keyauth_env_key_hash_uq')
          and not exists (select 1 from pg_indexes where schemaname = current_schema() and indexname = 'keyauth_env_key_uq') as done`,
      )
      .then((r) => r.rows);
    return state?.done === true;
  }

  /** The part of migration 0005 that needs the fingerprint key: run after every credential has a key_hash. */
  private async finishKeyHashMigration(): Promise<void> {
    const [row] = await this.db.select({ pending: sql<number>`count(*)::int` }).from(keyAuthCredentials).where(isNull(keyAuthCredentials.keyHash));
    if ((row?.pending ?? 0) > 0) throw new Error(`${row?.pending} credentials still without a fingerprint`);
    // Read from the catalog first: once done, a start must not queue an ACCESS EXCLUSIVE lock behind another
    // replica's open write (every reader of the table would then wait behind it).
    if (await this.keyHashMigrated()) return;
    // Bounded: behind another replica's open write the start fails (and is retried) instead of queueing every reader.
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`alter table keyauth_credentials alter column key_hash set not null`);
      await tx.execute(sql`create unique index if not exists keyauth_env_key_hash_uq on keyauth_credentials (environment_id, key_hash)`);
      await tx.execute(sql`drop index if exists keyauth_env_key_uq`);
    });
  }
}
