#!/usr/bin/env node
// N2 lab fixtures, run inside the lab's pods and containers (Node >= 24, no dependencies):
//   serve <id> <port>...     TCP server: answers each line with "<id> <line>" (the client's random token).
//   dns <zone.json> <port>   authoritative UDP DNS for the lab zone, TTL 0, zone re-read on every query.
//   probe                    reads targets (JSON) on stdin, prints one result per target (JSON) on stdout.
//   watch <ip> <port> <reach|blocked> <deadline ms>   prints the Date.now() of the first attempt in that state.
import { createSocket } from "node:dgram";
import { promises as dns } from "node:dns";
import { readFileSync } from "node:fs";
import { createServer, connect, isIP } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const [command, ...args] = process.argv.slice(2);

function serve(id, ports) {
  for (const port of ports) {
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end >= 0) socket.end(`${id} ${buffer.slice(0, end)}\n`);
      });
      socket.on("error", () => {});
      socket.setTimeout(5000, () => socket.destroy());
    });
    server.listen({ host: "::", port: Number(port), ipv6Only: false });
  }
}

function ipv6Bytes(address) {
  const [head, tail = ""] = address.split("::");
  const parts = (s) => (s ? s.split(":") : []);
  const missing = 8 - parts(head).length - parts(tail).length;
  const groups = address.includes("::") ? [...parts(head), ...Array(missing).fill("0"), ...parts(tail)] : parts(head);
  return Buffer.from(groups.flatMap((g) => { const v = parseInt(g, 16); return [v >> 8, v & 0xff]; }));
}

function dnsServer(zoneFile, port) {
  const socket = createSocket("udp4");
  socket.on("message", (query, peer) => {
    let offset = 12;
    const labels = [];
    while (query[offset] !== 0) { labels.push(query.subarray(offset + 1, offset + 1 + query[offset]).toString()); offset += query[offset] + 1; }
    const qtype = query.readUInt16BE(offset + 1);
    const question = query.subarray(12, offset + 5);
    const name = labels.join(".").toLowerCase();
    let zone = {};
    try { zone = JSON.parse(readFileSync(zoneFile, "utf8")); } catch { /* an absent zone answers NXDOMAIN */ }
    const records = zone[name];
    const type = qtype === 1 ? "A" : qtype === 28 ? "AAAA" : "";
    const values = (records && type && records[type]) || [];
    const answers = values.map((value) => {
      const data = type === "A" ? Buffer.from(value.split(".").map(Number)) : ipv6Bytes(value);
      const rr = Buffer.alloc(12);
      rr.writeUInt16BE(0xc00c, 0); rr.writeUInt16BE(qtype, 2); rr.writeUInt16BE(1, 4); rr.writeUInt32BE(0, 6); rr.writeUInt16BE(data.length, 10);
      return Buffer.concat([rr, data]);
    });
    const header = Buffer.alloc(12);
    query.copy(header, 0, 0, 2);
    // QR + AA, RD copied; NXDOMAIN only for names outside the zone file.
    header.writeUInt16BE(0x8400 | (query.readUInt16BE(2) & 0x0100) | (records ? 0 : 3), 2);
    header.writeUInt16BE(1, 4); header.writeUInt16BE(answers.length, 6);
    socket.send(Buffer.concat([header, question, ...answers]), peer.port, peer.address);
  });
  socket.bind(Number(port));
}

// Only refusal, timeout and an ICMP host-unreachable prove a block. ENETUNREACH is usually a missing local route
// (e.g. no IPv6 in the pod) and DNS failures prove nothing about the destination: both are inconclusive.
const BLOCKING = new Set(["refused", "timeout", "unreachable"]);
function classify(error) {
  switch (error?.code) {
    case "ECONNREFUSED": return "refused";
    case "EHOSTUNREACH": return "unreachable";
    case "ECONNRESET": return "reset-after-connect";
    default: return "local-error";
  }
}

function tcp(ip, port, timeoutMs) {
  const token = randomBytes(12).toString("hex");
  const started = performance.now();
  return new Promise((resolve) => {
    let connected = false;
    let reply = "";
    const done = (outcome, extra = {}) => { socket.destroy(); resolve({ outcome, ms: Math.round(performance.now() - started), ...extra }); };
    const socket = connect({ host: ip, port, family: isIP(ip) || undefined });
    socket.setEncoding("utf8");
    const timer = setTimeout(() => done(connected ? "connected-no-reply" : "timeout"), timeoutMs);
    socket.on("connect", () => { connected = true; socket.write(`${token}\n`); });
    socket.on("data", (chunk) => {
      reply += chunk;
      const end = reply.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      const [server, echoed] = reply.slice(0, end).split(" ");
      done(echoed === token ? "reach" : "connected-bad-reply", { server });
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      done(connected ? "reset-after-connect" : classify(error), { error: error.code ?? String(error) });
    });
    socket.on("close", () => { if (connected && !reply.includes("\n")) { clearTimeout(timer); done("connected-no-reply"); } });
  });
}

// A handshake-only target (e.g. kubelet TLS) is reached as soon as TCP connects; it never echoes the token.
async function attempt(target, ip) {
  const result = await tcp(ip, target.port, target.timeoutMs ?? 2000);
  if (target.proof === "handshake" && ["connected-no-reply", "connected-bad-reply", "reset-after-connect"].includes(result.outcome)) {
    return { ...result, outcome: "handshake" };
  }
  return result;
}

function verdict(target, results) {
  const outcomes = results.map((r) => r.outcome);
  if (target.expect === "blocked") {
    if (outcomes.every((o) => BLOCKING.has(o))) return "pass";
    if (outcomes.some((o) => o === "reach" || o === "handshake" || o.startsWith("connected") || o === "reset-after-connect")) return "fail";
    return "inconclusive";
  }
  const reached = results.every((r) => r.outcome === "reach" && (!target.server || r.server === target.server))
    || (target.proof === "handshake" && outcomes.every((o) => o === "handshake" || o === "reach"));
  if (reached) return "pass";
  return outcomes.some((o) => o === "dns-error" || o === "local-error") ? "inconclusive" : "fail";
}

async function resolveName(name, family) {
  const resolver = new dns.Resolver({ timeout: 1500, tries: 1 });
  try {
    return { addresses: family === 6 ? await resolver.resolve6(name) : await resolver.resolve4(name) };
  } catch (error) {
    return { error: error.code ?? String(error) };
  }
}

async function probeOne(target) {
  if (target.kind === "dns") {
    const { addresses, error } = await resolveName(target.name, target.family);
    const ok = !error && JSON.stringify([...addresses].sort()) === JSON.stringify([...target.expectAddresses].sort());
    return { id: target.id, cap: target.cap, outcome: error ? "dns-error" : "resolved", addresses, error, verdict: ok ? "pass" : error ? "inconclusive" : "fail" };
  }
  let ips = [target.ip];
  let resolved;
  if (target.name) {
    const { addresses, error } = await resolveName(target.name, target.family);
    if (error || addresses.length === 0) {
      const results = [{ outcome: "dns-error", error: error ?? "NODATA" }];
      return { id: target.id, cap: target.cap, expect: target.expect, results, verdict: verdict(target, results) };
    }
    if (target.expectAddresses && JSON.stringify([...addresses].sort()) !== JSON.stringify([...target.expectAddresses].sort())) {
      const results = [{ outcome: "dns-unexpected", addresses }];
      return { id: target.id, cap: target.cap, expect: target.expect, results, verdict: "inconclusive" };
    }
    ips = addresses;
    resolved = addresses;
  }
  const results = await Promise.all(ips.map(async (ip) => ({ ip, ...(await attempt(target, ip)) })));
  return { id: target.id, cap: target.cap, expect: target.expect, resolved, results, verdict: verdict(target, results) };
}

async function probe() {
  const targets = JSON.parse(readFileSync(0, "utf8"));
  const results = await Promise.all(targets.map(probeOne));
  process.stdout.write(`${JSON.stringify(results)}\n`);
}

async function watch(ip, port, state, deadlineMs) {
  const end = Date.now() + Number(deadlineMs);
  process.stdout.write("ready\n");
  while (Date.now() < end) {
    const at = Date.now();
    const { outcome } = await tcp(ip, Number(port), 300);
    if ((state === "reach") === (outcome === "reach")) { process.stdout.write(`${at}\n`); return; }
    await sleep(Math.max(0, 100 - (Date.now() - at)));
  }
  process.stdout.write("deadline\n");
  process.exitCode = 1;
}

if (command === "serve") serve(args[0], args.slice(1));
else if (command === "dns") dnsServer(args[0], args[1] ?? "53");
else if (command === "probe") await probe();
else if (command === "watch") await watch(...args);
else { console.error(`unknown command ${command}`); process.exit(2); }
