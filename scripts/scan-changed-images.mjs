#!/usr/bin/env node
// Application build inputs rebuild native images for Trivy (CRITICAL fails) and the publication's Syft content gate.
// Changed pinned references (compose, charts, kind, e2e and CI services) are pulled for Trivy. Kong builds stay on Trivy.
// SCAN_PLATFORM selects the native platform. SBOM identity uses GITHUB_SHA, TARGET_ARCH, RUNNER_ARCH and the local image ID.
// Usage: SCAN_PLATFORM=linux/arm64 TARGET_ARCH=arm64 node scripts/scan-changed-images.mjs <base-ref>
import { execFileSync, spawnSync } from "node:child_process";
import { applicationBuilds, validatePrImageSbom } from "./ci-pr-sbom.mjs";

const TRIVY = "aquasec/trivy:0.58.1@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7";
const base = process.argv[2];
const platform = process.env.SCAN_PLATFORM || "linux/amd64";
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
for (const app of applicationBuilds(changed)) {
  builds.push({ name: app, file: `apps/${app}/Dockerfile`, context: "." });
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
const skipped = [];
const scanned = [];
const scan = (image) => {
  scanned.push(image);
  console.log(`\n== Trivy (CRITICAL fails, ${platform}): ${image}`);
  const ok = run("docker", ["run", "--rm", "-v", "/var/run/docker.sock:/var/run/docker.sock:ro", "-v", "trivy-cache:/root/.cache/trivy",
    TRIVY, "image", "--image-src", "docker", "--platform", platform, "--scanners", "vuln", "--severity", "CRITICAL", "--exit-code", "1",
    "--ignorefile", "/dev/null", "--no-progress", "--timeout", "15m", image]);
  if (!ok) failures.push(image);
};
for (const b of builds) {
  const tag = `gromesh-scan/${b.name}:pr`;
  console.log(`\n== Build ${b.file} (${platform})`);
  if (!run("docker", ["build", "--platform", platform, "-t", tag, "-f", b.file, b.context])) { failures.push(`${tag} (build failed)`); continue; }
  if (b.name !== "kong") {
    try {
      validatePrImageSbom(tag, b.name);
    } catch {
      console.error("CI supply chain rejected.");
      failures.push(`${tag} (SBOM rejected)`);
    }
  }
  scan(tag);
}
/** Platforms (os/arch) a reference is published for: the index entries, or the single image's own platform. */
const platformsOf = (ref) => {
  const inspect = spawnSync("docker", ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Image}}"], { encoding: "utf8" });
  if (inspect.status !== 0) return null;
  const image = JSON.parse(inspect.stdout);
  return image.architecture ? [`${image.os}/${image.architecture}`] : Object.keys(image);
};
// Third-party references used only by amd64 CI tooling may lack other platforms; the project's own images may not.
const OWN = /^ghcr\.io\/grometis\/gromesh-/;
for (const ref of pulls) {
  console.log(`\n== Pull ${ref} (${platform})`);
  const platforms = platformsOf(ref);
  if (platforms && !platforms.includes(platform)) {
    if (OWN.test(ref)) failures.push(`${ref} (not published for ${platform}: ${platforms.join(", ")})`);
    else skipped.push(ref);
    continue;
  }
  if (!run("docker", ["pull", "--platform", platform, ref])) { failures.push(`${ref} (pull failed)`); continue; }
  scan(ref);
}
console.log(`\nScanned for ${platform}: ${scanned.join(", ") || "nothing"}`);
if (skipped.length > 0) console.log(`Not published for ${platform} (third-party, skipped): ${skipped.join(", ")}`);
if (failures.length > 0) {
  console.error(`CRITICAL vulnerabilities, SBOM rejections or failures in: ${failures.join(", ")}`);
  process.exit(1);
}
