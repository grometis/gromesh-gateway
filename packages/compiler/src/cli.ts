#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildSnapshot, compile, CompileError, type GatewayState } from "./index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    envelope: { type: "boolean", default: false },
    version: { type: "string", default: "1" },
    "environment-id": { type: "string", default: "00000000-0000-4000-8000-000000000000" },
    "created-at": { type: "string" },
  },
});

const file = positionals[0];
if (!file) {
  console.error("usage: gromesh-compile <state.json> [--envelope --version N --environment-id UUID --created-at ISO]");
  process.exit(2);
}

try {
  const state = JSON.parse(readFileSync(file, "utf8")) as GatewayState;
  const out = values.envelope
    ? buildSnapshot(state, {
        version: Number(values.version),
        environmentId: values["environment-id"]!,
        ...(values["created-at"] ? { createdAt: values["created-at"] } : {}),
      })
    : compile(state);
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
} catch (err) {
  if (err instanceof CompileError) {
    for (const issue of err.issues) console.error(`${issue.path}: ${issue.message}`);
    process.exit(1);
  }
  throw err;
}
