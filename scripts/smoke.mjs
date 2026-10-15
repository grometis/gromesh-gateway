#!/usr/bin/env node
// Smoke test against a real Kong: applies contracts/examples/snapshot.example.json via POST /config
// and checks routing, key-auth and rate-limiting. Requires `pnpm dev:up`. No dependencies (Node >= 22).
import { readFileSync } from "node:fs";

const ADMIN = process.env.KONG_ADMIN_URL ?? "http://127.0.0.1:8001";
const PROXY = process.env.KONG_PROXY_URL ?? "http://127.0.0.1:8000";
const STATUS = process.env.KONG_STATUS_URL ?? "http://127.0.0.1:8100";
const envelope = JSON.parse(readFileSync(new URL("../contracts/examples/snapshot.example.json", import.meta.url), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function waitFor(url, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`${label} not reachable at ${url}`);
}

await waitFor(`${STATUS}/status`, "Kong status API");
const info = await (await fetch(ADMIN)).json();
check("Kong runs in DB-less mode", info.configuration?.database === "off", `version ${info.version}`);

const apply = await fetch(`${ADMIN}/config`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(envelope.config),
});
check("POST /config accepted the compiled snapshot", apply.status === 201, `HTTP ${apply.status}${apply.ok ? "" : " " + (await apply.text())}`);

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
