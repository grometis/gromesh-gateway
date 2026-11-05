import { createHash, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
import { authorizeClusterDelivery, confirmClusterAssociation } from "../../src/analytics/cluster-history.js";
import { IngestionAdmissions } from "../../src/analytics/ingestion-admissions.js";
import { AgentGatewayService } from "../../src/agent-gateway/agent-gateway.js";
import { pruneAdmissionHistory } from "../../src/analytics/admission-retention.js";
import { audit } from "../../src/audit/audit.js";

async function fixture() {
  const f = await clusterHistoryFixture();
  try {
    const producer = await f.registered();
    const authorization = await f.db.transaction(tx => authorizeClusterDelivery(tx, producer.ctx, producer.source));
    await confirmClusterAssociation(f.db, authorization);
    const service = new IngestionAdmissions(f.db, f.h.app.get(AgentGatewayService));
    const stream = await service.open(producer.token, randomUUID());
    return { ...f, producer, service, stream };
  } catch (error) { await f.close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function usingFixture(run: (f: Fixture) => Promise<void>) {
  const f = await fixture();
  try { await run(f); } finally { await f.close(); }
}
async function copy(f: Fixture, podUid = f.stream.podUid) {
  const requestId = randomUUID().replaceAll("-", "");
  const hex = createHash("sha256").update(`${f.producer.source.clusterId}|${podUid}|${requestId}`).digest("hex").slice(0, 32);
  const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  const ts = (await f.h.sql.query("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') ts")).rows[0]!.ts as string;
  return { schemaVersion: 1 as const, copyId: randomUUID(), podUid, requestId, event: {
    id, ts, environmentId: f.instanceId, clusterId: f.producer.source.clusterId,
    routeId: f.routeId, serviceId: f.serviceId, consumerId: null, method: "GET", path: "/same", status: 200,
    latencyKongMs: 1, latencyUpstreamMs: null, latencyTotalMs: 2, clientIp: "2001:db8::1",
    requestSize: "1", responseSize: "1", retentionDays: 7,
  } };
}
/** Synthetic expired metadata exercises GC, not an assertion of historical producer delivery. */
async function oldBatch(f: Fixture) {
  const id = randomUUID();
  await f.db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(1818,1801)`);
    const generation = (await tx.execute<{ position: string }>(sql`insert into analytics_ingestion_counter(singleton,position) values(true,1) on conflict(singleton) do update set position=analytics_ingestion_counter.position+1 returning position::text`)).rows[0]!.position;
    const descriptor = JSON.stringify([{ copyId: randomUUID(), id: randomUUID(), commitment: "a".repeat(64), expiresAt: "2020-01-01T00:00:00.000Z" }]);
    await tx.execute(sql`insert into analytics_ingestion_batches(id,stream_id,generation,descriptor,recorded_at) values(${id},${f.stream.id},${generation},${descriptor}::jsonb,clock_timestamp()-interval '8 days')`);
    await audit(tx, f.producer.ctx, { action: "synthetic.expired-admission", entityType: "ingestion-batch", entityId: id });
  });
  return id;
}
async function counters(f: Fixture) {
  return (await f.h.sql.query("select (select position::text from analytics_ingestion_counter) position,(select count(*)::int from audit_events where action='analytics.ingestion.prepare') prepared")).rows[0];
}
async function waitForLock(f: Fixture, key: number) {
  const until = Date.now() + 2500;
  while (Date.now() < until) {
    const row = (await f.h.sql.query("select exists(select 1 from pg_locks where database=(select oid from pg_database where datname=current_database()) and locktype='advisory' and classid=$1::oid and not granted) waiting", [key])).rows[0];
    if (row?.waiting) return;
    await setImmediate();
  }
  throw Error("Expected controlled PostgreSQL lock barrier");
}

it("does not admit any unprovable identity after pruning or allocate a position/audit on refusal", () => usingFixture(async f => {
  await oldBatch(f);
  expect(await pruneAdmissionHistory(f.db, f.producer.ctx, 1)).toEqual({ removed: 1 });
  const before = await counters(f);
  await expect(f.service.prepare(f.producer.token, f.stream.id, randomUUID(), [await copy(f)])).rejects.toMatchObject({ status: 409 });
  expect(await counters(f)).toEqual(before);
}));

it("preserves the exact live retry and original position after unrelated historical loss", () => usingFixture(async f => {
  const id = randomUUID(), copies = [await copy(f)];
  const admitted = await f.service.prepare(f.producer.token, f.stream.id, id, copies);
  await oldBatch(f);
  await pruneAdmissionHistory(f.db, f.producer.ctx, 1);
  const before = await counters(f);
  expect(await f.service.prepare(f.producer.token, f.stream.id, id, copies)).toEqual(admitted);
  await expect(f.service.prepare(f.producer.token, f.stream.id, id, [{ ...copies[0]!, event: { ...copies[0]!.event, status: 201 } }])).rejects.toMatchObject({ status: 409 });
  expect(await counters(f)).toEqual(before);
}));

it("refuses a pruned identity in its old stream without allocating a new generation", () => usingFixture(async f => {
  const id = await oldBatch(f);
  await pruneAdmissionHistory(f.db, f.producer.ctx, 1);
  const copies = [await copy(f)], before = await counters(f);
  await expect(f.service.prepare(f.producer.token, f.stream.id, id, copies)).rejects.toMatchObject({ status: 409 });
  expect(await counters(f)).toEqual(before);
}));

it("refuses unknown identities from two concurrent clients after pruning", () => usingFixture(async f => {
  await oldBatch(f); await pruneAdmissionHistory(f.db, f.producer.ctx, 1);
  const other = await f.service.open(f.producer.token, randomUUID()), before = await counters(f);
  const clients = [f.service, new IngestionAdmissions(f.db, f.h.app.get(AgentGatewayService))];
  const result = await Promise.allSettled([
    clients[0]!.prepare(f.producer.token, f.stream.id, randomUUID(), [await copy(f)]),
    clients[1]!.prepare(f.producer.token, other.id, randomUUID(), [await copy(f, other.podUid)]),
  ]);
  for (const item of result) { expect(item.status).toBe("rejected"); if (item.status === "rejected") expect(item.reason).toMatchObject({ status: 409 }); }
  expect(await counters(f)).toEqual(before);
}));

it("does not close admission when pruning rolls back before its audit commits", () => usingFixture(async f => {
  await oldBatch(f);
  await f.h.sql.query("create function r21_fail_prune() returns trigger language plpgsql as $$ begin if NEW.action='analytics.ingestion.prune' then raise exception 'synthetic prune failure'; end if; return NEW; end $$;create trigger r21_fail_prune before insert on audit_events for each row execute function r21_fail_prune()");
  try { await expect(pruneAdmissionHistory(f.db, f.producer.ctx, 1)).rejects.toMatchObject({ cause: { message: "synthetic prune failure" } }); }
  finally { await f.h.sql.query("drop trigger r21_fail_prune on audit_events;drop function r21_fail_prune()"); }
  expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_prune_coverage")).rows[0]!.n).toBe(0);
  await expect(f.service.prepare(f.producer.token, f.stream.id, randomUUID(), [await copy(f)])).resolves.toMatchObject({ state: "prepared" });
}));

it("serializes pruning before a waiting admission without resurrecting an identity", () => usingFixture(async f => {
  await oldBatch(f);
  const gate = await f.h.sql.connect();
  await gate.query("select pg_advisory_lock(2121,1)");
  await f.h.sql.query("create function r21_prune_barrier() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(2121,1); return OLD; end $$;create trigger r21_prune_barrier before delete on analytics_ingestion_batches for each row execute function r21_prune_barrier()");
  let pruning: Promise<unknown> | undefined, admission: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    const copies = [await copy(f)], before = await counters(f);
    pruning = pruneAdmissionHistory(f.db, f.producer.ctx, 1);
    await waitForLock(f, 2121);
    admission = Promise.allSettled([f.service.prepare(f.producer.token, f.stream.id, randomUUID(), copies)]);
    await waitForLock(f, 1818);
    await gate.query("select pg_advisory_unlock(2121,1)");
    expect(await pruning).toEqual({ removed: 1 });
    const [result] = await admission; expect(result?.status).toBe("rejected");
    if (result?.status === "rejected") expect(result.reason).toMatchObject({ status: 409 });
    expect(await counters(f)).toEqual(before);
  } finally {
    await gate.query("select pg_advisory_unlock_all()"); gate.release();
    await Promise.allSettled([pruning, admission]);
    await f.h.sql.query("drop trigger r21_prune_barrier on analytics_ingestion_batches;drop function r21_prune_barrier()");
  }
}));
