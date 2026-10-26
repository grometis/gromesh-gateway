import { Controller, Get, Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { API_V1_USAGE, type ApiV1UsageRecorder, RequiredPermission } from "../auth/auth.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { ENCRYPTOR, type Encryptor } from "../crypto/crypto.js";
import { BEFORE_POOL_END, DB, type Db, type Executor } from "../db/db.js";
import { apiV1Usage, apiV1UsageReplicas } from "../db/schema.js";
import { migrationReport } from "../workspaces/migration-report.js";

const WINDOW_DAYS = 30;
/**
 * How long a replica's counting may go unconfirmed: a gap after a replica's last confirmation shorter than this (a
 * restart) is not a gap, a replica silent for longer without stopping cleanly may have lost a call, and the report
 * claims completeness only up to this long ago.
 */
export const CONFIRM_MS = 120_000;
const today = sql`(now() at time zone 'utc')::date`;
/** The UTC day of a call, taken when it is made (a session call written after midnight keeps its day). */
const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * The calls to the v1 operations the controlled migration will cut (decision H-9). The counting never touches a
 * request: a call is added up here, in memory, and written every few seconds with the confirmation of this replica's
 * counting, in one transaction. No call counted proves nothing about a time nobody was counting: each replica keeps
 * a row from its start, confirmed up to the moment its counts were taken (never past a token call still being
 * authenticated) and closed only when it stops cleanly, once its HTTP server takes no more calls and every count is
 * written. Counts that cannot be written stay here and the confirmation does not move: a replica that went silent
 * without closing may hold calls nobody knows of, so no day from its last confirmation on is complete, its row is
 * never pruned, and the report lists it.
 */
@Injectable()
export class ApiV1UsageService implements ApiV1UsageRecorder, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("ApiV1Usage");
  private readonly replicaId = randomUUID();
  private readonly startedAt = new Date();
  /** Calls not written yet, by UTC day and token (token null: sessions, the UI). */
  private pending = new Map<string, { day: string; token: { id: string; name: string; ownerId: string } | null; calls: number }>();
  /** When each admitted token call (being authenticated) was admitted. */
  private readonly inFlight = new Map<symbol, number>();
  /** The confirmations, one at a time. */
  private confirming: Promise<void> = Promise.resolve();
  private busy = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BEFORE_POOL_END) beforePoolEnd: (() => Promise<void>)[],
  ) {
    beforePoolEnd.push(() => this.close());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.confirm();
    if (this.config.apiV1UsageFlushMs <= 0) return;
    this.timer = setInterval(() => {
      // A flush still waiting for the database is not queued behind by another.
      if (this.busy) return;
      this.busy = true;
      void this.flush()
        .catch((err: unknown) => this.logger.error(`v1 usage not written (the counting stays unconfirmed): ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => (this.busy = false));
    }, this.config.apiV1UsageFlushMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * After the HTTP server stopped (no call is admitted any more), before the pool ends: the admitted calls finish
   * first (a few seconds at most), then everything counted is written and the row closed, in one transaction; if
   * that fails the row stays open and its silence counts as a possible loss.
   */
  async close(): Promise<void> {
    for (let i = 0; i < 100 && this.inFlight.size > 0; i++) await new Promise((r) => setTimeout(r, 50));
    try {
      await this.confirm(this.inFlight.size === 0);
    } catch (error) {
      this.logger.error(`v1 usage row left open (silent): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  begin(): symbol {
    const call = Symbol();
    this.inFlight.set(call, Date.now());
    return call;
  }

  end(call: symbol): void {
    this.inFlight.delete(call);
  }

  /** In memory only: a request never waits for the database here. */
  record(token: { id: string; name: string; ownerId: string } | null): void {
    const day = utcDay();
    const key = `${day}|${token?.id ?? ""}`;
    const entry = this.pending.get(key);
    if (entry) {
      entry.calls++;
      entry.token = token;
    } else this.pending.set(key, { day, token, calls: 1 });
  }

  /**
   * Writes the calls counted so far and confirms the counting up to when they were taken (never past an admitted
   * call), in one transaction, after any confirmation still being written; `close` marks a clean stop. On failure the
   * counts are kept for the next one and the confirmation does not move.
   */
  private confirm(close = false): Promise<void> {
    const run = this.confirming.then(async () => {
      // The moment first, then the counts: a call admitted before it is either in them or still admitted.
      const seenAt = new Date(Math.min(Date.now(), ...this.inFlight.values()));
      const taken = this.pending;
      this.pending = new Map();
      try {
        await this.db.transaction(async (tx) => {
          for (const { day, token, calls } of taken.values()) await this.add(day, token, calls, tx);
          await tx
            .insert(apiV1UsageReplicas)
            .values({ replicaId: this.replicaId, startedAt: this.startedAt, seenAt, closed: close })
            .onConflictDoUpdate({ target: apiV1UsageReplicas.replicaId, set: { seenAt: sql`greatest(${apiV1UsageReplicas.seenAt}, excluded.seen_at)`, closed: sql`excluded.closed` } });
        });
      } catch (error) {
        for (const [key, entry] of taken) {
          const later = this.pending.get(key);
          this.pending.set(key, later ? { ...later, calls: later.calls + entry.calls } : entry);
        }
        throw error;
      }
    });
    this.confirming = run.catch(() => undefined);
    return run;
  }

  /** Writes and confirms, and drops what is out of the window. */
  async flush(): Promise<void> {
    await this.confirm();
    await this.db.delete(apiV1Usage).where(lt(apiV1Usage.day, sql`${today} - ${WINDOW_DAYS - 1}::int`));
    // An open row that went silent is never pruned: nothing proves that replica stopped taking calls.
    const windowStart = sql`(${today} - ${WINDOW_DAYS - 1}::int)::timestamp at time zone 'utc'`;
    await this.db.delete(apiV1UsageReplicas).where(and(lt(apiV1UsageReplicas.seenAt, windowStart), eq(apiV1UsageReplicas.closed, true)));
  }

  private async add(day: string, token: { id: string; name: string; ownerId: string } | null, calls: number, db: Executor): Promise<void> {
    await db
      .insert(apiV1Usage)
      .values({ day, tokenId: token?.id ?? null, tokenName: token?.name ?? null, ownerId: token?.ownerId ?? null, calls })
      .onConflictDoUpdate({ target: [apiV1Usage.day, apiV1Usage.tokenId], set: { calls: sql`${apiV1Usage.calls} + excluded.calls`, tokenName: sql`excluded.token_name` } });
  }

  /** contract: ApiV1Usage. The window is the last 30 UTC days, today included. */
  async read() {
    await this.flush();
    const since = sql`${today} - ${WINDOW_DAYS - 1}::int`;
    const margin = sql`make_interval(secs => ${CONFIRM_MS / 1000})`;
    // A day is complete when the replicas' rows, each extended by the margin past its last confirmation, cover it from
    // its start (to now less the margin, for today), no call failed on it and no replica that went silent without
    // closing could have lost one on it (from its last confirmation through today). The report's since is the day
    // after the last incomplete one in the window.
    const [window] = await this.db
      .execute<{ since: string; completeThrough: string }>(sql`
        with cover as (
          select range_agg(tstzrange(started_at, seen_at + ${margin}, '[]')) as m from ${apiV1UsageReplicas}
        ), lost as (
          select generate_series((seen_at at time zone 'utc')::date, ${today}, interval '1 day')::date
          from ${apiV1UsageReplicas} where not closed and seen_at < now() - ${margin}
        ), days as (
          select g::date as day, g::date::timestamp at time zone 'utc' as starts,
                 least((g::date + 1)::timestamp at time zone 'utc', now() - ${margin}) as ends
          from generate_series(${since}, ${today}, interval '1 day') as g
        )
        select to_char(coalesce((
          select max(d.day) from days d, cover
          where d.day in (select day from lost)
             or (d.ends > d.starts and not coalesce(cover.m @> tstzrange(d.starts, d.ends, '[]'), false))
        ) + 1, ${since}), 'YYYY-MM-DD') as since,
        to_char((now() - ${margin}) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "completeThrough"`)
      .then((r) => r.rows);
    const [session] = await this.db
      .select({ calls: sql<number>`coalesce(sum(${apiV1Usage.calls}), 0)::int` })
      .from(apiV1Usage)
      .where(and(isNull(apiV1Usage.tokenId), gte(apiV1Usage.day, since)));
    // Deleted tokens and owners included: their calls are still in the window. The name is the latest one seen.
    const rows = await this.db
      .select({
        tokenId: sql<string>`${apiV1Usage.tokenId}`,
        tokenName: sql<string>`(array_agg(${apiV1Usage.tokenName} order by ${apiV1Usage.day} desc))[1]`,
        ownerId: sql<string>`(array_agg(${apiV1Usage.ownerId} order by ${apiV1Usage.day} desc))[1]`,
        calls: sql<number>`sum(${apiV1Usage.calls})::int`,
        lastCalledOn: sql<string>`to_char(max(${apiV1Usage.day}), 'YYYY-MM-DD')`,
      })
      .from(apiV1Usage)
      .where(and(isNotNull(apiV1Usage.tokenId), gte(apiV1Usage.day, since)))
      .groupBy(apiV1Usage.tokenId)
      .orderBy(desc(sql`max(${apiV1Usage.day})`), apiV1Usage.tokenId);
    // What keeps the window from completing until someone proves those replicas stopped: listed, by identity only.
    const silent = await this.db
      .select({
        replicaId: apiV1UsageReplicas.replicaId,
        startedAt: sql<string>`to_char(${apiV1UsageReplicas.startedAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        lastConfirmedAt: sql<string>`to_char(${apiV1UsageReplicas.seenAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      })
      .from(apiV1UsageReplicas)
      .where(and(eq(apiV1UsageReplicas.closed, false), lt(apiV1UsageReplicas.seenAt, sql`now() - ${margin}`)))
      .orderBy(asc(apiV1UsageReplicas.seenAt));
    return { windowDays: WINDOW_DAYS as 30, since: window!.since, completeThrough: window!.completeThrough, silentReplicas: silent, sessionCalls: session!.calls, tokens: rows };
  }
}

/** control-plane-v2: what the N1 migration left for a person, and what still calls the v1 the cut will remove. */
@Controller("api/v2/instance")
export class InstanceController {
  constructor(
    private readonly usage: ApiV1UsageService,
    @Inject(DB) private readonly db: Db,
    @Inject(ENCRYPTOR) private readonly enc: Encryptor,
  ) {}

  @Get("workspace-migration")
  @RequiredPermission("platform.admin", "instance")
  report() {
    return migrationReport(this.db, this.enc);
  }

  @Get("api-v1-usage")
  @RequiredPermission("platform.admin", "instance")
  apiV1Usage() {
    return this.usage.read();
  }
}

@Module({
  controllers: [InstanceController],
  providers: [ApiV1UsageService, { provide: API_V1_USAGE, useExisting: ApiV1UsageService }],
  exports: [API_V1_USAGE],
})
export class InstanceModule {}
