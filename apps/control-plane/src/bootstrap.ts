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
import { DB, type Db } from "./db/db.js";
import { backfillWorkspaces } from "./workspaces/workspaces.js";
import { enforceInstanceUniquenessSoon } from "./workspaces/instance-uniqueness.js";

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
  // control-plane-v2 (Workspaces) is served under /api/v2: its controllers carry the full path.
  app.setGlobalPrefix("api/v1", {
    exclude: ["healthz", { path: "agent/v1/{*splat}", method: RequestMethod.ALL }, { path: "api/v2/{*splat}", method: RequestMethod.ALL }],
  });
  app.enableShutdownHooks();
  if (config.trustProxy !== false) (app.getHttpAdapter().getInstance() as import("express").Express).set("trust proxy", config.trustProxy);
  app.set("client ip header", config.clientIpHeader);
  await app.init();
  // Also without migrateOnStart: a replica of the previous version may have created an environment (whose workspace
  // the trigger left without a slug) after the migration ran.
  await app.get<Db>(DB).transaction((tx) => backfillWorkspaces(tx));
  // Rows written before the encryption migration (or with an older key, after a rotation) are sealed here.
  await app.get(AtRestService).encryptExisting();
  // Another replica may be completing migration 0005 (it holds the at-rest lock, so this one skipped): until it is
  // done, key-auth uniqueness is not enforced, so this replica waits for it (30 s at most) and does not serve.
  await app
    .get(AtRestService)
    .assertKeyHashMigrated(config.keyHashWaitMs)
    .catch(async (error: unknown) => {
      await app.close();
      throw error;
    });
  // Only now are all key-auth fingerprints filled in (encryptExisting completes an interrupted 0005): the instance
  // unique index of every kind no two drafts repeat (decision H-5); a repeated one stays a blocker of the report.
  await enforceInstanceUniquenessSoon(app.get<Db>(DB));
  if (config.bootstrapAdmin) {
    if (await app.get(UsersService).bootstrapAdmin(config.bootstrapAdmin)) Logger.log(`Bootstrap admin ${config.bootstrapAdmin.email} created`, "Bootstrap");
  }
  return app;
}
