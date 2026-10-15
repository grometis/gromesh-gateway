import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (apps/control-plane), same from src/ and dist/. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface AppConfig {
  /** Temporary until week 5: the built-in admin is available only with AUTH_MODE=dev. */
  authMode: "dev" | "disabled";
  port: number;
  databaseUrl: string;
  /** A Kong (DB-less, no traffic) whose Admin API validates plugin configs: POST /schemas/plugins/validate. */
  kongValidatorUrl: string | null;
  contractsDir: string;
  migrateOnStart: boolean;
  /** Auto-publish environments fire this long after their last draft edit (debounce). */
  autoPublishDelayMs: number;
  /** How often each replica looks for due auto-publish environments; 0 disables the poller. */
  autoPublishPollMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    authMode: env.AUTH_MODE === "dev" ? "dev" : "disabled",
    port: Number(env.PORT ?? 3000),
    databaseUrl,
    kongValidatorUrl: env.KONG_VALIDATOR_URL || null,
    contractsDir: env.CONTRACTS_DIR ?? resolve(PACKAGE_ROOT, "../../contracts"),
    migrateOnStart: env.MIGRATE_ON_START === "true",
    autoPublishDelayMs: Number(env.AUTO_PUBLISH_DELAY_MS ?? 3000),
    autoPublishPollMs: Number(env.AUTO_PUBLISH_POLL_MS ?? 1000),
  };
}

export const APP_CONFIG = Symbol("APP_CONFIG");
