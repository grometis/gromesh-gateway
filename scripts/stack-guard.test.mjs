import { test } from "node:test";
import assert from "node:assert/strict";
import { stackProblems, assertStack, disposableLabel, composeProblems, daemonProblems, hostBindSource } from "./stack-guard.mjs";
import { fixture, remappedFixture } from "./stack-guard.fixture.mjs";
const secret = "fixture-secret-never-in-diagnostics";
const problems = (f) => stackProblems("acceptance", f.env, f.containers, f.volumes, f.networks).join("\n");
test("valid isolated stack and CI environment pass without an optional flag", async () => {
  const f = fixture();
  assert.equal(problems(f), "");
  await assertStack("acceptance", f.env, async () => f);
  assert.equal(disposableLabel, "com.grometis.gromesh.disposable");
});
for (const name of ["UI_URL", "CLICKHOUSE_URL", "CP_URL", "POSTGRES_PORT", "GROMESH_DISPOSABLE_ID", "COMPOSE_PROJECT_NAME", "COMPOSE_FILE"]) {
  test(`missing critical ${name} refuses`, () => { const f = fixture(); delete f.env[name]; assert.match(problems(f), new RegExp(name)); });
}
test("port published by another container refuses", () => { const f = fixture(); f.containers.find(c => c.service === "ui").service = "unexpected"; assert.match(problems(f), /UI_URL/); });
test("wrong compose project refuses", () => { const f = fixture(); f.containers[0].project = "other"; assert.match(problems(f), /UI_URL/); f.env.COMPOSE_PROJECT_NAME = "gromesh"; assert.match(problems(f), /COMPOSE_PROJECT_NAME/); });
test("shared credentials refuse even if caller supplies a different credential", () => {
  const f = fixture();
  f.env.CLICKHOUSE_PASSWORD = "gromesh-dev-observability";
  assert.match(problems(f), /CLICKHOUSE_PASSWORD/);
  f.env.CLICKHOUSE_PASSWORD = secret;
  f.containers.find(c => c.service === "postgres").environment.POSTGRES_PASSWORD = "gromesh";
  assert.match(problems(f), /credential/);
});
test("unlabelled database storage, bind mounts and foreign volumes refuse", () => {
  for (const mutate of [f => { f.volumes[0].disposableId = ""; }, f => { f.volumes[0].project = "other"; }, f => { f.containers.find(c => c.service === "postgres").mounts[0].type = "bind"; }]) {
    const f = fixture();
    mutate(f);
    assert.match(problems(f), /volume|storage/);
  }
});
test("duplicate publisher at a destination refuses", () => {
  const f = fixture();
  f.containers.push({ ...f.containers[0], id: "other", project: "foreign", ports: [5174] });
  assert.match(problems(f), /UI_URL/);
});
test("remapped run coexists with shared ClickHouse, validator and Postgres publishers", async () => {
  const f = remappedFixture();
  assert.equal(problems(f), "");
  await assertStack("acceptance", f.env, async () => f);
});
test("configured destinations must match the run publishers, never the shared defaults", () => {
  for (const [name, port] of [["CLICKHOUSE_URL", 8123], ["KONG_VALIDATOR_URL", 8011], ["POSTGRES_PORT", 55433]]) {
    const f = remappedFixture();
    f.env[name] = name === "POSTGRES_PORT" ? String(port) : `http://127.0.0.1:${port}`;
    assert.match(problems(f), new RegExp(`${name}: port ${port}`));
  }
});
test("fixed compose ports still require the run publisher when URLs are remapped", () => {
  for (const [service, name, port] of [["control-plane", "CP_URL", 3000], ["kong", "KONG_PROXY_URL", 8000],
    ["kong", "KONG_STATUS_URL", 8100], ["kong", "KONG_PROXY_TLS_PORT", 8443], ["echo", "ECHO_URL", 8080]]) {
    const f = remappedFixture();
    const own = f.containers.find(c => c.service === service);
    own.ports = own.ports.filter(p => p !== port);
    own.bindings = own.bindings.filter(b => b.port !== port);
    own.ports.push(port + 10000);
    own.bindings.push({ port: port + 10000, host: "127.0.0.1", protocol: "tcp" });
    f.env[name] = name.endsWith("_PORT") ? String(port + 10000) : `http://127.0.0.1:${port + 10000}`;
    f.containers.push({ ...own, id: "shared-fixed", project: "gromesh", ports: [port] });
    assert.match(problems(f), new RegExp(`${name}: port ${port}`));
  }
});
test("missing run label and stale service refuse", () => { const f = fixture(); f.containers[0].disposableId = "stale"; assert.match(problems(f), /UI_URL/); });
test("remote URLs and URL credentials are rejected without exposing them", () => {
  const f = fixture();
  f.env.UI_URL = `http://user:${secret}@example.test:5174`;
  const p = problems(f);
  assert.match(p, /UI_URL/);
  assert.ok(!p.includes(secret));
});
test("diagnostics never include secrets, raw Docker labels or errors", async () => {
  const f = fixture();
  f.containers[0].project = secret;
  f.containers[0].service = secret;
  assert.ok(!problems(f).includes(secret));
  await assert.rejects(assertStack("acceptance", f.env, async () => { throw Error(secret); }), e => !e.message.includes(secret));
});
test("assertStack checks each call, including changed env; no success cache", async () => {
  const f = fixture();
  await assertStack("acceptance", f.env, async () => f);
  delete f.env.UI_URL;
  await assert.rejects(assertStack("acceptance", f.env, async () => f), /UI_URL/);
});
test("binding must be TCP on the exact destination IP", () => {
  for (const b of [{ host: "127.0.0.2", protocol: "tcp" }, { host: "::1", protocol: "tcp" }, { host: "127.0.0.1", protocol: "udp" }]) {
    const f = fixture();
    Object.assign(f.containers[0].bindings[0], b);
    assert.match(problems(f), /UI_URL/);
  }
});
test("unproven networks and writable bind mounts refuse", () => {
  const f = fixture();
  f.networks[0].disposableId = "foreign";
  assert.match(problems(f), /network/);
  const g = fixture();
  g.containers[0].mounts.push({ type: "bind", destination: "/data", writable: true });
  assert.match(problems(g), /bind mount/);
});
test("control-plane database URL cannot redirect beyond the proven Postgres service", () => {
  for (const suffix of ["?host=foreign", "?port=5432", "?database=shared", "?user=other", "#foreign"]) {
    const f = fixture();
    f.containers.find(c => c.service === "control-plane").environment.DATABASE_URL += suffix;
    assert.match(problems(f), /database credential/);
  }
  for (const url of ["http://gromesh:secret@postgres:5432/gromesh", "postgres://other:secret@postgres:5432/gromesh", "postgres://gromesh:secret@postgres:9999/gromesh"]) {
    const f = fixture();
    f.containers.find(c => c.service === "control-plane").environment.DATABASE_URL = url;
    assert.match(problems(f), /database credential/);
  }
});
test("disposable override labels every compose service, volume and network", async () => {
  const { readFileSync } = await import("node:fs");
  const base = readFileSync(new URL("../deploy/compose/docker-compose.yml", import.meta.url), "utf8");
  const override = readFileSync(new URL("../deploy/compose/disposable.yml", import.meta.url), "utf8");
  const section = (s, key) => s.split("\n" + key + ":\n")[1]?.split(/^\S/m)[0] ?? "";
  for (const key of ["services", "volumes"]) {
    const own = section(override, key);
    for (const match of section(base, key).matchAll(/^  ([a-z0-9-]+):\s*$/gm)) {
      const body = own.split(`  ${match[1]}:\n`)[1]?.split(/^  [a-z]/m)[0];
      assert.ok(body?.includes("labels: *disposable"), `${key}/${match[1]} must carry the run label`);
    }
  }
  assert.match(section(override, "networks"), /default:\n    labels: \*disposable/);
});
test("CI endpoint environment matches the accepted fixture and forwards all critical generated values", async () => {
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const require = createRequire(new URL("../apps/control-plane/package.json", import.meta.url));
  const workflow = require("yaml").parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const f = fixture();
  for (const [key, value] of Object.entries(workflow.jobs.e2e.env))
    if (key !== "COMPOSE_PROJECT_NAME")
      assert.equal(f.env[key], String(value), `CI ${key} fixture must track workflow`);
  assert.equal(problems(f), "");
  for (const service of ["control-plane", "ui", "agent"]) {
    const build = workflow.jobs.e2e.steps.find(s => s.with?.file === `apps/${service}/Dockerfile`);
    assert.equal(build.with.tags, "${{ env.COMPOSE_PROJECT_NAME }}-" + service);
  }
  const setup = workflow.jobs.e2e.steps.find(s => s.name === "Configure disposable acceptance run").run;
  for (const key of ["COMPOSE_FILE", "GROMESH_DISPOSABLE_ID", "POSTGRES_PASSWORD", "BOOTSTRAP_ADMIN_PASSWORD", "CLICKHOUSE_PASSWORD", "CLICKHOUSE_READER_PASSWORD", "CLICKHOUSE_WRITER_PASSWORD", "GROMESH_COLLECTOR_TOKEN", "GROMESH_ENCRYPTION_KEY", "GROMESH_FINGERPRINT_KEY"])
    assert.ok(setup.includes(key), `CI must generate ${key}`);
  assert.ok(setup.includes("::add-mask::"));
});

test("Compose remapping preserves defaults and published ports match the configured URLs", async () => {
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const require = createRequire(new URL("../apps/control-plane/package.json", import.meta.url));
  const compose = require("yaml").parse(readFileSync(new URL("../deploy/compose/docker-compose.yml", import.meta.url), "utf8"));
  const f = remappedFixture();
  for (const [service, variable, input, fallback, remote] of [
    ["clickhouse", "CLICKHOUSE_PORT", "CLICKHOUSE_URL", 8123, 8123],
    ["kong-validator", "KONG_VALIDATOR_PORT", "KONG_VALIDATOR_URL", 8011, 8001],
    ["postgres", "POSTGRES_PORT", "POSTGRES_PORT", 5432, 5432],
  ]) {
    const binding = compose.services[service].ports[0];
    assert.equal(binding, `127.0.0.1:\${${variable}:-${fallback}}:${remote}`);
    const port = input === "POSTGRES_PORT" ? f.env[input] : new URL(f.env[input]).port;
    f.env[variable] = port;
    assert.equal(binding.replace(`\${${variable}:-${fallback}}`, port), `127.0.0.1:${port}:${remote}`);
  }
  assert.equal(problems(f), "");
});
test("a stopped sidecar may retain a removed Kong namespace after recreation, but its volumes still need proof", () => {
  const f = fixture();
  f.containers.push({ id: "old-agent", project: f.env.COMPOSE_PROJECT_NAME, service: "agent", disposableId: f.env.GROMESH_DISPOSABLE_ID, ports: [], bindings: [], networks: [], networkParent: "removed-kong", mounts: [], environment: {}, running: false });
  assert.equal(problems(f), "");
  f.containers.at(-1).mounts.push({ type: "volume", name: "foreign", destination: "/data" });
  assert.match(problems(f), /volume/);
});

// Future services must be proved even when no container has been created yet.
test("effective Compose protects future one-shots, storage, networks and checkout binds", () => {
  const f = fixture();
  assert.deepEqual(composeProblems(f.env, f.compose, f.images), []);
  for (const mutate of [
    c => { c.services.smoke.labels = {}; },
    c => { c.services.smoke.volumes = [{type: "volume", source: "foreign", target: "/data"}]; },
    c => { c.volumes["pg-data"].external = true; },
    c => { c.volumes["pg-data"].name = "foreign"; },
    c => { c.services.smoke.volumes = [{type: "volume", target: "/data"}]; },
    c => { c.services.smoke.volumes = [{type: "bind", source: "/tmp/foreign", target: "/data", read_only: true}]; },
    c => { c.services.smoke.volumes[0].read_only = false; },
    c => { c.networks.default.external = true; },
    c => { c.services.smoke.network_mode = "host"; },
    c => { c.services.smoke.networks = {foreign: {}}; },
    c => { c.services.smoke.volumes_from = ["foreign"]; },
    c => { c.services.smoke.configs = [{source: "foreign"}]; },
    c => { c.services.smoke.secrets = [{source: "foreign"}]; },
    c => { c.services.smoke.use_api_socket = true; },
  ]) {
    const config = structuredClone(f.compose);
    mutate(config);
    assert.ok(composeProblems(f.env, config, f.images).length > 0);
  }
});
test("image VOLUME on an exited ClickHouse init is refused until explicitly covered", () => {
  const f = fixture();
  const image = f.compose.services["clickhouse-init"].image;
  f.images[image] = ["/var/lib/clickhouse"];
  assert.ok(composeProblems(f.env, f.compose, f.images).some(p => p.includes("image volume")));
  f.compose.services["clickhouse-init"].tmpfs = ["/var/lib/clickhouse", "/var/log/clickhouse-server"];
  assert.deepEqual(composeProblems(f.env, f.compose, f.images), []);
  const init = {...f.containers[0], id: "exited-init", service: "clickhouse-init", running: false,
    mounts: [{type: "volume", name: "anonymous-unlabelled", destination: "/var/lib/clickhouse"}]};
  f.containers.push(init);
  assert.match(problems(f), /mounted volume/);
  init.mounts = [{type: "tmpfs", destination: "/var/lib/clickhouse"}];
  assert.equal(problems(f), "");
});
test("daemon must be a local Unix context and a remote DOCKER_HOST always refuses", () => {
  const context = {Endpoints: {docker: {Host: "unix:///var/run/docker.sock"}}};
  assert.deepEqual(daemonProblems({}, context), []);
  for (const env of [{DOCKER_HOST: "tcp://127.0.0.1:2375"}, {DOCKER_HOST: "ssh://foreign"}])
    assert.ok(daemonProblems(env, context).length > 0);
  for (const host of ["tcp://127.0.0.1:2375", "ssh://foreign", "npipe:////./pipe/docker_engine", "unix://foreign/socket", "unix:relative"])
    assert.ok(daemonProblems({}, {Endpoints: {docker: {Host: host}}}).length > 0);
  assert.ok(daemonProblems({}, {}).length > 0);
});

test("a future Compose volume/network cannot adopt an existing foreign resource", async () => {
  for (const type of ["volumes", "networks"]) {
    const f = fixture();
    const key = "future";
    f.compose[type][key] = {name: `${f.env.COMPOSE_PROJECT_NAME}_${key}`, labels: {[disposableLabel]: f.env.GROMESH_DISPOSABLE_ID}};
    f[type].push({name: f.compose[type][key].name, project: "foreign", disposableId: "foreign"});
    await assert.rejects(assertStack("acceptance", f.env, async () => f), /ownership/);
  }
});

test("Docker Desktop translated bind paths retain real checkout proof only on a verified Mac daemon", () => {
  const source = new URL("../scripts", import.meta.url).pathname;
  assert.equal(hostBindSource(`/host_mnt${source}`, "Docker Desktop", "darwin"), source);
  assert.equal(hostBindSource(`/host_mnt${source}`, "Linux", "darwin"), `/host_mnt${source}`);
  assert.equal(hostBindSource(`/host_mnt${source}`, "Docker Desktop", "linux"), `/host_mnt${source}`);
  const f = fixture();
  f.containers[0].mounts = [{type: "bind", source: hostBindSource(`/host_mnt${source}`, "Docker Desktop", "darwin"), destination: "/scripts", writable: false}];
  assert.equal(problems(f), "");
  f.containers[0].mounts[0].source = hostBindSource("/host_mnt/tmp/foreign", "Docker Desktop", "darwin");
  assert.match(problems(f), /bind/);
});
