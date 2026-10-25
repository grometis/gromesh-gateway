import { Controller, Get, Inject, Module, Param, Query, Req } from "@nestjs/common";
import { and, asc, eq, gt, not, or, sql } from "drizzle-orm";
import { type AuthenticatedRequest, RequiredPermission } from "../auth/auth.js";
import { permissionsIn, tokenPermissions } from "../auth/permissions.js";
import { decodeCursor, parseLimit, toPage } from "../common/pagination.js";
import { notFound } from "../common/problem.js";
import { DB, type Db } from "../db/db.js";
import { environmentRoles, environments, workspaces } from "../db/schema.js";
import { uuidParam } from "../environments/environments.js";
import { backfillWorkspaces } from "./workspaces.js";

type WorkspaceRow = { id: string; key: string; name: string; description: string | null; slug: string | null; status: "active" | "archived" };

/** No release exists before the workspace composition (N2), and none was provisioned by a promotion. */
const toWorkspace = (w: WorkspaceRow) => ({
  id: w.id,
  key: w.key,
  name: w.name,
  ...(w.description !== null ? { description: w.description } : {}),
  slug: w.slug!,
  status: w.status,
  activeRelease: null,
  provisionedByPromotion: null,
});

/**
 * Creating a workspace through v2 waits for N2 (it would join the instance's clusters); v1 keeps creating
 * environments, each its own workspace.
 */
@Controller("api/v2/workspaces")
export class WorkspacesController {
  constructor(@Inject(DB) private readonly db: Db) {}

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

@Module({ controllers: [WorkspacesController] })
export class WorkspacesApiModule {}
