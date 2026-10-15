import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Post,
  Req,
  Res,
  SetMetadata,
  UseGuards,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { audit } from "../audit/audit.js";
import { Public, type RequestContext } from "../auth/auth.js";
import { HEARTBEAT_SECONDS, newToken, tokenHash } from "../clusters/clusters.js";
import { ProblemException, unprocessable } from "../common/problem.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { clusterNodes, clusters, environments, snapshots, type SnapshotRow } from "../db/schema.js";
import { PluginCatalog, PluginCatalogModule } from "../plugin-catalog/catalog.js";
import { AgentEvents, type AgentEvent } from "./events.js";
import { agentBody, type RegisterRequest, type StatusReport } from "./protocol.js";
import { redactAgentError } from "./redact-error.js";

const REGISTRATION = "gromesh:registration-bearer";
const unauthorized = () => new ProblemException(401, "Missing, invalid or revoked agent token");

function bearer(req: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization ?? "");
  if (!match) throw unauthorized();
  return match[1]!;
}

function agentContext(req: Request, nodeId: string): RequestContext {
  return {
    actor: { type: "agent", id: nodeId },
    ip: req.ip ?? null,
    role: "viewer",
  };
}

@Injectable()
export class AgentGatewayService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly catalog: PluginCatalog,
  ) {}

  async registration(tx: Executor, token: string, lock = false) {
    const query = tx.select().from(clusters).where(eq(clusters.registrationTokenHash, tokenHash(token)));
    const [cluster] = lock ? await query.for("update") : await query;
    if (!cluster) throw unauthorized();
    return cluster;
  }

  async node(tx: Executor, token: string, lock = false) {
    const query = tx
      .select({ node: clusterNodes, cluster: clusters })
      .from(clusterNodes)
      .innerJoin(clusters, eq(clusters.id, clusterNodes.clusterId))
      .where(eq(clusterNodes.tokenHash, tokenHash(token)));
    const [result] = lock ? await query.for("update") : await query;
    if (!result) throw unauthorized();
    return result;
  }

  async authenticate(req: Request, registration: boolean) {
    const token = bearer(req);
    if (registration) await this.registration(this.db, token);
    else await this.node(this.db, token);
  }

  async register(req: Request, body: RegisterRequest) {
    return this.db.transaction(async (tx) => {
      const cluster = await this.registration(tx, bearer(req), true);
      const nodeToken = newToken();
      // The identity remains stable on re-registration; a fresh secret replaces the old node token.
      await tx
        .insert(clusterNodes)
        .values({
          clusterId: cluster.id,
          nodeId: body.nodeId,
          hostname: body.hostname,
          kongVersion: body.kongVersion,
          agentVersion: body.agentVersion,
          labels: body.labels ?? {},
          tokenHash: tokenHash(nodeToken),
        })
        .onConflictDoUpdate({
          target: [clusterNodes.clusterId, clusterNodes.nodeId],
          set: {
            hostname: body.hostname,
            kongVersion: body.kongVersion,
            agentVersion: body.agentVersion,
            labels: body.labels ?? {},
            tokenHash: tokenHash(nodeToken),
            lastSeenAt: sql`now()`,
          },
        });
      await audit(tx, agentContext(req, body.nodeId), {
        action: "agent.register",
        entityType: "node",
        entityId: body.nodeId,
        environmentId: cluster.environmentId,
        after: { clusterId: cluster.id },
      });
      return {
        nodeToken,
        clusterId: cluster.id,
        environmentId: cluster.environmentId,
        pollIntervalSeconds: 30,
        heartbeatIntervalSeconds: HEARTBEAT_SECONDS,
      };
    });
  }

  async current(req: Request, res: Response) {
    const { cluster } = await this.node(this.db, bearer(req));
    const [snapshot] = await this.db
      .select({ snapshot: snapshots })
      .from(snapshots)
      .innerJoin(environments, and(eq(environments.id, snapshots.environmentId), eq(environments.currentVersion, snapshots.version)))
      .where(eq(snapshots.environmentId, cluster.environmentId));
    if (!snapshot) {
      res.status(204).end();
      return;
    }
    const row = snapshot.snapshot;
    res.setHeader("ETag", row.hash);
    res.setHeader("Cache-Control", "private, no-cache");
    const tags = (req.headers["if-none-match"] ?? "")
      .split(",")
      .map((tag) => tag.trim().replace(/^W\//, "").replace(/^"|"$/g, ""));
    if (tags.includes(row.hash) || tags.includes("*")) {
      res.status(304).end();
      return;
    }
    res.json({
      environmentId: row.environmentId,
      version: row.version,
      hash: row.hash,
      createdAt: row.createdAt.toISOString(),
      config: row.config,
    });
  }

  async report(req: Request, body: StatusReport) {
    await this.db.transaction(async (tx) => {
      const token = bearer(req);
      const { cluster, node } = await this.node(tx, token, true);
      if (body.nodeId !== node.nodeId) {
        throw unprocessable("Node identity does not match token", [{ path: "nodeId", message: "must match the registered node" }]);
      }
      const error = await this.redactError(tx, cluster.environmentId, body, token, cluster.registrationTokenHash);
      const appliedVersion = body.appliedVersion ?? null;
      const failedVersion = body.failedVersion ?? null;
      const changed =
        node.state !== body.state ||
        node.appliedVersion !== appliedVersion ||
        node.failedVersion !== failedVersion ||
        node.kongHealthy !== body.kongHealthy;
      await tx
        .update(clusterNodes)
        .set({
          state: body.state,
          appliedVersion,
          appliedHash: body.appliedHash ?? null,
          failedVersion,
          error,
          kongHealthy: body.kongHealthy,
          reportedAt: new Date(body.reportedAt),
          lastSeenAt: sql`now()`,
        })
        .where(and(eq(clusterNodes.clusterId, cluster.id), eq(clusterNodes.nodeId, node.nodeId)));
      if (changed) {
        await audit(tx, agentContext(req, node.nodeId), {
          action: "agent.status",
          entityType: "node",
          entityId: node.nodeId,
          environmentId: cluster.environmentId,
          after: {
            clusterId: cluster.id,
            state: body.state,
            appliedVersion,
            failedVersion,
            kongHealthy: body.kongHealthy,
            error,
          },
        });
      }
    });
  }

  private async redactError(
    tx: Executor,
    envId: string,
    body: StatusReport,
    nodeToken: string,
    registrationTokenHash: string,
  ): Promise<string | null> {
    if (body.error == null) return null;
    let snapshot: Pick<SnapshotRow, "state"> | undefined;
    if (body.failedVersion != null) {
      [snapshot] = await tx
        .select({ state: snapshots.state })
        .from(snapshots)
        .where(and(eq(snapshots.environmentId, envId), eq(snapshots.version, body.failedVersion)));
    }
    if (!snapshot) {
      [snapshot] = await tx
        .select({ state: snapshots.state })
        .from(snapshots)
        .innerJoin(environments, and(eq(environments.id, snapshots.environmentId), eq(environments.currentVersion, snapshots.version)))
        .where(eq(snapshots.environmentId, envId));
    }
    return redactAgentError(body.error, snapshot?.state, this.catalog, nodeToken, registrationTokenHash);
  }

  async stream(req: Request, res: Response, events: AgentEvents) {
    const token = bearer(req);
    const { cluster } = await this.node(this.db, token);
    const lastId = req.headers["last-event-id"];
    let sentVersion = typeof lastId === "string" && /^\d+$/.test(lastId) && Number.isSafeInteger(Number(lastId)) ? Number(lastId) : 0;
    let closed = false;
    let queue = Promise.resolve();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      unsubscribe();
      res.end();
    };
    const catchup = async () => {
      if (closed) return;
      await this.node(this.db, token);
      const rows = await this.db
        .select({ version: snapshots.version, hash: snapshots.hash })
        .from(snapshots)
        .where(and(eq(snapshots.environmentId, cluster.environmentId), gt(snapshots.version, sentVersion)))
        .orderBy(asc(snapshots.version));
      for (const row of rows) {
        if (closed) return;
        // Bound buffering when a client stops reading; it reconnects with Last-Event-ID.
        if (res.writableLength > 64 * 1024) {
          close();
          return;
        }
        res.write(`id: ${row.version}\nevent: snapshot.published\ndata: ${JSON.stringify(row)}\n\n`);
        sentVersion = row.version;
      }
    };
    const enqueue = (work: () => Promise<void>) => {
      queue = queue.then(work).catch(close);
    };
    const unsubscribe = events.subscribe((event: AgentEvent) => {
      if ("shutdown" in event || ("clusterId" in event && event.clusterId === cluster.id)) {
        close();
        return;
      }
      if ("catchup" in event || ("environmentId" in event && event.environmentId === cluster.environmentId)) enqueue(catchup);
    });
    const timer = setInterval(() => {
      enqueue(async () => {
        await this.node(this.db, token);
        if (!closed) res.write("event: ping\n\n");
      });
    }, 15_000);
    timer.unref();
    req.on("close", close);
    res.on("error", close);
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("event: ping\n\n");
    enqueue(catchup);
  }
}

@Injectable()
export class AgentBearerGuard implements CanActivate {
  constructor(
    private readonly gateway: AgentGatewayService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    await this.gateway.authenticate(
      context.switchToHttp().getRequest<Request>(),
      this.reflector.get<boolean>(REGISTRATION, context.getHandler()) === true,
    );
    return true;
  }
}

@Controller("agent/v1")
@UseGuards(AgentBearerGuard)
export class AgentGatewayController {
  constructor(
    private readonly gateway: AgentGatewayService,
    private readonly events: AgentEvents,
  ) {}

  // Public skips user RBAC; AgentBearerGuard enforces the separate agent protocol bearer scheme on EVERY handler.
  @Post("register")
  @HttpCode(200)
  @Public()
  @SetMetadata(REGISTRATION, true)
  register(@Req() req: Request, @Body(agentBody("RegisterRequest")) body: RegisterRequest) {
    return this.gateway.register(req, body);
  }

  @Get("snapshots/current")
  @Public()
  current(@Req() req: Request, @Res() res: Response) {
    return this.gateway.current(req, res);
  }

  @Post("status")
  @HttpCode(204)
  @Public()
  report(@Req() req: Request, @Body(agentBody("StatusReport")) body: StatusReport) {
    return this.gateway.report(req, body);
  }

  @Get("events")
  @Public()
  stream(@Req() req: Request, @Res() res: Response) {
    return this.gateway.stream(req, res, this.events);
  }
}

@Module({
  imports: [PluginCatalogModule],
  controllers: [AgentGatewayController],
  providers: [AgentGatewayService, AgentBearerGuard, AgentEvents],
})
export class AgentGatewayModule {}
