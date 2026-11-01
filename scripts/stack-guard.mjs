// Acceptance must prove resource ownership before its first write. Environment variables name the run;
// Docker's container and volume metadata prove it. Integration uses exclusive databases instead (see its setup).
import { AssertionError } from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";

export const disposableLabel = "com.grometis.gromesh.disposable";
const projectLabel = "com.docker.compose.project";
const serviceLabel = "com.docker.compose.service";
// Keep this list beside the compose development defaults. Never interpolate values into diagnostics.
const devSecrets = new Set(["gromesh", "gromesh-dev-admin", "gromesh-dev-observability", "gromesh-dev-reader",
  "gromesh-dev-writer", "gromesh-dev-collector-token-not-a-secret",
  "dev:ZGV2LW9ubHktZ3JvbWVzaC1lbmNyeXB0aW9uLWtleS0=", "ZGV2LW9ubHktZ3JvbWVzaC1maW5nZXJwcmludC1rZXk="]);
const secrets = ["POSTGRES_PASSWORD", "BOOTSTRAP_ADMIN_PASSWORD", "CLICKHOUSE_PASSWORD", "CLICKHOUSE_READER_PASSWORD",
  "CLICKHOUSE_WRITER_PASSWORD", "GROMESH_COLLECTOR_TOKEN", "GROMESH_ENCRYPTION_KEY", "GROMESH_FINGERPRINT_KEY"];
// The compose host ports for CP, Kong and echo remain fixed. UI, Postgres, ClickHouse and
// validator can be remapped; their unused development ports are not destinations of this run.
const destinations = [
  ["UI_URL", "ui"], ["CP_URL", "control-plane", 3000], ["CLICKHOUSE_URL", "clickhouse"], ["POSTGRES_PORT", "postgres"],
  ["KONG_PROXY_URL", "kong", 8000], ["KONG_STATUS_URL", "kong", 8100], ["KONG_METRICS_URL", "kong", 8100],
  ["ECHO_URL", "echo", 8080], ["KONG_VALIDATOR_URL", "kong-validator"], ["KONG_PROXY_TLS_PORT", "kong", 8443],
];
function hostPort(value) {
  if (/^\d+$/.test(value))
    return Number(value) > 0 && Number(value) <= 65535 ? { port: Number(value), host: "127.0.0.1" } : null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password)
      return null;
    return { port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), host: url.hostname === "[::1]" ? "::1" : url.hostname };
  }
  catch {
    return null;
  }
}
export function stackProblems(scope, env, containers = [], volumes = [], networks = []) {
  if (scope !== "acceptance")
    throw new Error("Unknown isolation scope");
  const problems = [];
  const project = env.COMPOSE_PROJECT_NAME;
  const run = env.GROMESH_DISPOSABLE_ID;
  if (!project || project === "gromesh" || !/^[a-z0-9][a-z0-9_-]+$/.test(project))
    problems.push("COMPOSE_PROJECT_NAME must name a non-default run project");
  if (!run || !/^[a-zA-Z0-9_-]{12,128}$/.test(run))
    problems.push("GROMESH_DISPOSABLE_ID must identify this execution");
  if (!env.COMPOSE_FILE || !composeFiles("", env).some(f => resolve(import.meta.dirname, "..", f) === resolve(import.meta.dirname, "../deploy/compose/disposable.yml"))) {
    problems.push("COMPOSE_FILE must include deploy/compose/disposable.yml");
  }
  for (const name of ["BOOTSTRAP_ADMIN_EMAIL", ...secrets]) {
    if (!env[name])
      problems.push(`${name} must be set explicitly`);
    else if (devSecrets.has(env[name]))
      problems.push(`${name} must not use a development credential`);
  }
  const owned = c => c.project === project && c.disposableId === run;
  for (const [name, service, fixed] of destinations) {
    if (!env[name]) {
      problems.push(`${name} must be set explicitly`);
      continue;
    }
    const endpoint = hostPort(env[name]);
    if (endpoint === null) {
      problems.push(`${name} must be a loopback endpoint without URL credentials`);
      continue;
    }
    for (const target of new Set([endpoint.port, ...(fixed ? [fixed] : [])])) {
      const publishers = containers.filter(c => c.running !== false && c.ports.includes(target));
      if (publishers.length !== 1 || !owned(publishers[0]) || publishers[0].service !== service
        || !publishers[0].bindings?.some(b => b.port === target && b.protocol === "tcp"
          && [target === endpoint.port ? endpoint.host : "127.0.0.1", target === endpoint.port && endpoint.host === "::1" ? "::" : "0.0.0.0"].includes(b.host))) {
        problems.push(`${name}: port ${target} must have exactly one disposable publisher of service ${service} in this run`);
      }
    }
  }
  // A compose exec/run can address services that have no published port, including stopped init services.
  for (const c of containers.filter(c => c.project === project)) {
    if (!owned(c))
      problems.push("A project container lacks this execution disposable label");
    if (c.running !== false && (!c.networks?.length || c.networks.some(name => !networks.some(n => n.name === name && n.project === project && n.disposableId === run)))) {
      // Network-mode sidecars inherit the proved Kong namespace; their own Networks can be empty.
      const parent = containers.find(p => p.id === c.networkParent && owned(p));
      if (!parent || !parent.networks?.length || parent.networks.some(name => !networks.some(n => n.name === name && n.project === project && n.disposableId === run)))
        problems.push("A project container network lacks this execution ownership proof");
    }
    for (const m of c.mounts ?? []) {
      if (m.type === "bind" && m.writable !== false)
        problems.push("A project container has an unproven writable bind mount");
      if (m.type !== "volume")
        continue;
      const volume = volumes.find(v => v.name === m.name);
      if (!volume || volume.project !== project || volume.disposableId !== run)
        problems.push("A mounted volume lacks this execution ownership proof");
    }
  }
  const pg = containers.find(c => owned(c) && c.service === "postgres" && c.running !== false);
  if (!pg?.mounts?.some(m => m.destination === "/var/lib/postgresql/data" && m.type === "volume"
    && volumes.some(v => v.name === m.name && v.project === project && v.disposableId === run))) {
    problems.push("Postgres storage must be a labelled disposable volume of this execution");
  }
  const credentialChecks = [
    ["postgres", "POSTGRES_PASSWORD", "POSTGRES_PASSWORD"], ["control-plane", "BOOTSTRAP_ADMIN_PASSWORD", "BOOTSTRAP_ADMIN_PASSWORD"],
    ["control-plane", "CLICKHOUSE_PASSWORD", "CLICKHOUSE_READER_PASSWORD"], ["control-plane", "GROMESH_ENCRYPTION_KEY", "GROMESH_ENCRYPTION_KEY"],
    ["control-plane", "GROMESH_FINGERPRINT_KEY", "GROMESH_FINGERPRINT_KEY"], ["clickhouse", "CLICKHOUSE_PASSWORD", "CLICKHOUSE_PASSWORD"],
    ["kong", "GROMESH_COLLECTOR_TOKEN", "GROMESH_COLLECTOR_TOKEN"], ["vector", "CLICKHOUSE_PASSWORD", "CLICKHOUSE_WRITER_PASSWORD"],
    ["vector", "GROMESH_COLLECTOR_TOKEN", "GROMESH_COLLECTOR_TOKEN"],
  ];
  for (const [service, key, variable] of credentialChecks) {
    const matches = containers.filter(c => owned(c) && c.service === service && c.running !== false);
    if (matches.length !== 1 || !matches[0].environment?.[key] || devSecrets.has(matches[0].environment[key])
      || matches[0].environment[key] !== env[variable])
      problems.push(`${service} credential ${variable} is not the run credential`);
  }
  const cp = containers.find(c => owned(c) && c.service === "control-plane" && c.running !== false);
  if (cp?.environment?.CLICKHOUSE_URL !== "http://clickhouse:8123" || cp?.environment?.KONG_VALIDATOR_URL !== "http://kong-validator:8001")
    problems.push("control-plane internal destinations do not match the disposable services");
  try {
    const db = new URL(cp?.environment?.DATABASE_URL);
    if (decodeURIComponent(db.password) !== env.POSTGRES_PASSWORD || devSecrets.has(decodeURIComponent(db.password))
      || db.protocol !== "postgres:" || db.username !== "gromesh" || db.port !== "5432" || db.search || db.hash
      || db.hostname !== "postgres" || db.pathname !== "/gromesh")
      throw Error();
  }
  catch {
    problems.push("control-plane database credential/destination does not match this run");
  }
  return [...new Set(problems)];
}
async function docker(args) {
  return new Promise((resolve, reject) => execFile("docker", args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (error, out) => error ? reject(new Error("Docker ownership inspection failed")) : resolve(String(out))));
}
export async function runningContainers() {
  const ids = (await docker(["ps", "-aq"])).trim().split(/\s+/).filter(Boolean);
  if (!ids.length)
    return { containers: [], volumes: [], networks: [] };
  const raw = JSON.parse(await docker(["inspect", ...ids]));
  const containers = raw.map(c => ({
    id: c.Id, project: c.Config?.Labels?.[projectLabel] ?? "", service: c.Config?.Labels?.[serviceLabel] ?? "",
    disposableId: c.Config?.Labels?.[disposableLabel] ?? "", running: c.State?.Running === true,
    networks: Object.keys(c.NetworkSettings?.Networks ?? {}), networkParent: c.HostConfig?.NetworkMode?.replace(/^container:/, ""),
    bindings: Object.entries(c.NetworkSettings?.Ports ?? {}).flatMap(([key, bindings]) => (bindings ?? []).map(b => ({ port: Number(b.HostPort), host: b.HostIp, protocol: key.split("/")[1] }))),
    ports: [...new Set(Object.values(c.NetworkSettings?.Ports ?? {}).flatMap(bindings => (bindings ?? []).map(b => Number(b.HostPort))))],
    environment: Object.fromEntries((c.Config?.Env ?? []).map(e => { const i = e.indexOf("="); return [e.slice(0, i), e.slice(i + 1)]; })),
    mounts: (c.Mounts ?? []).map(m => ({ type: m.Type, name: m.Name, destination: m.Destination, writable: m.RW })),
  }));
  const names = [...new Set(containers.flatMap(c => c.mounts.filter(m => m.type === "volume").map(m => m.name)))];
  const volumes = names.length ? JSON.parse(await docker(["volume", "inspect", ...names])).map(v => ({
    name: v.Name, project: v.Labels?.[projectLabel] ?? "", disposableId: v.Labels?.[disposableLabel] ?? "",
  })) : [];
  const networkNames = [...new Set(containers.filter(c => c.project).flatMap(c => c.networks))];
  const networks = networkNames.length ? JSON.parse(await docker(["network", "inspect", ...networkNames])).map(n => ({
    name: n.Name, project: n.Labels?.[projectLabel] ?? "", disposableId: n.Labels?.[disposableLabel] ?? "",
  })) : [];
  return { containers, volumes, networks };
}
export async function assertStack(scope, env = process.env, inspect = runningContainers) {
  // Fail on missing configuration without even requiring a working Docker daemon.
  const config = stackProblems(scope, env, [], []).filter(p => /must be set explicitly|COMPOSE_|GROMESH_DISPOSABLE_ID/.test(p));
  let problems = config;
  if (!problems.length) {
    try {
      const snapshot = await inspect();
      problems = stackProblems(scope, env, snapshot.containers, snapshot.volumes, snapshot.networks);
    }
    catch {
      problems = ["Docker ownership inspection failed; destinations cannot be proved"];
    }
  }
  if (problems.length)
    throw new AssertionError({ message: `Test stack refused before any write (scope ${scope}):\n- ${problems.join("\n- ")}` });
}
export function composeFiles(base, env = process.env) {
  return env.COMPOSE_FILE ? env.COMPOSE_FILE.split(env.COMPOSE_PATH_SEPARATOR ?? ":") : [base];
}
