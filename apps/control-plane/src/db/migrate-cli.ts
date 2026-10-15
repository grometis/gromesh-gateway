import { loadConfig } from "../config.js";
import { runMigrations } from "./migrate.js";

await runMigrations(loadConfig().databaseUrl);
console.log("migrations applied");
