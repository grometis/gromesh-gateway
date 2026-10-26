import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the pool-backed db or an open transaction. */
export type Executor = Db | Tx;

export const DB = Symbol("DB");
export const PG_POOL = Symbol("PG_POOL");
/** Work that needs the database after the HTTP server has stopped: run, in order, right before the pool ends. */
export const BEFORE_POOL_END = Symbol("BEFORE_POOL_END");

export function createDb(databaseUrl: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}
