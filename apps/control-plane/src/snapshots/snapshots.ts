import { Body, Controller, HttpCode, Inject, Injectable, Module, Param, Post } from "@nestjs/common";
import { buildSnapshot, CompileError, diffConfigs } from "@gromesh/compiler";
import { and, eq, sql } from "drizzle-orm";
import type { PublishRequest } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredRole, type RequestContext } from "../auth/auth.js";
import { contractBody } from "../common/contract.js";
import { conflict, unprocessable } from "../common/problem.js";
import { DB, type Db } from "../db/db.js";
import { environments, snapshots, type SnapshotRow } from "../db/schema.js";
import { requireEnvironment, uuidParam } from "../environments/environments.js";
import { loadGatewayState } from "../gateway/gateway.js";
import { KongPusher } from "../kong/kong-pusher.js";

export function toSnapshotSummary(r: SnapshotRow, isCurrent: boolean, changeCount?: number) {
  return {
    version: r.version,
    hash: r.hash,
    message: r.message,
    createdAt: r.createdAt.toISOString(),
    createdBy: { id: r.createdBy.id, name: r.createdBy.name ?? r.createdBy.id },
    rollbackOf: r.rollbackOf,
    isCurrent,
    ...(changeCount === undefined ? {} : { changeCount }),
  };
}

@Injectable()
export class SnapshotsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly kong: KongPusher,
  ) {}

  /** Compiles the draft into version N+1. The environment row lock serialises concurrent publishes. */
  async publish(ctx: RequestContext, envId: string, body: PublishRequest) {
    const { row, changeCount, envelope } = await this.db.transaction(async (tx) => {
      const env = await requireEnvironment(tx, envId, true);
      if (body.expectedCurrentVersion !== undefined && body.expectedCurrentVersion !== env.currentVersion) {
        throw conflict(`Current version is ${env.currentVersion ?? "none"}, expected ${body.expectedCurrentVersion ?? "none"}`);
      }

      const state = await loadGatewayState(tx, envId);
      const version = (env.currentVersion ?? 0) + 1;
      let envelope;
      try {
        envelope = buildSnapshot(state, { version, environmentId: envId });
      } catch (err) {
        if (err instanceof CompileError) throw unprocessable("The draft cannot be published", err.issues);
        throw err;
      }

      const [current] = env.currentVersion
        ? await tx
            .select()
            .from(snapshots)
            .where(and(eq(snapshots.environmentId, envId), eq(snapshots.version, env.currentVersion)))
        : [];
      if (current && current.hash === envelope.hash) throw conflict("Nothing to publish: the draft equals the current version");

      const [row] = await tx
        .insert(snapshots)
        .values({
          environmentId: envId,
          version,
          hash: envelope.hash,
          config: envelope.config,
          state,
          message: body.message ?? null,
          createdBy: ctx.actor,
          createdAt: new Date(envelope.createdAt),
        })
        .returning();
      await tx
        .update(environments)
        .set({ currentVersion: version, hasUnpublishedChanges: false, updatedAt: sql`now()` })
        .where(eq(environments.id, envId));
      const changeCount = diffConfigs(current?.config ?? null, envelope.config).length;
      await audit(tx, ctx, {
        action: "snapshot.publish",
        entityType: "snapshot",
        entityId: String(version),
        environmentId: envId,
        after: { version, hash: envelope.hash, message: body.message ?? null, changeCount },
      });
      return { row: row!, changeCount, envelope };
    });

    // Outside the transaction: the publish is durable even if Kong is down (the agent will catch up later).
    await this.kong.push(envelope);
    return toSnapshotSummary(row, true, changeCount);
  }
}

@Controller("environments/:envId/snapshots")
export class SnapshotsController {
  constructor(private readonly snapshotsService: SnapshotsService) {}

  // W2-C1: list, get, diff, rollback, publish-preview.

  @Post()
  @HttpCode(201)
  @RequiredRole("editor")
  publish(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Body(contractBody("PublishRequest")) body: PublishRequest) {
    return this.snapshotsService.publish(ctx, envId, body);
  }
}

@Module({ controllers: [SnapshotsController], providers: [SnapshotsService, KongPusher] })
export class SnapshotsModule {}
