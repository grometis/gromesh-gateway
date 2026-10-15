import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from "@nestjs/common";
import {
  buildSnapshot,
  CompileError,
  diffConfigs,
  type EntityChange,
  type GatewayState,
  type KongDeclarativeConfig,
  type SnapshotEnvelope,
} from "@gromesh/compiler";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { PublishRequest } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredRole, type RequestContext, type Role } from "../auth/auth.js";
import { contractBody } from "../common/contract.js";
import { decodeCursor, encodeCursor, parseLimit } from "../common/pagination.js";
import { conflict, notFound, ProblemException, unprocessable } from "../common/problem.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { DB, type Db, type Executor, type Tx } from "../db/db.js";
import { environments, snapshots, type EnvironmentRow, type SnapshotRow } from "../db/schema.js";
import { requireEnvironment, uuidParam } from "../environments/environments.js";
import { loadGatewayState, restoreGatewayState } from "../gateway/gateway.js";
import { KongPusher } from "../kong/kong-pusher.js";
import { PluginCatalog, PluginCatalogModule } from "../plugin-catalog/catalog.js";

type SnapshotSummaryRow = Pick<SnapshotRow, "version" | "hash" | "message" | "createdAt" | "createdBy" | "rollbackOf">;

export function toSnapshotSummary(r: SnapshotSummaryRow, isCurrent: boolean, changeCount?: number) {
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

type RedactPluginConfig = (name: string, config: Record<string, unknown>) => Record<string, unknown>;

/** Credential keys and plugin secrets are only readable by admins (contract: getSnapshot). */
export function maskConfigFor(role: Role, config: KongDeclarativeConfig, redact: RedactPluginConfig = (_n, c) => c): KongDeclarativeConfig {
  if (role === "admin") return config;
  return {
    ...config,
    keyauth_credentials: config.keyauth_credentials.map((c) => ({ ...c, key: "REDACTED" })),
    plugins: config.plugins.map((p) => ({ ...p, config: redact(p.name, p.config) })),
  };
}

/** Diffs never carry plugin secrets (the compiler already redacts credential keys). */
function redactChanges(changes: EntityChange[], redact: RedactPluginConfig): EntityChange[] {
  const plugin = (e: unknown) => {
    if (!e || typeof e !== "object") return e;
    const { name, config } = e as { name?: unknown; config?: unknown };
    return typeof name === "string" && config && typeof config === "object" ? { ...e, config: redact(name, config as Record<string, unknown>) } : e;
  };
  return changes.map((c) => (c.kind === "plugins" ? { ...c, before: plugin(c.before), after: plugin(c.after) } : c));
}

const versionParam = () => new ParseIntPipe({ errorHttpStatusCode: 404 });

/** Auto-publish runs as the platform, not as whoever made the last edit. */
const AUTO_PUBLISH_CTX: RequestContext = {
  actor: { type: "system", id: "00000000-0000-4000-8000-000000000002", name: "auto-publish" },
  ip: null,
  role: "admin",
};

/** Raw SQL: the debounce compares against the database clock, not each replica's. */
const isDue = (delayMs: number) =>
  sql`(${environments.draftChangedAt} is null or ${environments.draftChangedAt} <= now() - ${delayMs} * interval '1 millisecond')`;

/** The draft of an environment compiled as its next version, next to what is published now. */
interface PreparedPublish {
  state: GatewayState;
  envelope: SnapshotEnvelope;
  current: SnapshotRow | undefined;
}

@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger("Snapshots");

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly kong: KongPusher,
    private readonly catalog: PluginCatalog,
  ) {}

  private readonly redact: RedactPluginConfig = (name, config) => this.catalog.redactConfig(name, config);

  /** Compiles the draft into version N+1. The environment row lock serialises concurrent publishes. */
  async publish(ctx: RequestContext, envId: string, body: PublishRequest) {
    const { row, changeCount, envelope } = await this.db.transaction(async (tx) => {
      const env = await requireEnvironment(tx, envId, true);
      if (body.expectedCurrentVersion !== undefined && body.expectedCurrentVersion !== env.currentVersion) {
        throw conflict(`Current version is ${env.currentVersion ?? "none"}, expected ${body.expectedCurrentVersion ?? "none"}`);
      }
      const prepared = await this.prepare(tx, env);
      if (prepared.current?.hash === prepared.envelope.hash) throw conflict("Nothing to publish: the draft equals the current version");
      return this.commit(tx, ctx, env, prepared, { message: body.message ?? null, rollbackOf: null });
    });
    await this.kong.push(envelope);
    return toSnapshotSummary(row, true, changeCount);
  }

  /** Restores the draft to `version` and publishes it as a new version (unpublished edits are discarded). */
  async rollback(ctx: RequestContext, envId: string, version: number) {
    const { row, changeCount, envelope } = await this.db.transaction(async (tx) => {
      const env = await requireEnvironment(tx, envId, true);
      const target = await this.requireSnapshot(tx, envId, version);
      await restoreGatewayState(tx, envId, target.state);
      const prepared = await this.prepare(tx, env);
      if (prepared.current?.hash === prepared.envelope.hash) {
        throw conflict(`Nothing to roll back: version ${version} has the same configuration as the current version`);
      }
      return this.commit(tx, ctx, env, prepared, { message: `Rollback to version ${version}`, rollbackOf: version });
    });
    await this.kong.push(envelope);
    return toSnapshotSummary(row, true, changeCount);
  }

  /**
   * Publishes `envId` if it is in auto mode, has changes and its last edit is older than `delayMs`.
   * SKIP LOCKED: replicas (and manual publishes in flight) never wait on each other; whoever holds the row does the work.
   * Returns false when the draft does not compile, so the caller stops retrying until the next edit.
   */
  async autoPublish(envId: string, delayMs: number): Promise<boolean> {
    let envelope: SnapshotEnvelope | null = null;
    const compiled = await this.db.transaction(async (tx) => {
      const [env] = await tx
        .select()
        .from(environments)
        .where(
          and(
            eq(environments.id, envId),
            eq(environments.publishMode, "auto"),
            eq(environments.hasUnpublishedChanges, true),
            isDue(delayMs),
          ),
        )
        .for("update", { skipLocked: true });
      if (!env) return true;

      let prepared: PreparedPublish;
      try {
        prepared = await this.prepare(tx, env);
      } catch (err) {
        // Only a draft that does not compile is "broken"; anything else (e.g. a dropped connection) must be retried.
        if (!(err instanceof ProblemException) || err.getStatus() !== 422) throw err;
        this.logger.warn(`Auto-publish of environment ${envId} skipped: ${err.message}`);
        return false;
      }
      if (prepared.current?.hash === prepared.envelope.hash) {
        // The edits cancelled out: nothing to publish, and nothing pending either.
        await tx.update(environments).set({ hasUnpublishedChanges: false }).where(eq(environments.id, envId));
        return true;
      }
      ({ envelope } = await this.commit(tx, AUTO_PUBLISH_CTX, env, prepared, { message: "Auto-publish", rollbackOf: null }));
      return true;
    });
    if (envelope) await this.kong.push(envelope).catch((err: unknown) => this.logger.error(String(err)));
    return compiled;
  }

  async preview(envId: string) {
    return this.db.transaction(
      async (tx) => {
        const env = await requireEnvironment(tx, envId);
        const { envelope, current } = await this.prepare(tx, env);
        return {
          currentVersion: env.currentVersion,
          draftHash: envelope.hash,
          hasChanges: current?.hash !== envelope.hash,
          changes: redactChanges(diffConfigs(current?.config ?? null, envelope.config), this.redact),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async list(envId: string, query: Record<string, unknown>) {
    const env = await requireEnvironment(this.db, envId);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const before = cursor ? Number(cursor.k) : null;
    if (cursor && (!Number.isInteger(before) || cursor.id !== envId)) {
      throw unprocessable("Invalid cursor", [{ path: "cursor", message: "is not a valid cursor" }]);
    }
    const rows = await this.db
      .select({
        version: snapshots.version,
        hash: snapshots.hash,
        message: snapshots.message,
        createdAt: snapshots.createdAt,
        createdBy: snapshots.createdBy,
        rollbackOf: snapshots.rollbackOf,
      })
      .from(snapshots)
      .where(and(eq(snapshots.environmentId, envId), before === null ? undefined : lt(snapshots.version, before)))
      .orderBy(desc(snapshots.version))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => toSnapshotSummary(r, r.version === env.currentVersion)),
      nextCursor: rows.length > limit && last ? encodeCursor({ k: String(last.version), id: envId }) : null,
    };
  }

  async get(ctx: RequestContext, envId: string, version: number) {
    await requireEnvironment(this.db, envId);
    const row = await this.requireSnapshot(this.db, envId, version);
    return {
      version: row.version,
      hash: row.hash,
      environmentId: row.environmentId,
      createdAt: row.createdAt.toISOString(),
      config: maskConfigFor(ctx.role, row.config, this.redact),
    };
  }

  async diff(envId: string, version: number, against: unknown) {
    await requireEnvironment(this.db, envId);
    let base: number | null = version > 1 ? version - 1 : null;
    if (against !== undefined) {
      if (typeof against !== "string" || !/^[1-9]\d*$/.test(against)) {
        throw unprocessable("Invalid against", [{ path: "against", message: "must be an integer >= 1" }]);
      }
      base = Number(against);
    }
    const target = await this.requireSnapshot(this.db, envId, version);
    const before = base === null ? null : await this.requireSnapshot(this.db, envId, base);
    return { items: redactChanges(diffConfigs(before?.config ?? null, target.config), this.redact) };
  }

  private async prepare(tx: Executor, env: EnvironmentRow): Promise<PreparedPublish> {
    const state = await loadGatewayState(tx, env.id);
    let envelope: SnapshotEnvelope;
    try {
      envelope = buildSnapshot(state, { version: (env.currentVersion ?? 0) + 1, environmentId: env.id });
    } catch (err) {
      if (err instanceof CompileError) throw unprocessable("The draft cannot be published", err.issues);
      throw err;
    }
    const current = env.currentVersion ? await this.findSnapshot(tx, env.id, env.currentVersion) : undefined;
    return { state, envelope, current };
  }

  private async commit(
    tx: Tx,
    ctx: RequestContext,
    env: EnvironmentRow,
    { state, envelope, current }: PreparedPublish,
    opts: { message: string | null; rollbackOf: number | null },
  ) {
    const [row] = await tx
      .insert(snapshots)
      .values({
        environmentId: env.id,
        version: envelope.version,
        hash: envelope.hash,
        config: envelope.config,
        state,
        message: opts.message,
        createdBy: ctx.actor,
        rollbackOf: opts.rollbackOf,
        createdAt: new Date(envelope.createdAt),
      })
      .returning();
    await tx
      .update(environments)
      .set({ currentVersion: envelope.version, hasUnpublishedChanges: false, updatedAt: sql`now()` })
      .where(eq(environments.id, env.id));
    const changeCount = diffConfigs(current?.config ?? null, envelope.config).length;
    await audit(tx, ctx, {
      action: opts.rollbackOf === null ? "snapshot.publish" : "snapshot.rollback",
      entityType: "snapshot",
      entityId: String(envelope.version),
      environmentId: env.id,
      after: { version: envelope.version, hash: envelope.hash, message: opts.message, rollbackOf: opts.rollbackOf, changeCount },
    });
    // The push to Kong happens after commit: the publish is durable even if Kong is down (the agent catches up later).
    return { row: row!, changeCount, envelope };
  }

  private async findSnapshot(tx: Executor, envId: string, version: number): Promise<SnapshotRow | undefined> {
    const [row] = await tx
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.environmentId, envId), eq(snapshots.version, version)));
    return row;
  }

  private async requireSnapshot(tx: Executor, envId: string, version: number): Promise<SnapshotRow> {
    const row = await this.findSnapshot(tx, envId, version);
    if (!row) throw notFound(`Snapshot version ${version}`);
    return row;
  }
}

/** Per-replica poller for auto-publish environments; the row lock in autoPublish makes it safe to run on every replica. */
@Injectable()
export class AutoPublisher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("AutoPublisher");
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** envId → draftChangedAt of a draft that did not compile; retried only after the next edit. */
  private readonly broken = new Map<string, number>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly snapshotsService: SnapshotsService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.autoPublishPollMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.config.autoPublishPollMs);
    this.timer.unref();
  }

  // onModuleDestroy runs before DbModule ends the pool (onApplicationShutdown).
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = this.publishDue()
      .catch((err: unknown) => this.logger.error(err instanceof Error ? err.stack : String(err)))
      .finally(() => {
        this.running = null;
      });
    await this.running;
  }

  private async publishDue(): Promise<void> {
    const delay = this.config.autoPublishDelayMs;
    const due = await this.db
      .select({ id: environments.id, draftChangedAt: environments.draftChangedAt })
      .from(environments)
      .where(and(eq(environments.publishMode, "auto"), eq(environments.hasUnpublishedChanges, true), isDue(delay)));
    for (const env of due) {
      const editedAt = env.draftChangedAt?.getTime() ?? 0;
      if (this.broken.get(env.id) === editedAt) continue;
      try {
        if (await this.snapshotsService.autoPublish(env.id, delay)) this.broken.delete(env.id);
        else this.broken.set(env.id, editedAt);
      } catch (err) {
        // A transient failure on one environment must not hold back the others; the next tick retries it.
        this.logger.error(err instanceof Error ? err.stack : String(err));
      }
    }
  }
}

@Controller("environments/:envId")
export class SnapshotsController {
  constructor(private readonly snapshotsService: SnapshotsService) {}

  @Get("publish-preview")
  @RequiredRole("viewer")
  preview(@Param("envId", uuidParam()) envId: string) {
    return this.snapshotsService.preview(envId);
  }

  @Get("snapshots")
  @RequiredRole("viewer")
  list(@Param("envId", uuidParam()) envId: string, @Query() query: Record<string, unknown>) {
    return this.snapshotsService.list(envId, query);
  }

  @Post("snapshots")
  @HttpCode(201)
  @RequiredRole("editor")
  publish(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Body(contractBody("PublishRequest")) body: PublishRequest) {
    return this.snapshotsService.publish(ctx, envId, body);
  }

  @Get("snapshots/:version")
  @RequiredRole("viewer")
  get(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Param("version", versionParam()) version: number) {
    return this.snapshotsService.get(ctx, envId, version);
  }

  @Get("snapshots/:version/diff")
  @RequiredRole("viewer")
  diff(@Param("envId", uuidParam()) envId: string, @Param("version", versionParam()) version: number, @Query("against") against: unknown) {
    return this.snapshotsService.diff(envId, version, against);
  }

  @Post("snapshots/:version/rollback")
  @HttpCode(201)
  @RequiredRole("editor")
  rollback(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Param("version", versionParam()) version: number) {
    return this.snapshotsService.rollback(ctx, envId, version);
  }
}

@Module({ imports: [PluginCatalogModule], controllers: [SnapshotsController], providers: [SnapshotsService, AutoPublisher, KongPusher] })
export class SnapshotsModule {}
