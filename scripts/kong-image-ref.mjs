#!/usr/bin/env node
// Prints the project's Kong image as the ci workflow needs it, read from the single source of truth
// (the compose default by digest and the chart tag): "<repository>@<digest> <repository>:<tag>".
// GITHUB_TOKEN cannot push changes to .github/workflows, so image-digests never edits ci.yml; ci reads this instead.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const compose = readFileSync(resolve(root, "deploy/compose/docker-compose.yml"), "utf8");
const byDigest = compose.match(/\$\{KONG_IMAGE:-([^@}]+)@(sha256:[0-9a-f]{64})\}/);
if (!byDigest) throw new Error("compose default is not <repository>@<digest>");
const values = readFileSync(resolve(root, "deploy/helm/data-plane/values.yaml"), "utf8");
const tag = values.match(/^\s*repository: (\S+)\n(?:\s*#.*\n)*\s*tag: "([^"]+)"\n(?:\s*#.*\n)*\s*digest: "sha256:/m);
if (!tag || tag[1] !== byDigest[1]) throw new Error("data-plane values: kong image tag not found or repository differs from compose");
console.log(`${byDigest[1]}@${byDigest[2]} ${byDigest[1]}:${tag[2]}`);
