import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import type pg from "pg";
import type { TrustedCopyStorageSettings } from "../../src/analytics/trusted-copy-storage.js";
import { integrationInputs } from "../../../../scripts/integration-databases.mjs";
import { AgentGatewayService } from "../../src/agent-gateway/agent-gateway.js";
import { openTrustedIngestion } from "../../src/analytics/trusted-ingestion.js";
import { provisionTrustedCopyStorage } from "../../src/analytics/trusted-copy-storage.js";
import { openVerifiedHistoricalReader } from "../../src/analytics/verified-historical-reader.js";
import { trustedFixture, trustedRuntime, trustedContext as ctx } from "./trusted-copy-storage-fixtures.js";
export async function verifiedChain(run: (f: Parameters<Parameters<typeof trustedFixture>[0]>[0], reader: Awaited<ReturnType<typeof openVerifiedHistoricalReader>>, producer: Awaited<ReturnType<typeof openTrustedIngestion>>, copies: ReturnType<typeof makeVerifiedCopy>[], streamId: string, token: string, admin: ClickHouseClient, settings: TrustedCopyStorageSettings, pool: pg.Pool) => Promise<void>) {
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
        const copies = [makeVerifiedCopy(f.instanceId, source.source.clusterId, pod, ts, f.routeId, f.serviceId), makeVerifiedCopy(f.instanceId, source.source.clusterId, pod, ts, f.otherRouteId, f.otherServiceId)];
        await producer.persist(source.token, stream.id, randomUUID(), copies);
        await run(f, reader, producer, copies, stream.id, source.token, admin, settings, pool);
      } finally { await reader.close(); await producer.close(); }
    });
  });
}
export function makeVerifiedCopy(instanceId: string, clusterId: string, podUid: string, ts: string, routeId: string, serviceId: string) {
  const requestId = randomBytes(16).toString("hex"), h = createHash("sha256").update(`${clusterId}|${podUid}|${requestId}`).digest("hex").slice(0,32);
  return { schemaVersion: 1 as const, copyId: randomUUID(), requestId, podUid, event: {
    id: `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`, ts, environmentId: instanceId, clusterId, routeId, serviceId,
    consumerId: null, method: "GET", path: "/same", status: 200, latencyKongMs: 1, latencyUpstreamMs: null, latencyTotalMs: 2,
    clientIp: "2001:db8::1", requestSize: "9007199254740993", responseSize: "18446744073709551615", retentionDays: 7 } };
}
