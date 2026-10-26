import { Controller, Get, HttpStatus, Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { API_V1_USAGE, type ApiV1UsageRecorder, RequiredPermission } from "../auth/auth.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { ENCRYPTOR, type Encryptor } from "../crypto/crypto.js";
import { DB, type Db } from "../db/db.js";
import { ProblemException } from "../common/problem.js";
import { apiV1Usage, apiV1UsageReplicas } from "../db/schema.js";
import { migrationReport } from "../workspaces/migration-report.js";

const WINDOW_DAYS = 30;
/**
 * How long a replica's counting may go unconfirmed: a gap after a replica's last confirmation shorter than this (a
 * restart) is not a gap, a replica silent for longer without stopping cleanly may have lost a call, and the report
 * claims completeness only up to this long ago.
 */
export const CONFIRM_MS = 120_000;
/** After its last confirmation, how long a silent replica may still have taken a token call: twice CONFIRM_MS. */
const LOSS_SPAN = sql.raw(`interval '${(2 * CONFIRM_MS) / 1000} seconds'`);
const today = sql`(now() at time zone 'utc')::date`;
/** The UTC day of a call, taken when it is made (a session call written after midnight keeps its day). */
const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * The calls to the v1 operations the controlled migration will cut (decision H-9). A token's call is written at once:
 * a call lost to a crash could let the cut through. Session calls (the UI, one row a day) are added up here and
 * written every few seconds, so concurrent requests do not queue on that row.
 *
 * No call counted proves nothing about a time nobody was counting: each replica keeps a row from its start, confirmed
 * by every flush up to then (never past a token call still being written, one confirmation at a time) and closed
 * when it stops cleanly with nothing in flight. A token call that could not be written is refused and its day goes
 * with the next confirmation. A replica unconfirmed for CONFIRM_MS refuses the token calls it would count before
 * authenticating them (counting()), so one that went silent without closing can only have lost a call within that
 * long of its last confirmation.
 */
@Injectable()
export class ApiV1UsageService implements ApiV1UsageRecorder, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("ApiV1Usage");
  private readonly replicaId = randomUUID();
  private readonly startedAt = new Date();
  /** Session calls not written yet, by the UTC day they were made. */
  private sessionCalls = new Map<string, number>();
  /** The UTC days of the token calls not written since the last confirmation. */
  private failedOn = new Set<string>();
  /** When each token call still being written started. */
  private readonly inFlight = new Map<symbol, number>();
  /** Up to when this replica's counting is confirmed (written). */
  private confirmedThrough = 0;
  /** The confirmations, one at a time: a later one must not pass a failure an earlier one is still writing. */
  private confirming: Promise<void> = Promise.resolve();
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.confirm();
    if (this.config.apiV1UsageFlushMs <= 0) return;
    this.timer = setInterval(() => void this.flush().catch((err: unknown) => this.logger.error(err instanceof Error ? err.stack : String(err))), this.config.apiV1UsageFlushMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // From here on, a call that fails to be written confirms its failure itself (the row may be closed meanwhile).
    this.stopping = true;
    // The calls being written finish first (a few seconds at most): their failures go with the last confirmation.
    for (let i = 0; i < 100 && this.inFlight.size > 0; i++) await new Promise((r) => setTimeout(r, 50));
    await this.flush();
    // Only a clean stop with nothing in flight closes the row: otherwise its silence counts as a possible loss.
    if (this.inFlight.size === 0 && this.failedOn.size === 0) await this.confirm(true);
  }

  /** Whether this replica's counting is confirmed recently enough to take the v1 token calls it counts. */
  counting(): boolean {
    return Date.now() - this.confirmedThrough <= CONFIRM_MS;
  }

  async record(token: { id: string; name: string; ownerId: string } | null): Promise<void> {
    const day = utcDay();
    if (token === null) {
      this.sessionCalls.set(day, (this.sessionCalls.get(day) ?? 0) + 1);
      return;
    }
    const call = Symbol();
    this.inFlight.set(call, Date.now());
    try {
      if (!this.counting()) throw new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, "The v1 usage counting is not confirmed: retry");
      await this.add(day, token, 1);
    } catch (error) {
      this.failedOn.add(day);
      // While stopping there may be no next confirmation: this one carries the failure.
      if (this.stopping) await this.confirm().catch(() => undefined);
      throw error;
    } finally {
      this.inFlight.delete(call);
    }
  }

  /**
   * Confirms the counting up to now, with the days of the calls not written meanwhile (kept if this fails too), after
   * any confirmation still being written; `close` marks a clean stop.
   */
  private confirm(close = false): Promise<void> {
    const run = this.confirming.then(async () => {
      const failed = this.failedOn;
      this.failedOn = new Set();
      // Up to now, or to the start of the oldest token call still being written (it may still fail).
      const seenAt = new Date(Math.min(Date.now(), ...this.inFlight.values()));
      try {
        await this.persist(seenAt, [...failed], close);
      } catch (error) {
        for (const d of failed) this.failedOn.add(d);
        throw error;
      }
      this.confirmedThrough = Math.max(this.confirmedThrough, seenAt.getTime());
    });
    this.confirming = run.catch(() => undefined);
    return run;
  }

  private async persist(seenAt: Date, failedOn: string[], close: boolean): Promise<void> {
    await this.db
      .insert(apiV1UsageReplicas)
      .values({ replicaId: this.replicaId, startedAt: this.startedAt, seenAt, failedOn, closed: close })
      .onConflictDoUpdate({
        target: apiV1UsageReplicas.replicaId,
        set: {
          seenAt: sql`greatest(${apiV1UsageReplicas.seenAt}, excluded.seen_at)`,
          failedOn: sql`array(select distinct unnest(${apiV1UsageReplicas.failedOn} || excluded.failed_on) order by 1)`,
          // A failure written after the clean stop opens the row again.
          closed: sql`(${apiV1UsageReplicas.closed} or excluded.closed) and cardinality(excluded.failed_on) = 0`,
        },
      });
  }

  /**
   * Confirms the counting, writes the session calls counted so far, each on its own day, and drops what is out of
   * the window.
   */
  async flush(): Promise<void> {
    await this.confirm();
    const pending = [...this.sessionCalls];
    this.sessionCalls = new Map();
    for (const [i, [day, n]] of pending.entries()) {
      try {
        await this.add(day, null, n);
      } catch (error) {
        // Kept for the next flush, on their own days.
        for (const [d, m] of pending.slice(i)) this.sessionCalls.set(d, (this.sessionCalls.get(d) ?? 0) + m);
        throw error;
      }
    }
    await this.db.delete(apiV1Usage).where(lt(apiV1Usage.day, sql`${today} - ${WINDOW_DAYS - 1}::int`));
    // A row matters while what it covers, or the time it may have lost a call in, reaches into the window.
    const windowStart = sql`(${today} - ${WINDOW_DAYS - 1}::int)::timestamp at time zone 'utc'`;
    await this.db.delete(apiV1UsageReplicas).where(lt(sql`${apiV1UsageReplicas.seenAt} + ${LOSS_SPAN}`, windowStart));
  }

  private async add(day: string, token: { id: string; name: string; ownerId: string } | null, calls: number): Promise<void> {
    await this.db
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
    // closing could have lost one on it (within LOSS_SPAN of its last confirmation). The report's since is the day
    // after the last incomplete one in the window.
    const [window] = await this.db
      .execute<{ since: string; completeThrough: string }>(sql`
        with cover as (
          select range_agg(tstzrange(started_at, seen_at + ${margin}, '[]')) as m from ${apiV1UsageReplicas}
        ), lost as (
          select unnest(failed_on) as day from ${apiV1UsageReplicas}
          union select generate_series((seen_at at time zone 'utc')::date, ((seen_at + ${LOSS_SPAN}) at time zone 'utc')::date, interval '1 day')::date
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
    return { windowDays: WINDOW_DAYS as 30, since: window!.since, completeThrough: window!.completeThrough, sessionCalls: session!.calls, tokens: rows };
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
