import { Body, Controller, Get, HttpCode, Inject, Module, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { and, asc, eq, gt, not, or, sql } from "drizzle-orm";
import { ArchivedAllowed, type AuthenticatedRequest, Ctx, RequiredPermission, type RequestContext, SessionOnly } from "../auth/auth.js";
import { permissionsIn, tokenPermissions } from "../auth/permissions.js";
import { contractBodyV2, inlineBody } from "../common/contract.js";
import { decodeCursor, parseLimit, toPage } from "../common/pagination.js";
import { notFound } from "../common/problem.js";
import { DB, type Db } from "../db/db.js";
import { environmentRoles, environments, workspaces } from "../db/schema.js";
import { uuidParam } from "../environments/environments.js";
import { type CreationPolicyWrite, toWorkspace, WorkspaceAdminService, type WorkspaceUpdate, type WorkspaceWrite } from "./workspace-admin.js";
import { backfillWorkspaces } from "./workspaces.js";


/**
 * Creating a workspace through v2 is refused while Workspaces mode is disabled (the N2 block, WS-M0: only disposable
 * labs enable it); v1 keeps creating environments, each its own workspace.
 */
@Controller("api/v2/workspaces")
export class WorkspacesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly admin: WorkspaceAdminService,
  ) {}

  @Post()
  @RequiredPermission("workspace.create", "instance")
  create(@Ctx() ctx: RequestContext, @Req() req: AuthenticatedRequest, @Body(contractBodyV2("WorkspaceWrite")) body: WorkspaceWrite) {
    return this.admin.create(ctx, req.auth!.permissions, body);
  }

  @Patch(":workspaceId")
  @RequiredPermission("workspace.admin", "workspace")
  update(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string, @Body(contractBodyV2(inlineBody("/workspaces/{workspaceId}", "patch"))) body: WorkspaceUpdate) {
    return this.admin.update(ctx, workspaceId, body);
  }

  @Post(":workspaceId/archive")
  @HttpCode(204)
  @ArchivedAllowed()
  @RequiredPermission("platform.admin", "workspace")
  async archive(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string) {
    await this.admin.archive(ctx, workspaceId);
  }

  private select() {
    return this.db
      .select({ id: workspaces.id, key: workspaces.key, name: environments.name, description: environments.description, slug: workspaces.slug, status: workspaces.status })
      .from(workspaces)
      .innerJoin(environments, eq(environments.id, workspaces.id));
  }

  /**
   * Only the workspaces the caller may read there (a token: within its own role). The query leaves out the only
   * thing that hides a workspace from someone who reads the instance (an environment role none, for anyone but a
   * global admin), so the work follows the page; permissionsIn still decides each one shown.
   */
  @Get()
  @RequiredPermission("workspace.read", "instance")
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    // Every workspace has its slug before it is shown (an older replica may have created one without it).
    await this.db.transaction((tx) => backfillWorkspaces(tx));
    const user = req.user!;
    const limit = parseLimit(query.limit);
    const c = decodeCursor(query.cursor);
    const hidden = sql`exists (select 1 from ${environmentRoles} where ${environmentRoles.userId} = ${user.id} and ${environmentRoles.environmentId} = ${workspaces.id} and ${environmentRoles.role} = 'none')`;
    const rows = await this.select()
      .where(
        and(
          user.role === "admin" ? undefined : not(hidden),
          c ? or(gt(environments.name, c.k), and(eq(environments.name, c.k), gt(workspaces.id, c.id))) : undefined,
        ),
      )
      .orderBy(asc(environments.name), asc(workspaces.id))
      .limit(limit + 1);
    // The cursor follows the query; a row it let through but the decision hides only shortens the page.
    const { items, nextCursor } = toPage(rows, limit, (w) => w.name, (w) => w);
    const shown: ReturnType<typeof toWorkspace>[] = [];
    for (const row of items) if (await this.readable(req, row.id)) shown.push(toWorkspace(row));
    return { items: shown, nextCursor };
  }

  @Get(":workspaceId")
  @RequiredPermission("workspace.read", "workspace")
  async get(@Param("workspaceId", uuidParam()) workspaceId: string) {
    await this.db.transaction((tx) => backfillWorkspaces(tx));
    const [row] = await this.select().where(eq(workspaces.id, workspaceId));
    if (!row) throw notFound("Workspace");
    return toWorkspace(row);
  }

  private async readable(req: AuthenticatedRequest, workspaceId: string): Promise<boolean> {
    const owner = await permissionsIn(this.db, req.user!, { type: "workspace", workspaceId });
    const held = req.auth?.via === "token" ? tokenPermissions(req.auth.tokenRole, owner) : owner;
    return held.has("workspace.read");
  }
}

/** The instance's creation policy (WS-M0). */
@Controller("api/v2/workspace-creation-policy")
export class WorkspaceCreationPolicyController {
  constructor(private readonly admin: WorkspaceAdminService) {}

  @Get()
  @RequiredPermission("workspace.read", "instance")
  get(@Req() req: AuthenticatedRequest) {
    return this.admin.policyFor(req.auth!.permissions);
  }

  @Put()
  @RequiredPermission("platform.admin", "instance")
  @SessionOnly()
  set(@Ctx() ctx: RequestContext, @Req() req: AuthenticatedRequest, @Body(contractBodyV2("WorkspaceCreationPolicyWrite")) body: CreationPolicyWrite) {
    return this.admin.setPolicy(ctx, req.auth!.permissions, body);
  }
}

@Module({ controllers: [WorkspacesController, WorkspaceCreationPolicyController], providers: [WorkspaceAdminService] })
export class WorkspacesApiModule {}
