import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.js";
import { keyAuthCredentials, plugins, snapshots } from "../db/schema.js";
import { PluginCatalog } from "../plugin-catalog/catalog.js";
import { ENCRYPTOR, Encryptor, fingerprint, isSealed } from "./crypto.js";

export interface AtRestReport {
  credentials: number;
  plugins: number;
  snapshots: number;
}

/**
 * Seals what is stored in clear (first start after the encryption migration) or with an older key (rotation).
 * Row by row in short transactions: it runs on a live system, next to normal traffic.
 */
@Injectable()
export class AtRestService {
  private readonly logger = new Logger("AtRest");

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENCRYPTOR) private readonly enc: Encryptor,
    private readonly catalog: PluginCatalog,
  ) {}

  /** Seals rows still stored in clear. Idempotent; called on every start. */
  encryptExisting(): Promise<AtRestReport> {
    return this.reseal((stored) => !isSealed(stored), (doc) => !this.enc.currentJson(doc) && !isSealedDoc(doc));
  }

  /** Re-seals everything not sealed with the current write key. */
  rotate(): Promise<AtRestReport> {
    return this.reseal((stored) => !this.enc.current(stored), (doc) => !this.enc.currentJson(doc));
  }

  private async reseal(needsText: (stored: string) => boolean, needsDoc: (doc: unknown) => boolean): Promise<AtRestReport> {
    const report: AtRestReport = { credentials: 0, plugins: 0, snapshots: 0 };
    for (const row of await this.db.select({ id: keyAuthCredentials.id, key: keyAuthCredentials.key }).from(keyAuthCredentials)) {
      if (!needsText(row.key)) continue;
      const plain = this.enc.open(row.key);
      await this.db.update(keyAuthCredentials).set({ key: this.enc.seal(plain), keyHash: fingerprint(plain) }).where(eq(keyAuthCredentials.id, row.id));
      report.credentials++;
    }
    for (const row of await this.db.select({ id: plugins.id, name: plugins.name, config: plugins.config }).from(plugins)) {
      let touched = false;
      const sealed = this.catalog.mapSecrets(row.name, row.config, (value) => {
        if (!needsText(value)) return value;
        touched = true;
        return this.enc.seal(this.enc.open(value));
      });
      if (!touched) continue;
      await this.db.update(plugins).set({ config: sealed }).where(eq(plugins.id, row.id));
      report.plugins++;
    }
    for (const row of await this.db.select({ environmentId: snapshots.environmentId, version: snapshots.version, config: snapshots.config, state: snapshots.state }).from(snapshots)) {
      if (!needsDoc(row.config) && !needsDoc(row.state)) continue;
      await this.db
        .update(snapshots)
        .set({ config: this.enc.sealJson(this.enc.openJson(row.config)), state: this.enc.sealJson(this.enc.openJson(row.state)) })
        .where(and(eq(snapshots.environmentId, row.environmentId), eq(snapshots.version, row.version)));
      report.snapshots++;
    }
    if (report.credentials + report.plugins + report.snapshots > 0) {
      this.logger.log(`Sealed ${report.credentials} credentials, ${report.plugins} plugin configs, ${report.snapshots} snapshots`);
    }
    return report;
  }
}

const isSealedDoc = (doc: unknown) => typeof doc === "object" && doc !== null && "$enc" in (doc as object);
