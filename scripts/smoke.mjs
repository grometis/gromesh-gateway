#!/usr/bin/env node
// Smoke test against a real Kong: applies contracts/examples/snapshot.example.json via POST /config
// and checks routing, key-auth and rate-limiting. Requires `pnpm dev:up`. No dependencies (Node >= 22).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { assertStack, composeFiles } from "./stack-guard.mjs";

export async function smokeInside() {
  // Kong's Admin and status APIs listen only on Unix sockets (contract: agent-protocol); fetch cannot dial them.
  const ADMIN = process.env.KONG_ADMIN_URL ?? "unix:///kong/admin/admin.sock";
  const PROXY = process.env.KONG_PROXY_URL ?? "http://127.0.0.1:8000";
  const STATUS = process.env.KONG_STATUS_URL ?? "unix:///kong/admin/status.sock";
  const envelope = JSON.parse(readFileSync(new URL("../contracts/examples/snapshot.example.json", import.meta.url), "utf8"));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let failures = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };

  function kong(socket, path, body) {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: new URL(socket).pathname, path, method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : {} }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (chunk) => { text += chunk; }).on("end", () => resolve({ status: res.statusCode, text }));
      });
      req.on("error", reject).end(body);
    });
  }

  async function waitFor(socket, path, label, tries = 60) {
    for (let i = 0; i < tries; i++) {
      try {
        if ((await kong(socket, path)).status === 200) return;
      } catch {}
      await sleep(1000);
    }
    throw new Error(`${label} not reachable at ${socket}`);
  }

  await waitFor(STATUS, "/status", "Kong status API");
  const info = JSON.parse((await kong(ADMIN, "/")).text);
  check("Kong runs in DB-less mode", info.configuration?.database === "off", `version ${info.version}`);
  check("Kong has no TCP Admin API listener", info.configuration?.admin_listen?.join() === "off");

  const apply = await kong(ADMIN, "/config", JSON.stringify(envelope.config));
  check("POST /config accepted the compiled snapshot", apply.status === 201, `HTTP ${apply.status}${apply.status === 201 ? "" : " " + apply.text}`);

  // Config is applied asynchronously across workers; wait until the route answers.
  let noKey;
  for (let i = 0; i < 20; i++) {
    noKey = await fetch(`${PROXY}/echo`);
    if (noKey.status !== 404) break;
    await sleep(500);
  }
  check("request without key is rejected by key-auth", noKey.status === 401, `HTTP ${noKey.status}`);

  const withKey = await fetch(`${PROXY}/echo`, { headers: { apikey: "demo-key-123" } });
  const body = await withKey.text();
  check("request with key reaches the upstream", withKey.status === 200 && body.includes("Hostname"), `HTTP ${withKey.status}`);
  const limit = withKey.headers.get("x-ratelimit-limit-minute") ?? withKey.headers.get("ratelimit-limit");
  check("rate-limiting is active", limit === "60", `limit header = ${limit}`);
  check("consumer is identified", /X-Consumer-Username: demo-app/i.test(body));

  const wrongMethod = await fetch(`${PROXY}/echo`, { method: "DELETE", headers: { apikey: "demo-key-123" } });
  check("route only matches its methods", wrongMethod.status === 404, `DELETE → HTTP ${wrongMethod.status}`);

  console.log(failures === 0 ? "\nSmoke OK" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await assertStack("acceptance");
  execFileSync("docker", ["compose", ...composeFiles("deploy/compose/docker-compose.yml").flatMap((f) => ["-f", f]),
    "run", "--rm", "--no-deps", "-T", "smoke", "node", "--input-type=module", "-e",
    'const { smokeInside } = await import("/repo/scripts/smoke.mjs"); await smokeInside();'],
    { cwd: fileURLToPath(new URL("../", import.meta.url)), env: process.env, stdio: "inherit" });
}
