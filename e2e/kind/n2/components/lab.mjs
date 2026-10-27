// Infrastructure of the N2 components suite: the lab guard, kubectl/helm/docker on the lab context only, the control
// plane's API through a port-forward (session + CSRF, API tokens) and its Postgres, and the objects the suite installs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const here = fileURLToPath(new URL(".", import.meta.url));
export const root = fileURLToPath(new URL("../../../../", import.meta.url));
export const CLUSTER = "gromesh-n2-lab";
export const CONTEXT = `kind-${CLUSTER}`;
export const NS = { cp: "gromesh-n2-cp", dp: "gromesh-n2-comp", fx: "gromesh-n2-fixtures" };
export const NODES = { cp: `${CLUSTER}-control-plane`, workers: [`${CLUSTER}-worker`, `${CLUSTER}-worker2`] };

// One explicit file, never a list, never a link, never the user's kubeconfig (same inode also catches a hard link).
export function assertLabKubeconfig(path, home) {
  if (!path) throw new Error("set LAB_KUBECONFIG to the lab kubeconfig file");
  if (path.includes(":")) throw new Error("LAB_KUBECONFIG must be a single file, not a list");
  if (lstatSync(path).isSymbolicLink()) throw new Error("LAB_KUBECONFIG must not be a symlink");
  const lab = statSync(path);
  let user;
  try { user = statSync(join(home, ".kube/config")); } catch { return; }
  if (lab.dev === user.dev && lab.ino === user.ino) throw new Error("LAB_KUBECONFIG must not be ~/.kube/config");
}

export const kubeconfig = process.env.LAB_KUBECONFIG;
assertLabKubeconfig(kubeconfig, homedir());
const env = { ...process.env, KUBECONFIG: kubeconfig };

export function run(command, args, { input, timeout = 180_000, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || allowFail) resolve({ code, stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${(stderr || stdout).slice(0, 4000)}`));
    });
    child.stdin.end(input ?? "");
  });
}
export const kubectl = (args, options) => run("kubectl", ["--kubeconfig", kubeconfig, "--context", CONTEXT, ...args], options);
export const helm = (args, options) => run("helm", ["--kubeconfig", kubeconfig, "--kube-context", CONTEXT, ...args], options);
export const docker = (args, options) => run("docker", args, options);
export const json = async (args) => JSON.parse((await kubectl([...args, "-o", "json"])).stdout);
export const apply = (objects) => kubectl(["apply", "-f", "-"], { input: JSON.stringify({ apiVersion: "v1", kind: "List", items: objects }) });

/**
 * cluster.sh status (N2-E1) proves, read-only, that the context is the named kind cluster (endpoint and CA as kind
 * exports them) and that it runs the pinned Kubernetes and Cilium; nothing is mutated before it passes.
 */
export async function assertLab() {
  const script = process.env.LAB_CLUSTER_SH ?? join(here, "../cluster.sh");
  assert.ok(existsSync(script), `cluster.sh of the N2 lab not found at ${script} (set LAB_CLUSTER_SH)`);
  const { code, stdout, stderr } = await run("bash", [script, "status"], { allowFail: true });
  assert.equal(code, 0, `the lab is not the pinned kind cluster: ${stderr.trim()}`);
  return stdout;
}

// --- control plane API --------------------------------------------------------------------------------------------
/** kubectl port-forward to the control plane Service, restarted whenever it dies (a restarted pod breaks it). */
export class Forward {
  constructor(port) { this.port = port; this.child = null; }

  async start() {
    this.stop();
    for (let attempt = 0; attempt < 30; attempt++) {
      const child = spawn("kubectl", ["--kubeconfig", kubeconfig, "--context", CONTEXT, "-n", NS.cp, "port-forward", "--address", "127.0.0.1", "svc/control-plane", `${this.port}:3000`], { env, stdio: ["ignore", "pipe", "pipe"] });
      const ready = await new Promise((resolve) => {
        let out = "";
        const timer = setTimeout(() => resolve(false), 10_000);
        child.stdout.on("data", (d) => { out += d; if (out.includes("Forwarding from")) { clearTimeout(timer); resolve(true); } });
        child.on("exit", () => { clearTimeout(timer); resolve(false); });
      });
      if (ready) { this.child = child; return; }
      child.kill("SIGKILL");
      await sleep(1000);
    }
    throw new Error("kubectl port-forward to the control plane did not come up");
  }

  async ensure() { if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) await this.start(); }
  stop() { if (this.child) { this.child.kill("SIGKILL"); this.child = null; } }
}

export class Api {
  constructor(forward) { this.forward = forward; }

  /** One request; `auth` is a session ({cookie, csrf}, csrf: false leaves the header out) or a bearer token. */
  async req(method, path, { body, session, csrf = true, token, timeoutMs = 15_000 } = {}) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (session) {
      headers.cookie = session.cookie;
      if (csrf && session.csrf) headers["x-csrf-token"] = session.csrf;
    }
    if (token) headers.authorization = `Bearer ${token}`;
    let last;
    for (let attempt = 0; attempt < 8; attempt++) {
      await this.forward.ensure();
      try {
        const res = await fetch(`http://127.0.0.1:${this.forward.port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        return { status: res.status, body: parsed, headers: res.headers };
      } catch (error) {
        // A broken forward (the pod restarted) or a control plane still starting: reconnect and retry.
        last = error;
        await this.forward.start().catch(() => {});
        await sleep(1000);
      }
    }
    throw new Error(`${method} ${path}: ${last}`);
  }

  async ok(method, path, options, expected = [200, 201, 202, 204]) {
    const res = await this.req(method, path, options);
    assert.ok(expected.includes(res.status), `${method} ${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async login(email, password) {
    const res = await this.req("POST", "/api/v1/auth/login", { body: { email, password } });
    assert.equal(res.status, 200, `login ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("gromesh_session="));
    assert.ok(cookie, "login set no gromesh_session cookie");
    const { csrfToken } = await this.ok("GET", "/api/v1/auth/csrf", { session: { cookie } });
    return { cookie, csrf: csrfToken };
  }
}

// --- control plane database (the lab's own, disposable) -----------------------------------------------------------
export async function sql(query) {
  const { stdout } = await kubectl(["-n", NS.cp, "exec", "-i", "deploy/postgres", "--", "psql", "-U", "gromesh", "-d", "gromesh", "-v", "ON_ERROR_STOP=1", "-At", "-f", "-"],
    { input: `select coalesce(json_agg(t), '[]'::json) from (${query}) t;\n`, timeout: 30_000 });
  return JSON.parse(stdout.trim());
}

/** Database clock minus this host's clock (ms), from the midpoint of a round trip: every DB instant is mapped back by it. */
export async function dbSkew() {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const before = Date.now();
    const [{ ms }] = await sql("select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms");
    const after = Date.now();
    samples.push({ skew: Number(ms) - (before + after) / 2, rtt: after - before });
  }
  return samples.sort((a, b) => a.rtt - b.rtt)[0];
}

// --- objects ------------------------------------------------------------------------------------------------------
const b64 = (n) => randomBytes(n).toString("base64");
export function cpSecrets() {
  const pg = randomBytes(18).toString("base64url");
  return {
    pgPassword: pg,
    admin: { email: "platform-admin@n2.lab", password: randomBytes(18).toString("base64url") },
    editor: { email: "editor@n2.lab", password: randomBytes(18).toString("base64url") },
    env: {
      DATABASE_URL: `postgres://gromesh:${pg}@postgres.${NS.cp}.svc.cluster.local:5432/gromesh`,
      GROMESH_ENCRYPTION_KEY: `lab1:${b64(32)}`,
      GROMESH_FINGERPRINT_KEY: b64(32),
    },
  };
}

const onControlPlaneNode = { nodeName: NODES.cp, tolerations: [{ operator: "Exists" }], automountServiceAccountToken: false };
const restricted = { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } };

/** Postgres and one control plane replica, both on the control plane node: nothing the suite does to a worker touches them. */
export function controlPlaneObjects(secrets, { cpImage, pgImage }) {
  const secret = { apiVersion: "v1", kind: "Secret", metadata: { name: "cp-env", namespace: NS.cp }, type: "Opaque",
    stringData: { ...secrets.env, BOOTSTRAP_ADMIN_EMAIL: secrets.admin.email, BOOTSTRAP_ADMIN_PASSWORD: secrets.admin.password, POSTGRES_PASSWORD: secrets.pgPassword } };
  const deployment = (name, spec) => ({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name, namespace: NS.cp, labels: { app: name } },
    spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { ...onControlPlaneNode, ...spec } } } });
  const service = (name, port) => ({ apiVersion: "v1", kind: "Service", metadata: { name, namespace: NS.cp }, spec: { selector: { app: name }, ports: [{ port, targetPort: port }] } });
  return [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: NS.cp } },
    secret,
    deployment("postgres", { containers: [{ name: "postgres", image: pgImage, imagePullPolicy: "Never",
      env: [{ name: "POSTGRES_DB", value: "gromesh" }, { name: "POSTGRES_USER", value: "gromesh" }, { name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "cp-env", key: "POSTGRES_PASSWORD" } } }],
      ports: [{ containerPort: 5432 }], readinessProbe: { exec: { command: ["pg_isready", "-U", "gromesh", "-d", "gromesh"] }, periodSeconds: 2 },
      resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "384Mi" } }, volumeMounts: [{ name: "data", mountPath: "/var/lib/postgresql/data" }] }],
      volumes: [{ name: "data", emptyDir: {} }] }),
    service("postgres", 5432),
    // The image's USER is the name `node`: the kubelet only verifies runAsNonRoot against a numeric uid.
    deployment("control-plane", { securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
      containers: [{ name: "control-plane", image: cpImage, imagePullPolicy: "Never",
        // The lab database is disposable: the app applies its migrations itself; http without TLS, so no Secure cookie.
        env: [{ name: "MIGRATE_ON_START", value: "true" }, { name: "COOKIE_SECURE", value: "false" }, { name: "PORT", value: "3000" }],
        envFrom: [{ secretRef: { name: "cp-env" } }],
        ports: [{ containerPort: 3000 }], readinessProbe: { httpGet: { path: "/healthz", port: 3000 }, periodSeconds: 2 },
        securityContext: restricted, resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: "512Mi" } } }] }),
    service("control-plane", 3000),
  ];
}

const ccnp = (name, egressDeny) => ({
  apiVersion: "cilium.io/v2", kind: "CiliumClusterwideNetworkPolicy", metadata: { name },
  spec: {
    endpointSelector: { matchLabels: { "app.kubernetes.io/name": "data-plane", "app.kubernetes.io/instance": "dp", "k8s:io.kubernetes.pod.namespace": NS.dp } },
    enableDefaultDeny: { egress: false, ingress: false },
    egressDeny,
  },
});

/** The N2-E1 protected layers for this suite's data plane namespace (the chart's own NetworkPolicy comes with the release). */
export function denyPolicies(net) {
  return [
    ccnp("n2c-deny-host", [{ toEntities: ["host", "remote-node"] }]),
    ccnp("n2c-deny-imds", [{ toCIDR: ["169.254.169.254/32", "169.254.170.2/32", "fd00:ec2::254/128"] }]),
    ccnp("n2c-deny-cidrs", [{ toCIDR: [...net.nodeCidrs, ...net.deniedCidrs] }]),
  ];
}
