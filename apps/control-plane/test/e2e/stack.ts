import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";

// Shared by the e2e specs against the live compose stack. Each spec that publishes owns the agent service while it
// runs (the e2e config runs files serially).
export const CP = process.env.CP_URL ?? "http://127.0.0.1:3000/api/v1";
export const PROXY = process.env.KONG_PROXY_URL ?? "http://127.0.0.1:8000";
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const COMPOSE = fileURLToPath(new URL("../../../../deploy/compose/docker-compose.yml", import.meta.url));
const exec = promisify(execFile);
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ADMIN = { email: process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@gromesh.dev", password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "gromesh-dev-admin" };

export interface Entity { id: string }
export interface Cluster { id: string; registrationToken?: string; status: string; nodes: { appliedVersion: number | null }[] }
let session: { cookie: string; csrf: string } | null = null;

export async function api<T = Entity>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  session ??= await login();
  const res = await fetch(CP + path, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), cookie: session.cookie, "x-csrf-token": session.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${CP}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ADMIN), signal: AbortSignal.timeout(5000) });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (res.status !== 200 || !cookie) throw new Error(`login as ${ADMIN.email} failed: HTTP ${res.status}`);
  const csrf = await fetch(`${CP}/auth/csrf`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  return { cookie, csrf: ((await csrf.json()) as { csrfToken: string }).csrfToken };
}

export async function compose(args: string[], registrationToken?: string) {
  await exec("docker", ["compose", ...(process.env.COMPOSE_FILE ? [] : ["-f", COMPOSE]), ...args], {
    cwd: ROOT,
    timeout: 60_000,
    env: { ...process.env, ...(registrationToken ? { GROMESH_REGISTRATION_TOKEN: registrationToken } : {}) },
  });
}

export async function publishAndConverge(envId: string, clusterId: string) {
  const published = await api<{ version: number }>("POST", `/environments/${envId}/snapshots`, {});
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const c = await api<Cluster>("GET", `/clusters/${clusterId}`);
    if (c.body.status === "converged" && c.body.nodes.length > 0 && c.body.nodes.every((n) => n.appliedVersion === published.body.version)) return;
    await sleep(200);
  }
  throw new Error(`cluster did not converge to version ${published.body.version}`);
}

