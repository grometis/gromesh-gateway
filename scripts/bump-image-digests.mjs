#!/usr/bin/env node
// Pins a published build of one of the project's images everywhere the repository references it.
// Usage: node scripts/bump-image-digests.mjs --image <kong|control-plane|ui|agent> --tag <tag> --digest sha256:<hex> [--check]
// kong: the compose default, both charts, the security checklist and the kind script comment (ci reads
// scripts/kong-image-ref.mjs: GITHUB_TOKEN cannot push workflow changes).
// control-plane, ui, agent: the chart values (repository/tag/digest block) of the component.
// The current reference is read from the files, so the script is idempotent and needs no state.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REGISTRY = "ghcr.io/grometis";
const KONG_FILES = [
  "deploy/compose/docker-compose.yml",
  "deploy/helm/data-plane/values.yaml",
  "deploy/helm/control-plane/values.yaml",
  "e2e/security-checklist.md",
  "e2e/kind/run.sh", // comment listing the images the kind cluster preloads
];
const APP_FILES = {
  "control-plane": ["deploy/helm/control-plane/values.yaml"],
  ui: ["deploy/helm/control-plane/values.yaml"],
  agent: ["deploy/helm/data-plane/values.yaml"],
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const image = arg("image");
const tag = arg("tag");
const digest = arg("digest");
const check = process.argv.includes("--check");
if (!image || !tag || !digest || (image !== "kong" && !APP_FILES[image])) {
  console.error("usage: bump-image-digests.mjs --image <kong|control-plane|ui|agent> --tag <tag> --digest sha256:<hex> [--check]");
  process.exit(2);
}
if (!/^[A-Za-z0-9._-]{1,128}$/.test(tag)) throw new Error(`invalid tag: ${tag}`);
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`invalid digest: ${digest}`);

const root = resolve(new URL("..", import.meta.url).pathname);
const read = (file) => readFileSync(resolve(root, file), "utf8");
const changed = [];

function apply(file, edit) {
  const before = read(file);
  const after = edit(before);
  if (after !== before) {
    changed.push(file);
    if (!check) writeFileSync(resolve(root, file), after);
  }
}

if (image === "kong") {
  const current = read(KONG_FILES[0]).match(/\$\{KONG_IMAGE:-([^@}]+)@(sha256:[0-9a-f]{64})\}/);
  if (!current) throw new Error("compose default is not <repository>@<digest>");
  const [, repository, oldDigest] = current;
  const oldTag = read(KONG_FILES[1]).match(/^\s*tag: "([^"]+)"\n\s*digest: "sha256:/m)?.[1];
  if (!oldTag) throw new Error("data-plane values: tag/digest pair not found");
  if (oldDigest === digest && oldTag === tag) {
    console.log(`already at ${repository}:${tag}@${digest}`);
    process.exit(0);
  }
  for (const file of KONG_FILES) {
    apply(file, (s) => s
      .replaceAll(oldDigest, digest)
      .replaceAll(`${repository}:${oldTag}`, `${repository}:${tag}`)
      .replaceAll(`tag: "${oldTag}"`, `tag: "${tag}"`));
  }
  console.log(`${check ? "would update" : "updated"} ${repository}: ${oldTag}@${oldDigest.slice(7, 19)} -> ${tag}@${digest.slice(7, 19)}`);
} else {
  const repository = `${REGISTRY}/gromesh-${image}`;
  // The block is "repository: [registry/]gromesh-<image>" followed by its tag and digest lines (comments allowed between).
  const block = new RegExp(`^(\\s*)repository: (?:${REGISTRY}/)?gromesh-${image}\\n((?:\\s*#.*\\n)*)(\\s*)tag: "([^"]*)"\\n((?:\\s*#.*\\n)*)(\\s*)digest: "([^"]*)"`, "m");
  let same = true;
  for (const file of APP_FILES[image]) {
    const current = read(file).match(block);
    if (!current) throw new Error(`${file}: image block for ${repository} not found`);
    if (current[4] !== tag || current[7] !== digest) same = false;
    apply(file, (s) => s.replace(block, (_, i1, c1, i2, _oldTag, c2, i3) =>
      `${i1}repository: ${repository}\n${c1}${i2}tag: "${tag}"\n${c2}${i3}digest: "${digest}"`));
  }
  if (same) {
    console.log(`already at ${repository}:${tag}@${digest}`);
    process.exit(0);
  }
  console.log(`${check ? "would update" : "updated"} ${repository}: ${tag}@${digest.slice(7, 19)}`);
}
for (const file of changed) console.log(`  ${file}`);
if (check && changed.length > 0) process.exit(1);
