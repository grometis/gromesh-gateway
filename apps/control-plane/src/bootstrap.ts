import "reflect-metadata";
import { type INestApplication, Logger, RequestMethod } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import type { AppConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";

/** Shared by main.ts and the integration tests, so tests run the real app wiring. */
export async function createApp(config: AppConfig, opts: { logger?: false } = {}): Promise<INestApplication> {
  if (config.migrateOnStart) {
    await runMigrations(config.databaseUrl);
    Logger.log("Migrations applied", "Bootstrap");
  }
  const app = await NestFactory.create(AppModule.forRoot(config), {
    ...(opts.logger === false ? { logger: false } : {}),
  });
  app.setGlobalPrefix("api/v1", {
    exclude: ["healthz", { path: "agent/v1/(.*)", method: RequestMethod.ALL }],
  });
  app.enableShutdownHooks();
  return app;
}
