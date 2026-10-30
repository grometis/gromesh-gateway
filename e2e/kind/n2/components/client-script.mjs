// The traffic client of the containment scenarios (v2.mjs), apart so a test can run it, inside the unrestricted observer pod: one new connection per request, one keepalive socket,
// one WebSocket; every event is a JSON line stamped with the pod's (VM) clock.
export const CLIENT = String.raw`
import http from "node:http"; import net from "node:net"; import crypto from "node:crypto";
const [host, port, path, key, wsPath, privPath] = JSON.parse(globalThis.ARGS);
const log = (o) => console.log(JSON.stringify({ t: Date.now(), ...o }));
const ka = new http.Agent({ keepAlive: true, maxSockets: 1 });
function get(kind, agent) {
  const q = http.request({ host, port, path, agent, headers: { apikey: key }, timeout: 3000 }, (r) => { r.resume(); r.on("end", () => log({ k: kind, s: r.statusCode, reused: q.reusedSocket })); });
  q.on("timeout", () => q.destroy(new Error("timeout"))); q.on("error", (e) => log({ k: kind, e: e.code ?? e.message })); q.end();
}
setInterval(() => get("new", false), 250);
setInterval(() => get("ka", ka), 250);
// Traffic for the privileged destination's log only (its own kind, never read by a budget).
if (privPath) setInterval(() => { const q = http.request({ host, port, path: privPath, agent: false, timeout: 3000 }, (r) => { r.resume(); r.on("end", () => log({ k: "priv", s: r.statusCode })); }); q.on("timeout", () => q.destroy(new Error("timeout"))); q.on("error", (e) => log({ k: "priv", e: e.code ?? e.message })); q.end(); }, 250);
function ws() {
  const sock = net.connect(Number(port), host); let open = false, n = 0, buf = "";
  sock.on("connect", () => sock.write("GET " + wsPath + " HTTP/1.1\r\nHost: " + host + "\r\napikey: " + key + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + crypto.randomBytes(16).toString("base64") + "\r\n\r\n"));
  sock.on("data", (d) => { if (!open) { buf += d.toString("latin1"); if (buf.includes("\r\n\r\n")) { const st = buf.split(" ")[1]; open = st === "101"; log({ k: "ws", ev: open ? "open" : "refused", s: Number(st) }); if (!open) sock.destroy(); } return; }
    if (d.toString().includes("pong")) log({ k: "ws", ev: "pong" }); });
  const timer = setInterval(() => { if (!open) return; const p = Buffer.from("ping " + (++n)); const m = crypto.randomBytes(4); sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), m, p.map((b, i) => b ^ m[i % 4])])); }, 500);
  sock.on("close", () => { clearInterval(timer); log({ k: "ws", ev: "close" }); setTimeout(ws, 1000); });
  sock.on("error", (e) => log({ k: "ws", ev: "error", e: e.code }));
}
ws();`;
