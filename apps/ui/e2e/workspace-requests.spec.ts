import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect,mockSession,test } from "./fixtures";
import { checkLayout } from "./layout";
const A="11111111-1111-4111-8111-111111111111",I="22222222-2222-4222-8222-222222222222",R="33333333-3333-4333-8333-333333333333",stamp="2026-11-05T03:00:00.000Z";
async function setup(page:Page,enabled=false){
 const traffic:string[]=[];
 if(enabled)await page.route(/\/src\/pages\/WorkspaceRequests\.tsx(?:\?.*)?$/,async route=>{
  // Synthetic browser-only activation. The committed router flag remains false and no backend is enabled.
  const response=await route.fetch(),body=await response.text();expect(body).toContain("WORKSPACE_REQUESTS_ENABLED = false");await route.fulfill({response,body:body.replace("WORKSPACE_REQUESTS_ENABLED = false","WORKSPACE_REQUESTS_ENABLED = true")});
 });
 const workspace={id:A,key:A,name:"Workspace de pedidos",slug:"pedidos",status:"active",activeRelease:null};
 await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//,async route=>{
  const url=new URL(route.request().url()),path=url.pathname;
  if(path.endsWith("/requests")){traffic.push(url.toString());const from=url.searchParams.get("from")!,to=url.searchParams.get("to")!,ts=new Date((Date.parse(from)+Date.parse(to))/2).toISOString();return route.fulfill({json:{scope:"workspace",instanceId:I,workspaceId:A,from,to,generatedAt:to,attributionVersion:"route-history-v2",retention:"per-route-1-to-7-days",delivery:"best-effort",items:[{id:R,ts,instanceId:I,workspaceId:A,clusterId:I,routeId:R,serviceId:I,consumerId:null,method:"GET",path:"/synthetic",status:url.searchParams.has("status")?Number(url.searchParams.get("status")):url.searchParams.get("statusClass")?Number(url.searchParams.get("statusClass")![0])*100+(url.searchParams.get("statusClass")==="5xx"?3:0):200,latencyKongMs:1,latencyUpstreamMs:null,latencyTotalMs:2,clientIp:"2001:db8::",requestSize:"9007199254740993",responseSize:"1",effectiveRevision:null,candidateRevisions:[{epoch:1,revision:1,recordedAt:stamp}]}],nextCursor:null}});}
  if(path==="/api/v1/auth/csrf")return route.fulfill({json:{csrfToken:"synthetic"}});
  if(path==="/api/v2/workspace-creation-policy")return route.fulfill({status:403,json:{title:"Forbidden",status:403}});
  if(path==="/api/v2/workspaces")return route.fulfill({json:{items:[workspace],nextCursor:null}});
  if(path===`/api/v2/workspaces/${A}`)return route.fulfill({json:workspace});
  if(path.endsWith("/variables")||path.endsWith("/releases"))return route.fulfill({json:[]});
  return route.fulfill({json:{items:[],nextCursor:null}});
 });
 await mockSession(page,{id:A,name:"Ana",email:"ana@example.test",role:"viewer",active:true,createdAt:stamp,updatedAt:stamp});
 await page.context().addCookies([{name:"gromesh_session",value:"synthetic-workspace-requests",url:test.info().project.use.baseURL!}]);return traffic;
}
function browserEvidence(page:Page){
 const failures:string[]=[],logs:{level:string;text:string;url:string}[]=[];
 page.on("pageerror",error=>failures.push(error.message));
 page.on("console",message=>{if(!["error","warning"].includes(message.type()))return;const entry={level:message.type(),text:message.text(),url:message.location().url};logs.push(entry);
  // This explicit 403 is the synthetic viewer's creation-policy response, not an application runtime failure.
  if(!(entry.url.endsWith("/api/v2/workspace-creation-policy")&&entry.text.includes("status of 403")))failures.push(entry.text);
 });
 return {failures,finish:async()=>{await expect(page).toHaveURL(new RegExp(`/workspaces/${A}/requests$`));await expect(page).toHaveTitle("Gromesh Gateway");await expect(page.locator("vite-error-overlay")).toHaveCount(0);expect(failures).toEqual([]);await test.info().attach("browser-console",{body:Buffer.from(JSON.stringify(logs)),contentType:"application/json"});}};
}
for(const width of [390,768,1440]){
 test(`disabled Workspace requests does not imply empty traffic at ${width}px`,async({page})=>{
  const evidence=browserEvidence(page);const traffic=await setup(page);await page.setViewportSize({width,height:900});await page.goto(`/workspaces/${A}/requests`);
  await expect(page.getByRole("heading",{name:"Requisições do Workspace",exact:true})).toBeVisible();await expect(page.locator("main").getByRole("status").filter({hasText:"Analytics ainda não ativado"})).toContainText("Analytics ainda não ativado");expect(traffic).toEqual([]);
  await checkLayout(page);expect((await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({path:test.info().outputPath(`disabled-${width}.png`),fullPage:true});await evidence.finish();
 });
 test(`synthetic isolated request query states and keyboard at ${width}px`,async({page})=>{
  const evidence=browserEvidence(page);const traffic=await setup(page,true);await page.setViewportSize({width,height:900});await page.goto(`/workspaces/${A}/requests`);
  await expect(page.getByRole("table",{name:"Requisições do Workspace"})).toBeVisible();const initial=traffic.length;await page.getByLabel("Classe de status",{exact:true}).selectOption("5xx");await expect(page.getByText("Filtros alterados. Selecione Consultar para atualizar os resultados.")).toBeVisible();expect(traffic).toHaveLength(initial);
  await page.getByRole("button",{name:"Consultar",exact:true}).click();await expect(page.getByRole("cell",{name:"503",exact:true})).toBeVisible();
  await page.getByLabel("ID da rota",{exact:true}).fill(R);await page.getByLabel("ID do serviço",{exact:true}).fill(I);await page.getByLabel("Status HTTP exato",{exact:true}).fill("500");
  await expect(page.getByLabel("Classe de status",{exact:true})).toHaveValue("");await page.getByRole("button",{name:"Consultar",exact:true}).click();await expect(page.getByRole("cell",{name:"500",exact:true})).toBeVisible();
  const applied=new URL(traffic.at(-1)!);expect(applied.searchParams.get("status")).toBe("500");expect(applied.searchParams.has("statusClass")).toBe(false);expect(applied.searchParams.get("routeId")).toBe(R);expect(applied.searchParams.get("serviceId")).toBe(I);
  await checkLayout(page);expect((await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({path:test.info().outputPath(`synthetic-${width}.png`),fullPage:true});
  const beforeInvalid=traffic.length;await page.getByLabel("ID da rota",{exact:true}).fill("invalid-route");await page.getByLabel("ID da rota",{exact:true}).press("Enter");
  await expect(page.getByText("Informe um ID de rota no formato UUID.")).toBeVisible();await expect(page.getByLabel("ID da rota",{exact:true})).toBeFocused();expect(traffic).toHaveLength(beforeInvalid);await expect(page.getByText("Nenhuma requisição no período.")).not.toBeVisible();
  await page.getByLabel("ID da rota",{exact:true}).press("Tab");await expect(page.getByLabel("ID do serviço",{exact:true})).toBeFocused();
  expect((await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({path:test.info().outputPath(`invalid-${width}.png`),fullPage:true});
  await page.getByRole("button",{name:"Limpar filtros",exact:true}).click();await expect(page.getByLabel("ID da rota",{exact:true})).toHaveValue("");await expect(page.getByLabel("ID do serviço",{exact:true})).toHaveValue("");await expect(page.getByLabel("Status HTTP exato",{exact:true})).toHaveValue("");await expect(page.getByRole("cell",{name:"200",exact:true})).toBeVisible();await evidence.finish();
 });
}
