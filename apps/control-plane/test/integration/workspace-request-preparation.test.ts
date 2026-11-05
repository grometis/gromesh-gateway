import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module,RequestMethod,type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll,beforeAll,it,expect } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { APP_CONFIG,type AppConfig } from "../../src/config.js";
import { WorkspaceRequestPreparationModule } from "../../src/analytics/workspace-request-preparation.js";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
let f:Awaited<ReturnType<typeof clusterHistoryFixture>>,app:INestApplication,base:string,cookie:string;
const url=(id:string,extra="")=>`${base}/api/v2/workspaces/${id}/requests?from=${encodeURIComponent(new Date(Date.now()-3600000).toISOString())}&to=${encodeURIComponent(new Date(Date.now()-1000).toISOString())}${extra}`;
beforeAll(async()=>{
 f=await clusterHistoryFixture();
 // Only this disposable test root imports the prepared module; AppModule/production has no new handler.
 @Module({imports:[AppModule.forRoot(f.h.app.get<AppConfig>(APP_CONFIG)),WorkspaceRequestPreparationModule]})class PreparedTestApp{}
 app=await NestFactory.create(PreparedTestApp,{logger:false});app.getHttpAdapter().getInstance().set("query parser","simple");
 app.setGlobalPrefix("api/v1",{exclude:[{path:"api/v2/{*splat}",method:RequestMethod.ALL}]});await app.init();await app.listen(0,"127.0.0.1");base=(await app.getUrl()).replace("[::1]","127.0.0.1");
 cookie=(await f.h.login(f.h.admin.email,f.h.admin.password)).cookie!;
});
afterAll(async()=>{await app?.close();await f?.close();});
async function get(id=f.workspaceId,extra="",session=cookie){const response=await fetch(url(id,extra),{headers:session?{cookie:session}:{}});return {status:response.status,body:await response.json() as Record<string,unknown>};}
it("does not register the prepared endpoint in the operational AppModule",async()=>{expect((await fetch(url(f.workspaceId).replace(base,f.base),{headers:{cookie}})).status).toBe(404);});
it("authorized valid HTTP requests fail closed with an explicit problem, never a synthetic empty page",async()=>{const r=await get();expect(r.status).toBe(502);expect(r.body.code).toBe("analytics-not-ready");expect(r.body).not.toHaveProperty("items");});
it("authenticates and reauthorizes the mandatory workspace before query parsing",async()=>{
 expect((await get(f.workspaceId,"","")).status).toBe(401);expect((await get(randomUUID(),"&invalid=1")).status).toBe(404);
 const viewer=await f.h.as("viewer");await f.h.api("PUT",`/users/${viewer.id}/environment-roles`,{items:[{environmentId:f.workspaceId,role:"none"}]});const login=await f.h.login(viewer.email,viewer.password);
 expect((await get(f.workspaceId,"&invalid=1",login.cookie!)).status).toBe(404);
});
it.each(["&instanceId=foreign","&environmentId=foreign","&status=200&statusClass=2xx","&limit=201","&limit=1&limit=2","&cursor=forged","&routeId=invalid","&method=GET"])("rejects invalid scoped HTTP input %s",async extra=>{const r=await get(f.workspaceId,extra);expect(r.status).toBe(422);});
it("rejects another workspace's Route and Service even while serving is unavailable",async()=>{expect((await get(f.workspaceId,`&routeId=${f.otherRouteId}`)).status).toBe(404);expect((await get(f.workspaceId,`&serviceId=${f.otherServiceId}`)).status).toBe(404);expect((await get(f.workspaceId,`&routeId=${f.routeId}&serviceId=${f.serviceId}`)).status).toBe(502);});
it("keeps archived workspace read semantics without activating Analytics",async()=>{await f.h.sql.query("update workspaces set status='archived' where id=$1",[f.workspaceId]);expect((await get()).status).toBe(502);});
