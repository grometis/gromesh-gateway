import { createPrivateKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Put } from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredPermission, type RequestContext } from "../auth/auth.js";
import { contractBodyV2, inlineBody } from "../common/contract.js";
import { notFound, unprocessable } from "../common/problem.js";
import { ENCRYPTOR, Encryptor, variableValueContext } from "../crypto/crypto.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { workspaceVariables, workspaceVariableValues, type WorkspaceVariableRow } from "../db/schema.js";
import { markDraftChanged, requireEnvironment, uuidParam } from "../environments/environments.js";

/** contracts/control-plane-v2.openapi.yaml#/components/schemas/WorkspaceVariableDeclaration */
interface Declaration {
  name?: string;
  type: WorkspaceVariableRow["type"];
  secret: boolean;
  required: boolean;
  validation?: { pattern?: string; minimum?: number; maximum?: number; maxLength?: number };
}

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const REDACTED = "REDACTED";
const nameParam = () => ({
  transform(value: unknown) {
    if (typeof value !== "string" || !NAME.test(value)) throw notFound("Variable");
    return value;
  },
});

const MAX_VALUE = 16_384;

/**
 * A declared pattern runs on the server: no group that is itself quantified and holds a quantifier (the shape of
 * catastrophic backtracking, e.g. (a+)+), no backreference, and values of bounded length.
 */
function patternProblem(pattern: string): string | null {
  try {
    new RegExp(pattern, "u");
  } catch {
    return "is not a valid regular expression";
  }
  if (/\\[1-9k]/.test(pattern)) return "backreferences are not allowed";
  if (/\([^()]*[+*{][^()]*\)\s*[+*{]/.test(pattern) || /\([^()]*\|[^()]*\)\s*[+*{]/.test(pattern)) return "a quantified group holding a quantifier or an alternative is not allowed";
  return null;
}

/** Why a value does not fit its declaration (its type, then the declared validation), or null. */
function valueProblem(d: Pick<Declaration, "type" | "secret" | "validation">, value: string): string | null {
  if (value.length > MAX_VALUE) return `must have at most ${MAX_VALUE} characters`;
  // An empty sealed value cannot be opened again (nor re-sealed by a key rotation): a secret has content.
  if (value.length === 0 && (d.type !== "string" || d.secret)) return "must not be empty";
  switch (d.type) {
    case "port": {
      if (!/^[0-9]{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) return "must be a port, 1 to 65535";
      break;
    }
    case "host": {
      const bracketed = /^\[(.*)\]$/.exec(value)?.[1];
      const ok = bracketed !== undefined ? isIP(bracketed) === 6 : isIP(value) !== 0 || (value.length <= 253 && /^[A-Za-z0-9]([A-Za-z0-9-]{0,62})?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62})?)*\.?$/.test(value));
      if (!ok) return "must be a host name or an IP address";
      break;
    }
    case "url": {
      let url: URL | null = null;
      try {
        url = new URL(value);
      } catch {}
      if (!url || !["http:", "https:"].includes(url.protocol)) return "must be an http or https URL";
      break;
    }
    case "certificate":
      try {
        new X509Certificate(value);
      } catch {
        return "must be a PEM certificate";
      }
      break;
    case "privateKey":
      try {
        createPrivateKey(value);
      } catch {
        return "must be a PEM private key";
      }
      break;
  }
  if (d.validation?.maxLength !== undefined && [...value].length > d.validation.maxLength) return `must have at most ${d.validation.maxLength} characters`;
  if (d.validation?.minimum !== undefined && !(Number.isFinite(Number(value)) && Number(value) >= d.validation.minimum)) return `must be at least ${d.validation.minimum}`;
  if (d.validation?.maximum !== undefined && !(Number.isFinite(Number(value)) && Number(value) <= d.validation.maximum)) return `must be at most ${d.validation.maximum}`;
  if (d.validation?.pattern !== undefined && !new RegExp(`^(?:${d.validation.pattern})$`, "u").test(value)) return "does not match the declared pattern";
  return null;
}

/** A declaration as audited: never its value. */
const declared = (d: WorkspaceVariableRow) => ({ name: d.name, type: d.type, secret: d.secret, required: d.required, ...(d.validation ? { validation: d.validation } : {}) });

@Injectable()
export class WorkspaceVariablesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENCRYPTOR) private readonly enc: Encryptor,
  ) {}

  private async current(tx: Executor, workspaceId: string, name: string) {
    const [row] = await tx
      .select()
      .from(workspaceVariableValues)
      .where(and(eq(workspaceVariableValues.workspaceId, workspaceId), eq(workspaceVariableValues.name, name)))
      .orderBy(desc(workspaceVariableValues.version))
      .limit(1);
    return row;
  }

  private async present(tx: Executor, d: WorkspaceVariableRow) {
    const value = await this.current(tx, d.workspaceId, d.name);
    return {
      name: d.name,
      type: d.type,
      secret: d.secret,
      required: d.required,
      hasValue: value !== undefined,
      // A secret never reads back; nor does a value stored sealed (secret when set), even after the flag went off.
      value: value === undefined ? null : d.secret || value.sealed ? REDACTED : value.value,
      ...(d.validation ? { validation: d.validation } : {}),
    };
  }

  async list(workspaceId: string) {
    const rows = await this.db.select().from(workspaceVariables).where(eq(workspaceVariables.workspaceId, workspaceId)).orderBy(asc(workspaceVariables.name));
    return Promise.all(rows.map((d) => this.present(this.db, d)));
  }

  /**
   * declareWorkspaceVariable: creates or replaces the declaration in the draft. Changing type or secret of a variable
   * the draft references answers 409; no field can reference one yet (a VarRef is still refused), so it never does.
   * Turning secret on or off re-stores the values this instance holds (sealed or not), never exposing one.
   */
  async declare(ctx: RequestContext, workspaceId: string, name: string, body: Declaration) {
    if (body.name !== undefined && body.name !== name) throw unprocessable("Invalid declaration", [{ path: "name", message: "must equal the name in the path" }]);
    const badPattern = body.validation?.pattern !== undefined ? patternProblem(body.validation.pattern) : null;
    if (badPattern) throw unprocessable("Invalid declaration", [{ path: "validation.pattern", message: badPattern }]);
    return this.db.transaction(async (tx) => {
      await requireEnvironment(tx, workspaceId, true);
      const [before] = await tx.select().from(workspaceVariables).where(and(eq(workspaceVariables.workspaceId, workspaceId), eq(workspaceVariables.name, name))).for("update");
      const values = { type: body.type, secret: body.secret, required: body.required, validation: body.validation ?? null };
      const [row] = before
        ? await tx.update(workspaceVariables).set({ ...values, updatedAt: sql`now()` }).where(and(eq(workspaceVariables.workspaceId, workspaceId), eq(workspaceVariables.name, name))).returning()
        : await tx.insert(workspaceVariables).values({ workspaceId, name, ...values }).returning();
      // Values kept from before (a replaced or a deleted and declared again variable): a secret one seals them.
      if (body.secret) await this.sealStored(tx, workspaceId, name);
      await markDraftChanged(tx, workspaceId);
      // A declaration's audit never carries a value: one that stops being secret would otherwise land there in clear.
      await audit(tx, ctx, { action: before ? "workspace_variable.update" : "workspace_variable.declare", entityType: "workspace_variable", entityId: name, environmentId: workspaceId, ...(before ? { before: declared(before) } : {}), after: declared(row!) });
      return this.present(tx, row!);
    });
  }

  /**
   * Seals every stored value of the variable still in clear (same rows, same versions). Never the reverse: turning
   * secret off needs only gateway.write and must not reveal a value, so a sealed one stays sealed (and REDACTED).
   */
  private async sealStored(tx: Executor, workspaceId: string, name: string) {
    const rows = await tx.select().from(workspaceVariableValues).where(and(eq(workspaceVariableValues.workspaceId, workspaceId), eq(workspaceVariableValues.name, name), eq(workspaceVariableValues.sealed, false)));
    for (const r of rows) {
      const value = this.enc.seal(r.value, variableValueContext(workspaceId, name, r.version));
      await tx.update(workspaceVariableValues).set({ value, sealed: true }).where(and(eq(workspaceVariableValues.workspaceId, workspaceId), eq(workspaceVariableValues.name, name), eq(workspaceVariableValues.version, r.version)));
    }
  }

  /** deleteWorkspaceVariable: the declaration only; this instance's values stay until a release without it is active. */
  async remove(ctx: RequestContext, workspaceId: string, name: string) {
    await this.db.transaction(async (tx) => {
      await requireEnvironment(tx, workspaceId, true);
      const [before] = await tx.delete(workspaceVariables).where(and(eq(workspaceVariables.workspaceId, workspaceId), eq(workspaceVariables.name, name))).returning();
      if (!before) throw notFound("Variable");
      await markDraftChanged(tx, workspaceId);
      await audit(tx, ctx, { action: "workspace_variable.delete", entityType: "workspace_variable", entityId: name, environmentId: workspaceId, before: declared(before) });
    });
  }

  /**
   * setWorkspaceValue: a new version of this instance's value, checked against the declaration. A secret one is
   * sealed and the audit records only that it changed (REDACTED); a plain one is audited as written.
   */
  async setValue(ctx: RequestContext, workspaceId: string, name: string, value: string) {
    await this.db.transaction(async (tx) => {
      // The environment first, the order every writer of the workspace takes.
      await requireEnvironment(tx, workspaceId, true);
      const [d] = await tx.select().from(workspaceVariables).where(and(eq(workspaceVariables.workspaceId, workspaceId), eq(workspaceVariables.name, name))).for("share");
      if (!d) throw notFound("Variable");
      const problem = valueProblem(d as Declaration, value);
      if (problem) throw unprocessable("Invalid value", [{ path: "value", message: problem }]);
      const version = ((await this.current(tx, workspaceId, name))?.version ?? 0) + 1;
      const stored = d.secret ? this.enc.seal(value, variableValueContext(workspaceId, name, version)) : value;
      await tx.insert(workspaceVariableValues).values({ workspaceId, name, version, value: stored, sealed: d.secret, setBy: ctx.actor.id });
      await audit(tx, ctx, { action: "workspace_variable.value.set", entityType: "workspace_variable", entityId: name, environmentId: workspaceId, after: { name, version, value: d.secret ? REDACTED : value } });
    });
  }
}

/** control-plane-v2: workspace variables and this instance's values (GW-ENV-05). */
@Controller("api/v2/workspaces/:workspaceId/variables")
export class WorkspaceVariablesController {
  constructor(private readonly vars: WorkspaceVariablesService) {}

  @Get()
  @RequiredPermission("workspace.read", "workspace")
  list(@Param("workspaceId", uuidParam()) workspaceId: string) {
    return this.vars.list(workspaceId);
  }

  @Put(":name")
  @RequiredPermission("gateway.write", "workspace")
  declare(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string, @Param("name", nameParam()) name: string, @Body(contractBodyV2("WorkspaceVariableDeclaration")) body: Declaration) {
    return this.vars.declare(ctx, workspaceId, name, body);
  }

  @Delete(":name")
  @HttpCode(204)
  @RequiredPermission("gateway.write", "workspace")
  async remove(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string, @Param("name", nameParam()) name: string) {
    await this.vars.remove(ctx, workspaceId, name);
  }

  @Put(":name/value")
  @HttpCode(204)
  @RequiredPermission("values.write", "workspace")
  async setValue(
    @Ctx() ctx: RequestContext,
    @Param("workspaceId", uuidParam()) workspaceId: string,
    @Param("name", nameParam()) name: string,
    @Body(contractBodyV2(inlineBody("/workspaces/{workspaceId}/variables/{name}/value", "put"))) body: { value: string },
  ) {
    await this.vars.setValue(ctx, workspaceId, name, body.value);
  }
}

@Module({ controllers: [WorkspaceVariablesController], providers: [WorkspaceVariablesService] })
export class WorkspaceVariablesModule {}
