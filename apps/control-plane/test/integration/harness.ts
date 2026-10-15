import type { INestApplication } from "@nestjs/common";
import { inject } from "vitest";
import pg from "pg";
import { createApp } from "../../src/bootstrap.js";
import { loadConfig, type AppConfig } from "../../src/config.js";

export interface Harness {
  app: INestApplication;
  api: <T = any>(method: string, path: string, body?: unknown) => Promise<{ status: number; body: T; contentType: string | null }>;
  sql: pg.Pool;
  close: () => Promise<void>;
}

/** Plugin configs are validated by a real Kong: the compose one unless overridden. */
export const KONG_VALIDATOR_URL = process.env.KONG_VALIDATOR_URL ?? "http://127.0.0.1:8001";

/** Each call is one more control-plane replica on the shared test database. */
export async function startHarness(overrides: Partial<AppConfig> = {}): Promise<Harness> {
  const databaseUrl = inject("databaseUrl");
  const app: INestApplication = await createApp(
    { ...loadConfig({ ...process.env, DATABASE_URL: databaseUrl }), kongValidatorUrl: KONG_VALIDATOR_URL, migrateOnStart: false, ...overrides },
    { logger: false },
  );
  await app.listen(0, "127.0.0.1");
  const base = `${await app.getUrl()}/api/v1`.replace("[::1]", "127.0.0.1");
  const sql = new pg.Pool({ connectionString: databaseUrl, max: 2 });

  return {
    app,
    sql,
    api: async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined, contentType: res.headers.get("content-type") };
    },
    close: async () => {
      await app.close();
      await sql.end();
    },
  };
}

let seq = 0;
/** Unique, contract-valid names so tests never collide in the shared database. */
export const uniq = (prefix: string) => `${prefix}-${process.pid}-${Date.now().toString(36)}-${++seq}`;
