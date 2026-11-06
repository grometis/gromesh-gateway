import pg from "pg";
import { expect, it, vi } from "vitest";
import { integrationDatabaseName, createIntegrationDatabase, dropIntegrationDatabase, ADMIN_URL } from "./databases.js";
import { awaitDatabaseDisconnect } from "./postgres-disconnect.js";

it("waits for actual owned backends to disconnect before disposable database removal", async () => {
  const name = integrationDatabaseName("r21disconnect"), url = await createIntegrationDatabase(name);
  const held = new pg.Client({ connectionString: url }), control = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await held.connect(); await control.connect();
    let complete = false;
    const drain = awaitDatabaseDisconnect(url).then(() => { complete = true; });
    // Synchronize on a real live backend, not an arbitrary sleep.
    await vi.waitFor(async () => { expect((await control.query<{ n: number }>("select count(*)::int n from pg_stat_activity where datname=$1", [name])).rows[0]!.n).toBe(1); });
    expect(complete).toBe(false);
    await held.end(); await drain;
    expect(complete).toBe(true);
  } finally { await held.end(); await control.end(); await dropIntegrationDatabase(name); }
});
