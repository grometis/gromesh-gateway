// Pulls the images an e2e script runs with `docker run`, before any step timeout starts counting: a cold pull on a
// CI runner can take longer than the step itself, and a timeout there is a false failure. Retries with backoff.
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const VECTOR_IMAGE = "timberio/vector:0.53.0-alpine";
export const NODE_IMAGE = "node:24.18.0-alpine";

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
