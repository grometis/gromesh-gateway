import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (apps/control-plane), same from src/ and dist/. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** Created on start-up when the users table is empty (BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD). */
  bootstrapAdmin: { email: string; password: string } | null;
  /** `Secure` attribute of the session cookie; only the development compose turns it off. */
  cookieSecure: boolean;
  /**
   * Express `trust proxy` setting (TRUST_PROXY): which upstream proxies may set X-Forwarded-For, so the login lockout
   * per client address sees the real client behind the UI's nginx instead of the proxy. Off by default.
   */
  trustProxy: boolean | string;
  /** Sliding session lifetime. */
  sessionTtlMs: number;
  /** Failed logins per e-mail+client address before a lockout of `loginLockoutMs`. */
  loginMaxFailures: number;
  /** Failures on the e-mail alone (from anywhere) only delay the next attempt: base × 2^(n-1), capped. */
  loginDelayBaseMs: number;
  loginDelayMaxMs: number;
  /** Same per client address; higher, because many users can share one address (NAT, proxies). */
  loginMaxFailuresPerIp: number;
  loginLockoutMs: number;
  /** A Kong (DB-less, no traffic) whose Admin API validates plugin configs: POST /schemas/plugins/validate. */
  kongValidatorUrl: string | null;
  /**
   * http-log endpoint of the clusters' collectors (PLATFORM_HTTP_LOG_ENDPOINT, a fixed name resolved inside each
   * cluster). Set, every publication carries the platform prometheus and http-log plugins; empty = none.
   */
  platformHttpLogEndpoint: string | null;
  /** The analytics store (CLICKHOUSE_URL/USER/PASSWORD/DATABASE), read with a SELECT-only user; null = analytics off (502). */
  clickhouse: { url: string; user: string; password: string; database: string } | null;
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
  const bootstrapEmail = env.BOOTSTRAP_ADMIN_EMAIL;
  const bootstrapPassword = env.BOOTSTRAP_ADMIN_PASSWORD;
  if (Boolean(bootstrapEmail) !== Boolean(bootstrapPassword)) {
    throw new Error("BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together");
  }
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl,
    bootstrapAdmin: bootstrapEmail && bootstrapPassword ? { email: bootstrapEmail, password: bootstrapPassword } : null,
    cookieSecure: env.COOKIE_SECURE !== "false",
    trustProxy: env.TRUST_PROXY === undefined || env.TRUST_PROXY === "false" ? false : env.TRUST_PROXY === "true" ? true : env.TRUST_PROXY,
    sessionTtlMs: Number(env.SESSION_TTL_MS ?? 8 * 60 * 60 * 1000),
    loginMaxFailures: Number(env.LOGIN_MAX_FAILURES ?? 5),
    loginDelayBaseMs: Number(env.LOGIN_DELAY_BASE_MS ?? 250),
    loginDelayMaxMs: Number(env.LOGIN_DELAY_MAX_MS ?? 5000),
    loginMaxFailuresPerIp: Number(env.LOGIN_MAX_FAILURES_PER_IP ?? 50),
    loginLockoutMs: Number(env.LOGIN_LOCKOUT_MS ?? 15 * 60 * 1000),
    kongValidatorUrl: env.KONG_VALIDATOR_URL || null,
    platformHttpLogEndpoint: env.PLATFORM_HTTP_LOG_ENDPOINT || null,
    clickhouse: env.CLICKHOUSE_URL
      ? { url: env.CLICKHOUSE_URL, user: env.CLICKHOUSE_USER ?? "gromesh_reader", password: env.CLICKHOUSE_PASSWORD ?? "", database: env.CLICKHOUSE_DATABASE ?? "gromesh" }
      : null,
    contractsDir: env.CONTRACTS_DIR ?? resolve(PACKAGE_ROOT, "../../contracts"),
    migrateOnStart: env.MIGRATE_ON_START === "true",
    autoPublishDelayMs: Number(env.AUTO_PUBLISH_DELAY_MS ?? 3000),
    autoPublishPollMs: Number(env.AUTO_PUBLISH_POLL_MS ?? 1000),
  };
}

export const APP_CONFIG = Symbol("APP_CONFIG");
