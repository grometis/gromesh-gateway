import { Controller, Get, Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { API_V1_USAGE, type ApiV1UsageRecorder, RequiredPermission } from "../auth/auth.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { ENCRYPTOR, type Encryptor } from "../crypto/crypto.js";
import { DB, type Db } from "../db/db.js";
import { apiTokens, apiV1Usage } from "../db/schema.js";
import { migrationReport } from "../workspaces/migration-report.js";

const WINDOW_DAYS = 30;
const today = sql`(now() at time zone 'utc')::date`;

/**
 * The calls to the v1 operations the controlled migration will cut (decision H-9). A token's call is written at once:
 * a call lost to a crash could let the cut through. Session calls (the UI, one row a day) are added up here and
 * written every few seconds, so concurrent requests do not queue on that row.
 */
@Injectable()
export class ApiV1UsageService implements ApiV1UsageRecorder, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("ApiV1Usage");
  private sessionCalls = 0;
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

  async record(tokenId: string | null): Promise<void> {
    if (tokenId === null) this.sessionCalls++;
    else await this.add(tokenId, 1);
  }

  /** Writes the session calls counted so far and drops the days out of the window. */
  async flush(): Promise<void> {
    const n = this.sessionCalls;
    this.sessionCalls = 0;
    try {
      if (n > 0) await this.add(null, n);
    } catch (error) {
      this.sessionCalls += n;
      throw error;
    }
    await this.db.delete(apiV1Usage).where(lt(apiV1Usage.day, sql`${today} - ${WINDOW_DAYS - 1}::int`));
  }

  private async add(tokenId: string | null, calls: number): Promise<void> {
    await this.db
      .insert(apiV1Usage)
      .values({ day: sql`${today}`, tokenId, calls })
      .onConflictDoUpdate({ target: [apiV1Usage.day, apiV1Usage.tokenId], set: { calls: sql`${apiV1Usage.calls} + excluded.calls` } });
  }

  /** contract: ApiV1Usage. The window is the last 30 UTC days, today included. */
  async read() {
    await this.flush();
    const since = sql`${today} - ${WINDOW_DAYS - 1}::int`;
    const [window] = await this.db.execute<{ since: string }>(sql`select to_char(${since}, 'YYYY-MM-DD') as since`).then((r) => r.rows);
    const [session] = await this.db
      .select({ calls: sql<number>`coalesce(sum(${apiV1Usage.calls}), 0)::int` })
      .from(apiV1Usage)
      .where(and(isNull(apiV1Usage.tokenId), gte(apiV1Usage.day, since)));
    const tokens = await this.db
      .select({
        tokenId: apiTokens.id,
        tokenName: apiTokens.name,
        ownerId: apiTokens.userId,
        calls: sql<number>`sum(${apiV1Usage.calls})::int`,
        lastCalledOn: sql<string>`to_char(max(${apiV1Usage.day}), 'YYYY-MM-DD')`,
      })
      .from(apiV1Usage)
      .innerJoin(apiTokens, eq(apiTokens.id, apiV1Usage.tokenId))
      .where(and(isNotNull(apiV1Usage.tokenId), gte(apiV1Usage.day, since)))
      .groupBy(apiTokens.id, apiTokens.name, apiTokens.userId)
      .orderBy(desc(sql`max(${apiV1Usage.day})`), apiTokens.id);
    return { windowDays: WINDOW_DAYS as 30, since: window!.since, sessionCalls: session!.calls, tokens };
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
