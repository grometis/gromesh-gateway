#!/usr/bin/env node
// Fingerprint of a Helm chart as a release carries it: every template, default value, schema and file (subcharts
// included), so a release that keeps the pinned version and images but runs other templates or defaults is told apart
// from the pinned artifact. Both sides are release JSON: the installed one (decoded Secret) and the pinned chart's
// `helm install --dry-run=client -o json`.
//   node chart-fingerprint.mjs < release.json
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const sha = (data) => createHash("sha256").update(data).digest("hex");
// Canonical JSON: sorted keys, so the same values hash the same whatever order Helm wrote them in.
const canonical = (v) => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;

function entries(chart, prefix = "") {
  const files = [...(chart.templates ?? []), ...(chart.files ?? [])].map((f) => [`${prefix}${f.name}`, sha(Buffer.from(f.data, "base64"))]);
  return [
    ...files,
    [`${prefix}values`, sha(canonical(chart.values ?? {}))],
    [`${prefix}schema`, sha(chart.schema ? Buffer.from(chart.schema, "base64") : "")],
    [`${prefix}metadata`, sha(canonical({ name: chart.metadata?.name, version: chart.metadata?.version, appVersion: chart.metadata?.appVersion }))],
    ...(chart.dependencies ?? []).flatMap((d) => entries(d, `${prefix}charts/${d.metadata.name}/`)),
  ];
}

const list = entries(JSON.parse(readFileSync(0, "utf8")).chart).sort(([a], [b]) => (a < b ? -1 : 1));
console.log(sha(list.map(([name, h]) => `${name}\0${h}\n`).join("")));
