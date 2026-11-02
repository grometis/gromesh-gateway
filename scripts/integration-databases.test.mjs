import assert from "node:assert/strict";
import { createServer } from "node:http";
import { devNull } from "node:os";
import { test } from "node:test";
import { createPostgresSandbox, provisionClickhouse, clickhouseInputs } from "./integration-databases.mjs";
const adminUrl = "postgres://tester:secret@db.invalid:5432/base";
function postgres(existing = new Set(), fail = () => false) {
  const queries = [];
  const factory = async (url) => ({
    async query(sql) {
      queries.push({ url, sql });
      if (fail(sql))
        throw new Error("injected PG failure");
      const name = /"([a-z0-9_]+)"/.exec(sql)?.[1];
      if (sql.startsWith("CREATE DATABASE")) {
        if (existing.has(name))
          throw new Error("already exists");
        existing.add(name);
      }
      else if (sql.startsWith("DROP DATABASE"))
        existing.delete(name);
      else
        throw new Error(`unexpected base database write: ${sql}`);
    },
    async end() { },
  });
  return { factory, queries, existing };
}
test("Postgres owns only exclusively created random databases and never the base URL", async () => {
  const pg = postgres();
  const sandbox = createPostgresSandbox(adminUrl, pg.factory);
  const name = sandbox.name("migration");
  assert.notEqual(name, createPostgresSandbox(adminUrl, pg.factory).name("migration"));
  assert.throws(() => sandbox.assertOwned(adminUrl), /not owned/);
  assert.throws(() => sandbox.assertOwned(adminUrl.replace("base", name)), /not owned/);
  assert.throws(() => sandbox.name("gromesh; DROP DATABASE base"), /label/);
  await assert.rejects(sandbox.create("gromesh"), /not issued/);
  const url = await sandbox.create(name);
  assert.equal(sandbox.assertOwned(url), url);
  assert.throws(() => sandbox.assertOwned(url.replace("db.invalid", "elsewhere.invalid")), /not owned/);
  await assert.rejects(sandbox.drop("gromesh"), /not issued/);
  await sandbox.drop(name);
  assert.throws(() => sandbox.assertOwned(url), /not owned/);
  await sandbox.drop(name);
  assert.deepEqual(pg.queries.map(q => q.sql), [`CREATE DATABASE "${name}"`, `DROP DATABASE "${name}" WITH (FORCE)`]);
  assert.ok(pg.queries.every(q => q.url === adminUrl));
});
test("failed exclusive creation never adopts or drops an existing PostgreSQL database", async () => {
  const pg = postgres();
  const sandbox = createPostgresSandbox(adminUrl, pg.factory);
  const name = sandbox.name("collision");
  pg.existing.add(name);
  await assert.rejects(sandbox.create(name), /database command failed/);
  await sandbox.drop(name);
  assert.equal(pg.existing.has(name), true);
  assert.equal(pg.queries.length, 1);
});
async function clickhouse(run, reject = () => false) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let query = "";
    for await (const chunk of req)
      query += chunk;
    requests.push({ query, headers: req.headers, url: req.url });
    res.statusCode = reject(query) ? 403 : 200;
    res.end(res.statusCode === 200 ? "OK" : "sensitive server response");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(url, requests);
  }
  finally {
    await new Promise(resolve => server.close(resolve));
  }
}
const ddl = "CREATE TABLE IF NOT EXISTS gromesh.requests (id UUID) ENGINE = MergeTree ORDER BY id";
test("ClickHouse uses an exclusive database and new scoped users, then drops only its resources", async () => {
  await clickhouse(async (url, requests) => {
    const run = await provisionClickhouse({ url, user: "admin", password: "secret" }, ddl);
    assert.match(run.reader.database, /^gromesh_test_[a-f0-9]+$/);
    assert.equal(run.writer.database, run.reader.database);
    assert.notEqual(run.reader.user, run.writer.user);
    assert.notEqual(run.reader.password, run.writer.password);
    assert.ok(requests.every(r => !r.query.includes("IF NOT EXISTS") && !r.query.includes("gromesh.requests")));
    assert.match(requests.find(r => r.query.startsWith("GRANT SELECT")).query, new RegExp(`ON ${run.reader.database}\\.\\* TO ${run.reader.user}$`));
    assert.match(requests.find(r => r.query.startsWith("GRANT INSERT")).query, new RegExp(`ON ${run.reader.database}\\.\\* TO ${run.writer.user}$`));
    assert.ok(requests.every(r => !r.query.startsWith("GRANT ALL")));
    await run.close();
    assert.deepEqual(requests.filter(r => r.query.startsWith("DROP")).map(r => r.query), [
      `DROP USER ${run.writer.user}`, `DROP USER ${run.reader.user}`, `DROP DATABASE ${run.reader.database}`,
    ]);
  });
});
test("ClickHouse collision is fail closed without cleanup of the pre-existing database", async () => {
  await clickhouse(async (url, requests) => {
    await assert.rejects(provisionClickhouse({ url, user: "admin", password: "secret" }, ddl), /ClickHouse setup failed/);
    assert.equal(requests.length, 1);
    assert.match(requests[0].query, /^CREATE DATABASE gromesh_test_/);
  }, q => q.startsWith("CREATE DATABASE"));
});
test("ClickHouse setup failure removes owned database and users but omits failed user creation", async () => {
  await clickhouse(async (url, requests) => {
    await assert.rejects(provisionClickhouse({ url, user: "admin", password: "secret" }, ddl), e => !e.message.includes("sensitive server response") && /ClickHouse setup failed/.test(e.message));
    const creates = requests.filter(r => r.query.startsWith("CREATE USER"));
    const drops = requests.filter(r => r.query.startsWith("DROP"));
    assert.equal(creates.length, 2);
    assert.equal(drops.length, 2);
    assert.equal(drops[0].query, `DROP USER ${creates[0].query.split(" ")[2]}`);
    assert.match(drops[1].query, /^DROP DATABASE gromesh_test_/);
  }, q => q.startsWith("CREATE USER") && q.includes("_writer "));
});
test("ClickHouse rejects inherited database and reader overrides before any requests", () => {
  for (const key of ["TEST_CLICKHOUSE_DATABASE", "TEST_CLICKHOUSE_USER", "TEST_CLICKHOUSE_PASSWORD"]) {
    assert.throws(() => clickhouseInputs({ [key]: "gromesh" }), /generated/);
  }
  for (const url of ["http://db.invalid/?database=gromesh", "http://user:pw@db.invalid", "http://db.invalid/gromesh"]) {
    assert.throws(() => clickhouseInputs({ TEST_CLICKHOUSE_URL: url }), /origin/);
  }
  assert.equal(clickhouseInputs({ TEST_CLICKHOUSE_URL: "http://db.invalid:18123" }).url, "http://db.invalid:18123");
});
test("ClickHouse overrides preserve only run-owned identity and explicit unavailable-store test", async () => {
  const { assertClickhouseOverride } = await import("./integration-databases.mjs");
  const owned = { url: "http://db.invalid:18123", database: "gromesh_test_owned", user: "run_reader", password: "generated-secret" };
  assert.doesNotThrow(() => assertClickhouseOverride(owned, null));
  assert.doesNotThrow(() => assertClickhouseOverride(owned, { ...owned }));
  assert.doesNotThrow(() => assertClickhouseOverride(owned, { ...owned, url: "http://127.0.0.1:9" }));
  for (const override of [{ database: "gromesh" }, { url: "http://elsewhere.invalid" }, { user: "gromesh_reader" }, { password: "shared" }]) {
    assert.throws(() => assertClickhouseOverride(owned, { ...owned, ...override }), /not owned/);
  }
});
test("migration CLI targets cannot be redirected through an unproven command prefix", async () => {
  const { postgresToolUrl } = await import("./integration-databases.mjs");
  const pg = postgres();
  const sandbox = createPostgresSandbox(adminUrl, pg.factory);
  const name = sandbox.name("restore");
  const url = await sandbox.create(name);
  assert.equal(postgresToolUrl(url, {}, sandbox.assertOwned).toString(), url);
  assert.throws(() => postgresToolUrl(adminUrl, {}, sandbox.assertOwned), /not owned/);
  assert.throws(() => postgresToolUrl(url, { GROMESH_PG_TOOLS: "docker exec -i shared-postgres" }, sandbox.assertOwned), /unproven/);
});
test("Postgres teardown remains authorized when CREATE succeeds but disconnect fails", async () => {
  const queries = [];
  let disconnects = 0;
  const sandbox = createPostgresSandbox(adminUrl, async () => ({
    async query(sql) { queries.push(sql); },
    async end() { if (disconnects++ === 0)
      throw new Error("disconnect failed"); },
  }));
  const name = sandbox.name("disconnect");
  await assert.rejects(sandbox.create(name), /disconnect failed/);
  await sandbox.drop(name);
  assert.deepEqual(queries, [`CREATE DATABASE "${name}"`, `DROP DATABASE "${name}" WITH (FORCE)`]);
});
test("real ClickHouse migration files are scoped to the exclusive run database", async () => {
  const { readFile } = await import("node:fs/promises");
  const ddl = await Promise.all(["001-requests.sql", "002-retention.sql"].map(name => readFile(new URL(`../deploy/observability/clickhouse/${name}`, import.meta.url), "utf8")));
  await clickhouse(async (url, requests) => {
    const run = await provisionClickhouse({ url, user: "admin", password: "secret" }, ddl.join("\n"));
    const mutations = requests.filter(r => /^(CREATE TABLE|ALTER TABLE)/.test(r.query));
    assert.equal(mutations.length, 3);
    assert.ok(mutations.every(r => r.query.includes(`${run.reader.database}.requests`) && !r.query.includes("gromesh.requests") && !r.query.includes("IF NOT EXISTS")));
    await run.close();
  });
});
test("failed ClickHouse cleanup attempts every owned resource and remains retryable", async () => {
  let failed = false;
  await clickhouse(async (url, requests) => {
    const run = await provisionClickhouse({ url, user: "admin", password: "secret" }, ddl);
    await assert.rejects(run.close(), /cleanup failed/);
    assert.equal(requests.filter(r => r.query.startsWith("DROP")).length, 3);
    await run.close();
    const drops = requests.filter(r => r.query.startsWith("DROP"));
    assert.equal(drops.length, 4);
    assert.equal(drops[3].query, `DROP USER ${run.writer.user}`);
  }, q => { if (!failed && q.startsWith("DROP USER")) {
    failed = true;
    return true;
  } return false; });
});
test("Postgres rejects URL parameters or missing fields that can redirect native tools", () => {
  const factory = async () => { throw new Error("must not connect"); };
  for (const url of [
    `${adminUrl}?host=elsewhere.invalid`, `${adminUrl}?port=5439`, `${adminUrl}?user=other`,
    `${adminUrl}?options=-c%20search_path=public`, `${adminUrl}?connectionString=postgres://elsewhere.invalid/base`,
    "postgres:///base",
    "postgres://db.invalid/base",
    "postgres://tester@db.invalid/",
  ])
    assert.throws(() => createPostgresSandbox(url, factory), /PostgreSQL admin URL/);
  assert.doesNotThrow(() => createPostgresSandbox(`${adminUrl}?sslmode=require`, factory));
});
test("native migration tools strip every inherited PG variable before restoring proven credentials", async () => {
  const { postgresToolContext } = await import("./integration-databases.mjs");
  const url = adminUrl.replace("secret", "proven%20password");
  const inherited = {
    PATH: "/usr/bin", CI: "true",
    PGHOSTADDR: "192.0.2.5", PGHOST: "shared.invalid", PGPORT: "6432", PGDATABASE: "shared",
    PGUSER: "shared_admin", PGPASSWORD: "inherited-secret", PGSERVICE: "shared-service",
    PGSERVICEFILE: "/untrusted/service", PGSYSCONFDIR: "/untrusted", PGOPTIONS: "-c role=shared_admin",
    PGSSLMODE: "disable", PGSSLROOTCERT: "/untrusted/root", PGSSLKEY: "/untrusted/key", PGFUTUREOPTION: "untrusted",
  };
  const context = postgresToolContext(url, inherited, candidate => {
    assert.equal(candidate, url);
    return candidate;
  });
  assert.equal(context.url.toString(), url);
  assert.deepEqual(context.env, { PATH: "/usr/bin", CI: "true", PGPASSWORD: "proven password", PGPASSFILE: devNull });
  assert.equal(inherited.PGHOSTADDR, "192.0.2.5");
  assert.throws(() => postgresToolContext(adminUrl, {}, () => { throw new Error("not owned"); }), /not owned/);
});
test("native tools map only URL-owned TLS settings and reject ambiguous ssl options", async () => {
  const { postgresToolContext } = await import("./integration-databases.mjs");
  const tlsUrl = `${adminUrl}?sslmode=verify-full&sslrootcert=%2Fproven%2Froot.pem&sslcert=%2Fproven%2Fcert.pem&sslkey=%2Fproven%2Fkey.pem`;
  const context = postgresToolContext(tlsUrl, { PGSSLMODE: "disable", PGSSLROOTCERT: "/inherited/root", PATH: "/usr/bin" }, candidate => candidate);
  assert.deepEqual(context.env, {
    PATH: "/usr/bin", PGPASSWORD: "secret", PGPASSFILE: devNull, PGSSLMODE: "verify-full",
    PGSSLROOTCERT: "/proven/root.pem", PGSSLCERT: "/proven/cert.pem", PGSSLKEY: "/proven/key.pem",
  });
  for (const query of ["ssl=true", "ssl=false", "sslmode=unknown", "sslmode=no-verify"]) {
    assert.throws(() => postgresToolContext(`${adminUrl}?${query}`, {}, candidate => candidate), /TLS/);
  }
});
test("native tools cannot fall back to an ambient password file when the URL has no password", async () => {
  const { postgresToolContext } = await import("./integration-databases.mjs");
  const context = postgresToolContext(adminUrl.replace(":secret@", "@"), { PGPASSFILE: "/inherited/passwords" }, candidate => candidate);
  assert.equal(context.env.PGPASSWORD, "");
  assert.equal(context.env.PGPASSFILE, devNull);
});
test("private database creation cleans up immediately when disconnect fails before caller registration", async () => {
  const queries = [];
  let disconnects = 0;
  const sandbox = createPostgresSandbox(adminUrl, async () => ({
    async query(sql) { queries.push(sql); },
    async end() { if (disconnects++ === 0)
      throw new Error("CREATE disconnect failed"); },
  }));
  const name = sandbox.name("private");
  await assert.rejects(sandbox.create(name), /disconnect failed/);
  assert.deepEqual(queries, [`CREATE DATABASE "${name}"`, `DROP DATABASE "${name}" WITH (FORCE)`]);
  assert.throws(() => sandbox.assertOwned(adminUrl.replace("/base", `/${name}`)), /not owned/);
});
test("Postgres failed creation cleanup preserves both errors and ownership for a retry", async () => {
  let disconnects = 0;
  let drops = 0;
  const sandbox = createPostgresSandbox(adminUrl, async () => ({
    async query(sql) { if (sql.startsWith("DROP") && drops++ === 0)
      throw new Error("DROP failed"); },
    async end() { if (disconnects++ === 0)
      throw new Error("CREATE disconnect failed"); },
  }));
  const name = sandbox.name("private");
  await assert.rejects(sandbox.create(name), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0].message === "PostgreSQL disconnect failed" && error.errors[1].message === "PostgreSQL database command failed");
  await sandbox.drop(name);
  assert.equal(drops, 2);
});
test("database setup diagnostics never expose credentials in URL parser or client failures", async () => {
  const secret = "sensitive-fixture-database-password";
  const safe = error => !String(error.stack).includes(secret) && !JSON.stringify(error).includes(secret);
  assert.throws(() => createPostgresSandbox("://" + secret, () => { }), safe);
  assert.throws(() => clickhouseInputs({ TEST_CLICKHOUSE_URL: "://" + secret }), safe);
  const sandbox = createPostgresSandbox(adminUrl, async () => { throw Error(secret); });
  await assert.rejects(sandbox.create(sandbox.name()), safe);
  const queryFailure = createPostgresSandbox(adminUrl, async () => ({ async query() { throw Error(secret); }, async end() { } }));
  await assert.rejects(queryFailure.create(queryFailure.name()), safe);
});

test("integration requires all three explicit destinations before any connection", async () => {
  const { integrationInputs } = await import("./integration-databases.mjs");
  const env = {TEST_DATABASE_URL: adminUrl, TEST_CLICKHOUSE_URL: "http://db.invalid:8123", KONG_VALIDATOR_URL: "http://validator.invalid:8001"};
  for (const key of Object.keys(env)) {
    const missing = {...env}; delete missing[key];
    assert.throws(() => integrationInputs(missing), new RegExp(key));
  }
  assert.doesNotThrow(() => integrationInputs(env));
  assert.throws(() => clickhouseInputs({}), /TEST_CLICKHOUSE_URL/);
});
test("private file database owns its application_name URL and drops only its creation", async () => {
  const pg = postgres();
  const sandbox = createPostgresSandbox(adminUrl, pg.factory);
  const name = sandbox.name("wsr4d");
  const url = await sandbox.create(name, {applicationName: "ws-r4d-123"});
  assert.equal(new URL(url).searchParams.get("application_name"), "ws-r4d-123");
  assert.equal(sandbox.assertOwned(url), url);
  assert.throws(() => sandbox.assertOwned(url.replace("ws-r4d-123", "foreign")), /not owned/);
  await sandbox.drop(name);
  assert.throws(() => sandbox.assertOwned(url), /not owned/);
  assert.equal(pg.existing.size, 0);
});
