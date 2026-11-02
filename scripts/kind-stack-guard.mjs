import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { assertLocalDaemon } from "./stack-guard.mjs";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fail = () => new Error("Kind test stack refused before any write: ownership, kubeconfig or port-forward proof missing");
export function kindClusterName(run) {
  return `gromesh-mvp-${createHash("sha256").update(run).digest("hex").slice(0, 32)}`;
}
export function kindProblems(env, node, current, exported) {
  const problems = [];
  const name = env.KIND_CLUSTER_NAME;
  if (!name || name === "gromesh-mvp" || !/^[a-z0-9][a-z0-9-]+$/.test(name))
    problems.push("KIND_CLUSTER_NAME");
  if (!/^[a-zA-Z0-9_-]{12,128}$/.test(env.GROMESH_DISPOSABLE_ID ?? ""))
    problems.push("GROMESH_DISPOSABLE_ID");
  else if (name !== kindClusterName(env.GROMESH_DISPOSABLE_ID))
    problems.push("kind cluster does not belong to this execution ID");
  if (!env.KUBECONFIG)
    problems.push("KUBECONFIG");
  if (node?.Config?.Labels?.["io.x-k8s.kind.cluster"] !== name || node?.State?.Running !== true)
    problems.push("kind node");
  if (current?.contexts?.[0]?.context?.cluster !== `kind-${name}` || current?.["current-context"] !== `kind-${name}`)
    problems.push("context");
  const cluster = current?.clusters?.[0]?.cluster, expected = exported?.clusters?.[0]?.cluster;
  if (!cluster?.server || !cluster?.["certificate-authority-data"] || cluster.server !== expected?.server
    || cluster["certificate-authority-data"] !== expected?.["certificate-authority-data"])
    problems.push("server/CA");
  try {
    const url = new URL(cluster.server);
    const bindings = node.NetworkSettings.Ports["6443/tcp"];
    if (url.protocol !== "https:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !bindings?.some(b => b.HostPort === url.port && ["127.0.0.1", "0.0.0.0"].includes(b.HostIp)))
      problems.push("API binding");
  }
  catch {
    problems.push("API binding");
  }
  return problems;
}
async function exec(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(fail()) : resolve(String(stdout))));
}
// Linux CI: bind ownership is proved by the socket inode in the actual kubectl process's fd table.
// Merely having a PID environment variable or a responsive localhost endpoint is insufficient.
export function listeningPorts(pid, read = readFileSync, list = readdirSync, link = readlinkSync) {
  if (!/^[1-9][0-9]*$/.test(String(pid)))
    throw fail();
  const sockets = new Set(list(`/proc/${pid}/fd`).flatMap(fd => {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(link(`/proc/${pid}/fd/${fd}`));
      return m ? [m[1]] : [];
    }
    catch {
      return [];
    }
  }));
  return new Set(read(`/proc/${pid}/net/tcp`, "utf8").split("\n").slice(1).flatMap(line => {
    const f = line.trim().split(/\s+/);
    if (f[3] !== "0A" || !sockets.has(f[9]))
      return [];
    const [host, port] = f[1].split(":");
    return host === "0100007F" ? [parseInt(port, 16)] : [];
  }));
}
export async function assertKindStack(scope = "cluster", env = process.env) {
  let dir;
  try {
    if (!env.KIND_CLUSTER_NAME || !env.KUBECONFIG || !env.GROMESH_DISPOSABLE_ID)
      throw fail();
    await assertLocalDaemon(env);
    const node = JSON.parse(await exec("docker", ["inspect", `${env.KIND_CLUSTER_NAME}-control-plane`]))[0];
    const current = JSON.parse(await exec("kubectl", ["--kubeconfig", env.KUBECONFIG, "config", "view", "--raw", "--minify", "-o", "json"]));
    const yaml = await exec("kind", ["get", "kubeconfig", "--name", env.KIND_CLUSTER_NAME]);
    dir = mkdtempSync(join(tmpdir(), "gromesh-kind-proof-"));
    const file = join(dir, "config");
    writeFileSync(file, yaml, { mode: 0o600 });
    const exported = JSON.parse(await exec("kubectl", ["--kubeconfig", file, "config", "view", "--raw", "--minify", "-o", "json"]));
    if (kindProblems(env, node, current, exported).length)
      throw fail();
    if (scope === "cluster")
      return;
    if (scope !== "acceptance" || !env.E2E_NAMESPACE || !env.E2E_ADMIN_PASSWORD || !env.E2E_ENV_ID || !env.E2E_CLUSTER_ID)
      throw fail();
    const ns = JSON.parse(await exec("kubectl", ["--kubeconfig", env.KUBECONFIG, "--context", `kind-${env.KIND_CLUSTER_NAME}`, "get", "namespace", env.E2E_NAMESPACE, "-o", "json"]));
    if (ns.metadata?.labels?.["com.grometis.gromesh.disposable"] !== env.GROMESH_DISPOSABLE_ID)
      throw fail();
    const forwards = [["UI_URL", "KIND_UI_FORWARD_PID", "cp-control-plane-ui", 8080], ["CP_URL", "KIND_CP_FORWARD_PID", "control-plane", 3000], ["KONG_PROXY_URL", "KIND_PROXY_FORWARD_PID", "mvp-data-plane", 8000]];
    for (const [variable, pidVariable, service, remote] of forwards) {
      const url = new URL(env[variable]);
      const pid = env[pidVariable];
      if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || url.username || url.password || !listeningPorts(pid).has(Number(url.port)))
        throw fail();
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const inherited = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (!inherited.includes(`KUBECONFIG=${env.KUBECONFIG}`))
        throw fail();
      const hasPair = (a, b) => cmd.some((v, i) => v === a && cmd[i + 1] === b);
      if (!cmd[0]?.endsWith("kubectl") || !hasPair("--context", `kind-${env.KIND_CLUSTER_NAME}`) || !hasPair("-n", env.E2E_NAMESPACE)
        || !cmd.includes("port-forward") || !hasPair("--address", "127.0.0.1") || !cmd.includes(`svc/${service}`) || !cmd.includes(`${url.port}:${remote}`))
        throw fail();
    }
  }
  catch {
    throw fail();
  }
  finally {
    if (dir)
      rmSync(dir, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href)
  if (process.argv[2] === "name") {
    if (!/^[a-zA-Z0-9_-]{12,128}$/.test(process.env.GROMESH_DISPOSABLE_ID ?? "")) throw fail();
    console.log(kindClusterName(process.env.GROMESH_DISPOSABLE_ID));
  } else await assertKindStack(process.argv[2]);
