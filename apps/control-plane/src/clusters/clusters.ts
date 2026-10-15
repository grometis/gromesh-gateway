import { createHash, randomBytes } from "node:crypto";
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Post } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredRole, type RequestContext } from "../auth/auth.js";
import { contractBody, inlineBody } from "../common/contract.js";
import { notFound } from "../common/problem.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { clusters, clusterNodes, snapshots, type ClusterRow } from "../db/schema.js";
import { requireEnvironment, uuidParam } from "../environments/environments.js";

export const HEARTBEAT_SECONDS = 15;
export const AGENT_CHANNEL = "gromesh_agent_events";
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

@Injectable()
export class ClustersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async requireCluster(tx: Executor, id: string, lock = false) {
    const query = tx.select().from(clusters).where(eq(clusters.id, id));
    const [row] = lock ? await query.for("update") : await query;
    if (!row) throw notFound("Cluster");
    return row;
  }

  private async present(tx: Executor, cluster: ClusterRow) {
    const env = await requireEnvironment(tx, cluster.environmentId);
    const [current] = env.currentVersion === null
      ? []
      : await tx
          .select({ hash: snapshots.hash })
          .from(snapshots)
          .where(and(eq(snapshots.environmentId, env.id), eq(snapshots.version, env.currentVersion)));
    const rows = await tx
      .select()
      .from(clusterNodes)
      .where(eq(clusterNodes.clusterId, cluster.id))
      .orderBy(asc(clusterNodes.nodeId));
    const nodes = rows.map((n) => ({
      nodeId: n.nodeId,
      hostname: n.hostname,
      kongVersion: n.kongVersion,
      agentVersion: n.agentVersion,
      state: n.state,
      appliedVersion: n.appliedVersion,
      error: n.error,
      kongHealthy: n.kongHealthy,
      lastSeenAt: n.lastSeenAt.toISOString(),
      online: Date.now() - n.lastSeenAt.getTime() <= 3 * HEARTBEAT_SECONDS * 1000,
    }));
    const status = !nodes.length
      ? "no-nodes"
      : nodes.some((n) => !n.online || !n.kongHealthy || n.state === "failed")
        ? "degraded"
        : rows.every((n) => env.currentVersion === null
            ? n.state === "idle"
            : n.state === "applied" && n.appliedVersion === env.currentVersion && n.appliedHash === current?.hash)
          ? "converged"
          : "converging";
    return {
      id: cluster.id,
      environmentId: cluster.environmentId,
      name: cluster.name,
      status,
      nodes,
      createdAt: cluster.createdAt.toISOString(),
    };
  }

  async list(envId: string) {
    return this.db.transaction(
      async (tx) => {
        await requireEnvironment(tx, envId);
        const rows = await tx.select().from(clusters).where(eq(clusters.environmentId, envId)).orderBy(asc(clusters.name));
        return { items: await Promise.all(rows.map((row) => this.present(tx, row))) };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async get(id: string) {
    return this.db.transaction(
      async (tx) => this.present(tx, await this.requireCluster(tx, id)),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async create(ctx: RequestContext, envId: string, body: { name: string }) {
    return this.db.transaction(async (tx) => {
      await requireEnvironment(tx, envId, true);
      const registrationToken = newToken();
      const [row] = await tx
        .insert(clusters)
        .values({
          environmentId: envId,
          name: body.name,
          registrationTokenHash: tokenHash(registrationToken),
        })
        .returning();
      const result = await this.present(tx, row!);
      await audit(tx, ctx, {
        action: "cluster.create",
        entityType: "cluster",
        entityId: row!.id,
        environmentId: envId,
        after: result,
      });
      return { ...result, registrationToken };
    });
  }

  async rotate(ctx: RequestContext, id: string) {
    return this.db.transaction(async (tx) => {
      const row = await this.requireCluster(tx, id, true);
      const registrationToken = newToken();
      await tx.update(clusters).set({ registrationTokenHash: tokenHash(registrationToken) }).where(eq(clusters.id, id));
      await audit(tx, ctx, {
        action: "cluster.rotate-token",
        entityType: "cluster",
        entityId: id,
        environmentId: row.environmentId,
      });
      return { registrationToken };
    });
  }

  async remove(ctx: RequestContext, id: string) {
    await this.db.transaction(async (tx) => {
      const row = await this.requireCluster(tx, id, true);
      await tx.delete(clusters).where(eq(clusters.id, id));
      await audit(tx, ctx, {
        action: "cluster.delete",
        entityType: "cluster",
        entityId: id,
        environmentId: row.environmentId,
        before: { name: row.name },
      });
      await tx.execute(sql`select pg_notify(${AGENT_CHANNEL}, ${JSON.stringify({ clusterId: id })})`);
    });
  }
}

@Controller()
export class ClustersController {
  constructor(private readonly clusters: ClustersService) {}

  @Get("environments/:envId/clusters")
  @RequiredRole("viewer")
  list(@Param("envId", uuidParam()) envId: string) {
    return this.clusters.list(envId);
  }

  @Post("environments/:envId/clusters")
  @RequiredRole("admin")
  create(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Body(contractBody(inlineBody("/environments/{envId}/clusters", "post"))) body: { name: string },
  ) {
    return this.clusters.create(ctx, envId, body);
  }

  @Get("clusters/:clusterId")
  @RequiredRole("viewer")
  get(@Param("clusterId", uuidParam()) id: string) {
    return this.clusters.get(id);
  }

  @Delete("clusters/:clusterId")
  @HttpCode(204)
  @RequiredRole("admin")
  remove(@Ctx() ctx: RequestContext, @Param("clusterId", uuidParam()) id: string) {
    return this.clusters.remove(ctx, id);
  }

  @Post("clusters/:clusterId/rotate-token")
  @HttpCode(200)
  @RequiredRole("admin")
  rotate(@Ctx() ctx: RequestContext, @Param("clusterId", uuidParam()) id: string) {
    return this.clusters.rotate(ctx, id);
  }
}

@Module({ controllers: [ClustersController], providers: [ClustersService] })
export class ClustersModule {}
