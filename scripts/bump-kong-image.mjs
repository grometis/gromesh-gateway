#!/usr/bin/env node
// Pins a new build of the project's Kong image (workflow kong-image) everywhere the repository references it:
// compose default, both charts, the ci workflow and the security checklist evidence.
// Usage: node scripts/bump-kong-image.mjs --tag 3.9.4-<sha> --digest sha256:<hex> [--check]
// The current reference is read from the compose default, so the script is idempotent and needs no state.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILES = [
  "deploy/compose/docker-compose.yml",
  "deploy/helm/data-plane/values.yaml",
  "deploy/helm/control-plane/values.yaml",
  ".github/workflows/ci.yml",
  "e2e/security-checklist.md",
  "e2e/kind/run.sh", // comment listing the images the kind cluster preloads
];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const tag = arg("tag");
const digest = arg("digest");
const check = process.argv.includes("--check");
if (!tag || !digest) {
  console.error("usage: bump-kong-image.mjs --tag <tag> --digest sha256:<hex> [--check]");
  process.exit(2);
}
if (!/^[A-Za-z0-9._-]{1,128}$/.test(tag)) throw new Error(`invalid tag: ${tag}`);
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`invalid digest: ${digest}`);

const root = resolve(new URL("..", import.meta.url).pathname);
const compose = readFileSync(resolve(root, FILES[0]), "utf8");
const current = compose.match(/\$\{KONG_IMAGE:-([^@}]+)@(sha256:[0-9a-f]{64})\}/);
if (!current) throw new Error("compose default is not <repository>@<digest>");
const [, repository, oldDigest] = current;
const dataPlane = readFileSync(resolve(root, FILES[1]), "utf8");
const oldTag = dataPlane.match(/^\s*tag: "([^"]+)"\n\s*digest: "sha256:/m)?.[1];
if (!oldTag) throw new Error("data-plane values: tag/digest pair not found");

if (oldDigest === digest && oldTag === tag) {
  console.log(`already at ${repository}:${tag}@${digest}`);
  process.exit(0);
}

const changed = [];
for (const file of FILES) {
  const path = resolve(root, file);
  const before = readFileSync(path, "utf8");
  const after = before
    .replaceAll(oldDigest, digest)
    .replaceAll(`${repository}:${oldTag}`, `${repository}:${tag}`)
    .replaceAll(`tag: "${oldTag}"`, `tag: "${tag}"`);
  if (after !== before) {
    changed.push(file);
    if (!check) writeFileSync(path, after);
  }
}
console.log(`${check ? "would update" : "updated"} ${repository}: ${oldTag}@${oldDigest.slice(7, 19)} -> ${tag}@${digest.slice(7, 19)}`);
for (const file of changed) console.log(`  ${file}`);
if (check && changed.length > 0) process.exit(1);
