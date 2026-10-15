import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import type pg from "pg";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { createDb, DB, PG_POOL } from "./db.js";

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
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly created: { pool: pg.Pool }) {}

  async onApplicationShutdown(): Promise<void> {
    await this.created.pool.end();
  }
}
