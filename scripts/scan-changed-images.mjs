#!/usr/bin/env node
// Trivy gate for a change: every image it touches must have no CRITICAL vulnerability, the same rule as the images
// workflow. An image is touched when its Dockerfile (or images/kong/**) changes, then it is built here, or when a
// pinned reference (compose, chart values, kind manifests, e2e runners, ci.yml services) is added or changed, then
// that exact reference is pulled. Usage: node scripts/scan-changed-images.mjs <base-ref>
import { execFileSync, spawnSync } from "node:child_process";

const TRIVY = "aquasec/trivy:0.58.1@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7";
const base = process.argv[2];
if (!base) {
  console.error("usage: node scripts/scan-changed-images.mjs <base-ref>");
  process.exit(2);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const show = (rev, file) => {
  try { return git("show", `${rev}:${file}`); } catch { return ""; }
};
const changed = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);

const builds = [];
for (const app of ["agent", "control-plane", "ui"]) {
  if (changed.includes(`apps/${app}/Dockerfile`)) builds.push({ name: app, file: `apps/${app}/Dockerfile`, context: "." });
}
if (changed.some((f) => f.startsWith("images/kong/"))) builds.push({ name: "kong", file: "images/kong/Dockerfile", context: "images/kong" });

const REF_FILES = /^(deploy\/compose\/docker-compose\.yml|deploy\/helm\/[^/]+\/values\.yaml|e2e\/kind\/[^/]+\.ya?ml|e2e\/docker-images\.mjs|\.github\/workflows\/ci\.yml)$/;
const REF = /^[a-z0-9][a-z0-9._\/-]*(:[\w][\w.-]*)?(@sha256:[0-9a-f]{64})?$/;
/** Image references a file pins: `image:` lines (compose defaults resolved), chart repository/tag/digest blocks and
 * string constants that look like an image. References still holding a variable or a template are skipped. */
function refsOf(text) {
  const refs = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const image = /^\s*-?\s*image:\s*["']?([^"'\s#]+)/.exec(line)?.[1];
    if (image) refs.push(image.replace(/^\$\{[A-Z_]+:-(.+)\}$/, "$1"));
    const pulled = /docker pull (?:-q |--quiet )?["']?([^"'\s]+)/.exec(line)?.[1];
    if (pulled) refs.push(pulled);
    const repository = /^\s*repository:\s*["']?([^"'\s#]+)/.exec(line)?.[1];
    if (repository) {
      const block = lines.slice(i + 1, i + 6).join("\n");
      const tag = /^\s*tag:\s*["']?([^"'\s#]*)/m.exec(block)?.[1];
      const digest = /^\s*digest:\s*["']?(sha256:[0-9a-f]{64})/m.exec(block)?.[1];
      if (tag || digest) refs.push(`${repository}${tag ? `:${tag}` : ""}${digest ? `@${digest}` : ""}`);
    }
    for (const m of line.matchAll(/["']([a-z0-9][\w./-]*(?::[\w.-]+)?@sha256:[0-9a-f]{64}|[a-z0-9][\w./-]*\/[\w./-]+:[\w.-]+)["']/g)) refs.push(m[1]);
  }
  return [...new Set(refs.filter((r) => REF.test(r) && !r.includes("${")))];
}

const pulls = new Set();
for (const file of changed.filter((f) => REF_FILES.test(f))) {
  const before = new Set(refsOf(show(base, file)));
  for (const ref of refsOf(show("HEAD", file))) if (!before.has(ref)) pulls.add(ref);
}

if (builds.length === 0 && pulls.size === 0) {
  console.log("No image changes: nothing to scan.");
  process.exit(0);
}
const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit" }).status === 0;
const failures = [];
const scan = (image) => {
  console.log(`\n== Trivy (CRITICAL fails): ${image}`);
  const ok = run("docker", ["run", "--rm", "-v", "/var/run/docker.sock:/var/run/docker.sock:ro", "-v", "trivy-cache:/root/.cache/trivy",
    TRIVY, "image", "--image-src", "docker", "--scanners", "vuln", "--severity", "CRITICAL", "--exit-code", "1",
    "--ignorefile", "/dev/null", "--no-progress", "--timeout", "15m", image]);
  if (!ok) failures.push(image);
};
for (const b of builds) {
  const tag = `gromesh-scan/${b.name}:pr`;
  console.log(`\n== Build ${b.file}`);
  if (!run("docker", ["build", "-t", tag, "-f", b.file, b.context])) { failures.push(`${tag} (build failed)`); continue; }
  scan(tag);
}
for (const ref of pulls) {
  console.log(`\n== Pull ${ref}`);
  if (!run("docker", ["pull", ref])) { failures.push(`${ref} (pull failed)`); continue; }
  scan(ref);
}
console.log(`\nScanned: ${[...builds.map((b) => `${b.file} (built)`), ...pulls].join(", ")}`);
if (failures.length > 0) {
  console.error(`CRITICAL vulnerabilities or failures in: ${failures.join(", ")}`);
  process.exit(1);
}
