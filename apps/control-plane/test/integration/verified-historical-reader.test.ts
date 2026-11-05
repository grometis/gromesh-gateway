import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import type { TrustedCopyStorageSettings } from "../../src/analytics/trusted-copy-storage.js";
import { integrationInputs } from "../../../../scripts/integration-databases.mjs";
import { AgentGatewayService } from "../../src/agent-gateway/agent-gateway.js";
import { openTrustedIngestion } from "../../src/analytics/trusted-ingestion.js";
import { provisionTrustedCopyStorage } from "../../src/analytics/trusted-copy-storage.js";
import { openVerifiedHistoricalReader } from "../../src/analytics/verified-historical-reader.js";
import { trustedFixture, trustedRuntime, trustedContext as ctx } from "./trusted-copy-storage-fixtures.js";

async function chain(run: (f: Parameters<Parameters<typeof trustedFixture>[0]>[0], reader: Awaited<ReturnType<typeof openVerifiedHistoricalReader>>, producer: Awaited<ReturnType<typeof openTrustedIngestion>>, copies: ReturnType<typeof make>[], streamId: string, token: string, admin: ClickHouseClient, settings: TrustedCopyStorageSettings) => Promise<void>) {
  await trustedFixture(async (f, admin, settings) => {
    await provisionTrustedCopyStorage({ db: f.db, ctx, admin, settings, administratorNames: [integrationInputs(process.env).clickhouse.user] });
    const source = await f.registered();
    // Real CP delivery endpoint confirms the authorized synthetic node and post-commit map visibility.
    expect((await fetch(`${f.base}/agent/v2/deployments/current`, { headers: { authorization: `Bearer ${source.token}` } })).status).toBe(200);
    await trustedRuntime(f, async (db, _role, pool) => {
      const producer = await openTrustedIngestion({ db, gateway: f.h.app.get(AgentGatewayService), settings });
      const reader = await openVerifiedHistoricalReader({ pool, settings });
      try {
        const pod = randomUUID(), stream = await producer.open(source.token, pod);
        const ts = (await f.h.sql.query<{ ts: string }>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ts`)).rows[0]!.ts;
        const copies = [make(f.instanceId, source.source.clusterId, pod, ts, f.routeId, f.serviceId), make(f.instanceId, source.source.clusterId, pod, ts, f.otherRouteId, f.otherServiceId)];
        await producer.persist(source.token, stream.id, randomUUID(), copies);
        await run(f, reader, producer, copies, stream.id, source.token, admin, settings);
      } finally { await reader.close(); await producer.close(); }
    });
  });
}
function make(instanceId: string, clusterId: string, podUid: string, ts: string, routeId: string, serviceId: string) {
  const requestId = randomBytes(16).toString("hex"), h = createHash("sha256").update(`${clusterId}|${podUid}|${requestId}`).digest("hex").slice(0,32);
  return { schemaVersion: 1 as const, copyId: randomUUID(), requestId, podUid, event: {
    id: `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`, ts, environmentId: instanceId, clusterId, routeId, serviceId,
    consumerId: null, method: "GET", path: "/same", status: 200, latencyKongMs: 1, latencyUpstreamMs: null, latencyTotalMs: 2,
    clientIp: "2001:db8::1", requestSize: "9007199254740993", responseSize: "18446744073709551615", retentionDays: 7 } };
}
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
