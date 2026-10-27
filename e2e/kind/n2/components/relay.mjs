// The data plane's way to the control plane in the N2 components suite: a transparent HTTP relay that, only while
// /tmp/relay/arm.json names {admissionId, seq}, leaves that one report out of every batch the agent submits. It lets
// the suite deliver n+1 without n, which a well-behaved agent never does. It logs report seqs and acks, never headers.
import http from "node:http";
import { readFileSync } from "node:fs";

const UPSTREAM = process.env.UPSTREAM;
const REPORTS = "/agent/v2/isolation/reports";
const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "accept-encoding", "upgrade", "proxy-connection"]);
const log = (entry) => console.log(JSON.stringify({ at: Date.now(), ...entry }));

function armed() {
  try {
    const arm = JSON.parse(readFileSync("/tmp/relay/arm.json", "utf8"));
    return typeof arm.admissionId === "string" && Number.isInteger(arm.seq) ? arm : null;
  } catch {
    return null;
  }
}

const claims = (report) => {
  const c = JSON.parse(Buffer.from(report.payload, "base64url"));
  return { admissionId: c.admissionId, seq: c.seq };
};

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = Buffer.concat(chunks);
  let note = null;
  if (req.method === "POST" && req.url === REPORTS) {
    try {
      const parsed = JSON.parse(body);
      const seen = parsed.reports.map(claims);
      note = { received: seen.map((s) => s.seq), admissionId: seen[0]?.admissionId };
      const arm = armed();
      if (arm) {
        const keep = parsed.reports.filter((_, i) => !(seen[i].admissionId === arm.admissionId && seen[i].seq === arm.seq));
        if (keep.length !== parsed.reports.length) {
          note.withheld = arm.seq;
          if (keep.length === 0) {
            // Nothing else to deliver: the control plane looks unavailable for this call, as on a network failure.
            log({ ...note, forwarded: [], status: 503 });
            res.writeHead(503, { "content-type": "application/problem+json" }).end('{"title":"relay withheld the only report"}');
            return;
          }
          body = Buffer.from(JSON.stringify({ reports: keep }));
        }
      }
      note.forwarded = JSON.parse(body).reports.map((r) => claims(r).seq);
    } catch {
      note = { unparsed: true };
    }
  }
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)));
  let upstream;
  try {
    upstream = await fetch(UPSTREAM + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, redirect: "manual" });
  } catch (error) {
    if (note) log({ ...note, status: 502, error: String(error.cause?.code ?? error.message) });
    res.writeHead(502, { "content-type": "application/problem+json" }).end('{"title":"control plane unreachable"}');
    return;
  }
  const out = Buffer.from(await upstream.arrayBuffer());
  if (note) {
    let acks = null;
    try { acks = JSON.parse(out); } catch { /* not JSON */ }
    log({ ...note, status: upstream.status, acks: acks?.acks ?? null, rejected: acks?.rejected ?? null });
  }
  const back = {};
  upstream.headers.forEach((v, k) => { if (!HOP.has(k) && k !== "content-encoding") back[k] = v; });
  res.writeHead(upstream.status, back).end(out);
}).listen(3000, () => log({ listening: 3000, upstream: UPSTREAM }));
