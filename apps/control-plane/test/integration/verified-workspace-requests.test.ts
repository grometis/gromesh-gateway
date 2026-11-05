import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Module, RequestMethod, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { APP_CONFIG, type AppConfig } from "../../src/config.js";
import { WorkspaceRequestPreparationModule } from "../../src/analytics/workspace-request-preparation.js";
import { createVerifiedWorkspaceRequests } from "../../src/analytics/workspace-request-serving.js";
import { verifiedChain, makeVerifiedCopy } from "./verified-ingestion-fixtures.js";
import { copyStorageProxy, phaseBarrier } from "./copy-storage-proxy.js";

it("delivers proven persisted requests through real HTTP with scope, cursor and conservative failures", () => verifiedChain(async (f, _reader, producer, copies, streamId, token, _admin, settings, pool) => {
  let blocked = false, observers = 0;
  const observed = phaseBarrier(), release = phaseBarrier();
  const proxy = await copyStorageProxy(settings.url,async query=>{
    if(blocked&&query.includes("currentUser() AS principal")&&observers<2){if(++observers===2)observed.release();await release.promise;}
  });
  const serving = await createVerifiedWorkspaceRequests({ pool, settings:{...settings,url:proxy.url}, capacity: 3 });
  let app: INestApplication | undefined;
  try {
    const original = copies[0]!;
    await producer.persist(token, streamId, randomUUID(), [makeVerifiedCopy(f.instanceId, original.event.clusterId, original.podUid, original.event.ts, f.routeId, f.serviceId)]);
    @Module({ imports: [AppModule.forRoot(f.h.app.get<AppConfig>(APP_CONFIG)), WorkspaceRequestPreparationModule.withServing(serving)] }) class VerifiedTestApp {}
    app = await NestFactory.create(VerifiedTestApp, { logger: false });
    app.getHttpAdapter().getInstance().set("query parser", "simple");
    app.setGlobalPrefix("api/v1", { exclude: [{ path: "api/v2/{*splat}", method: RequestMethod.ALL }] });
    await app.init(); await app.listen(0, "127.0.0.1");
    const base = (await app.getUrl()).replace("[::1]", "127.0.0.1"), cookie = (await f.h.login(f.h.admin.email, f.h.admin.password)).cookie!;
    const fixed = new URLSearchParams({ from: new Date(Date.parse(original.event.ts)-1000).toISOString(), to: new Date().toISOString(), limit: "1" });
    const get = async (workspaceId: string, params = fixed, session: string | null = cookie) => {
      const response = await fetch(`${base}/api/v2/workspaces/${workspaceId}/requests?${params}`, { headers: session ? { cookie: session } : {} });
      return { status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json() as { items?: Record<string,unknown>[];nextCursor?:string|null;code?:string;delivery?:string } };
    };
    expect((await fetch(`${f.base}/api/v2/workspaces/${f.workspaceId}/requests?${fixed}`, { headers: { cookie } })).status).toBe(404);
    expect((await get(f.workspaceId, fixed, null)).status).toBe(401);
    const first = await get(f.workspaceId);
    expect(first.status).toBe(200); expect(first.body.delivery).toBe("best-effort"); expect(first.body.items).toHaveLength(1);
    const ajv = new Ajv2020.default({allErrors:true,strict:false});addFormats.default(ajv);
    const contract = JSON.parse(readFileSync(new URL("../../../../contracts/analytics-v2.schemas.json",import.meta.url),"utf8")) as Record<string,unknown>;
    const valid = ajv.compile({...contract,$ref:"#/components/schemas/WorkspaceRequestPage"});
    expect(valid(first.body),JSON.stringify(valid.errors)).toBe(true);
    expect(first.body.items![0]).toMatchObject({ workspaceId: f.workspaceId, routeId: f.routeId, effectiveRevision: null, requestSize: "9007199254740993" });
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const next = new URLSearchParams(fixed); next.set("cursor", first.body.nextCursor!);
    const second = await get(f.workspaceId, next);
    expect(second.status).toBe(200); expect(second.body.items).toHaveLength(1); expect(second.body.nextCursor).toBeNull();
    expect(second.body.items![0]!.id).not.toBe(first.body.items![0]!.id);
    const other=await get(f.otherWorkspaceId);expect(other.status).toBe(200);expect(other.body.items).toHaveLength(1);expect(other.body.items![0]).toMatchObject({workspaceId:f.otherWorkspaceId,routeId:f.otherRouteId});
    expect((await get(f.otherWorkspaceId, next)).status).toBe(422);
    const tampered = new URLSearchParams(next); tampered.set("cursor", first.body.nextCursor!+"0"); expect((await get(f.workspaceId, tampered)).status).toBe(422);
    const foreign = new URLSearchParams(fixed); foreign.set("routeId", f.otherRouteId); expect((await get(f.workspaceId, foreign)).status).toBe(404);
    const none = new URLSearchParams(fixed); none.set("status", "599"); const empty = await get(f.workspaceId, none); expect(empty.status).toBe(200); expect(empty.body.items).toEqual([]);
    const viewer = await f.h.as("viewer"), login = await f.h.login(viewer.email, viewer.password);
    expect((await get(f.workspaceId, next, login.cookie!)).status).toBe(422);
    const masked = await get(f.workspaceId, fixed, login.cookie!); expect(masked.status).toBe(200); expect(masked.body.items![0]!.clientIp).toBe("2001:db8:0::");
    await f.h.api("PUT", `/users/${viewer.id}/environment-roles`, { items: [{ environmentId: f.workspaceId, role: "none" }] });
    expect((await get(f.workspaceId, fixed, login.cookie!)).status).toBe(404);
    blocked=true;
    const a=get(f.workspaceId),b=get(f.workspaceId);
    try {
      await Promise.race([observed.promise,Promise.all([a,b]).then(()=>{throw Error("Expected controlled in-flight queries");})]);
      const third=await get(f.workspaceId);expect(third.status).toBe(429);expect(third.retryAfter).toBe("1");expect(observers).toBe(2);
      const leases=await f.h.sql.query<{pid:number}>("select pid from pg_stat_activity where datname=current_database() and application_name like 'gromesh-analytics-query:%' order by pid");
      expect(leases.rows).toHaveLength(2);
      await f.h.sql.query("select pg_terminate_backend($1)",[leases.rows[0]!.pid]);
    } finally {blocked=false;release.release();}
    expect([(await a).status,(await b).status].sort()).toEqual([200,502]);
    await producer.prepare(token, streamId, randomUUID(), [{ ...original, copyId: randomUUID() }]);
    const unavailable = await get(f.workspaceId); expect(unavailable.status).toBe(502); expect(unavailable.body.code).toBe("analytics-not-ready"); expect(unavailable.body).not.toHaveProperty("items");
  } finally { release.release();await app?.close(); await serving.close();await proxy.close(); }
}));
