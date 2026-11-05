import { act } from "react";
import type { Root } from "react-dom/client";
import { QueryClient,QueryClientProvider } from "@tanstack/react-query";
import { afterEach,it,expect,vi } from "vitest";
import { installTestDom } from "../test/dom";
const A="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222",I="33333333-3333-4333-8333-333333333333";
const NOW="2026-11-05T03:00:00.000Z";let root:Root|undefined,client:QueryClient;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
afterEach(async()=>{if(root)await act(()=>root!.unmount());root=undefined;client?.clear();vi.unstubAllGlobals();vi.restoreAllMocks();});
const page=(w:string,query:URL,items:unknown[]=[],nextCursor:string|null=null)=>({scope:"workspace",instanceId:I,workspaceId:w,from:query.searchParams.get("from"),to:query.searchParams.get("to"),generatedAt:NOW,attributionVersion:"route-history-v2",retention:"per-route-1-to-7-days",delivery:"best-effort",items,nextCursor});
const record=(query:URL,w=A)=>({id:I,ts:new Date((Date.parse(query.searchParams.get("from")!)+Date.parse(query.searchParams.get("to")!))/2).toISOString(),instanceId:I,workspaceId:w,clusterId:I,routeId:I,serviceId:null,consumerId:null,method:"GET",path:"/synthetic",status:200,latencyKongMs:1,latencyUpstreamMs:null,latencyTotalMs:2,clientIp:"2001:db8::",requestSize:"9007199254740993",responseSize:"1",effectiveRevision:null,candidateRevisions:[{epoch:1,revision:1}]});
async function mount(answer?:(url:URL)=>Promise<Response>|Response,enabled=true){
 vi.resetModules();vi.spyOn(Date,"now").mockReturnValue(Date.parse(NOW));const container=installTestDom();const sent:URL[]=[];const NativeRequest=Request;
 vi.stubGlobal("Request",class extends NativeRequest{constructor(input:RequestInfo|URL,init?:RequestInit){super(typeof input==="string"?new URL(input,"https://ui.example"):input,init);}});
 vi.stubGlobal("fetch",async(request:Request)=>{expect(request.method).toBe("GET");const url=new URL(request.url);sent.push(url);return answer?answer(url):Response.json(page(A,url));});
 const {WorkspaceRequests}=await import("./WorkspaceRequests");const {createRoot}=await import("react-dom/client");client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});root=createRoot(container as unknown as HTMLElement);
 const render=async(id=A)=>{await act(async()=>{root!.render(<QueryClientProvider client={client}><WorkspaceRequests workspaceId={id} principalId="synthetic-user" enabled={enabled}/></QueryClientProvider>);await tick();});await act(async()=>{await tick();});};await render();
 const wait=async(text:string)=>vi.waitFor(async()=>{await act(async()=>{await tick();});expect(container.textContent).toContain(text);});
 const click=async(text:string)=>{const button=container.findAll(n=>n.tagName==="BUTTON"&&n.textContent===text)[0]!;expect(button).toBeDefined();await act(async()=>{button.dispatchEvent(new Event("click",{bubbles:true}));await tick();});};
 const field=(label:string)=>{const node=container.findAll(n=>n.tagName==="LABEL"&&n.textContent===label)[0]!;expect(node).toBeDefined();return container.findAll(n=>n.getAttribute("id")===node.getAttribute("for"))[0]!;};
 const input=async(label:string,value:string)=>{await act(async()=>{const node=field(label);node.value=value;node.dispatchEvent(new Event(node.tagName==="SELECT"?"change":"input",{bubbles:true}));await tick();});};
 const submit=async()=>{await act(async()=>{container.findAll(n=>n.tagName==="FORM")[0]!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));await tick();});};
 return {container,sent,render,wait,click,field,input,submit};
}
it("default activation gate sends no traffic request and never displays an empty result",async()=>{const v=await mount(undefined,false);expect(v.sent).toHaveLength(0);expect(v.container.textContent).toContain("Analytics ainda não ativado");expect(v.container.textContent).not.toContain("Nenhuma requisição");});
it("distinguishes a complete empty page from analytics-not-ready",async()=>{const v=await mount();await v.wait("Nenhuma requisição no período.");expect(v.sent[0]!.pathname).toBe(`/api/v2/workspaces/${A}/requests`);expect(Date.parse(v.sent[0]!.searchParams.get("to")!)).toBeLessThanOrEqual(Date.parse(NOW));});
it.each([[403,"Acesso negado"],[502,"Analytics indisponível"],[500,"Falha de consulta"]])("shows status %s without presenting a zero count",async(status,text)=>{const v=await mount(()=>Response.json({status,title:"Synthetic failure",code:status===502?"analytics-not-ready":"failure"},{status}));await v.wait(text);expect(v.container.textContent).not.toContain("Nenhuma requisição");});
it("rejects a response carrying another workspace",async()=>{const v=await mount(url=>Response.json(page(B,url)));await v.wait("Falha de consulta");expect(v.container.textContent).not.toContain("Nenhuma requisição");});
it("ignores a delayed response from the previous workspace and resets cursor state",async()=>{let release!:(response:Response)=>void;const delayed=new Promise<Response>(resolve=>{release=resolve;});let first:URL|undefined;
 const v=await mount(url=>{if(url.pathname.includes(A)){first=url;return delayed;}return Response.json(page(B,url));});expect(v.container.textContent).toContain("Carregando requisições");await v.render(B);await v.wait("Nenhuma requisição no período.");await act(async()=>{release(Response.json(page(A,first!,[],"old-workspace-cursor")));await tick();});expect(v.sent.at(-1)!.pathname).toContain(B);expect(v.container.findAll(n=>n.tagName==="BUTTON"&&n.textContent==="Próxima página")[0]!.getAttribute("disabled")).not.toBeNull();
});
it("uses deterministic cursor pagination while preserving the fixed query window",async()=>{const v=await mount(url=>Response.json(page(A,url,[record(url)],url.searchParams.has("cursor")?null:"signed-test-cursor")));await v.wait("GET");await v.click("Próxima página");await vi.waitFor(()=>expect(v.sent).toHaveLength(2));await v.wait("GET");expect(v.sent[1]!.searchParams.get("cursor")).toBe("signed-test-cursor");for(const key of ["from","to","limit"])expect(v.sent[1]!.searchParams.get(key)).toBe(v.sent[0]!.searchParams.get(key));await v.click("Página anterior");expect(v.sent.every(url=>url.pathname.includes(A))).toBe(true);});

it("renders only contract rows without exposing IP or request payload",async()=>{const v=await mount(url=>Response.json(page(A,url,[record(url)])));await v.wait("GET");expect(v.container.textContent).toContain("200");expect(v.container.textContent).not.toMatch(/2001:db8|synthetic-user|synthetic\//);});
it("rejects another Workspace hidden inside a correctly scoped envelope",async()=>{const v=await mount(url=>Response.json(page(A,url,[record(url,B)])));await v.wait("Falha de consulta");expect(v.container.textContent).not.toContain("GET");});

it("never displays an earlier page before current authorization/conflict/TTL revalidation succeeds",async()=>{
 let calls=0,release!:(response:Response)=>void;const delayed=new Promise<Response>(resolve=>{release=resolve;});
 const v=await mount(url=>{calls++;return calls===3?delayed:Response.json(page(A,url,[{...record(url),method:calls===1?"GET":"POST"}],calls===1?"signed-cursor":null));});
 await v.wait("GET");await v.click("Próxima página");await v.wait("POST");await v.click("Página anterior");
 expect(v.container.textContent).toContain("Carregando requisições");expect(v.container.textContent).not.toContain("GET");expect(v.container.textContent).not.toContain("POST");
 await act(async()=>{release(Response.json({title:"Forbidden",status:403},{status:403}));await tick();});await v.wait("Acesso negado");expect(v.container.textContent).not.toContain("GET");
});

const ROUTE="abcdefab-1234-4abc-8abc-abcdefabcdef",SERVICE="fedcbafe-4321-4fed-8fed-fedcbafedcba";
it("applies validated identity/status filters atomically and never fetches unfinished drafts",async()=>{
 const v=await mount(url=>Response.json(page(A,url,[{...record(url),routeId:url.searchParams.get("routeId")??I,serviceId:url.searchParams.get("serviceId"),status:Number(url.searchParams.get("status")??200)}])));
 await v.wait("GET");await v.input("ID da rota",`  ${ROUTE.toUpperCase()}  `);await v.input("ID do serviço",SERVICE);await v.input("Status HTTP exato","500");expect(v.sent).toHaveLength(1);expect(v.container.textContent).not.toContain("Nenhuma requisição");
 await v.submit();await vi.waitFor(()=>expect(v.sent).toHaveLength(2));await v.wait("500");const query=v.sent[1]!.searchParams;expect(query.get("routeId")).toBe(ROUTE);expect(query.get("serviceId")).toBe(SERVICE);expect(query.get("status")).toBe("500");expect(query.has("statusClass")).toBe(false);expect(query.has("cursor")).toBe(false);
});
it("keeps exact status and status class mutually exclusive before applying filters",async()=>{
 const v=await mount();await v.wait("Nenhuma requisição no período.");await v.input("Classe de status","5xx");await v.input("Status HTTP exato","503");// The minimal Node host does not derive select.value from option.selected; browser tests verify the visual reset.
 await v.submit();await vi.waitFor(()=>expect(v.sent).toHaveLength(2));expect(v.sent[1]!.searchParams.get("status")).toBe("503");expect(v.sent[1]!.searchParams.has("statusClass")).toBe(false);
 await v.input("Classe de status","4xx");expect(v.field("Status HTTP exato").value).toBe("");await v.submit();await vi.waitFor(()=>expect(v.sent).toHaveLength(3));expect(v.sent[2]!.searchParams.get("statusClass")).toBe("4xx");expect(v.sent[2]!.searchParams.has("status")).toBe(false);
});
it("rejects invalid filter syntax locally without reusing a previous empty result",async()=>{
 const v=await mount();await v.wait("Nenhuma requisição no período.");await v.input("ID da rota","not-a-route");await v.input("Status HTTP exato","99");await v.submit();expect(v.sent).toHaveLength(1);expect(v.field("ID da rota").getAttribute("aria-invalid")).toBe("true");expect(v.container.ownerDocument.activeElement).toBe(v.field("ID da rota"));expect(v.container.textContent).not.toContain("Nenhuma requisição");
 await v.click("Limpar filtros");await v.wait("Nenhuma requisição no período.");expect(v.field("ID da rota").value).toBe("");expect(v.field("Status HTTP exato").value).toBe("");
});
it.each([["ID da rota",ROUTE],["ID do serviço",SERVICE],["Status HTTP exato","500"],["Classe de status","5xx"]])("rejects response rows that contradict the applied filter %s",async(label,value)=>{
 const v=await mount(url=>Response.json(page(A,url,[record(url)])));await v.wait("GET");await v.input(label,value);await v.submit();await v.wait("Falha de consulta");expect(v.container.textContent).not.toContain("Nenhuma requisição");expect(v.container.textContent).not.toContain("GET");
});
it("resets workspace-specific filters when the workspace changes",async()=>{
 const v=await mount(url=>Response.json(page(url.pathname.includes(B)?B:A,url)));await v.wait("Nenhuma requisição no período.");await v.input("ID da rota",ROUTE);await v.submit();await vi.waitFor(()=>expect(v.sent).toHaveLength(2));await v.render(B);await v.wait("Nenhuma requisição no período.");expect(v.sent.at(-1)!.pathname).toContain(B);expect(v.sent.at(-1)!.searchParams.has("routeId")).toBe(false);expect(v.field("ID da rota").value).toBe("");
});

it("resets the authenticated cursor context whenever filters change",async()=>{
 const v=await mount(url=>Response.json(page(A,url,[{...record(url),status:Number(url.searchParams.get("status")??200)}],url.searchParams.has("cursor")||url.searchParams.has("status")?null:"old-filter-cursor")));
 await v.wait("GET");await v.click("Próxima página");await vi.waitFor(()=>expect(v.sent).toHaveLength(2));await v.wait("GET");expect(v.sent[1]!.searchParams.get("cursor")).toBe("old-filter-cursor");
 await v.input("Status HTTP exato","500");await v.submit();await vi.waitFor(()=>expect(v.sent).toHaveLength(3));await v.wait("500");expect(v.sent[2]!.searchParams.has("cursor")).toBe(false);expect(v.sent[2]!.searchParams.get("status")).toBe("500");expect(v.container.findAll(n=>n.tagName==="BUTTON"&&n.textContent==="Página anterior")[0]!.getAttribute("disabled")).not.toBeNull();
});
it("ignores a late response from a previous filter set within the same workspace",async()=>{
 let release!:(response:Response)=>void,earlier:URL|undefined;const delayed=new Promise<Response>(resolve=>{release=resolve;});
 const v=await mount(url=>{if(url.searchParams.has("routeId")){earlier=url;return delayed;}return Response.json(page(A,url,[{...record(url),method:"POST",serviceId:url.searchParams.get("serviceId")}]))});
 await v.wait("POST");await v.input("ID da rota",ROUTE);await v.submit();await vi.waitFor(()=>expect(earlier).toBeDefined());await v.input("ID da rota","");await v.input("ID do serviço",SERVICE);await v.submit();await v.wait("POST");
 await act(async()=>{release(Response.json(page(A,earlier!,[{...record(earlier!),routeId:ROUTE,method:"GET"}],"old-filter-cursor")));await tick();});
 expect(v.container.textContent).not.toContain("GET");expect(v.sent.at(-1)!.searchParams.get("serviceId")).toBe(SERVICE);expect(v.container.findAll(n=>n.tagName==="BUTTON"&&n.textContent==="Próxima página")[0]!.getAttribute("disabled")).not.toBeNull();
});
