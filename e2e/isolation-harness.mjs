// Shared by the Workspaces e2e: builds apps/isolation for the Docker host's architecture inside the agent's Go image,
// runs the test lease writer (the isolation-probe's stand-in) and a Kong 3.9.4 gateway with the product plugins, the
// lease volume read-only and, on request, kong-supervisor as PID 1. Everything lives on one private network.
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { disposableDocker } from "../scripts/disposable-docker.mjs";
import { NODE_IMAGE, pullImages } from "./docker-images.mjs";

const exec = promisify(execFile);
export const root = fileURLToPath(new URL("../", import.meta.url));
const ownedDocker = disposableDocker((args) => exec("docker", args, { cwd: root, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }));
export const docker = (...args) => ownedDocker(args);
// The same toolchain as apps/agent/Dockerfile.
const GO_IMAGE = "golang:1.27.2-alpine";
export const ECHO_IMAGE = "traefik/whoami:v1.10.3";

export async function kongImage() {
  const { stdout } = await exec(process.execPath, [join(root, "scripts/kong-image-ref.mjs")]);
  return stdout.trim().split(" ")[0];
}

export class Harness {
  constructor() {
    this.run = randomUUID();
    this.network = `gromesh-e2e-${this.run}`;
    this.dir = mkdtempSync(join(tmpdir(), "gromesh-e2e-"));
    this.containers = [];
    this.volumes = [];
    this.podUid = randomUUID();
  }

  async setup() {
    await pullImages([ECHO_IMAGE, NODE_IMAGE, GO_IMAGE]);
    this.kongImage = await kongImage();
    await pullImages([this.kongImage]);
    await docker("network", "create", this.network);
    this.containers.push((await docker("run", "-d", "--rm", "--network", this.network, "--network-alias", "echo", ECHO_IMAGE)).stdout.trim());
    // CGO off: static binaries that run in the Kong image and in the node image alike.
    await docker("run", "--rm", "-v", `${join(root, "apps/isolation")}:/src:ro`, "-v", `${this.dir}:/out`, "-w", "/src",
      "-e", "CGO_ENABLED=0", "-e", "GOTOOLCHAIN=local", "-e", "GOCACHE=/tmp/go-cache", GO_IMAGE,
      "go", "build", "-trimpath", "-o", "/out/bin/", "./cmd/...");
    this.leaseVolume = `gromesh-e2e-lease-${this.run}`;
    await docker("volume", "create", this.leaseVolume);
    this.volumes.push(this.leaseVolume);
    this.mode("stop");
    this.writer = (await docker("run", "-d", "--rm", "--network", "none", "-v", `${this.leaseVolume}:/gromesh/isolation`,
      "-v", `${join(this.dir, "bin")}:/gromesh/bin:ro`, "-v", `${join(this.dir, "control")}:/control:ro`,
      "-e", "GROMESH_LEASE_FILE=/gromesh/isolation/lease.json", "-e", "GROMESH_TEST_MODE_FILE=/control/mode",
      "-e", `GROMESH_POD_UID=${this.podUid}`, "--entrypoint", "/gromesh/bin/test-lease-writer", NODE_IMAGE)).stdout.trim();
    this.containers.push(this.writer);
  }

  /** ok | violation | other-boot | other-pod | stop: what the lease writer does from now on. */
  mode(value) {
    // The directory is bind-mounted, the file replaced by rename: the container sees each new content.
    mkdirSync(join(this.dir, "control"), { recursive: true });
    writeFileSync(join(this.dir, "control", ".mode"), value, { mode: 0o644 });
    renameSync(join(this.dir, "control", ".mode"), join(this.dir, "control", "mode"));
  }

  /** Starts the gateway with `config`; supervised → kong-supervisor is PID 1. Returns the proxy URL. */
  async gateway(config, { plugins = "bundled,gromesh-workspace,gromesh-route-guard", supervised = false, pluginsDir = join(root, "images/kong/plugins") } = {}) {
    const name = `kong-${this.run}-${this.containers.length}`;
    writeFileSync(join(this.dir, `${name}.json`), JSON.stringify(config), { mode: 0o644 });
    const state = `gromesh-e2e-state-${this.run}-${this.containers.length}`;
    await docker("volume", "create", state);
    this.volumes.push(state);
    // The kong user (1001) writes its state; the volume starts root-owned.
    await docker("run", "--rm", "-v", `${state}:/s`, NODE_IMAGE, "chown", "1001:1001", "/s");
    const args = ["run", "-d", "--name", name, "--network", this.network, "-p", "127.0.0.1::8000",
      "-v", `${pluginsDir}:/opt/gromesh/plugins:ro`, "-v", `${this.dir}:/kong:ro`,
      "-v", `${this.leaseVolume}:/gromesh/isolation:ro`, "-v", `${state}:/gromesh/kong-state`,
      "-v", `${join(this.dir, "bin")}:/gromesh/bin:ro`,
      "-e", `KONG_DECLARATIVE_CONFIG=/kong/${name}.json`, "-e", `KONG_PLUGINS=${plugins}`,
      "-e", "KONG_PROXY_LISTEN=0.0.0.0:8000", "-e", "KONG_ADMIN_LISTEN=off", "-e", "KONG_STATUS_LISTEN=off",
      "-e", "KONG_NGINX_WORKER_PROCESSES=1", "-e", `GROMESH_POD_UID=${this.podUid}`, "-e", "KONG_NGINX_MAIN_ENV=GROMESH_POD_UID",
      "-e", "GROMESH_KONG_STATE_FILE=/gromesh/kong-state/kong-state.json"];
    if (supervised) args.push("--entrypoint", "/gromesh/bin/kong-supervisor", this.kongImage, "--", "/usr/local/bin/gromesh-entrypoint", "kong", "docker-start");
    else args.push(this.kongImage);
    const id = (await docker(...args)).stdout.trim();
    this.containers.push(id);
    const port = (await docker("port", id, "8000/tcp")).stdout.trim().split("\n")[0].split(":").pop();
    return { id, proxy: `http://127.0.0.1:${port}`, state };
  }

  /** Writes the probe's InstanceTrustSet (replaced by rename, as the kubelet swaps a ConfigMap's files). */
  trustSet(keys) {
    const dir = join(this.dir, "trust");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".instance-keys.json"), JSON.stringify({ keys: keys.map(({ kid, publicKey }) => ({ kid, publicKey })) }), { mode: 0o644 });
    renameSync(join(dir, ".instance-keys.json"), join(dir, "instance-keys.json"));
  }

  /**
   * The real isolation-probe in the gateway's network namespace (it proves what Kong reaches), writing the lease
   * volume; `handoff` is the directory the agent would share with it, `trustSet` its instance keys ({kid, publicKey})
   * and `kongState` the gateway's kong-state volume (read-only, for the final report). Returns the container id.
   */
  async probe(kongId, { config, trustSet, clusterId, handoff, kongState }) {
    writeFileSync(join(this.dir, "probe.json"), JSON.stringify(config), { mode: 0o644 });
    mkdirSync(handoff, { recursive: true });
    this.trustSet(trustSet);
    const id = (await docker("run", "-d", "--network", `container:${kongId}`, "-v", `${this.leaseVolume}:/gromesh/isolation`,
      "-v", `${handoff}:/gromesh/handoff`, "-v", `${join(this.dir, "bin")}:/gromesh/bin:ro`, "-v", `${join(this.dir, "probe.json")}:/etc/gromesh/probe.json:ro`,
      "-v", `${join(this.dir, "trust")}:/etc/gromesh/trust:ro`, ...(kongState ? ["-v", `${kongState}:/gromesh/kong-state:ro`] : []),
      "-e", `GROMESH_POD_UID=${this.podUid}`, "-e", `GROMESH_CLUSTER_ID=${clusterId}`, "-e", "GROMESH_INSTANCE_KEYS=/etc/gromesh/trust/instance-keys.json",
      "--entrypoint", "/gromesh/bin/isolation-probe", NODE_IMAGE)).stdout.trim();
    this.containers.push(id);
    return id;
  }

  /** Writes a file of the handoff from a container, as the agent would (root-owned files on Linux runners). */
  async put(handoff, name, content) {
    const data = Buffer.from(content).toString("base64");
    await docker("run", "--rm", "-v", `${handoff}:/h`, NODE_IMAGE, "sh", "-c", `echo ${data} | base64 -d > /h/.${name}.tmp && mv /h/.${name}.tmp /h/${name}`);
  }

  async waitFor(what, ok, { timeoutMs = 60_000, id } = {}) {
    const began = Date.now();
    for (;;) {
      if (await ok().catch(() => false)) return Date.now() - began;
      if (Date.now() - began > timeoutMs) {
        const logs = id ? await docker("logs", "--tail", "60", id).then((r) => r.stdout + r.stderr, () => "") : "";
        throw new Error(`${what}: not within ${timeoutMs} ms\n${logs}`.slice(0, 6000));
      }
      await sleep(100);
    }
  }

  async teardown() {
    for (const id of this.containers.reverse()) await docker("rm", "-f", id).catch(() => {});
    for (const v of this.volumes) await docker("volume", "rm", "-f", v).catch(() => {});
    await docker("network", "rm", this.network).catch(() => {});
    // On Linux the containers leave root-owned files in the bind-mounted directory: removed from a container first.
    await docker("run", "--rm", "-v", `${this.dir}:/d`, NODE_IMAGE, "sh", "-c", "rm -rf /d/* /d/.[!.]*").catch(() => {});
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** An instance signing key as the control plane holds one: kid = RFC 7638 thumbprint of its public key. */
export function instanceKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x;
  return { privateKey, publicKey: x, kid: createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest("base64url") };
}

/** A flattened JWS with the typed header of agent-protocol-v2: {alg, kid, typ} for instance-signed documents. */
export function instanceJws(key, typ, claims, { kid = key.kid } = {}) {
  const b64 = (data) => Buffer.from(data).toString("base64url");
  const protectedHeader = b64(JSON.stringify({ alg: "EdDSA", kid, typ }));
  const payload = b64(JSON.stringify(claims));
  return JSON.stringify({ protected: protectedHeader, payload, signature: b64(sign(null, Buffer.from(`${protectedHeader}.${payload}`), key.privateKey)) });
}
