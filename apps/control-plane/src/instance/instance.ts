import { Controller, Get, Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { and, desc, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { API_V1_USAGE, type ApiV1UsageRecorder, RequiredPermission } from "../auth/auth.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { ENCRYPTOR, type Encryptor } from "../crypto/crypto.js";
import { DB, type Db } from "../db/db.js";
import { apiV1Usage, apiV1UsageCoverage } from "../db/schema.js";
import { migrationReport } from "../workspaces/migration-report.js";

const WINDOW_DAYS = 30;
const today = sql`(now() at time zone 'utc')::date`;
/** The UTC day of a call, taken when it is made (a session call written after midnight keeps its day). */
const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * The calls to the v1 operations the controlled migration will cut (decision H-9). A token's call is written at once:
 * a call lost to a crash could let the cut through. Session calls (the UI, one row a day) are added up here and
 * written every few seconds, so concurrent requests do not queue on that row.
 *
 * No call counted proves nothing about a day nobody was counting: each write also marks its UTC day as covered, and a
 * token call that could not be written (the call is refused) marks its day as failed. The report's `since` is the
 * first day from which every day is covered and none failed.
 */
@Injectable()
export class ApiV1UsageService implements ApiV1UsageRecorder, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("ApiV1Usage");
  /** Session calls not written yet, by the UTC day they were made. */
  private sessionCalls = new Map<string, number>();
  /** Token calls that could not be written, by the UTC day they were made. */
  private failures = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.apiV1UsageFlushMs <= 0) return;
    this.timer = setInterval(() => void this.flush().catch((err: unknown) => this.logger.error(err instanceof Error ? err.stack : String(err))), this.config.apiV1UsageFlushMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  async record(token: { id: string; name: string; ownerId: string } | null): Promise<void> {
    const day = utcDay();
    if (token === null) {
      this.sessionCalls.set(day, (this.sessionCalls.get(day) ?? 0) + 1);
      return;
    }
    try {
      await this.add(day, token, 1);
    } catch (error) {
      this.failures.set(day, (this.failures.get(day) ?? 0) + 1);
      throw error;
    }
  }

  /**
   * Marks today as covered with the failures not written yet, writes the session calls counted so far, each on its
   * own day, and drops the days out of the window.
   */
  async flush(): Promise<void> {
    const failed = this.failures;
    this.failures = new Map();
    const days = new Map([[utcDay(), 0], ...failed]);
    try {
      await this.db
        .insert(apiV1UsageCoverage)
        .values([...days].map(([day, failures]) => ({ day, failures })))
        .onConflictDoUpdate({ target: apiV1UsageCoverage.day, set: { failures: sql`${apiV1UsageCoverage.failures} + excluded.failures` } });
    } catch (error) {
      // Kept for the next flush: a failure is never dropped.
      for (const [d, m] of failed) this.failures.set(d, (this.failures.get(d) ?? 0) + m);
      throw error;
    }
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
    await this.db.delete(apiV1UsageCoverage).where(lt(apiV1UsageCoverage.day, sql`${today} - ${WINDOW_DAYS - 1}::int`));
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
    // The day after the last one in the window nobody covered or a write failed on (tomorrow when today did).
    const [window] = await this.db
      .execute<{ since: string }>(sql`
        select to_char(coalesce((
          select max(d.day) from generate_series(${since}, ${today}, interval '1 day') as d(day)
          left join ${apiV1UsageCoverage} c on c.day = d.day::date
          where c.day is null or c.failures > 0
        )::date + 1, ${since}), 'YYYY-MM-DD') as since`)
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
    return { windowDays: WINDOW_DAYS as 30, since: window!.since, sessionCalls: session!.calls, tokens: rows };
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
