import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { PACKAGE_ROOT } from "../config.js";
import { backfillWorkspaces } from "../workspaces/workspaces.js";
import * as schema from "./schema.js";

export const MIGRATIONS_DIR = resolve(PACKAGE_ROOT, "drizzle");

/** The SQL migrations, then the data steps SQL cannot do (the slugs of the workspaces the N1 migration created). */
export async function runMigrations(databaseUrl: string, migrationsFolder = MIGRATIONS_DIR): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
    // A folder that stops before the N1 migration (the migration tests) has no workspaces yet.
    const { rows } = await pool.query<{ ok: boolean }>("select to_regclass('public.workspaces') is not null as ok");
    if (rows[0]?.ok) await drizzle(pool, { schema }).transaction((tx) => backfillWorkspaces(tx));
  } finally {
    await pool.end();
  }
}
