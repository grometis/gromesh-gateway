// Regenerates src/plugin-catalog/kong-<major.minor>/ from a reference Kong's Admin API (the compose one by default).
// Usage: node scripts/generate-plugin-catalog.mjs [adminUrl]
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const adminUrl = (process.argv[2] ?? process.env.KONG_VALIDATOR_URL ?? "http://127.0.0.1:8001").replace(/\/$/, "");

const CATEGORIES = {
  authentication: ["basic-auth", "hmac-auth", "jwt", "key-auth", "ldap-auth", "oauth2", "session"],
  security: ["acl", "acme", "bot-detection", "cors", "ip-restriction"],
  "traffic-control": ["proxy-cache", "rate-limiting", "redirect", "request-size-limiting", "request-termination", "response-ratelimiting"],
  transformation: ["correlation-id", "grpc-gateway", "grpc-web", "request-transformer", "response-transformer", "standard-webhooks"],
  logging: ["file-log", "http-log", "loggly", "syslog", "tcp-log", "udp-log"],
  observability: ["datadog", "opentelemetry", "prometheus", "statsd", "zipkin"],
  serverless: ["aws-lambda", "azure-functions", "post-function", "pre-function"],
};
// Plugins that need Kong's database and therefore cannot run on our DB-less data plane.
const NOT_DBLESS = new Set(["oauth2"]);

const categoryOf = (name) =>
  name.startsWith("ai-") ? "ai" : (Object.entries(CATEGORIES).find(([, names]) => names.includes(name))?.[0] ?? "other");

async function get(path) {
  const res = await fetch(adminUrl + path);
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

const info = await get("/");
if (info.edition && info.edition !== "community") throw new Error(`reference Kong must be OSS, got edition "${info.edition}"`);
const version = String(info.version);
const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/plugin-catalog", `kong-${version.split(".").slice(0, 2).join(".")}`);

const { enabled_plugins: names } = await get("/plugins/enabled");
names.sort();

await mkdir(outDir, { recursive: true });
for (const f of await readdir(outDir)) if (f.endsWith(".json")) await rm(resolve(outDir, f));

const items = [];
for (const name of names) {
  const schema = await get(`/schemas/plugins/${name}`);
  await writeFile(resolve(outDir, `${name}.json`), JSON.stringify(schema, null, 2) + "\n");
  // Custom plugins (images/kong/plugins) will be marked "custom" once there are any.
  items.push({ name, category: categoryOf(name), source: "bundled", supportedInDbless: !NOT_DBLESS.has(name) });
}
await writeFile(resolve(outDir, "_catalog.json"), JSON.stringify({ kongVersion: version, items }, null, 2) + "\n");
console.log(`wrote ${items.length} plugin schemas from Kong ${version} to ${outDir}`);
