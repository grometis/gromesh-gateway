import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateHeaderName } from "node:http";

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
  /** Optional client address header, honoured only when the TCP peer is trusted by Express. */
  clientIpHeader: string | null;
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
  /**
   * FORBIDDEN_DESTINATIONS: comma-separated host names, `*.suffix` patterns, IP addresses or CIDRs that services,
   * upstreams and targets may not use, on top of loopback, link-local and this control plane's own dependencies.
   */
  forbiddenDestinations: string[];
  /**
   * Secrets at rest: GROMESH_ENCRYPTION_KEY is the write key (`<keyId>:<base64 of 32 bytes>`), GROMESH_ENCRYPTION_KEYS
   * the comma-separated previous keys still accepted for reading (rotation) and GROMESH_FINGERPRINT_KEY (base64 of
   * 32 bytes) the separate HMAC key behind uniqueness checks. The first and the last are required to start the API.
   */
  encryption: { writeKey: string; readKeys: string[]; fingerprintKey: string } | null;
  /** The analytics store (CLICKHOUSE_URL/USER/PASSWORD/DATABASE), read with a SELECT-only user; null = analytics off (502). */
  clickhouse: { url: string; user: string; password: string; database: string } | null;
  contractsDir: string;
  migrateOnStart: boolean;
  /** How long a start waits for another replica to complete migration 0005 before failing. */
  keyHashWaitMs: number;
  /** Auto-publish environments fire this long after their last draft edit (debounce). */
  autoPublishDelayMs: number;
  /** How often each replica looks for due auto-publish environments; 0 disables the poller. */
  autoPublishPollMs: number;
  /** How often each replica fills in workspace slugs an older replica left empty (rolling upgrade); 0 disables it. */
  workspaceSlugPollMs: number;
  /** Conflicting writes on an instance-unique value (credential, SNI) per actor before a 429 for `loginLockoutMs`. */
  uniqueConflictMax: number;
  /** How often each replica writes the v1 calls of sessions it counted (token calls are written at once). */
  apiV1UsageFlushMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const clientIpHeader = env.CLIENT_IP_HEADER || null;
  if (clientIpHeader !== null) {
    try {
      validateHeaderName(clientIpHeader);
    } catch {
      throw new Error("CLIENT_IP_HEADER must be a single HTTP header name");
    }
  }
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
    clientIpHeader,
    sessionTtlMs: Number(env.SESSION_TTL_MS ?? 8 * 60 * 60 * 1000),
    loginMaxFailures: Number(env.LOGIN_MAX_FAILURES ?? 5),
    loginDelayBaseMs: Number(env.LOGIN_DELAY_BASE_MS ?? 250),
    loginDelayMaxMs: Number(env.LOGIN_DELAY_MAX_MS ?? 5000),
    loginMaxFailuresPerIp: Number(env.LOGIN_MAX_FAILURES_PER_IP ?? 50),
    loginLockoutMs: Number(env.LOGIN_LOCKOUT_MS ?? 15 * 60 * 1000),
    kongValidatorUrl: env.KONG_VALIDATOR_URL || null,
    platformHttpLogEndpoint: env.PLATFORM_HTTP_LOG_ENDPOINT || null,
    forbiddenDestinations: (env.FORBIDDEN_DESTINATIONS ?? "").split(",").map((d) => d.trim()).filter(Boolean),
    encryption: env.GROMESH_ENCRYPTION_KEY
      ? {
          writeKey: env.GROMESH_ENCRYPTION_KEY,
          readKeys: (env.GROMESH_ENCRYPTION_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean),
          fingerprintKey: env.GROMESH_FINGERPRINT_KEY ?? "",
        }
      : null,
    clickhouse: env.CLICKHOUSE_URL
      ? { url: env.CLICKHOUSE_URL, user: env.CLICKHOUSE_USER ?? "gromesh_reader", password: env.CLICKHOUSE_PASSWORD ?? "", database: env.CLICKHOUSE_DATABASE ?? "gromesh" }
      : null,
    contractsDir: env.CONTRACTS_DIR ?? resolve(PACKAGE_ROOT, "../../contracts"),
    migrateOnStart: env.MIGRATE_ON_START === "true",
    keyHashWaitMs: Number(env.KEY_HASH_WAIT_MS ?? 30_000),
    autoPublishDelayMs: Number(env.AUTO_PUBLISH_DELAY_MS ?? 3000),
    autoPublishPollMs: Number(env.AUTO_PUBLISH_POLL_MS ?? 1000),
    workspaceSlugPollMs: Number(env.WORKSPACE_SLUG_POLL_MS ?? 30_000),
    uniqueConflictMax: Number(env.UNIQUE_CONFLICT_MAX ?? 20),
    apiV1UsageFlushMs: Number(env.API_V1_USAGE_FLUSH_MS ?? 5000),
  };
}

export const APP_CONFIG = Symbol("APP_CONFIG");
