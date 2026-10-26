import { createPrivateKey, randomUUID, X509Certificate, type KeyObject } from "node:crypto";
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Post, Put, Query } from "@nestjs/common";
import type { Certificate } from "@gromesh/compiler";
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { CertificateWrite } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredPermission, RequiredRole, type RequestContext } from "../auth/auth.js";
import { contractBody, contractBodyV2 } from "../common/contract.js";
import { decodeCursor, parseLimit, toPage } from "../common/pagination.js";
import { type FieldError, notFound, unprocessable } from "../common/problem.js";
import { certificateKeyContext, ENCRYPTOR, Encryptor } from "../crypto/crypto.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { certificateSnis, certificates, type CertificateRow } from "../db/schema.js";
import { markDraftChanged, requireEnvironment, uuidParam } from "../environments/environments.js";
import { admit, type ConflictLimit, conflictLimit, guardedUniqueWrite, lockTablesForWrite, lockUnique, refuse } from "../workspaces/instance-uniqueness.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { refuseVarRefs, type WithVarRefs } from "../workspaces/var-refs.js";

export const SECRET_PLACEHOLDER = "REDACTED";
const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** What the API shows of a certificate: the key never, the leaf's metadata always. */
export function toCertificate(r: CertificateRow, snis: string[]) {
  return {
    id: r.id,
    cert: r.cert,
    key: SECRET_PLACEHOLDER,
    snis: [...snis].sort(),
    tags: r.tags,
    subject: r.subject,
    issuer: r.issuer,
    notBefore: r.notBefore.toISOString(),
    notAfter: r.notAfter.toISOString(),
    fingerprintSha256: r.fingerprintSha256,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export interface LeafInfo {
  subject: string;
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  fingerprintSha256: string;
}

/** Parses the PEM chain; the first certificate is the leaf. Null when it is not a PEM certificate chain. */
export function parseChain(pem: string): X509Certificate[] | null {
  const blocks = pem.match(PEM_CERT);
  if (!blocks) return null;
  try {
    return blocks.map((block) => new X509Certificate(block));
  } catch {
    return null;
  }
}

/** X509Certificate prints distinguished names one attribute per line. */
const oneLine = (dn: string) => dn.split("\n").filter(Boolean).join(", ");

export function leafInfo(leaf: X509Certificate): LeafInfo {
  return {
    subject: oneLine(leaf.subject),
    issuer: oneLine(leaf.issuer),
    notBefore: leaf.validFromDate,
    notAfter: leaf.validToDate,
    fingerprintSha256: leaf.fingerprint256.toUpperCase(),
  };
}

function privateKey(pem: string): KeyObject | null {
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) return null;
  try {
    return createPrivateKey(pem);
  } catch {
    return null;
  }
}

/**
 * The contract's 422 rules. `storedKey` is the opened key of the certificate being replaced (for "REDACTED");
 * `certChanged` is false when a PUT keeps the same cert, which is then not judged on expiry.
 */
export function checkCertificate(body: CertificateWrite, storedKey: string | null, certChanged: boolean): { leaf: LeafInfo; key: string } {
  const errors: FieldError[] = [];
  const chain = parseChain(body.cert);
  if (!chain) errors.push({ path: "cert", message: "is not a PEM certificate chain" });
  else if (certChanged && chain[0]!.validToDate.getTime() <= Date.now()) errors.push({ path: "cert", message: `the leaf certificate expired on ${chain[0]!.validToDate.toISOString()}` });

  let key = body.key;
  if (key === SECRET_PLACEHOLDER) {
    if (storedKey === null) errors.push({ path: "key", message: '"REDACTED" is a placeholder: send the private key itself' });
    else key = storedKey;
  }
  const keyObject = key === SECRET_PLACEHOLDER ? null : privateKey(key);
  if (key !== SECRET_PLACEHOLDER && !keyObject) errors.push({ path: "key", message: "is not a PEM private key" });
  else if (keyObject && chain && !chain[0]!.checkPrivateKey(keyObject)) errors.push({ path: "key", message: "does not match the leaf certificate" });

  const seen = new Set<string>();
  body.snis.forEach((name, i) => {
    if (seen.has(name)) errors.push({ path: `snis.${i}`, message: `"${name}" is repeated` });
    seen.add(name);
  });
  if (errors.length > 0) throw unprocessable("Invalid certificate", errors);
  return { leaf: leafInfo(chain![0]!), key };
}

/** Rollback restores a stored certificate as it was: no 422 rules, but its metadata is recomputed from the leaf. */
export function restoredLeaf(cert: string): LeafInfo {
  const chain = parseChain(cert);
  if (!chain) throw new Error("stored certificate is not a PEM chain");
  return leafInfo(chain[0]!);
}

@Injectable()
export class CertificatesService {
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
    const c = decodeCursor(query.cursor);
    const rows = await this.db
      .select()
      .from(certificates)
      .where(and(eq(certificates.environmentId, envId), c ? gt(certificates.id, c.id) : undefined))
      .orderBy(asc(certificates.id))
      .limit(limit + 1);
    const names = await this.snisOf(this.db, rows.map((r) => r.id));
    return toPage(rows, limit, (r) => r.id, (r) => toCertificate(r, names.get(r.id) ?? []));
  }

  async get(envId: string, certificateId: string) {
    const row = await this.requireCertificate(this.db, envId, certificateId);
    return toCertificate(row, (await this.snisOf(this.db, [row.id])).get(row.id) ?? []);
  }

  async create(ctx: RequestContext, envId: string, body: CertificateWrite) {
    const { leaf, key } = checkCertificate(body, null, true);
    return guardedUniqueWrite(this.db, ctx, "sni", this.conflicts, () => this.db.transaction(async (tx) => {
      await lockTablesForWrite(tx, ["sni"]);
      await requireEnvironment(tx, envId, true);
      if (!(await this.snisFree(tx, ctx, body.snis, null))) return refuse(tx, ctx, "sni", this.conflicts);
      const id = randomUUID();
      const [row] = await tx
        .insert(certificates)
        .values({ id, environmentId: envId, cert: body.cert, key: this.enc.seal(key, certificateKeyContext(id)), ...leaf, tags: body.tags ?? [] })
        .returning();
      await this.writeSnis(tx, envId, id, body.snis);
      const after = toCertificate(row!, body.snis);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "certificate.create", entityType: "certificate", entityId: id, environmentId: envId, after });
      return after;
    }));
  }

  async replace(ctx: RequestContext, envId: string, certificateId: string, body: CertificateWrite) {
    // The stored key is read before validation: "REDACTED" keeps it, and it must still match the new leaf.
    const current = await this.requireCertificate(this.db, envId, certificateId);
    const { leaf, key } = checkCertificate(body, this.enc.open(current.key, certificateKeyContext(current.id)), body.cert !== current.cert);
    return guardedUniqueWrite(this.db, ctx, "sni", this.conflicts, () => this.db.transaction(async (tx) => {
      await lockTablesForWrite(tx, ["sni"]);
      await requireEnvironment(tx, envId, true);
      const locked = await this.requireCertificate(tx, envId, certificateId);
      const before = toCertificate(locked, (await this.snisOf(tx, [locked.id])).get(locked.id) ?? []);
      if (!(await this.snisFree(tx, ctx, body.snis, certificateId))) return refuse(tx, ctx, "sni", this.conflicts);
      const [row] = await tx
        .update(certificates)
        .set({ cert: body.cert, key: this.enc.seal(key, certificateKeyContext(certificateId)), ...leaf, tags: body.tags ?? [], updatedAt: sql`now()` })
        .where(eq(certificates.id, certificateId))
        .returning();
      await tx.delete(certificateSnis).where(eq(certificateSnis.certificateId, certificateId));
      await this.writeSnis(tx, envId, certificateId, body.snis);
      const after = toCertificate(row!, body.snis);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "certificate.update", entityType: "certificate", entityId: certificateId, environmentId: envId, before, after });
      return after;
    }));
  }

  async remove(ctx: RequestContext, envId: string, certificateId: string) {
    await this.db.transaction(async (tx) => {
      // The order of every writer of these tables (rollback, import): the tables, then the environment's row, before
      // any row is deleted.
      await lockTablesForWrite(tx, ["sni"]);
      await requireEnvironment(tx, envId, true);
      const row = await this.requireCertificate(tx, envId, certificateId);
      const before = toCertificate(row, (await this.snisOf(tx, [row.id])).get(row.id) ?? []);
      await tx.delete(certificates).where(eq(certificates.id, certificateId));
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "certificate.delete", entityType: "certificate", entityId: certificateId, environmentId: envId, before });
    });
  }

  private async requireCertificate(tx: Executor, envId: string, certificateId: string): Promise<CertificateRow> {
    const [row] = await tx.select().from(certificates).where(and(eq(certificates.id, certificateId), eq(certificates.environmentId, envId)));
    if (!row) throw notFound("Certificate");
    return row;
  }

  private async snisOf(tx: Executor, ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    const rows = await tx.select().from(certificateSnis).where(inArray(certificateSnis.certificateId, ids));
    for (const r of rows) out.set(r.certificateId, [...(out.get(r.certificateId) ?? []), r.name]);
    return out;
  }

  /**
   * A server name belongs to one certificate in the whole instance (Kong matches it across the node, decision H-5):
   * another certificate holding it, in any workspace, is the generic 409 that never names the other one. The lock per
   * kind serializes the writers; the instance index, once in force, is the backstop.
   */
  private async snisFree(tx: Executor, ctx: RequestContext, names: string[], ownId: string | null): Promise<boolean> {
    if (names.length === 0) return true;
    await lockUnique(tx, ["sni"]);
    await admit(tx, ctx);
    const [taken] = await tx
      .select({ name: certificateSnis.name })
      .from(certificateSnis)
      .where(and(inArray(certificateSnis.name, names), ownId ? ne(certificateSnis.certificateId, ownId) : undefined))
      .limit(1);
    return taken === undefined;
  }

  private async writeSnis(tx: Executor, envId: string, certificateId: string, names: string[]): Promise<void> {
    if (names.length > 0) await tx.insert(certificateSnis).values(names.map((name) => ({ environmentId: envId, certificateId, name })));
  }
}

/** The compiler's domain model of the environment's certificates, keys opened. */
export async function loadCertificates(tx: Executor, envId: string, enc: Encryptor): Promise<Certificate[]> {
  const rows = await tx.select().from(certificates).where(eq(certificates.environmentId, envId));
  if (rows.length === 0) return [];
  const names = await tx.select().from(certificateSnis).where(eq(certificateSnis.environmentId, envId));
  return rows.map((r) => ({
    id: r.id,
    cert: r.cert,
    key: enc.open(r.key, certificateKeyContext(r.id)),
    snis: names.filter((n) => n.certificateId === r.id).map((n) => n.name).sort(),
    tags: r.tags,
  }));
}

/** Rollback: the certificates of `state`, keys sealed again for their row. */
export async function restoreCertificates(tx: Executor, envId: string, state: Certificate[], enc: Encryptor): Promise<void> {
  await tx.delete(certificates).where(eq(certificates.environmentId, envId));
  for (const c of state) {
    await tx.insert(certificates).values({ id: c.id, environmentId: envId, cert: c.cert, key: enc.seal(c.key, certificateKeyContext(c.id)), ...restoredLeaf(c.cert), tags: c.tags ?? [] });
    if (c.snis.length > 0) await tx.insert(certificateSnis).values(c.snis.map((name) => ({ environmentId: envId, certificateId: c.id, name })));
  }
}

@Controller("environments/:envId/certificates")
export class CertificatesController {
  constructor(private readonly certs: CertificatesService) {}

  @Get()
  @RequiredRole("viewer")
  list(@Param("envId", uuidParam()) envId: string, @Query() query: Record<string, unknown>) {
    return this.certs.list(envId, query);
  }

  @Post()
  @RequiredRole("editor")
  create(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Body(contractBody("CertificateWrite")) body: CertificateWrite) {
    return this.certs.create(ctx, envId, body);
  }

  @Get(":certificateId")
  @RequiredRole("viewer")
  get(@Param("envId", uuidParam()) envId: string, @Param("certificateId", uuidParam()) certificateId: string) {
    return this.certs.get(envId, certificateId);
  }

  @Put(":certificateId")
  @RequiredRole("editor")
  replace(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("certificateId", uuidParam()) certificateId: string,
    @Body(contractBody("CertificateWrite")) body: CertificateWrite,
  ) {
    return this.certs.replace(ctx, envId, certificateId, body);
  }

  @Delete(":certificateId")
  @HttpCode(204)
  @RequiredRole("editor")
  async remove(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Param("certificateId", uuidParam()) certificateId: string) {
    await this.certs.remove(ctx, envId, certificateId);
  }
}

/** control-plane-v2: the same service in the workspace with the environment's id (decision H-9). */
@Controller("api/v2/workspaces/:workspaceId/certificates")
export class WorkspaceCertificatesController {
  constructor(private readonly certs: CertificatesService) {}

  @Get()
  @RequiredPermission("workspace.read", "workspace")
  list(@Param("workspaceId", uuidParam()) workspaceId: string, @Query() query: Record<string, unknown>) {
    return this.certs.list(workspaceId, query);
  }

  @Post()
  @RequiredPermission("gateway.write", "workspace")
  create(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string, @Body(contractBodyV2("WorkspaceCertificateWrite")) body: WithVarRefs<CertificateWrite, "cert" | "key">) {
    return this.certs.create(ctx, workspaceId, refuseVarRefs(body, ["cert", "key"]));
  }

  @Get(":certificateId")
  @RequiredPermission("workspace.read", "workspace")
  get(@Param("workspaceId", uuidParam()) workspaceId: string, @Param("certificateId", uuidParam()) certificateId: string) {
    return this.certs.get(workspaceId, certificateId);
  }

  @Put(":certificateId")
  @RequiredPermission("gateway.write", "workspace")
  replace(
    @Ctx() ctx: RequestContext,
    @Param("workspaceId", uuidParam()) workspaceId: string,
    @Param("certificateId", uuidParam()) certificateId: string,
    @Body(contractBodyV2("WorkspaceCertificateWrite")) body: WithVarRefs<CertificateWrite, "cert" | "key">,
  ) {
    return this.certs.replace(ctx, workspaceId, certificateId, refuseVarRefs(body, ["cert", "key"]));
  }

  @Delete(":certificateId")
  @HttpCode(204)
  @RequiredPermission("gateway.write", "workspace")
  async remove(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string, @Param("certificateId", uuidParam()) certificateId: string) {
    await this.certs.remove(ctx, workspaceId, certificateId);
  }
}

@Module({ controllers: [CertificatesController, WorkspaceCertificatesController], providers: [CertificatesService] })
export class CertificatesModule {}
