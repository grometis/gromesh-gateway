import pg from "pg";
import { ADMIN_URL, assertIntegrationDatabase } from "./databases.js";

/** pg-pool.end can resolve before its idle sockets finish closing. Observe the owned DB, not a delay. */
export async function awaitDatabaseDisconnect(url: string) {
  assertIntegrationDatabase(url);
  const database = new URL(url).pathname.slice(1), control = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 1000, statement_timeout: 1000 });
  try {
    await control.connect();
    const until = performance.now() + 1000;
    do {
      const result = await control.query<{ n: number }>("select count(*)::int n from pg_stat_activity where datname=$1", [database]);
      if (result.rows[0]?.n === 0) return;
    } while (performance.now() < until);
    throw Error("Disposable database still has live clients after pool shutdown");
  } finally { await control.end(); }
}
