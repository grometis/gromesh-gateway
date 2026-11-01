import { assertClickhouseOverride } from "../../../../scripts/integration-databases.mjs";
import { assertIntegrationDatabase } from "./databases.js";
import type { INestApplication } from "@nestjs/common";
import { inject } from "vitest";
import pg from "pg";
import { createApp } from "../../src/bootstrap.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import type { Role } from "../../src/auth/auth.js";

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  contentType: string | null;
  headers: Headers;
}

/** A client bound to one session (cookie + CSRF token), or to none. */
export type ApiClient = <T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<ApiResponse<T>>;

export interface Session {
  status: number;
  body: any;
  api: ApiClient;
  cookie: string | null;
}

export interface Harness {
  app: INestApplication;
  /** Logged in as the bootstrap admin. */
  api: ApiClient;
  admin: { email: string; password: string };
  /** No cookie at all. */
  anonymous: ApiClient;
  /** Logs in and returns a client for that session (when status is 200). */
  login: (email: string, password: string) => Promise<Session>;
  /** Creates a fresh user with `role` and returns a client logged in as it. */
  as: (role: Role) => Promise<{ api: ApiClient; email: string; password: string; id: string }>;
  sql: pg.Pool;
  close: () => Promise<void>;
}

/** Plugin configs are validated by a real Kong: the compose one unless overridden. */
export const KONG_VALIDATOR_URL = process.env.KONG_VALIDATOR_URL ?? "http://127.0.0.1:8011";

export const BOOTSTRAP_ADMIN = { email: "admin@harness.test", password: "harness-admin-password" };

/** Test-only keys (32 zero-ish bytes, base64); the encryption tests rotate between them. */
export const ENCRYPTION_KEYS = {
  k1: "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  k2: "k2:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  fingerprint: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
};

/** Credentials scoped to the exclusively created database of this run. */
export const CLICKHOUSE = inject("clickhouse");
export const CLICKHOUSE_ADMIN = inject("clickhouseWriter");

/** Each call is one more control-plane replica on the shared test database. */
export async function startHarness(overrides: Partial<AppConfig> = {}): Promise<Harness> {
  // A test may bring its own database (the migration tests); every other one shares the run's.
  const databaseUrl = assertIntegrationDatabase(overrides.databaseUrl ?? inject("databaseUrl"));
  assertClickhouseOverride(CLICKHOUSE, overrides.clickhouse);
  // The harness sets its own bootstrap admin: the shell's variables must not win.
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl, CLICKHOUSE_URL: CLICKHOUSE.url, CLICKHOUSE_DATABASE: CLICKHOUSE.database, CLICKHOUSE_USER: CLICKHOUSE.user, CLICKHOUSE_PASSWORD: CLICKHOUSE.password, BOOTSTRAP_ADMIN_EMAIL: undefined, BOOTSTRAP_ADMIN_PASSWORD: undefined };
  const app: INestApplication = await createApp(
    {
      ...loadConfig(env),
      bootstrapAdmin: BOOTSTRAP_ADMIN,
      cookieSecure: false,
      // Every test shares 127.0.0.1: the per-address lockout is exercised by its own test with a low threshold,
      // and the progressive delay by its own test with a non-zero base.
      loginMaxFailuresPerIp: 1_000_000,
      // Every test acts as the same bootstrap admin: the conflict limit is exercised by its own test with a low max.
      uniqueConflictMax: 1_000_000,
      loginDelayBaseMs: 0,
      kongValidatorUrl: KONG_VALIDATOR_URL,
      // k2 readable everywhere: the rotation test re-seals shared rows with it while other files run.
      encryption: { writeKey: ENCRYPTION_KEYS.k1, readKeys: [ENCRYPTION_KEYS.k2], fingerprintKey: ENCRYPTION_KEYS.fingerprint },
      clickhouse: CLICKHOUSE,
      migrateOnStart: false,
      ...overrides,
    },
    // Quiet locally; in CI the application's error log is the only trace of a 5xx behind an assertion.
    { logger: process.env.CI ? ["error"] : false },
  );
  await app.listen(0, "127.0.0.1");
  const base = `${await app.getUrl()}/api/v1`.replace("[::1]", "127.0.0.1");
  const sql = new pg.Pool({ connectionString: databaseUrl, max: 2 });

  const client = (cookie: string | null, csrf: string | null): ApiClient => async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) : undefined, contentType: res.headers.get("content-type"), headers: res.headers };
  };
  const anonymous = client(null, null);

  const login: Harness["login"] = async (email, password) => {
    const res = await anonymous("POST", "/auth/login", { email, password });
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? null;
    if (res.status !== 200 || !cookie) return { status: res.status, body: res.body, api: anonymous, cookie: null };
    const csrf = await client(cookie, null)("GET", "/auth/csrf");
    return { status: res.status, body: res.body, api: client(cookie, csrf.body.csrfToken), cookie };
  };

  const admin = await login(BOOTSTRAP_ADMIN.email, BOOTSTRAP_ADMIN.password);
  if (admin.status !== 200) throw new Error(`harness login failed: HTTP ${admin.status} ${JSON.stringify(admin.body)}`);

  const as: Harness["as"] = async (role) => {
    const email = `${uniq(role)}@harness.test`;
    const password = `pw-${uniq("secret")}`;
    const created = await admin.api("POST", "/users", { email, name: `${role} user`, role, password });
    if (created.status !== 201) throw new Error(`harness could not create ${role}: ${JSON.stringify(created.body)}`);
    const session = await login(email, password);
    return { api: session.api, email, password, id: created.body.id };
  };

  return {
    app,
    api: admin.api,
    admin: BOOTSTRAP_ADMIN,
    anonymous,
    login,
    as,
    sql,
    close: async () => {
      await app.close();
      await sql.end();
    },
  };
}

let seq = 0;
/** Unique, contract-valid names so tests never collide in the shared database. */
export const uniq = (prefix: string) => `${prefix}-${process.pid}-${Date.now().toString(36)}-${++seq}`;
