import { loadConfig } from "./config.js";
import { createApp } from "./bootstrap.js";

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.port, "0.0.0.0");
console.log(`control plane listening on :${config.port}${config.kongAdminUrl ? ` (pushing to ${config.kongAdminUrl})` : ""}`);
