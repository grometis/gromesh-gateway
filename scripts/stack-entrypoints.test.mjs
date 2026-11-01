import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { fixture, remappedFixture } from "./stack-guard.fixture.mjs";
import { assertStack } from "./stack-guard.mjs";
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const trap = `
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const log = entry => appendFileSync(process.env.TRAP_FILE, JSON.stringify(entry)+'\\n');
globalThis.fetch = async (...args) => { log({fetch:true}); throw Error('trapped fetch'); };
for (const name of ['http','https','net','tls']) {
const mod = require(name);
for (const fn of ['request','get','connect','createConnection']) if (typeof mod[fn]==='function') mod[fn]=()=>{log({[name]:fn});throw Error('trapped socket');};
}
const cp = require('node:child_process');
cp.execFile = (file, args, options, callback) => {
log({exec:[file,...args].join(' ')});
if (file!=='docker' || !(['ps','inspect','info'].includes(args[0]) || (['volume','network','image','context'].includes(args[0]) && args[1]==='inspect') || (['volume','network'].includes(args[0]) && args[1]==='ls') || (args[0]==='compose' && args.includes('config')))) throw Error('trapped mutation');
const f = JSON.parse(readFileSync(process.env.TRAP_SNAPSHOT,'utf8'));
let out;
if (args[0]==='info') out='Docker Desktop';
else if (args[1]==='ls') out=(args[0]==='volume'?f.volumes:f.networks).map(v=>v.name).join('\\n');
else if (args[0]==='context') out=JSON.stringify([f.context]);
else if (args[0]==='compose') out=JSON.stringify(f.compose);
else if (args[0]==='image') out=JSON.stringify([{Config:{Volumes:Object.fromEntries((f.images[args.at(-1)] ?? []).map(p=>[p,{}]))}}]);
else if (args[0]==='ps') out=f.containers.map(c=>c.id).join('\\n');
else if (args[0]==='volume' || args[0]==='network') out=JSON.stringify((args[0]==='volume'?f.volumes:f.networks).map(v=>({Name:v.name,Labels:{'com.docker.compose.project':v.project,'com.grometis.gromesh.disposable':v.disposableId}})));
else out=JSON.stringify(f.containers.map(c=>({Id:c.id,State:{Running:c.running},Config:{Labels:{'com.docker.compose.project':c.project,'com.docker.compose.service':c.service,'com.grometis.gromesh.disposable':c.disposableId},Env:Object.entries(c.environment).map(([k,v])=>k+'='+v)},NetworkSettings:{Networks:Object.fromEntries(c.networks.map(n=>[n,{}])),Ports:Object.fromEntries(c.bindings.map((b,i)=>[i+'/'+b.protocol,[{HostPort:String(b.port),HostIp:b.host}]]))},Mounts:c.mounts.map(m=>({Type:m.type,Name:m.name,Destination:m.destination,Source:m.source,RW:m.writable}))})));
queueMicrotask(()=>callback(null,out,'')); return {stdin:{end(){}}};
};
for(const name of ['spawn','spawnSync','exec','execSync','execFileSync','fork']) cp[name]=()=>{log({[name]:true});throw Error('trapped mutation');};
syncBuiltinESMExports();
`;
async function trapped(entry, env = {}, snapshot = fixture(), setup = false) {
  const dir = mkdtempSync(join(tmpdir(), "b21a-trap-"));
  try {
    writeFileSync(join(dir, "trap.mjs"), trap);
    writeFileSync(join(dir, "calls"), "");
    writeFileSync(join(dir, "snapshot"), JSON.stringify(snapshot));
    const clean = { PATH: process.env.PATH, HOME: process.env.HOME, TRAP_FILE: join(dir, "calls"), TRAP_SNAPSHOT: join(dir, "snapshot"), ...env };
    const args = ["--import", join(dir, "trap.mjs")];
    if (setup)
      args.push("--input-type=module", "-e", `await (await import(${JSON.stringify(new URL("../" + entry, import.meta.url).href)})).default()`);
    else
      args.push(resolve(root, entry));
    const result = await exec(process.execPath, args, { cwd: root, env: clean, timeout: 15000 }).then(r => ({ code: 0, ...r }), e => ({ code: e.code, stderr: e.stderr }));
    const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    return { ...result, calls };
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const standalone = ["e2e/retention-upgrade.mjs", "e2e/v2-flow.mjs"];
const entries = readdirSync(join(root, "e2e")).filter(f => f.endsWith(".mjs") && !["docker-images.mjs", "isolation-harness.mjs"].includes(f)).map(f => "e2e/" + f);
entries.push("deploy/observability/acceptance.mjs", "scripts/smoke.mjs", "scripts/assert-test-stack.mjs");
for (const entry of entries) {
  test(`${entry}: absent flag/config refuses before all I/O`, async () => {
    const r = await trapped(entry);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /refused before any write/);
    assert.deepEqual(r.calls, []);
  });
  test(`${entry}: foreign publisher refuses before requests, pulls, builds or writes`, async () => {
    const f = fixture();
    f.containers[0].project = "foreign";
    if (standalone.includes(entry)) f.context.Endpoints.docker.Host = "ssh://foreign";
    const r = await trapped(entry, f.env, f);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /refused before any write/);
    assert.ok(r.calls.length > 0);
    assert.ok(r.calls.every(c => /^docker (ps|inspect|info|volume (inspect|ls)|network (inspect|ls)|image inspect|context inspect|compose .*config)( |$)/.test(c.exec ?? "")));
    assert.ok(!r.stderr.includes(f.env.POSTGRES_PASSWORD));
  });
}
for (const entry of ["e2e/stack-guard.setup.ts", "apps/control-plane/test/e2e/global-setup.ts", "e2e/kind/stack-guard.setup.ts"]) {
  test(`${entry}: global setup refuses before writes`, async () => { const r = await trapped(entry, {}, fixture(), true); assert.notEqual(r.code, 0); assert.match(r.stderr, /refused before any write/); assert.deepEqual(r.calls, []); });
}
test("a foreign ephemeral HTTP endpoint receives zero requests", async () => {
  let hits = 0;
  const server = createServer((req, res) => { hits++; res.end("1"); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const f = fixture();
    f.env.CLICKHOUSE_URL = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(assertStack("acceptance", f.env, async () => f), /CLICKHOUSE_URL/);
    assert.equal(hits, 0);
  }
  finally {
    await new Promise(r => server.close(r));
  }
});
test("real CP slug unit suite runs with no Docker, external sockets or stack guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "b21a-pure-unit-"));
  try {
    const preload = join(dir, "pure.mjs");
    writeFileSync(preload, `
import {createRequire, registerHooks, syncBuiltinESMExports} from 'node:module';
const require = createRequire(import.meta.url);
registerHooks({resolve(specifier, context, next) {
  if (/stack-guard|integration-databases/.test(specifier)) throw Error('unit imported stack guard');
  return next(specifier, context);
}});
const cp = require('node:child_process');
for (const name of ['execFile','execFileSync','spawn','spawnSync','exec','execSync']) {
  const original = cp[name];
  cp[name] = (file,...args) => {
    if (String(file).includes('docker')) throw Error('unit called Docker');
    return original(file,...args);
  };
}
globalThis.fetch = () => {throw Error('unit external fetch');};
for (const name of ['http','https','net','tls']) {
  const mod = require(name);
  for (const fn of ['request','get','connect','createConnection']) if (typeof mod[fn]==='function') mod[fn]=()=>{throw Error('unit external socket');};
}
syncBuiltinESMExports();
`);
    const cpRoot = join(root, "apps/control-plane");
    const r = await exec(process.execPath, ["--import", preload, join(cpRoot, "node_modules/vitest/vitest.mjs"), "run", "--project", "unit", "src/workspaces/slug.test.ts", "--pool", "threads", "--maxWorkers", "1"], {
      cwd: cpRoot, env: {PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: `--import=${preload}`}, timeout: 20000,
    });
    assert.match(r.stdout, /slug.test.ts/);
    assert.match(r.stdout.replace(/\x1b\[[0-9;]*m/g, ""), /Tests\s+[1-9][0-9]* passed/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
test("CI fixture passes real Docker output normalization and the mandatory entrypoint", async () => {
  const f = fixture();
  const r = await trapped("scripts/assert-test-stack.mjs", f.env, f);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.ok(r.calls.length > 0 && r.calls.every(c => /^docker (ps|inspect|info|volume (inspect|ls)|network (inspect|ls)|image inspect|context inspect|compose .*config)( |$)/.test(c.exec ?? "")));
});
test("remapped fixture passes Docker normalization with the shared development stack present", async () => {
  const f = remappedFixture();
  const r = await trapped("scripts/assert-test-stack.mjs", f.env, f);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
});

test("dev:up/dev:down preserve Compose files, project, working directory and exit status without Docker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "b21a-compose-"));
  try {
    const preload = join(dir, "compose-trap.mjs");
    const record = join(dir, "calls.json");
    writeFileSync(preload, `
import { writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
require("node:child_process").spawnSync = (file, args, options) => {
  writeFileSync(process.env.TRAP_FILE, JSON.stringify({ file, args, cwd: options.cwd.pathname,
    project: options.env.COMPOSE_PROJECT_NAME, stdio: options.stdio }));
  return { status: Number(process.env.TRAP_STATUS) };
};
syncBuiltinESMExports();
`);
    const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
    for (const [script, env, files, status] of [
      ["dev:up", {}, ["deploy/compose/docker-compose.yml"], 0],
      ["dev:down", { COMPOSE_PROJECT_NAME: "gromesh-test-wrapper", COMPOSE_FILE: "base.yml:disposable.yml" }, ["base.yml", "disposable.yml"], 0],
      ["dev:up", { COMPOSE_PROJECT_NAME: "gromesh-test-wrapper", COMPOSE_FILE: "base.yml;disposable.yml", COMPOSE_PATH_SEPARATOR: ";" }, ["base.yml", "disposable.yml"], 17],
    ]) {
      const command = script === "dev:up" ? ["up", "-d"] : ["down"];
      assert.equal(scripts[script], ["node", "scripts/compose.mjs", ...command].join(" "));
      const result = await exec(process.execPath, ["--import", preload, join(root, "scripts/compose.mjs"), ...command], {
        cwd: dir,
        env: { PATH: process.env.PATH, TRAP_FILE: record, TRAP_STATUS: String(status), ...env },
        timeout: 5000,
      }).then(() => 0, error => error.code);
      assert.equal(result, status);
      const call = JSON.parse(readFileSync(record, "utf8"));
      assert.deepEqual(call, { file: "docker", args: ["compose", ...files.flatMap(f => ["-f", f]), ...command],
        cwd: root + "/", ...(env.COMPOSE_PROJECT_NAME ? { project: env.COMPOSE_PROJECT_NAME } : {}), stdio: "inherit" });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
