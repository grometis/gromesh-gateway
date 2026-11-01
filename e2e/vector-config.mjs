#!/usr/bin/env node
// Backlog 18: the collector runs without --dangerously-allow-env-var-interpolation. Only Docker is needed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pullImages, VECTOR_IMAGE, VECTOR_TEST } from "./docker-images.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const docker = (args, timeout = 60_000) => exec("docker", args, { cwd: root, timeout, maxBuffer: 8 * 1024 * 1024 });
const directories = ["deploy/observability/vector", "deploy/helm/data-plane/files/vector"];
const base = {
  GROMESH_CLUSTER_ID: "00000000-0000-4000-8000-00000000c0c0",
  GROMESH_ENVIRONMENT_ID: "any",
  GROMESH_COLLECTOR_TOKEN: randomBytes(24).toString("hex"),
  CLICKHOUSE_PASSWORD: `pw-${randomBytes(12).toString("hex")}`,
};
const envArgs = (env) => Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
// The same isolation as compose and the chart: read-only root, config read-only, only /var/lib/vector writable.
const runArgs = (directory, env) => ["--user", "65534:65534", "--read-only", "--tmpfs", "/var/lib/vector:uid=65534",
  ...envArgs(env), "-v", `${root}${directory}:/etc/vector:ro`, "--entrypoint", "sh", VECTOR_IMAGE];
const results = [];
const record = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

// Starts the entrypoint for up to 6 s; returns its exit code (null if still running) and its output.
async function start(directory, env) {
  const result = await docker(["run", "--rm", ...runArgs(directory, env), "-c",
    "timeout 6 sh /etc/vector/entrypoint.sh; code=$?; echo \"exit=$code\"; cat /var/lib/vector/vector.yaml 2>/dev/null"], 120_000)
    .then((r) => r, (e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
  const output = `${result.stdout}${result.stderr}`;
  const code = Number(/exit=(\d+)/.exec(output)?.[1]);
  // busybox timeout ends a still-running Vector with SIGTERM: 143.
  return { running: code === 143, code, output };
}

async function main() {
  await pullImages([VECTOR_IMAGE]);
  for (const name of ["vector.yaml", "entrypoint.sh", "config.sh"]) {
    record(`chart copy of ${name} is identical`, readFileSync(`${root}${directories[0]}/${name}`, "utf8") === readFileSync(`${root}${directories[1]}/${name}`, "utf8"));
  }

  for (const directory of directories) {
    const entrypoint = readFileSync(`${root}${directory}/entrypoint.sh`, "utf8");
    record(`${directory}: entrypoint has no interpolation flag`, !/dangerously-allow-env-var-interpolation/.test(entrypoint));

    // The values from the environment are applied: the collector listens on the address it was given.
    const listen = "127.0.0.1:18080";
    const name = `gromesh-vector-config-${randomBytes(4).toString("hex")}`;
    await docker(["run", "-d", "--name", name, ...runArgs(directory, { ...base, GROMESH_COLLECTOR_ADDRESS: listen,
      GROMESH_COLLECTOR_METRICS_ADDRESS: "127.0.0.1:19598", CLICKHOUSE_ENDPOINT: "http://clickhouse.invalid:8123/", CLICKHOUSE_DATABASE: "gromesh_b18" }),
      "/etc/vector/entrypoint.sh"]);
    try {
      let status = "";
      for (let i = 0; i < 40 && !status; i++) {
        await sleep(500);
        // busybox wget prints "HTTP/1.1 401 ..." with -S; it exits non-zero on 4xx, which is expected here.
        const probe = await docker(["exec", name, "sh", "-c", `wget -S -q -O /dev/null --post-data=[] http://${listen}/kong 2>&1 || true`]).catch(() => ({ stdout: "" }));
        status = /HTTP\/1\.1 (\d{3})/.exec(probe.stdout)?.[1] ?? "";
      }
      record(`${directory}: collector listens on GROMESH_COLLECTOR_ADDRESS and still requires the token`, status === "401", `status ${status || "none"}`);
      const { stdout: rendered } = await docker(["exec", name, "cat", "/var/lib/vector/vector.yaml"]);
      record(`${directory}: rendered config carries the given values`, rendered.includes(`address: "${listen}"`)
        && rendered.includes('endpoint: "http://clickhouse.invalid:8123/"') && rendered.includes('database: "gromesh_b18"') && !/@@[a-z_]+@@/.test(rendered));
      record(`${directory}: the password never reaches the rendered file`, !rendered.includes(base.CLICKHOUSE_PASSWORD)
        && rendered.includes('password: "SECRET[env.clickhouse_password]"'));
    } finally {
      await docker(["rm", "-f", name]).catch(() => {});
    }

    // Values that would add or change configuration are refused before Vector starts.
    const injected = "gromesh-injected-b18";
    const refusals = [
      ["newline in GROMESH_COLLECTOR_ADDRESS", { GROMESH_COLLECTOR_ADDRESS: `0.0.0.0:8080"\n    path: /${injected}` }, "GROMESH_COLLECTOR_ADDRESS"],
      ["quote in CLICKHOUSE_ENDPOINT", { CLICKHOUSE_ENDPOINT: `http://clickhouse:8123" # ${injected}` }, "CLICKHOUSE_ENDPOINT"],
      ["invalid CLICKHOUSE_DATABASE", { CLICKHOUSE_DATABASE: `gromesh; ${injected}` }, "CLICKHOUSE_DATABASE"],
      ["metrics address without port", { GROMESH_COLLECTOR_METRICS_ADDRESS: "0.0.0.0" }, "GROMESH_COLLECTOR_METRICS_ADDRESS"],
      ["quote in CLICKHOUSE_PASSWORD", { CLICKHOUSE_PASSWORD: `p"\n${injected}` }, "CLICKHOUSE_PASSWORD"],
      ["missing CLICKHOUSE_PASSWORD", { CLICKHOUSE_PASSWORD: "" }, "CLICKHOUSE_PASSWORD"],
    ];
    for (const [label, override, variable] of refusals) {
      const { running, code, output } = await start(directory, { ...base, ...override });
      const config = output.split(/exit=\d+\n?/)[1] ?? "";
      record(`${directory}: refuses ${label}`, !running && code !== 0 && output.includes(`${variable} is missing or not in the accepted format`)
        && !config.includes(injected), `exit ${code}`);
    }

    // ${VAR} written in a value is kept literally: nothing in the environment is expanded into the config.
    const literal = await docker(["run", "--rm", ...runArgs(directory, { ...base, CLICKHOUSE_PASSWORD: "${GROMESH_COLLECTOR_TOKEN}" }), "-c",
      `printf '{"version":"1.0","secrets":["clickhouse_password","other"]}' | sh /etc/vector/config.sh secret`]);
    const answer = JSON.parse(literal.stdout);
    record(`${directory}: secret backend returns values literally and only the password`, answer.clickhouse_password.value === "${GROMESH_COLLECTOR_TOKEN}"
      && answer.other.value === null && answer.other.error === "unknown secret");

    // The transforms keep their unit tests after rendering.
    const tests = await docker(["run", "--rm", ...envArgs({ ...base, GROMESH_KEY_NAMES: '["legacy-key"]' }),
      "-v", `${root}${directory}:/etc/vector:ro`, "-v", `${root}deploy/observability/vector:/tests:ro`, ...VECTOR_TEST,
      "/tests/key-names.tests.yaml", "/tests/path-masking.tests.yaml", "/tests/retention.tests.yaml"], 120_000)
      .then((r) => `${r.stdout}${r.stderr}`, (e) => `${e.stdout ?? ""}${e.stderr ?? ""}FAILED`);
    // The sanitizer logs "Mapping failed" for the events some tests expect it to drop: only a failed test counts.
    record(`${directory}: unit tests pass on the rendered config`, !tests.endsWith("FAILED") && !/\.\.\. failed/.test(tests) && /\.\.\. passed/.test(tests));

    // Negative control: the file Vector would read without the render step does not load, so the values above can
    // only have come from config.sh, not from any interpolation.
    const raw = await docker(["run", "--rm", ...runArgs(directory, base), "-c", "vector validate --no-environment /etc/vector/vector.yaml; echo exit=$?"])
      .then((r) => `${r.stdout}${r.stderr}`, (e) => `${e.stdout ?? ""}${e.stderr ?? ""}`);
    record(`${directory}: control: the unrendered config is refused`, /exit=[1-9]/.test(raw) && /invalid socket address/.test(raw));
  }

  const failed = results.filter((r) => !r.ok);
  assert.equal(failed.length, 0, `${failed.length} check(s) failed: ${failed.map((r) => r.name).join("; ")}`);
  console.log(`vector-config: ${results.length}/${results.length} checks passed`);
}

await main();
