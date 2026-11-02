// The traffic client of the containment scenarios (v2.mjs), apart so a test can run it, inside the unrestricted observer pod: one new connection per request, one keepalive socket,
// one WebSocket; every event is a JSON line stamped with the pod's (VM) clock.
export const CLIENT = String.raw`
import http from "node:http"; import net from "node:net"; import crypto from "node:crypto"; import fs from "node:fs";
const [host, port, path, key, wsPath, privPath, pod = host, observer = "n2-observer"] = JSON.parse(globalThis.ARGS);
// Non-Linux component tests can send traffic; null keeps their events invalid as boot-correlated lab evidence.
const boot = process.platform === "linux" ? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : null;
let seq = 0;
const now = () => globalThis.MONOTONIC ? performance.now() : Date.now();
const log = (o) => console.log(JSON.stringify({ t: now(), seq: ++seq, observer, boot, pod, ...o }));
setInterval(() => log({ k: "heartbeat" }), 500);
const ka = new http.Agent({ keepAlive: true, maxSockets: 1 });
function get(kind, agent) {
  const requestedAt = now();
  const q = http.request({ host, port, path, agent, headers: { apikey: key }, timeout: 3000 }, (r) => { r.resume(); r.on("end", () => log({ k: kind, requestedAt, s: r.statusCode, reused: q.reusedSocket })); });
  q.on("timeout", () => q.destroy(new Error("timeout"))); q.on("error", (e) => log({ k: kind, requestedAt, e: e.code ?? e.message })); q.end();
}
setInterval(() => get("new", false), 250);
setInterval(() => get("ka", ka), 250);
// Traffic for the privileged destination's log only (its own kind, never read by a budget).
if (privPath) setInterval(() => { const q = http.request({ host, port, path: privPath, agent: false, timeout: 3000 }, (r) => { r.resume(); r.on("end", () => log({ k: "priv", s: r.statusCode })); }); q.on("timeout", () => q.destroy(new Error("timeout"))); q.on("error", (e) => log({ k: "priv", e: e.code ?? e.message })); q.end(); }, 250);
function ws() {
  const connection = crypto.randomUUID();
  const emit = (o) => log({ k: "ws", connection, ...o });
  emit({ ev: "attempt" });
  const sock = net.connect(Number(port), host); let open = false, n = 0, buf = "";
  sock.setTimeout(3000, () => sock.destroy(new Error("WebSocket timeout")));
  sock.on("connect", () => sock.write("GET " + wsPath + " HTTP/1.1\r\nHost: " + host + "\r\napikey: " + key + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + crypto.randomBytes(16).toString("base64") + "\r\n\r\n"));
  sock.on("data", (d) => { if (!open) { buf += d.toString("latin1"); if (buf.includes("\r\n\r\n")) { const st = buf.split(" ")[1]; open = st === "101"; emit({ ev: open ? "open" : "refused", s: Number(st) }); if (!open) sock.destroy(); } return; }
    if (d.toString().includes("pong")) emit({ ev: "pong" }); });
  const timer = setInterval(() => { if (!open) return; const p = Buffer.from("ping " + (++n)); const m = crypto.randomBytes(4); sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), m, p.map((b, i) => b ^ m[i % 4])])); }, 500);
  sock.on("close", () => { clearInterval(timer); emit({ ev: "close" }); setTimeout(ws, 1000); });
  sock.on("error", (e) => emit({ ev: "error", e: e.code }));
}
ws();`;
