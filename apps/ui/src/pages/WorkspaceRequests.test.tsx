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
 return {container,sent,render,wait,click};
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
