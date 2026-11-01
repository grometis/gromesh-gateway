import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { stackProblems, type Container } from "../scripts/stack-guard.mjs";

// Isolated runs (GROMESH_STACK_ISOLATED=1) refuse before the first write when a destination is not explicit or not
// served by the run's own compose project. Needs only Docker (`docker ps`), not a running stack.
const exec = promisify(execFile);
const project = "gromesh-guard-test";
const env = {
  GROMESH_STACK_ISOLATED: "1", COMPOSE_PROJECT_NAME: project, COMPOSE_FILE: "a.yml:b.yml", UI_URL: "http://127.0.0.1:15174",
  CLICKHOUSE_URL: "http://127.0.0.1:18123", CLICKHOUSE_PASSWORD: "own-password", POSTGRES_PORT: "55442",
};
const own = (service: string, ...ports: number[]): Container => ({ project, service, ports });
const stack = [own("ui", 15174), own("clickhouse", 18123), own("postgres", 55442), own("control-plane", 3000),
  own("kong", 8000, 8443, 8100), own("echo", 8080)];

test("an explicit, matching isolated stack passes", () => {
  expect(stackProblems("acceptance", env, stack)).toEqual([]);
});

test("missing variables, the standard project, shared ports and development credentials are refused", () => {
  const { CLICKHOUSE_URL: _, ...missing } = env;
  expect(stackProblems("acceptance", missing, stack)).toContain("CLICKHOUSE_URL must be set explicitly");
  expect(stackProblems("acceptance", { ...env, COMPOSE_PROJECT_NAME: "gromesh" }, stack).join("\n"))
    .toContain('must not be the standard project "gromesh"');
  // The default ClickHouse port of another project: divergent destination.
  const shared = [...stack, { project: "gromesh", service: "clickhouse", ports: [8123] }];
  expect(stackProblems("acceptance", { ...env, CLICKHOUSE_URL: "http://127.0.0.1:8123" }, shared))
    .toContain("CLICKHOUSE_URL (port 8123) must be published by gromesh-guard-test/clickhouse, found gromesh/clickhouse");
  // A port the tests use without a variable, served by another project.
  const foreign = stack.map((c) => c.service === "control-plane" ? { ...c, project: "other" } : c);
  expect(stackProblems("acceptance", env, foreign))
    .toContain("control-plane (fixed in the tests) (port 3000) must be published by gromesh-guard-test/control-plane, found other/control-plane");
  expect(stackProblems("acceptance", { ...env, CLICKHOUSE_PASSWORD: "gromesh-dev-observability" }, stack))
    .toContain("CLICKHOUSE_PASSWORD must not be a development default credential");
  expect(stackProblems("acceptance", { ...env, UI_URL: "http://example.test:5174" }, stack)).toContain("UI_URL must be a loopback URL or port");
  expect(stackProblems("acceptance", { ...env, CP_URL: "http://127.0.0.1:13000/api/v1" }, stack))
    .toContain("CP_URL must use port 3000: other tests reach that port directly");
  const problems = stackProblems("integration", { GROMESH_STACK_ISOLATED: "1", COMPOSE_PROJECT_NAME: project }, stack);
  for (const name of ["TEST_DATABASE_URL", "TEST_CLICKHOUSE_URL", "KONG_VALIDATOR_URL"]) expect(problems).toContain(`${name} must be set explicitly`);
  // No value is ever echoed, only names, ports and services.
  expect(stackProblems("acceptance", { ...env, CLICKHOUSE_PASSWORD: "gromesh-dev-observability" }, stack).join("\n"))
    .not.toContain("gromesh-dev-observability");
});

// Records every outbound request and every child process of a script into a file, without letting any through.
const trap = `
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
const log = (entry) => appendFileSync(process.env.TRAP_FILE, JSON.stringify(entry) + "\\n");
globalThis.fetch = async (url) => { log({ fetch: String(url) }); throw new Error("trapped fetch"); };
for (const name of ["http", "https"]) {
  const mod = require(name);
  mod.request = mod.get = (...args) => { log({ [name]: String(args[0]?.href ?? args[0]?.host ?? args[0]) }); throw new Error("trapped request"); };
}
const cp = require("child_process");
const original = cp.execFile;
cp.execFile = (file, args, ...rest) => {
  log({ exec: [file, ...(args ?? [])].join(" ") });
  // docker ps is the guard's own read; anything else is a would-be mutation and is blocked.
  if (file === "docker" && args?.[0] === "ps") return original(file, args, ...rest);
  throw new Error("trapped exec");
};
for (const name of ["spawn", "exec", "execFileSync", "spawnSync", "execSync"]) {
  const real = cp[name];
  cp[name] = (...args) => { log({ [name]: String(args[0]) }); throw new Error("trapped " + name + " " + typeof real); };
}
syncBuiltinESMExports();
`;

async function runTrapped(script: string, extraEnv: Record<string, string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "gromesh-stack-guard-"));
  try {
    const preload = join(dir, "trap.mjs");
    const record = join(dir, "calls.jsonl");
    writeFileSync(preload, trap);
    writeFileSync(record, "");
    const scriptEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...extraEnv, TRAP_FILE: record })) if (value !== undefined) scriptEnv[key] = value;
    const result = await exec(process.execPath, ["--import", preload, fileURLToPath(new URL(script, import.meta.url))],
      { env: scriptEnv, timeout: 60_000 }).then(() => ({ code: 0, stderr: "" }), (e: { code?: number; stderr?: string }) => ({ code: e.code ?? 1, stderr: e.stderr ?? "" }));
    const calls = readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, string>);
    return { ...result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const clean = { CLICKHOUSE_URL: undefined, COMPOSE_PROJECT_NAME: undefined, COMPOSE_FILE: undefined, UI_URL: undefined,
  CLICKHOUSE_PASSWORD: undefined, POSTGRES_PORT: undefined };

for (const script of ["./route-retention.mjs", "./key-names.mjs", "./path-masking.mjs", "./collector-auth.mjs", "./resilient-observability.mjs"]) {
  test(`${script}: a missing variable is refused before the first request or command`, async () => {
    const { CLICKHOUSE_URL: _, ...rest } = env;
    const { code, stderr, calls } = await runTrapped(script, { ...clean, ...rest });
    expect(code).not.toBe(0);
    expect(stderr).toContain("Isolated run refused before any write");
    expect(stderr).toContain("CLICKHOUSE_URL must be set explicitly");
    expect(calls.filter((c) => !c.exec?.startsWith("docker ps"))).toEqual([]);
  });
}

test("a divergent destination is refused and never contacted", async () => {
  let hits = 0;
  const server = createServer((_, res) => { hits++; res.end("1"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    // Without the trap: the script is free to write, and only the guard stops it.
    const result = await exec(process.execPath, [fileURLToPath(new URL("./route-retention.mjs", import.meta.url))], {
      env: { ...process.env, ...env, CLICKHOUSE_URL: `http://127.0.0.1:${port}` }, timeout: 60_000 })
      .then(() => ({ code: 0, stderr: "" }), (e: { code?: number; stderr?: string }) => ({ code: e.code ?? 1, stderr: e.stderr ?? "" }));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`CLICKHOUSE_URL (port ${port}) must be published by ${project}/clickhouse, found no container`);
    expect(hits).toBe(0);
  } finally {
    server.close();
  }
});

test("without the flag the documented modes keep their defaults and nothing is checked", async () => {
  const { calls } = await runTrapped("./route-retention.mjs", { ...clean, GROMESH_STACK_ISOLATED: undefined });
  // The script proceeds to its first query (trapped here), with no docker ps before it.
  expect(calls[0]).toEqual({ fetch: "http://127.0.0.1:8123" });
  expect(calls.some((c) => c.exec)).toBe(false);
});
