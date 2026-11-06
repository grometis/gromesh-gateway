import {act} from 'react';
import type {Root} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,expect,it,vi} from 'vitest';
import {installTestDom} from '../test/dom';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',I='33333333-3333-4333-8333-333333333333';
let root:Root|undefined,client:QueryClient;const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
afterEach(async()=>{if(root)await act(()=>root!.unmount());client?.clear();root=undefined;vi.unstubAllGlobals();vi.restoreAllMocks();});
const stats=(requests=0)=>({requests,errors4xx:0,errors5xx:0,errorRate:0,p50Ms:requests?2:null,p95Ms:requests?2:null,p99Ms:requests?2:null});
function data(url:URL,w=A,count=2){const from=url.searchParams.get('from')!,to=url.searchParams.get('to')!,base={scope:'workspace',instanceId:I,workspaceId:w,from,to,generatedAt:to,attributionVersion:'route-history-v2',retention:'per-route-1-to-7-days',delivery:'best-effort'};
 return url.pathname.endsWith('/summary')?{...base,interval:'5m',totals:stats(count),series:Array.from({length:72},(_,i)=>({ts:new Date(Date.parse(from)+i*300000).toISOString(),...stats(i===0?count:0)}))}:{...base,by:'requests',items:count?[{routeId:I,routeName:w===A?'Rota A':'Rota B',serviceId:null,...stats(count)}]:[]};}
async function mount(answer?:(url:URL)=>Response|Promise<Response>,enabled=true){
 vi.resetModules();const container=installTestDom(),sent:Request[]=[],NativeRequest=Request;
 vi.stubGlobal('Request',class extends NativeRequest{constructor(input:RequestInfo|URL,init?:RequestInit){super(typeof input==='string'?new URL(input,'https://ui.example'):input,init);}});
 vi.stubGlobal('fetch',async(request:Request)=>{sent.push(request);return answer?answer(new URL(request.url)):Response.json(data(new URL(request.url)));});
 const {WorkspaceAnalyticsPanels}=await import('./WorkspaceAnalyticsPanels'),{createRoot}=await import('react-dom/client');client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});root=createRoot(container as unknown as HTMLElement);
 const render=async(w=A,principalId='synthetic-user')=>{await act(async()=>{root!.render(<QueryClientProvider client={client}><WorkspaceAnalyticsPanels workspaceId={w} principalId={principalId} enabled={enabled}/></QueryClientProvider>);await tick();});};await render();
 const wait=async(text:string)=>vi.waitFor(async()=>{await act(async()=>{await tick();});expect(container.textContent).toContain(text);});return{container,sent,render,wait};
}
it('sends no requests behind the default disabled activation gate',async()=>{const v=await mount(undefined,false);expect(v.sent).toHaveLength(0);expect(v.container.textContent).toContain('Analytics ainda não ativado');});
it('loads summary and ranking without duplicating the summary graph with a timeseries call',async()=>{const v=await mount();await v.wait('Rota A');expect(v.sent).toHaveLength(2);expect(v.sent.some(r=>r.url.includes('timeseries'))).toBe(false);expect(v.container.textContent).toContain('Latência p95');});
it.each([[403,'Acesso negado'],[502,'Analytics indisponível'],[500,'Falha de consulta']])('keeps failure %s distinct from a complete empty result',async(status,text)=>{const v=await mount(()=>Response.json({status,title:'Synthetic failure',code:status===502?'analytics-not-ready':'synthetic'},{status}));await v.wait(text);expect(v.container.textContent).not.toContain('Nenhuma requisição no período.');});
it('shows a proven empty result only after both valid responses',async()=>{const v=await mount(url=>Response.json(data(url,A,0)));await v.wait('Nenhuma requisição no período.');});
it('rejects a response for another workspace instead of displaying its counts',async()=>{const v=await mount(url=>Response.json(data(url,B)));await v.wait('Falha de consulta');expect(v.container.textContent).not.toContain('Rota B');});
it('cancels old requests and ignores late responses after switching workspace',async()=>{
 const pending:{url:URL;resolve:(r:Response)=>void}[]=[];
 const v=await mount(url=>url.pathname.includes(A)?new Promise(resolve=>pending.push({url,resolve})):Response.json(data(url,B)));
 await vi.waitFor(()=>expect(pending).toHaveLength(2));await v.render(B);await v.wait('Rota B');expect(v.sent.filter(r=>r.url.includes(A)).every(r=>r.signal.aborted)).toBe(true);
 await act(async()=>{for(const p of pending)p.resolve(Response.json(data(p.url,A)));await tick();});expect(v.container.textContent).not.toContain('Rota A');
});
it('does not reuse previous-user counts while authorization is being checked',async()=>{
 let count=0;const v=await mount(url=>++count<=2?Response.json(data(url)):Response.json({status:403},{status:403}));await v.wait('Rota A');await v.render(A,'another-user');await v.wait('Acesso negado');expect(v.container.textContent).not.toContain('Rota A');
});
