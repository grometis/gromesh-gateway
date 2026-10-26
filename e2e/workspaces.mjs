#!/usr/bin/env node
// N2-X1 against the real Kong 3.9.4 image with the product plugins (images/kong/plugins): two Workspaces composed by
// the compiler in one config, the same logical names in both. A credential of one Workspace never authenticates on a
// route of the other, and gets exactly what an unknown credential gets (key-auth, basic-auth, jwt; with and without
// anonymous). Self-contained (isolation-harness): its own network, upstream, lease and gateway. WORKSPACE_PLUGINS=off is the negative control:
// the same config without gromesh-workspace and gromesh-route-guard must fail the isolation checks.
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { docker, Harness, root } from "./isolation-harness.mjs";

const { composeWorkspaces, basicAuthPasswordHash } = await import(pathToFileURL(join(root, "packages/compiler/dist/index.js")).href);
const withPlugins = process.env.WORKSPACE_PLUGINS !== "off";

// Isolation failures are collected, not thrown, so the negative control sees all of them.
const failures = [];
const expectIsolated = (ok, message) => { if (!ok) failures.push(message); };

const WS = {
  a: { id: "00000000-0000-4000-8000-00000000a001", slug: "tvro" },
  b: { id: "00000000-0000-4000-8000-00000000b001", slug: "assine" },
};
const other = (ws) => (ws === "a" ? "b" : "a");
const MECHANISMS = ["key-auth", "basic-auth", "jwt"];
const route = (m) => m.replace("-auth", "");

function member(ws) {
  const n = (k) => `6a1f3c2e-0b7d-4c1a-9f10-${ws}${String(k).padStart(11, "0")}`;
  const app = n(3);
  const secret = randomBytes(24).toString("base64url");
  const routes = [];
  const plugins = [];
  let k = 100;
  const add = (name, paths, plugin, extra = {}) => {
    const id = n(k++);
    routes.push({ id, name, serviceId: n(1), paths, ...extra });
    if (plugin) plugins.push({ id: n(k++), name: plugin.name, scope: { routeId: id }, config: plugin.config ?? {} });
  };
  for (const m of MECHANISMS) {
    add(route(m), [`/${route(m)}`], { name: m });
    add(`${route(m)}-anon`, [`/${route(m)}-anon`], { name: m, config: { anonymous: "guest" } });
  }
  add("open", ["/open"]);
  add("basic-hide", ["/basic-hide"], { name: "basic-auth", config: { anonymous: "guest", hide_credentials: true } });
  add("foreign-anon", ["/foreign-anon"], { name: "key-auth", config: { anonymous: "guest" } });
  add("re", ["~/re/[0-9]+$"], { name: "key-auth" });
  add("strip", ["/strip"], { name: "key-auth" }, { stripPath: true });
  return {
    secret,
    member: {
      ...WS[ws],
      state: {
        services: [{ id: n(1), name: "echo", protocol: "http", host: "echo", port: 80 }],
        routes,
        consumers: [{ id: app, username: "app-sky", customId: "sky" }, { id: n(4), username: "guest" }],
        keyAuthCredentials: [{ id: n(5), consumerId: app, key: `key-${ws}-${randomUUID()}` }],
        basicAuthCredentials: [{ id: n(6), consumerId: app, username: `user-${ws}`, passwordHash: basicAuthPasswordHash(app, `pw-${ws}`) }],
        jwtCredentials: [{ id: n(7), consumerId: app, key: `iss-${ws}`, algorithm: "HS256", secret }],
        plugins,
      },
    },
  };
}

const b64url = (data) => Buffer.from(data).toString("base64url");
function hs256(iss, secret) {
  const input = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss, exp: Math.floor(Date.now() / 1000) + 300 }))}`;
  return `${input}.${b64url(createHmac("sha256", secret).update(input).digest())}`;
}

async function main() {

  const a = member("a");
  const b = member("b");
  const states = { a: a.member.state, b: b.member.state };
  const config = composeWorkspaces([a.member, b.member]);
  const guardFor = (routeName) => config.plugins.find((p) => p.name === "gromesh-route-guard" && config.routes.find((r) => r.id === p.route)?.name === routeName);
  // Defense in depth, forced into the config as a compiler bug would: a path outside the prefix, and a route without
  // its guard. The guard answers 404 for the first; gromesh-workspace never serves the second.
  config.routes.find((r) => r.name === "tvro~key").paths.push("/escape-tvro");
  config.plugins = config.plugins.filter((p) => p !== guardFor("tvro~open"));
  // Forced attempts to detach a consumer from its Workspace (the compiler refuses user gromesh-* tags and an anonymous
  // of another Workspace): a consumer with both Workspace tags, one with none, and an anonymous of the other Workspace.
  const forged = (n, tags) => {
    const consumer = { id: `6a1f3c2e-0b7d-4c1a-9f10-c${String(n).padStart(11, "0")}`, username: `forged-${n}`, tags: ["managed-by:gromesh", ...tags] };
    config.consumers.push(consumer);
    config.keyauth_credentials.push({ id: `6a1f3c2e-0b7d-4c1a-9f10-d${String(n).padStart(11, "0")}`, consumer: consumer.id, key: `forged-${n}-${randomUUID()}`, tags: ["managed-by:gromesh", ...tags] });
    return config.keyauth_credentials.at(-1).key;
  };
  const dualKey = forged(1, [`gromesh-ws:${WS.a.id}`, `gromesh-ws:${WS.b.id}`]);
  const untaggedKey = forged(2, []);
  const anonRoute = config.routes.find((r) => r.name === "assine~foreign-anon");
  const foreignGuest = states.a.consumers[1].id;
  config.plugins.find((p) => p.name === "key-auth" && p.route === anonRoute.id).config.anonymous = foreignGuest;
  guardFor("assine~foreign-anon").config.auth.anonymous = foreignGuest;
  if (!withPlugins) config.plugins = config.plugins.filter((p) => !p.name.startsWith("gromesh-"));

  const harness = new Harness();
  try {
    await harness.setup();
    // A valid lease from the isolation-probe's stand-in: without it every Workspace route answers 503 (e2e/containment).
    harness.mode("ok");
    const { id: kong, proxy } = await harness.gateway(config, { plugins: withPlugins ? undefined : "bundled" });

    const call = async (path, headers = {}) => {
      const res = await fetch(`${proxy}${path}`, { headers, signal: AbortSignal.timeout(5000) });
      const text = await res.text();
      const upstream = {};
      let upstreamPath = null;
      if (res.status === 200) {
        // whoami echoes the request line and headers.
        for (const line of text.split("\n")) {
          const request = /^(GET|POST) (\S+) HTTP/.exec(line);
          if (request) upstreamPath = request[2];
          const header = /^([A-Za-z-]+): (.*)$/.exec(line.trim());
          if (header) upstream[header[1].toLowerCase()] = header[2];
        }
      }
      let message = null;
      try { message = JSON.parse(text).message ?? null; } catch { /* upstream body */ }
      // What a client can compare between two refusals: everything but the per-request id.
      const look = JSON.stringify({ status: res.status, type: res.headers.get("content-type"), www: res.headers.get("www-authenticate"), body: res.status === 200 ? null : text.replace(/[0-9a-f]{32}/g, "<request-id>") });
      return { status: res.status, message, www: res.headers.get("www-authenticate"), upstream, upstreamPath, look };
    };
    for (let attempt = 0; ; attempt++) {
      const ready = await call("/").then((r) => r.status === 404, () => false);
      if (ready) break;
      if (attempt > 60) {
        const { stdout, stderr } = await docker("logs", kong).catch((e) => ({ stdout: "", stderr: String(e) }));
        throw new Error(`The gateway did not start:\n${stdout}\n${stderr}`.slice(0, 4000));
      }
      await sleep(1000);
    }

    const credentials = (ws, m) => {
      const s = states[ws];
      if (m === "key-auth") return { apikey: s.keyAuthCredentials[0].key };
      if (m === "basic-auth") return { authorization: `Basic ${Buffer.from(`user-${ws}:pw-${ws}`).toString("base64")}` };
      return { authorization: `Bearer ${hs256(`iss-${ws}`, (ws === "a" ? a : b).secret)}` };
    };
    const unknown = (m) => {
      if (m === "key-auth") return { apikey: `unknown-${randomUUID()}` };
      if (m === "basic-auth") return { authorization: `Basic ${Buffer.from("nobody:nothing").toString("base64")}` };
      return { authorization: `Bearer ${hs256("nobody", randomBytes(24).toString("base64url"))}` };
    };
    const consumerHeaders = (r) => ({ username: r.upstream["x-consumer-username"], customId: r.upstream["x-consumer-custom-id"], anonymous: r.upstream["x-anonymous-consumer"] });

    let checks = 0;
    for (const m of MECHANISMS) {
      for (const owner of ["a", "b"]) {
        const slug = WS[owner].slug;
        const path = `/${slug}/${route(m)}`;
        const own = await call(path, credentials(owner, m));
        check(own.status === 200, `${m}: own credential on ${path} → ${own.status}`);
        check(own.upstreamPath === path, `${m}: the upstream must receive the full path ${path}, got ${own.upstreamPath}`);
        check(own.upstream["x-consumer-id"] === states[owner].consumers[0].id, `${m}: the consumer of ${slug} on ${path}`);
        expectIsolated(own.upstream["x-consumer-username"] === "app-sky" && own.upstream["x-consumer-custom-id"] === "sky",
          `${m}: the upstream must receive the logical username and custom id on ${path}, got ${JSON.stringify(consumerHeaders(own))}`);

        const cross = await call(path, credentials(other(owner), m));
        const invalid = await call(path, unknown(m));
        check(invalid.status === 401, `${m}: an unknown credential on ${path} → ${invalid.status}`);
        expectIsolated(cross.status === 401, `${m}: a credential of ${WS[other(owner)].slug} accepted on another Workspace's route ${path} (${cross.status})`);
        expectIsolated(cross.look === invalid.look, `${m}: another Workspace's credential must look like an unknown one on ${path}: ${cross.look} vs ${invalid.look}`);
        const html = { accept: "text/html" };
        const crossHtml = await call(path, { ...credentials(other(owner), m), ...html });
        const invalidHtml = await call(path, { ...unknown(m), ...html });
        expectIsolated(crossHtml.look === invalidHtml.look, `${m}: with Accept text/html another Workspace's credential must look like an unknown one on ${path}: ${crossHtml.look} vs ${invalidHtml.look}`);

        const anonPath = `/${slug}/${route(m)}-anon`;
        const ownAnon = await call(anonPath, credentials(owner, m));
        check(ownAnon.status === 200 && ownAnon.upstream["x-consumer-id"] === states[owner].consumers[0].id && !ownAnon.upstream["x-anonymous-consumer"],
          `${m}: own credential on ${anonPath} → ${ownAnon.status} ${JSON.stringify(consumerHeaders(ownAnon))}`);
        const crossAnon = await call(anonPath, credentials(other(owner), m));
        const invalidAnon = await call(anonPath, unknown(m));
        check(invalidAnon.status === 200 && invalidAnon.upstream["x-consumer-id"] === states[owner].consumers[1].id,
          `${m}: an unknown credential on ${anonPath} must get the anonymous consumer`);
        expectIsolated(crossAnon.status === 200 && crossAnon.upstream["x-consumer-id"] === states[owner].consumers[1].id,
          `${m}: a credential of ${WS[other(owner)].slug} accepted on another Workspace's route ${anonPath} (consumer ${crossAnon.upstream["x-consumer-id"]})`);
        expectIsolated(JSON.stringify(consumerHeaders(crossAnon)) === JSON.stringify(consumerHeaders(invalidAnon)) && invalidAnon.upstream["x-consumer-username"] === "guest",
          `${m}: another Workspace's credential must look like an unknown one on ${anonPath}: ${JSON.stringify(consumerHeaders(crossAnon))} vs ${JSON.stringify(consumerHeaders(invalidAnon))}`);
        checks += 8;
      }
    }

    for (const [name, key] of [["two Workspace tags", dualKey], ["no Workspace tag", untaggedKey]]) {
      for (const path of ["/tvro/key", "/assine/key"]) {
        const r = await call(path, { apikey: key });
        expectIsolated(r.status === 401 && r.message === "Unauthorized", `a consumer with ${name} authenticated on ${path} (${r.status})`);
      }
    }
    const foreign = await call("/assine/foreign-anon", unknown("key-auth"));
    expectIsolated(foreign.status === 401, `an anonymous consumer of tvro was accepted on /assine/foreign-anon (${foreign.status} ${foreign.upstream["x-consumer-id"] ?? ""})`);

    // basic-auth with hide_credentials: another Workspace's credential in Proxy-Authorization and one more in
    // Authorization reach the upstream exactly as two unknown ones do (both removed, anonymous consumer).
    const basicOf = (ws) => `Basic ${Buffer.from(`user-${ws}:pw-${ws}`).toString("base64")}`;
    const nobody = `Basic ${Buffer.from("nobody:nothing").toString("base64")}`;
    const twoForeign = await call("/assine/basic-hide", { "proxy-authorization": basicOf("a"), authorization: basicOf("a") });
    const twoUnknown = await call("/assine/basic-hide", { "proxy-authorization": nobody, authorization: nobody });
    const forwarded = (r) => JSON.stringify({
      status: r.status, authorization: r.upstream.authorization ?? null, proxy: r.upstream["proxy-authorization"] ?? null,
      ...Object.fromEntries(["x-consumer-id", "x-consumer-username", "x-consumer-custom-id", "x-anonymous-consumer", "x-credential-identifier"].map((h) => [h, r.upstream[h] ?? null])),
    });
    const malformed = `Basic ${Buffer.from("nocolon").toString("base64")}`;
    const malformedForeign = await call("/assine/basic-hide", { "proxy-authorization": basicOf("a"), authorization: malformed });
    const malformedUnknown = await call("/assine/basic-hide", { "proxy-authorization": nobody, authorization: malformed });
    for (const [name, r] of [["foreign", malformedForeign], ["unknown", malformedUnknown]]) {
      expectIsolated(forwarded(r) === forwarded(twoUnknown), `basic-auth hide_credentials with a malformed Authorization (${name}): ${forwarded(r)} vs ${forwarded(twoUnknown)}`);
    }
    check(twoUnknown.status === 200 && !twoUnknown.upstream.authorization && !twoUnknown.upstream["proxy-authorization"], `two unknown basic credentials: ${forwarded(twoUnknown)}`);
    expectIsolated(forwarded(twoForeign) === forwarded(twoUnknown), `basic-auth hide_credentials: another Workspace's credentials reached the upstream differently: ${forwarded(twoForeign)} vs ${forwarded(twoUnknown)}`);

    // A route without authentication consumes no credential: nobody's consumer reaches the upstream.
    const open = await call("/assine/open", credentials("a", "key-auth"));
    check(open.status === 200 && !open.upstream["x-consumer-id"], `open route → ${open.status} ${open.upstream["x-consumer-id"] ?? ""}`);
    // The regex stays under the prefix; the other Workspace's key is refused there too.
    check((await call("/tvro/re/123", credentials("a", "key-auth"))).status === 200, "regex route with its own key");
    expectIsolated((await call("/tvro/re/123", credentials("b", "key-auth"))).status === 401, "a key of assine accepted on the regex route of tvro");
    check((await call("/tvro/re/123x", credentials("a", "key-auth"))).status === 404, "the regex is anchored at the end");
    check((await call("/re/123", credentials("a", "key-auth"))).status === 404, "the regex never matches without the prefix");
    // stripPath true keeps Kong's semantics: the whole matched part is removed.
    const strip = await call("/tvro/strip/x", credentials("a", "key-auth"));
    check(strip.status === 200 && strip.upstreamPath === "/x", `stripPath true → ${strip.status} ${strip.upstreamPath}`);
    // Forced config: a path outside the prefix is answered as no route, before authentication.
    const escaped = await call("/escape-tvro", credentials("a", "key-auth"));
    expectIsolated(escaped.status === 404 && escaped.message === "no Route matched with those values", `a path outside the Workspace prefix was served (${escaped.status})`);
    const unguarded = await call("/tvro/open");
    expectIsolated(unguarded.status === 503, `a route without its guard was served (${unguarded.status})`);

    if (failures.length > 0) throw new Error(`Workspace isolation failed:\n- ${failures.join("\n- ")}`);
    console.log(`Workspace isolation holds on the real gateway: ${checks + 18} checks, ${MECHANISMS.length} mechanisms × 2 Workspaces, with and without anonymous`);
  } finally {
    await harness.teardown();
  }
}

function check(ok, message) {
  assert.ok(ok, message);
}

await main();
