import { spawnSync } from "node:child_process";
import { composeFiles } from "./stack-guard.mjs";

const result = spawnSync("docker", ["compose", ...composeFiles("deploy/compose/docker-compose.yml").flatMap(f => ["-f", f]), ...process.argv.slice(2)], {
  cwd: new URL("../", import.meta.url), env: process.env, stdio: "inherit",
});
if (result.error) throw new Error("Compose command failed");
process.exitCode = result.status ?? 1;
