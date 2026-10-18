import { Controller, Get, HttpCode, Inject, Injectable, Module, Param, Post, Query, Res } from "@nestjs/common";
import { convertKongConfig, diffGatewayStates, exportConfig, type ConfigDocument } from "@gromesh/compiler";
import type { Response } from "express";
import { eq } from "drizzle-orm";
import { stringify } from "yaml";
import { Ctx, RequiredRole, type RequestContext } from "../auth/auth.js";
import { audit } from "../audit/audit.js";
import { contracts } from "../common/contract.js";
import { unprocessable } from "../common/problem.js";
import { ENCRYPTOR, Encryptor } from "../crypto/crypto.js";
import { DB, type Db } from "../db/db.js";
import { environments } from "../db/schema.js";
import { markDraftChanged, requireEnvironment, uuidParam } from "../environments/environments.js";
import { loadGatewayState, restoreGatewayState } from "../gateway/gateway.js";
import { PluginCatalog, PluginCatalogModule } from "../plugin-catalog/catalog.js";
import { PluginsModule, PluginsService } from "../plugins/plugins.js";
import { redactChanges } from "../snapshots/snapshots.js";
import { emptyReport, ImportBody, ImportBodyPipe, importFailure, type ImportRequest, schemaErrors } from "./document.js";
import { redactImportErrors } from "./redaction.js";
import { planImport } from "./plan.js";

@Injectable()
export class ConfigTransferService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(ENCRYPTOR) private readonly enc: Encryptor, private readonly catalog: PluginCatalog, private readonly plugins: PluginsService) {}

  async export(envId: string) {
    return this.db.transaction(async tx => {
      await requireEnvironment(tx, envId);
      const state = await loadGatewayState(tx, envId, this.enc, this.catalog);
      return exportConfig(state, (name, config) => this.catalog.redactConfig(name, config));
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async import(ctx: RequestContext, envId: string, request: ImportRequest) {
    retry: for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.transaction(async tx => {
          await requireEnvironment(tx, envId, true);
          const current = await loadGatewayState(tx, envId, this.enc, this.catalog);
          const converted = request.sourceFormat === "kong-declarative-3.0" ? convertKongConfig(request.document, request.mode === "merge" ? current : undefined) : null;
          const document = converted?.document ?? request.document as ConfigDocument;
          const errors: { path: string; message: string }[] = [];
          if (converted) {
            const checked = structuredClone(document);
            // Legacy Kong keys may be shorter than the new-credential Gromesh API constraint.
            checked.consumers.forEach(c => c.keyAuthCredentials.forEach(k => { if (typeof k.key === "string" && k.key.length > 0 && k.key !== "REDACTED") k.key = k.key.padEnd(16, "_"); }));
            const validate = contracts.validator("GromeshConfigV1");
            if (!validate(checked)) errors.push(...schemaErrors(validate.errors));
          }
          // A malformed converted shape cannot be planned safely, but all converter/schema diagnostics survive.
          const checkedSchema = errors.length > 0;
          let plan: Awaited<ReturnType<typeof planImport>> | undefined;
          if (!checkedSchema) { plan = await planImport(document, current, request.mode, this.catalog, this.plugins); errors.push(...plan.errors); }
          const mapped = [...(converted?.errors ?? []), ...errors.map(e => ({ ...e, path: converted?.sourcePath(e.path) ?? e.path }))];
          if (mapped.length) {
            const redacted = checkedSchema ? mapped : redactImportErrors(mapped, document, current, this.catalog);
            if (request.dryRun) return emptyReport(redacted);
            throw importFailure(redacted);
          }
          const changes = redactChanges(diffGatewayStates(current, plan!.state), (name, config) => this.catalog.redactConfig(name, config));
          const report = { added: changes.filter(c => c.change === "added"), modified: changes.filter(c => c.change === "modified"), removed: changes.filter(c => c.change === "removed"), errors: [] };
          if (!request.dryRun) {
            if (changes.length > 0) {
              await restoreGatewayState(tx, envId, plan!.state, this.enc, this.catalog);
              await markDraftChanged(tx, envId);
              // Changed imported drafts require an explicit publish, including after a restart or on another replica.
              await tx.update(environments).set({ draftRequiresPublish: true }).where(eq(environments.id, envId));
            }
            await audit(tx, ctx, { action: "environment.import", entityType: "environment", entityId: envId, environmentId: envId, after: { mode: request.mode, sourceFormat: request.sourceFormat ?? "gromesh/v1", ...report } });
          }
          return report;
        }, { isolationLevel: "serializable" });
      } catch (error) {
        let pg: unknown = error;
        for (let i = 0; i < 4 && pg && typeof pg === "object"; i++, pg = "cause" in pg ? pg.cause : undefined) {
          if ("code" in pg) {
            const code = String(pg.code);
            // SSI conflicts can also come from the at-rest key rotator. Re-plan from a fresh snapshot.
            if (["40001", "40P01"].includes(code) && attempt < 3) continue retry;
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
@Module({ imports: [PluginCatalogModule, PluginsModule], controllers: [ConfigTransferController], providers: [ConfigTransferService] })
export class ConfigTransferModule {}
