// Isolated acceptance runs (GROMESH_STACK_ISOLATED=1): a run beside another compose stack must never reach that
// stack through a default endpoint (the defaults are the ports of the standard compose project, and remapping ports
// or renaming the project does not change them). Before the first write, every destination the tests use from the
// host must be named explicitly where the tests read it from the environment, and every destination (named or fixed
// in the tests) must be published by the expected service of the run's own compose project. Containers the tests
// start join that project's network, so they follow COMPOSE_PROJECT_NAME. Without the flag nothing is checked and
// the documented modes (CI, `pnpm dev:up`) keep their defaults.
import { AssertionError } from "node:assert/strict";
import { execFile } from "node:child_process";

export const FLAG = "GROMESH_STACK_ISOLATED";
// The standard project (`name:` in deploy/compose/docker-compose.yml) and its development credentials.
const SHARED_PROJECT = "gromesh";
const DEV_SECRETS = new Set(["gromesh-dev-observability", "gromesh-dev-reader", "gromesh-dev-writer"]);

// [variable, service, fixed port when the tests also use it without the variable]
const SCOPES = {
  acceptance: {
    required: ["COMPOSE_FILE", "UI_URL", "CLICKHOUSE_URL", "CLICKHOUSE_PASSWORD", "POSTGRES_PORT"],
    secrets: ["CLICKHOUSE_PASSWORD"],
    destinations: [
      ["UI_URL", "ui"], ["CLICKHOUSE_URL", "clickhouse"], ["POSTGRES_PORT", "postgres"],
      ["CP_URL", "control-plane", 3000], ["KONG_PROXY_URL", "kong", 8000], ["KONG_STATUS_URL", "kong", 8100],
      ["KONG_METRICS_URL", "kong", 8100], ["ECHO_URL", "echo", 8080],
    ],
  },
  integration: {
    required: ["TEST_DATABASE_URL", "TEST_CLICKHOUSE_URL", "KONG_VALIDATOR_URL", "TEST_CLICKHOUSE_PASSWORD", "TEST_CLICKHOUSE_ADMIN_PASSWORD"],
    secrets: ["TEST_CLICKHOUSE_PASSWORD", "TEST_CLICKHOUSE_ADMIN_PASSWORD"],
    destinations: [["TEST_DATABASE_URL", "postgres"], ["TEST_CLICKHOUSE_URL", "clickhouse"], ["KONG_VALIDATOR_URL", "kong-validator"]],
  },
};

export const isolated = (env = process.env) => env[FLAG] === "1";

/** Loopback host port of a URL or a bare port; null when it is not a loopback destination. */
function hostPort(value) {
  if (/^\d+$/.test(value)) return Number(value);
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
  const port = url.port || { "http:": "80", "https:": "443", "postgres:": "5432", "postgresql:": "5432" }[url.protocol];
  return port ? Number(port) : null;
}

/**
 * Problems that refuse the run (empty = ok). `containers`: [{ project, service, ports: [host ports] }] of every
 * running container. Values are never echoed: only variable names, ports and service names.
 */
export function stackProblems(scope, env, containers) {
  const spec = SCOPES[scope];
  if (!spec) throw new Error(`unknown stack scope ${scope}`);
  const project = env.COMPOSE_PROJECT_NAME;
  const problems = [];
  if (!project) problems.push("COMPOSE_PROJECT_NAME must name the run's own compose project");
  else if (project === SHARED_PROJECT) problems.push(`COMPOSE_PROJECT_NAME must not be the standard project "${SHARED_PROJECT}"`);
  for (const name of spec.required) if (!env[name]) problems.push(`${name} must be set explicitly`);
  for (const name of spec.secrets) if (env[name] && DEV_SECRETS.has(env[name])) problems.push(`${name} must not be a development default credential`);
  const owned = (port, service, label) => {
    const publishers = containers.filter((c) => c.ports.includes(port));
    const match = publishers.filter((c) => c.project === project && c.service === service);
    if (match.length === 1 && publishers.length === 1) return;
    const seen = publishers.map((c) => `${c.project}/${c.service}`).join(", ") || "no container";
    problems.push(`${label} (port ${port}) must be published by ${project ?? "?"}/${service}, found ${seen}`);
  };
  const checked = new Set();
  for (const [name, service, fixed] of spec.destinations) {
    if (env[name]) {
      const port = hostPort(env[name]);
      if (port === null) problems.push(`${name} must be a loopback URL or port`);
      else if (fixed !== undefined && port !== fixed) problems.push(`${name} must use port ${fixed}: other tests reach that port directly`);
      else if (!checked.has(`${port}/${service}`)) { checked.add(`${port}/${service}`); owned(port, service, name); }
    } else if (fixed !== undefined && !checked.has(`${fixed}/${service}`)) {
      checked.add(`${fixed}/${service}`);
      owned(fixed, service, `${service} (fixed in the tests)`);
    }
  }
  return problems;
}

/** Running containers with their compose project, service and published host ports. */
export async function runningContainers() {
  const stdout = await new Promise((resolve, reject) => execFile("docker", ["ps", "--format",
    '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Ports}}'], { timeout: 30_000 },
  (error, out) => error ? reject(new Error("docker ps failed: the isolated run cannot check its destinations")) : resolve(String(out))));
  return stdout.split("\n").filter(Boolean).map((line) => {
    const [project, service, ports = ""] = line.split("\t");
    const published = [...ports.matchAll(/:(\d+)->/g)].map((m) => Number(m[1]));
    return { project, service, ports: [...new Set(published)] };
  });
}

const done = new Set();
/** Refuses an isolated run whose destinations are not explicit or not the run's own stack. No-op otherwise. */
export async function assertStack(scope, env = process.env) {
  if (!isolated(env) || done.has(scope)) return;
  const problems = stackProblems(scope, env, await runningContainers());
  if (problems.length) {
    // An assertion: the scripts print assertion messages, which carry only names, ports and services.
    throw new AssertionError({ message: `Isolated run refused before any write (${FLAG}=1, scope ${scope}):\n- ${problems.join("\n- ")}` });
  }
  done.add(scope);
}

/** The compose files the run uses: COMPOSE_FILE when set, so explicit `-f` calls keep the run's overrides. */
export function composeFiles(base, env = process.env) {
  return env.COMPOSE_FILE ? env.COMPOSE_FILE.split(env.COMPOSE_PATH_SEPARATOR ?? ":") : [base];
}
