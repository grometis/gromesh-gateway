import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { inject } from "vitest";
import pg from "pg";
import { createApp } from "../../src/bootstrap.js";
import { loadConfig, type AppConfig } from "../../src/config.js";

/** Stand-in for Kong's Admin API: records every POST /config and answers with a configurable status. */
export class FakeKong {
  readonly configs: unknown[] = [];
  status = 201;
  private server: Server | null = null;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/config") {
          this.configs.push(JSON.parse(body));
          res.writeHead(this.status, { "content-type": "application/json" });
          res.end(this.status < 300 ? "{}" : JSON.stringify({ message: "declarative config is invalid" }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}

export interface Harness {
  app: INestApplication;
  api: <T = any>(method: string, path: string, body?: unknown) => Promise<{ status: number; body: T; contentType: string | null }>;
  kong: FakeKong;
  sql: pg.Pool;
  close: () => Promise<void>;
}

/** Plugin configs are validated by a real Kong: the compose one unless overridden. */
export const KONG_VALIDATOR_URL = process.env.KONG_VALIDATOR_URL ?? "http://127.0.0.1:8001";

/** Each call is one more control-plane replica on the shared test database. */
export async function startHarness(overrides: Partial<AppConfig> = {}): Promise<Harness> {
  const kong = new FakeKong();
  await kong.start();
  const databaseUrl = inject("databaseUrl");
  const app: INestApplication = await createApp(
    { ...loadConfig({ ...process.env, DATABASE_URL: databaseUrl }), kongAdminUrl: kong.url, kongValidatorUrl: KONG_VALIDATOR_URL, migrateOnStart: false, ...overrides },
    { logger: false },
  );
  await app.listen(0, "127.0.0.1");
  const base = `${await app.getUrl()}/api/v1`.replace("[::1]", "127.0.0.1");
  const sql = new pg.Pool({ connectionString: databaseUrl, max: 2 });

  return {
    app,
    kong,
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
      await kong.stop();
      await sql.end();
    },
  };
}

let seq = 0;
/** Unique, contract-valid names so tests never collide in the shared database. */
export const uniq = (prefix: string) => `${prefix}-${process.pid}-${Date.now().toString(36)}-${++seq}`;
