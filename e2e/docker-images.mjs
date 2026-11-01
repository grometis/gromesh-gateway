// Pulls the images an e2e script runs with `docker run`, before any step timeout starts counting: a cold pull on a
// CI runner can take longer than the step itself, and a timeout there is a false failure. Retries with backoff.
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const VECTOR_IMAGE = "timberio/vector:0.57.0-alpine@sha256:19e3526faf4d4b1ed0c28a0d68d4cc3a1e13e437099986a5b7a768707907497c";
// `docker run [options] ...VECTOR_TEST <tests.yaml...>`: unit tests of the mounted /etc/vector/vector.yaml after the same
// "config.sh render" the entrypoint does (the raw file has @@placeholders@@ that Vector cannot parse).
export const VECTOR_TEST = ["--entrypoint", "sh", VECTOR_IMAGE, "-c",
  'sh /etc/vector/config.sh render /etc/vector/vector.yaml > /tmp/vector.yaml && exec vector test /tmp/vector.yaml "$@"', "vector-test"];
export const NODE_IMAGE = "node:24.18.0-alpine";
// The same ClickHouse as deploy/compose: bumped together.
export const CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:25.8.33.6-alpine@sha256:87e0a5b72f5465b18eacca7c76850e7ff551c9795c50e451f5646299e5e24146";

export async function pullImages(images, { attempts = 4, timeoutMs = 300_000 } = {}) {
  for (const image of images) {
    // Already present (local runs, or a previous step): no network needed.
    if (await exec("docker", ["image", "inspect", image], { timeout: 30_000 }).then(() => true, () => false)) continue;
    for (let attempt = 1; ; attempt++) {
      try {
        await exec("docker", ["pull", "--quiet", image], { timeout: timeoutMs });
        break;
      } catch (error) {
        if (attempt >= attempts) throw new Error(`docker pull ${image} failed after ${attempts} attempts: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(2_000 * 2 ** (attempt - 1));
      }
    }
  }
}
