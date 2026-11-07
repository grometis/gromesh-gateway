import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import pg from "pg";
import { copyStorageProxy } from "./copy-storage-proxy.js";
import { openVerifiedHistoricalReader } from "../../src/analytics/verified-historical-reader.js";
import { verifiedChain as chain } from "./verified-ingestion-fixtures.js";
const window = (instanceId: string, ts: string) => ({ instanceId, from: new Date(Date.parse(ts)-1000).toISOString(), to: new Date(Date.parse(ts)+1000).toISOString(), pageSize: 200 });

it("proves the admitted chain from real bearer and both databases to two workspace owners with identical paths", () => chain(async (f, reader, _producer, copies) => {
  const page = await reader.read(window(f.instanceId, copies[0]!.event.ts));
  expect(page.scope).toBe("admitted-prefix");
  expect(page.proof).toEqual({ copiesComplete: true, conflictHistoryComplete: true, coherentSnapshot: true, deliveryFromKongComplete: false });
  expect(page.items).toHaveLength(2);
  for (const [copy, workspaceId] of [[copies[0]!, f.workspaceId], [copies[1]!, f.otherWorkspaceId]] as const) {
    const item = page.items.find(i => i.id === copy.event.id)!;
    expect(item.attribution).toMatchObject({ workspaceId, reason: null, effectiveRevision: null });
    expect(item.storage).toMatchObject({ kind: "ready", content: { requestSize: "9007199254740993", responseSize: "18446744073709551615" } });
  }
  // No fixture supplies proof flags. The reader derives them after checking the actual admitted prefix.
}));
it("refuses an unpersisted intermediate admission rather than returning an empty valid result", () => chain(async (f, reader, producer, copies, stream, token) => {
  const copy = { ...copies[0]!, copyId: randomUUID() };
  await producer.prepare(token, stream, randomUUID(), [copy]);
  await expect(reader.read(window(f.instanceId, copy.event.ts))).rejects.toMatchObject({ code: "analytics-not-ready" });
}));
it("refuses a late cross-route conflict after an earlier valid observation", () => chain(async (f, reader, producer, copies, stream, token) => {
  const w = window(f.instanceId, copies[0]!.event.ts); expect((await reader.read(w)).items).toHaveLength(2);
  const conflict = { ...copies[0]!, copyId: randomUUID(), event: { ...copies[0]!.event, routeId: f.otherRouteId, serviceId: f.otherServiceId, status: 500 } };
  await expect(producer.persist(token, stream, randomUUID(), [conflict])).rejects.toThrow();
  await expect(reader.read(w)).rejects.toMatchObject({ code: "analytics-not-ready" });
}));
it("refuses an altered schema and never carries forward a previous successful proof", () => chain(async (f, reader, _producer, copies, _stream, _token, admin, settings) => {
  expect((await reader.read(window(f.instanceId, copies[0]!.event.ts))).items).toHaveLength(2);
  // Trusted test administrator deliberately violates the supported schema on this exclusively owned resource.
  await admin.command({ query: `ALTER TABLE ${settings.databaseName}.requests_v2_copies ADD COLUMN incompatible String` });
  await expect(reader.read(window(f.instanceId, copies[0]!.event.ts))).rejects.toMatchObject({ code: "analytics-not-ready" });
}));
it("refuses another instance and exposes neither clients nor resource mutation capabilities", () => chain(async (f, reader, _producer, copies) => {
  expect(Object.keys(reader).sort()).toEqual(["close", "read"]);
  await expect(reader.read({ ...window(f.instanceId, copies[0]!.event.ts), instanceId: randomUUID() })).rejects.toThrow();
}));
it("does not accept a receipt whose storage witness was removed or rebound", () => chain(async (f, reader, _producer, copies) => {
  await f.h.sql.query("update audit_events set after=after-'storageWitness' where action='analytics.ingestion.persist'");
  await expect(reader.read(window(f.instanceId, copies[0]!.event.ts))).rejects.toMatchObject({ code: "analytics-not-ready" });
}));
it("rechecks parts after the historical transaction commits and refuses a late physical deletion", () => chain(async (f, _reader, _producer, copies, _stream, _token, admin, settings, pool) => {
  let cuts = 0, noTransaction = false;
  const proxy = await copyStorageProxy(settings.url, async query => {
    if (query.includes("FROM system.parts") && ++cuts === 3) {
      const result = await f.h.sql.query<{ n: number }>("select count(*)::int n from pg_stat_activity where datname=current_database() and application_name like 'gromesh-analytics-read:%' and state='idle in transaction'");
      noTransaction = result.rows[0]!.n === 0;
      await admin.command({ query: `ALTER TABLE ${settings.databaseName}.requests_v2_copies DELETE WHERE id={id:UUID}`, query_params: { id: copies[0]!.event.id }, clickhouse_settings: { mutations_sync: "2" } });
    }
  });
  try {
    const guarded = await openVerifiedHistoricalReader({ pool, settings: { ...settings, url: proxy.url } });
    try { await expect(guarded.read(window(f.instanceId, copies[0]!.event.ts))).rejects.toMatchObject({ code: "analytics-not-ready" }); }
    finally { await guarded.close(); }
    expect(cuts).toBe(3); expect(noTransaction).toBe(true);
  } finally { await proxy.close(); }
}));
it("uses authoritative public history even if a pooled session contains a divergent TEMP route map", () => chain(async (f, _reader, _producer, copies, _stream, _token, _admin, settings, pool) => {
  const scoped = new pg.Pool({ ...pool.options, max: 1 });
  try {
    await scoped.query("create temporary table analytics_route_history_routes as select * from public.analytics_route_history_routes");
    await scoped.query("update analytics_route_history_routes set workspace_id=$1 where route_id=$2", [f.otherWorkspaceId,f.routeId]);
    expect((await scoped.query("select workspace_id from analytics_route_history_routes where route_id=$1 limit 1",[f.routeId])).rows[0]!.workspace_id).toBe(f.otherWorkspaceId);
    const reader = await openVerifiedHistoricalReader({ pool: scoped, settings });
    try {
      const result = await reader.read(window(f.instanceId,copies[0]!.event.ts));
      expect(result.items.find(item=>item.id===copies[0]!.event.id)!.attribution).toMatchObject({workspaceId:f.workspaceId,reason:null,effectiveRevision:null});
    } finally { await reader.close(); }
  } finally { await scoped.end(); }
}));
