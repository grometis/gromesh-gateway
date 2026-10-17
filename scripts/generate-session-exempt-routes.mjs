#!/usr/bin/env node
// Run from any directory: node scripts/generate-session-exempt-routes.mjs [--check].
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reuse the control plane's pinned YAML parser; this generator adds no dependency.
const { parse } = createRequire(new URL("../apps/control-plane/package.json", import.meta.url))("yaml");
const root = fileURLToPath(new URL("../", import.meta.url));
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const contractsDir = option("--contracts-dir", resolve(root, "contracts"));
const output = option("--output", resolve(root, "apps/control-plane/src/auth/session-exempt-routes.generated.ts"));
const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const routes = [];
for (const [file, agent] of [["control-plane.openapi.yaml", false], ["agent-protocol.openapi.yaml", true]]) {
  const doc = parse(readFileSync(resolve(contractsDir, file), "utf8"));
  const prefix = new URL(doc.servers[0].url, "http://localhost").pathname.replace(/\/$/, "");
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.has(method)) continue;
      // An omitted operation security inherits the document's security (OpenAPI 3.1).
      const security = operation.security ?? doc.security;
      if (agent || security === undefined || security.length === 0) {
        routes.push({ method: method.toUpperCase(), path: prefix + path });
      }
    }
  }
}
routes.sort((a, b) => a.path.localeCompare(b.path, "en") || a.method.localeCompare(b.method, "en"));
const source = `// Generated from both OpenAPI contracts. Do not edit by hand.\n// Regenerate: node scripts/generate-session-exempt-routes.mjs\nexport const SESSION_EXEMPT_ROUTES = ${JSON.stringify(routes, null, 2)} as const;\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== source) {
    console.error("Session exemptions differ from the contracts. Run node scripts/generate-session-exempt-routes.mjs");
    process.exitCode = 1;
  }
} else {
  writeFileSync(output, source);
}
