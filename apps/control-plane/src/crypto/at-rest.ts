import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type pg from "pg";
import { DB, PG_POOL, type Db } from "../db/db.js";
import { keyAuthCredentials, plugins, snapshots } from "../db/schema.js";
import { PluginCatalog } from "../plugin-catalog/catalog.js";
import { ENCRYPTOR, Encryptor, isSealed } from "./crypto.js";

export interface AtRestReport {
  credentials: number;
  plugins: number;
  snapshots: number;
  /** Another replica held the lock: nothing was done here. */
  skipped: boolean;
}

/** Test hook: runs before each row is written back, so a concurrent edit can be interposed deterministically. */
export interface AtRestHooks {
  beforeWrite?: (table: "credentials" | "plugins" | "snapshots", id: string) => Promise<void>;
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

  /** Seals rows still in clear and finishes migration 0005 (fingerprints, NOT NULL, index swap). Idempotent. */
  encryptExisting(hooks: AtRestHooks = {}): Promise<AtRestReport> {
    return this.locked(async () => {
      const report = await this.reseal((stored) => !isSealed(stored), (doc) => !isSealedDoc(doc), hooks);
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
      if (!rows[0]?.locked) return { credentials: 0, plugins: 0, snapshots: 0, skipped: true };
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
    const report = { credentials: 0, plugins: 0, snapshots: 0 };

    for (const { id } of await this.db.select({ id: keyAuthCredentials.id }).from(keyAuthCredentials).where(or(isNull(keyAuthCredentials.keyHash), sql`true`))) {
      await this.retry("credentials", id, async () => {
        const [row] = await this.db.select().from(keyAuthCredentials).where(eq(keyAuthCredentials.id, id));
        if (!row || (!needsText(row.key) && row.keyHash !== null)) return true;
        const plain = this.enc.open(row.key);
        await hooks.beforeWrite?.("credentials", id);
        const written = await this.db
          .update(keyAuthCredentials)
          .set({ key: this.enc.seal(plain), keyHash: this.enc.fingerprint(plain) })
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
        const sealed = this.catalog.mapSecrets(row.name, row.config, (value) => {
          if (!needsText(value)) return value;
          touched = true;
          return this.enc.seal(this.enc.open(value));
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
          .set({ config: this.enc.sealJson(this.enc.openJson(row.config)), state: this.enc.sealJson(this.enc.openJson(row.state)) })
          .where(and(eq(snapshots.environmentId, environmentId), eq(snapshots.version, version), sql`${snapshots.config} = ${JSON.stringify(row.config)}::jsonb`))
          .returning({ version: snapshots.version });
        if (written.length === 0) return false;
        report.snapshots++;
        return true;
      });
    }

    if (report.credentials + report.plugins + report.snapshots > 0) {
      this.logger.log(`Sealed ${report.credentials} credentials, ${report.plugins} plugin configs, ${report.snapshots} snapshots`);
    }
    return report;
  }

  /** `attempt` returns false when the row changed under it; it is then re-read, a few times. */
  private async retry(table: string, id: string, attempt: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < MAX_ATTEMPTS; i++) if (await attempt()) return;
    throw new Error(`Could not re-seal ${table} ${id}: the row kept changing`);
  }

  /** The part of migration 0005 that needs the fingerprint key: run after every credential has a key_hash. */
  private async finishKeyHashMigration(): Promise<void> {
    const [row] = await this.db.select({ pending: sql<number>`count(*)::int` }).from(keyAuthCredentials).where(isNull(keyAuthCredentials.keyHash));
    if ((row?.pending ?? 0) > 0) throw new Error(`${row?.pending} credentials still without a fingerprint`);
    await this.db.execute(sql`alter table keyauth_credentials alter column key_hash set not null`);
    await this.db.execute(sql`create unique index if not exists keyauth_env_key_hash_uq on keyauth_credentials (environment_id, key_hash)`);
    await this.db.execute(sql`drop index if exists keyauth_env_key_uq`);
  }
}

const isSealedDoc = (doc: unknown) => typeof doc === "object" && doc !== null && "$enc" in (doc as object);
