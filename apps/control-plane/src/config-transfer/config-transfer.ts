import { Controller, Get, HttpCode, Inject, Injectable, Module, Param, Post, Query, Res } from "@nestjs/common";
import { convertKongConfig, diffGatewayStates, exportConfig, privilegedFingerprint, type ConfigDocument } from "@gromesh/compiler";
import type { Response } from "express";
import { eq, sql } from "drizzle-orm";
import { stringify } from "yaml";
import { Ctx, RequiredPermission, RequiredRole, type RequestContext } from "../auth/auth.js";
import { audit } from "../audit/audit.js";
import { contracts } from "../common/contract.js";
import { pluginPrivilegedIssues, requirePlatformAdmin } from "../common/privileged.js";
import { unprocessable } from "../common/problem.js";
import { destinationPolicy, type DestinationPolicy } from "../common/destinations.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { ENCRYPTOR, Encryptor } from "../crypto/crypto.js";
import { DB, type Db } from "../db/db.js";
import { consumers, environments } from "../db/schema.js";
import { markDraftChanged, requireEnvironment, uuidParam } from "../environments/environments.js";
import { loadGatewayState, restoreGatewayState, workspaceDefaultRoutes } from "../gateway/gateway.js";
import { admit, conflictLimit, countConflict, lockUnenforcedTables, lockUnique, takenElsewhere, unenforcedKinds, UNIQUE_KINDS } from "../workspaces/instance-uniqueness.js";
import { PluginCatalog, PluginCatalogModule } from "../plugin-catalog/catalog.js";
import { PluginsModule, PluginsService } from "../plugins/plugins.js";
import { redactChanges } from "../snapshots/snapshots.js";
import { emptyReport, ImportBody, ImportBodyPipe, importFailure, type ImportRequest, schemaErrors } from "./document.js";
import { redactImportErrors } from "./redaction.js";
import { type InstanceTaken, planImport } from "./plan.js";

@Injectable()
export class ConfigTransferService {
  private readonly destinations: DestinationPolicy;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENCRYPTOR) private readonly enc: Encryptor,
    private readonly catalog: PluginCatalog,
    private readonly plugins: PluginsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.destinations = destinationPolicy(config);
  }

  async export(envId: string) {
    return this.db.transaction(async tx => {
      await requireEnvironment(tx, envId);
      const state = await loadGatewayState(tx, envId, this.enc, this.catalog);
      return exportConfig(state, (name, config) => this.catalog.redactConfig(name, config));
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  /**
   * A dry run would otherwise be a free oracle for the credentials of other workspaces: an import whose report or
   * failure carries an instance conflict counts against the actor and is audited, like a single write's 409. Imports
   * run one at a time (import_queue) and count inside their own transaction, so each sees the previous one's count:
   * an actor gets at most the limit plus the import already running.
   */
  async import(ctx: RequestContext, envId: string, request: ImportRequest) {
    const outcome = await this.importOnce(ctx, envId, request);
    if ("failure" in outcome) throw importFailure(outcome.failure);
    return outcome.report;
  }

  private async importOnce(ctx: RequestContext, envId: string, request: ImportRequest): Promise<{ report: ReturnType<typeof emptyReport> } | { failure: Parameters<typeof importFailure>[0] }> {
    retry: for (let attempt = 0; ; attempt++) {
      // Kinds without an instance index yet (a legacy repetition blocks them): their tables are locked before the
      // serializable snapshot, so the instance check sees every value committed before it (decision H-5).
      const unenforced = await unenforcedKinds(this.db);
      try {
        return await this.db.transaction(async tx => {
          // First statements, before the snapshot: one import at a time, then the tables of unenforced kinds.
          await tx.execute(sql`lock table import_queue in exclusive mode`);
          await lockUnenforcedTables(tx, unenforced);
          await requireEnvironment(tx, envId, true);
          const current = await loadGatewayState(tx, envId, this.enc, this.catalog);
          const converted = request.sourceFormat === "kong-declarative-3.0" ? convertKongConfig(request.document, request.mode === "merge" ? current : undefined) : null;
          const document = converted?.document ?? request.document as ConfigDocument;
          const errors: { path: string; message: string }[] = [];
          const conversionErrorPaths = new Set(converted?.errors.map(e => e.path));
          if (converted) {
            const checked = structuredClone(document);
            // Legacy Kong keys may be shorter than the new-credential Gromesh API constraint.
            checked.consumers.forEach(c => c.keyAuthCredentials.forEach(k => { if (typeof k.key === "string" && k.key.length > 0 && k.key !== "REDACTED") k.key = k.key.padEnd(16, "_"); }));
            // The converter already diagnosed these secret slots; avoid secondary write-schema errors.
            checked.consumers.forEach((c, i) => c.basicAuthCredentials.forEach((k, j) => {
              const path = converted.sourcePath(`document.consumers.${i}.basicAuthCredentials.${j}.password`);
              if (conversionErrorPaths.has(path)) k.password = "REDACTED";
            }));
            const validate = contracts.validator("GromeshConfigV1");
            if (!validate(checked)) errors.push(...schemaErrors(validate.errors));
          }
          // A malformed converted shape cannot be planned safely, but all converter/schema diagnostics survive.
          const checkedSchema = errors.length > 0;
          const invalidPrehashedPassword = converted && [...converted.identity.prehashedPasswords].some(path => conversionErrorPaths.has(converted.sourcePath(path)));
          let plan: Awaited<ReturnType<typeof planImport>> | undefined;
          if (!checkedSchema && !invalidPrehashedPassword) {
            const workspaceDefault = new Set(await workspaceDefaultRoutes(tx, envId));
            // After the environment's row lock, the order every writer of these values follows.
            await lockUnique(tx, UNIQUE_KINDS);
            await admit(tx, ctx);
            const instanceTaken: InstanceTaken = async (kind, values) => {
              if (kind !== "key-auth-key") return takenElsewhere(tx, kind, envId, values);
              const prints = values.map(v => this.enc.fingerprint(v));
              const taken = await takenElsewhere(tx, kind, envId, prints);
              return new Set(values.filter((_v, i) => taken.has(prints[i]!)));
            };
            plan = await planImport(document, current, request.mode, this.catalog, this.plugins, this.destinations, converted ? {
              identity: converted.identity,
              consumerIdExists: async id => (await tx.select({ id: consumers.id }).from(consumers).where(eq(consumers.id, id)).limit(1)).length > 0,
            } : undefined, workspaceDefault, instanceTaken);
            errors.push(...plan.errors);
            if (plan.instanceConflict) await countConflict(tx, ctx, "import", conflictLimit(this.config));
          }
          const mapped = [...(converted?.errors ?? []), ...errors.map(e => ({ ...e, path: converted?.sourcePath(e.path) ?? e.path }))];
          if (mapped.length) {
            const redacted = checkedSchema ? mapped : redactImportErrors(mapped, document, current, this.catalog);
            if (request.dryRun) return { report: emptyReport(redacted) };
            // Commit the count of a conflict (nothing else was written), then fail.
            return { failure: redacted };
          }
          if (privilegedFingerprint(current) !== privilegedFingerprint(plan!.state)) {
            const uses = document.plugins.flatMap((p, i) => pluginPrivilegedIssues(p, `document.plugins.${i}`));
            requirePlatformAdmin(ctx, (uses.length ? uses : [{ path: "document", message: "removes a plugin reserved to the platform admin" }])
              .map(e => ({ ...e, path: converted?.sourcePath(e.path) ?? e.path })));
          }
          const changes = redactChanges(diffGatewayStates(current, plan!.state), (name, config) => this.catalog.redactConfig(name, config));
          // Each by its path in the source document (a Kong document's, once converted), never with a value.
          const pendingCredentials = plan!.pending.map(p => ({ ...p, path: converted?.sourcePath(p.path) ?? p.path }));
          const report = { added: changes.filter(c => c.change === "added"), modified: changes.filter(c => c.change === "modified"), removed: changes.filter(c => c.change === "removed"), errors: [], pendingCredentials };
          if (!request.dryRun) {
            if (changes.length > 0) {
              await restoreGatewayState(tx, envId, plan!.state, this.enc, this.catalog);
              await markDraftChanged(tx, envId);
              // Changed imported drafts require an explicit publish, including after a restart or on another replica.
              await tx.update(environments).set({ draftRequiresPublish: true, draftPauseReason: "import" }).where(eq(environments.id, envId));
            }
            await audit(tx, ctx, { action: "environment.import", entityType: "environment", entityId: envId, environmentId: envId, after: { mode: request.mode, sourceFormat: request.sourceFormat ?? "gromesh/v1", ...report } });
          }
          return { report };
        }, { isolationLevel: "serializable" });
      } catch (error) {
        let pg: unknown = error;
        for (let i = 0; i < 4 && pg && typeof pg === "object"; i++, pg = "cause" in pg ? pg.cause : undefined) {
          if ("code" in pg) {
            const code = String(pg.code);
            // SSI conflicts can also come from the at-rest key rotator. Re-plan from a fresh snapshot.
            if (["40001", "40P01"].includes(code) && attempt < 3) continue retry;
            // An import into another environment may claim a free UUID after our serializable snapshot.
            if (code === "23505" && "constraint" in pg && pg.constraint === "consumers_pkey" && attempt < 3) continue retry;
            if (["23505", "23503", "40001", "40P01"].includes(code)) throw importFailure([{ path: "document", message: "the resulting draft conflicts with existing or concurrent changes; retry after resolving the conflict" }]);
          }
        }
        throw error;
      }
    }
  }
}

@Controller("environments/:envId")
export class ConfigTransferController {
  constructor(private readonly transfer: ConfigTransferService) {}
  @Get("export")
  @RequiredRole("viewer")
  async export(@Param("envId", uuidParam()) envId: string, @Query("format") format: unknown, @Res() response: Response) {
    if (format !== undefined && format !== "yaml" && format !== "json") throw unprocessable("Invalid export format", [{ path: "format", message: "must be yaml or json" }]);
    const document = await this.transfer.export(envId);
    if (format === "json") response.type("application/json").send(document);
    else response.type("application/yaml").send(stringify(document));
  }
  @Post("import")
  @HttpCode(200)
  @RequiredRole("editor")
  import(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @ImportBody(new ImportBodyPipe()) request: ImportRequest) { return this.transfer.import(ctx, envId, request); }
}
/**
 * control-plane-v2: the v1 export with the environment read as the workspace of the same id. No draft field can hold
 * a VarRef yet (no variable can be declared). Importing waits for the platform-only plugin capabilities (F-1).
 */
@Controller("api/v2/workspaces/:workspaceId")
export class WorkspaceConfigTransferController {
  constructor(private readonly transfer: ConfigTransferService) {}
  @Get("export")
  @RequiredPermission("workspace.read", "workspace")
  async export(@Param("workspaceId", uuidParam()) workspaceId: string, @Query("format") format: unknown, @Res() response: Response) {
    if (format !== undefined && format !== "yaml" && format !== "json") throw unprocessable("Invalid export format", [{ path: "format", message: "must be yaml or json" }]);
    const document = await this.transfer.export(workspaceId);
    if (format === "json") response.type("application/json").send(document);
    else response.type("application/yaml").send(stringify(document));
  }
}
@Module({ imports: [PluginCatalogModule, PluginsModule], controllers: [ConfigTransferController, WorkspaceConfigTransferController], providers: [ConfigTransferService] })
export class ConfigTransferModule {}
