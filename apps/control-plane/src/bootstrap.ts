import "reflect-metadata";
import { type INestApplication, Logger, type LogLevel, RequestMethod } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import type { AppConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { configureImportParser } from "./config-transfer/document.js";
import { AtRestService } from "./crypto/at-rest.js";
import { UsersService } from "./users/users.js";

/** Shared by main.ts and the integration tests, so tests run the real app wiring. */
export async function createApp(config: AppConfig, opts: { logger?: false | LogLevel[] } = {}): Promise<INestApplication> {
  if (config.migrateOnStart) {
    await runMigrations(config.databaseUrl);
    Logger.log("Migrations applied", "Bootstrap");
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
  });
  // Express 5's default made explicit: no operation takes nested query objects (FlatQueryInterceptor refuses them).
  app.set("query parser", "simple");
  configureImportParser(app);
  app.setGlobalPrefix("api/v1", {
    exclude: ["healthz", { path: "agent/v1/{*splat}", method: RequestMethod.ALL }],
  });
  app.enableShutdownHooks();
  if (config.trustProxy !== false) (app.getHttpAdapter().getInstance() as import("express").Express).set("trust proxy", config.trustProxy);
  app.set("client ip header", config.clientIpHeader);
  await app.init();
  // Rows written before the encryption migration (or with an older key, after a rotation) are sealed here.
  await app.get(AtRestService).encryptExisting();
  if (config.bootstrapAdmin) {
    if (await app.get(UsersService).bootstrapAdmin(config.bootstrapAdmin)) Logger.log(`Bootstrap admin ${config.bootstrapAdmin.email} created`, "Bootstrap");
  }
  return app;
}
