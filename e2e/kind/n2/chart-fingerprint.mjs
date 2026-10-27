#!/usr/bin/env node
// Fingerprint of a Helm chart's content: sha256 over every template (and subchart template) by path, so a release that
// keeps the pinned version and images but runs other templates is told apart from the pinned artifact.
//   node chart-fingerprint.mjs tgz <chart.tgz>     the pinned artifact
//   node chart-fingerprint.mjs release < release.json   a release as Helm stores it (decoded Secret)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const digest = (entries) => {
  const h = createHash("sha256");
  for (const [name, data] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) h.update(`${name}\0${createHash("sha256").update(data).digest("hex")}\n`);
  return h.digest("hex");
};

function fromRelease(chart, prefix = "") {
  const own = (chart.templates ?? []).map((t) => [`${prefix}${t.name}`, Buffer.from(t.data, "base64")]);
  return [...own, ...(chart.dependencies ?? []).flatMap((d) => fromRelease(d, `${prefix}charts/${d.metadata.name}/`))];
}

function fromDir(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const rel = relative(root, path);
        // templates/ of the chart and of each unpacked subchart, as Helm records them.
        if (/(^|\/)templates\//.test(rel)) out.push([rel, readFileSync(path)]);
      }
    }
  };
  walk(root);
  return out;
}

const [mode, file] = process.argv.slice(2);
if (mode === "tgz") {
  const dir = mkdtempSync(join(tmpdir(), "chart-fp-"));
  try {
    execFileSync("tar", ["-xzf", file, "-C", dir]);
    const [top] = readdirSync(dir);
    console.log(digest(fromDir(join(dir, top))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else if (mode === "release") {
  console.log(digest(fromRelease(JSON.parse(readFileSync(0, "utf8")).chart)));
} else {
  console.error("usage: chart-fingerprint.mjs tgz <file> | release < release.json");
  process.exit(2);
}
