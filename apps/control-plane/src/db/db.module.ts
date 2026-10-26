import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import type pg from "pg";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { BEFORE_POOL_END, createDb, DB, PG_POOL } from "./db.js";

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createDb(config.databaseUrl),
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (created: ReturnType<typeof createDb>) => created.db,
    },
    // One list per application: two in one process (the tests' replicas) must not close each other's work.
    { provide: BEFORE_POOL_END, useFactory: () => [] },
  ],
  exports: [DB, PG_POOL, BEFORE_POOL_END],
})
export class DbModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly created: { pool: pg.Pool },
    @Inject(BEFORE_POOL_END) private readonly before: (() => Promise<void>)[],
  ) {}

  async onApplicationShutdown(): Promise<void> {
    for (const work of this.before) await work();
    await this.created.pool.end();
  }
}
