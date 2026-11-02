import pg from "pg";
import { inject } from "vitest";
import { createPostgresSandbox } from "../../../../scripts/integration-databases.mjs";

const admin = new URL(inject("databaseAdminUrl"));
if (!admin.port) admin.port = "5432";
export const ADMIN_URL = admin.toString();
const sandbox = createPostgresSandbox(ADMIN_URL, async (connectionString) => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
});

export const integrationDatabaseName = sandbox.name;
export const createIntegrationDatabase = sandbox.create;
export const dropIntegrationDatabase = sandbox.drop;
export function assertIntegrationDatabase(url: string): string {
  // The global-setup value is passed through Vitest, never accepted from the shell.
  return url === inject("databaseUrl") ? url : sandbox.assertOwned(url);
}
