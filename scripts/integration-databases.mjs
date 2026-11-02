import { randomBytes } from "node:crypto";
import { devNull } from "node:os";
function privateUrl(value) {
  try {
    return new URL(value);
  }
  catch {
    throw new Error("Database URL is invalid");
  }
}
/** CREATE must succeed before a database becomes a permissible fixture or teardown target. */
export function createPostgresSandbox(adminUrl, connect) {
  const admin = privateUrl(adminUrl);
  const tlsParameters = new Set(["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey"]);
  if (!["postgres:", "postgresql:"].includes(admin.protocol) || !admin.hostname || !admin.username ||
    !/^\/[^/]+$/.test(decodeURIComponent(admin.pathname)) || admin.hash ||
    [...admin.searchParams.keys()].some(key => !tlsParameters.has(key))) {
    throw new Error("PostgreSQL admin URL requires an explicit host, user and database; only TLS query parameters are accepted");
  }
  // Do not inherit PGPORT: both the driver and native migration tools must reach the same server.
  if (!admin.port)
    admin.port = "5432";
  const adminConnection = admin.toString();
  const issued = new Set();
  const owned = new Map();
  const creating = new Set();
  const urlFor = name => {
    const url = new URL(admin);
    url.pathname = `/${name}`;
    return url.toString();
  };
  const execute = async (sql, succeeded) => {
    let client;
    try {
      client = await connect(adminConnection);
    }
    catch {
      throw new Error("PostgreSQL admin connection failed");
    }
    try {
      try {
        await client.query(sql);
      }
      catch {
        throw new Error("PostgreSQL database command failed");
      }
      succeeded();
    }
    finally {
      try {
        await client.end();
      }
      catch {
        throw new Error("PostgreSQL disconnect failed");
      }
    }
  };
  const drop = async (name) => {
    if (!issued.has(name))
      throw new Error("Database name was not issued by this run");
    // A failed CREATE, including a collision, must never make DROP permissible.
    if (!owned.has(name))
      return;
    await execute(`DROP DATABASE "${name}" WITH (FORCE)`, () => owned.delete(name));
  };
  return {
    name(label = "test") {
      if (!/^[a-z0-9_]{1,24}$/.test(label))
        throw new Error("Invalid database label");
      const name = `gromesh_test_${label}_${randomBytes(12).toString("hex")}`;
      issued.add(name);
      return name;
    },
    async create(name, { applicationName } = {}) {
      if (!issued.has(name))
        throw new Error("Database name was not issued by this run");
      if (owned.has(name) || creating.has(name))
        throw new Error("Database already created by this run");
      creating.add(name);
      try {
        const parsed = new URL(urlFor(name));
        if (applicationName !== undefined) {
          if (!/^[a-zA-Z0-9_-]{1,63}$/.test(applicationName))
            throw new Error("Invalid database application name");
          parsed.searchParams.set("application_name", applicationName);
        }
        const url = parsed.toString();
        await execute(`CREATE DATABASE "${name}"`, () => owned.set(name, url));
        return url;
      }
      catch (error) {
        // Callers cannot register a fixture if CREATE succeeded but disconnect rejected the promise.
        try {
          await drop(name);
        }
        catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "PostgreSQL creation and cleanup failed");
        }
        throw error;
      }
      finally {
        creating.delete(name);
      }
    },
    assertOwned(url) {
      if (![...owned.values()].includes(url))
        throw new Error("Database URL is not owned by this run");
      return url;
    },
    drop,
  };
}
export function integrationInputs(env = process.env) {
  const missing = ["TEST_DATABASE_URL", "TEST_CLICKHOUSE_URL", "KONG_VALIDATOR_URL"].filter(key => !env[key]);
  if (missing.length)
    throw new Error(`Integration requires explicit destinations: ${missing.join(", ")}`);
  const validator = privateUrl(env.KONG_VALIDATOR_URL);
  if (!["http:", "https:"].includes(validator.protocol) || validator.username || validator.password || validator.search || validator.hash)
    throw new Error("KONG_VALIDATOR_URL must be an HTTP URL without credentials or query");
  return { databaseUrl: env.TEST_DATABASE_URL, clickhouse: clickhouseInputs(env), validatorUrl: env.KONG_VALIDATOR_URL };
}
export function clickhouseInputs(env = process.env) {
  for (const key of ["TEST_CLICKHOUSE_DATABASE", "TEST_CLICKHOUSE_USER", "TEST_CLICKHOUSE_PASSWORD"]) {
    if (env[key] !== undefined)
      throw new Error(`${key} cannot override generated run resources`);
  }
  const url = env.TEST_CLICKHOUSE_URL;
  if (!url)
    throw new Error("TEST_CLICKHOUSE_URL must be set explicitly");
  const parsed = privateUrl(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("TEST_CLICKHOUSE_URL must be an HTTP origin without credentials, database path or query");
  }
  return {
    url,
    user: env.TEST_CLICKHOUSE_ADMIN_USER ?? "gromesh",
    password: env.TEST_CLICKHOUSE_ADMIN_PASSWORD ?? "gromesh-dev-observability",
  };
}
export async function provisionClickhouse(admin, requestsDdl) {
  const database = `gromesh_test_${randomBytes(16).toString("hex")}`;
  const reader = { url: admin.url, database, user: `${database}_reader`, password: randomBytes(24).toString("hex") };
  const writer = { url: admin.url, database, user: `${database}_writer`, password: randomBytes(24).toString("hex") };
  const owned = [];
  const command = async (query) => {
    let response;
    try {
      response = await fetch(admin.url, {
        method: "POST",
        headers: { "X-ClickHouse-User": admin.user, "X-ClickHouse-Key": admin.password },
        body: query,
        signal: AbortSignal.timeout(10000),
      });
      // Never surface query text (CREATE USER includes its credential) or server response bodies.
      await response.arrayBuffer();
    }
    catch {
      throw new Error("ClickHouse setup request failed");
    }
    if (!response.ok)
      throw new Error(`ClickHouse setup failed: HTTP ${response.status}; admin requires CREATE DATABASE, CREATE USER and scoped GRANT permissions`);
  };
  const close = async () => {
    const errors = [];
    for (const resource of [...owned].reverse()) {
      try {
        await command(`DROP ${resource}`);
        owned.splice(owned.indexOf(resource), 1);
      }
      catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "ClickHouse run cleanup failed");
  };
  try {
    await command(`CREATE DATABASE ${database}`);
    owned.push(`DATABASE ${database}`);
    // The migration is applied only to the database whose exclusive CREATE just succeeded.
    const schema = requestsDdl.replace(/CREATE DATABASE IF NOT EXISTS gromesh\s*;/, "").replaceAll("gromesh.requests", `${database}.requests`).replaceAll("IF NOT EXISTS ", "");
    if (/\bgromesh\b/.test(schema) || !schema.trim().startsWith(`CREATE TABLE ${database}.requests`))
      throw new Error("Unexpected ClickHouse requests schema");
    for (const statement of schema.split(";").map(s => s.trim()).filter(Boolean))
      await command(statement);
    for (const user of [reader, writer]) {
      await command(`CREATE USER ${user.user} IDENTIFIED WITH sha256_password BY '${user.password}'`);
      owned.push(`USER ${user.user}`);
      await command(`GRANT ${user === reader ? "SELECT" : "INSERT"} ON ${database}.* TO ${user.user}`);
    }
    return { reader, writer, close };
  }
  catch (error) {
    try {
      await close();
    }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "ClickHouse setup and cleanup failed");
    }
    throw error;
  }
}
export function assertClickhouseOverride(owned, override) {
  if (override && (override.database !== owned.database || override.user !== owned.user || override.password !== owned.password ||
    // Port 9 is the existing read-only, unreachable-store acceptance case; it cannot receive fixture writes.
    ![owned.url, "http://127.0.0.1:9"].includes(override.url)))
    throw new Error("ClickHouse override is not owned by this run");
}
export function postgresToolUrl(url, env, assertOwned) {
  assertOwned(url);
  if (env.GROMESH_PG_TOOLS)
    throw new Error("GROMESH_PG_TOOLS is unproven; use native PostgreSQL tools against the run-owned URL");
  return new URL(url);
}
export function postgresToolContext(url, inherited, assertOwned) {
  const parsed = postgresToolUrl(url, inherited, assertOwned);
  // libpq's PGHOSTADDR bypasses -h, and service/options variables can change more than the visible arguments.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith("PG")));
  env.PGPASSWORD = decodeURIComponent(parsed.password);
  env.PGPASSFILE = devNull;
  const tlsVariables = new Map([
    ["sslmode", "PGSSLMODE"], ["sslrootcert", "PGSSLROOTCERT"], ["sslcert", "PGSSLCERT"], ["sslkey", "PGSSLKEY"],
  ]);
  for (const [parameter, value] of parsed.searchParams) {
    const variable = tlsVariables.get(parameter);
    if (!variable || (parameter === "sslmode" && !["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(value))) {
      throw new Error("Native PostgreSQL tools require explicit libpq-compatible TLS URL parameters");
    }
    env[variable] = value;
  }
  return { url: parsed, env };
}
