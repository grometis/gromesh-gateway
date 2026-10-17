import "reflect-metadata";
import { createApp } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { AtRestService } from "./at-rest.js";

// Key rotation without downtime: start with GROMESH_ENCRYPTION_KEY=<new> and GROMESH_ENCRYPTION_KEYS=<old,...>
// on every replica, run this once, then drop the old keys from GROMESH_ENCRYPTION_KEYS.
const app = await createApp(loadConfig(), { logger: false });
const report = await app.get(AtRestService).rotate();
console.log(`re-sealed ${report.credentials} credentials, ${report.plugins} plugin configs, ${report.snapshots} snapshots, ${report.certificates} certificate keys, ${report.jwtSecrets} JWT secrets, ${report.basicAuthHashes} basic-auth hashes`);
await app.close();
