import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (apps/control-plane), same from src/ and dist/. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** Week 1 only: the control plane pushes snapshots straight to Kong. Removed when the agent lands (W3-X1). */
  kongAdminUrl: string | null;
  contractsDir: string;
  migrateOnStart: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl,
    kongAdminUrl: env.KONG_ADMIN_URL || null,
    contractsDir: env.CONTRACTS_DIR ?? resolve(PACKAGE_ROOT, "../../contracts"),
    migrateOnStart: env.MIGRATE_ON_START === "true",
  };
}

export const APP_CONFIG = Symbol("APP_CONFIG");
