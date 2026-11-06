import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {ApiError,unwrap} from '../api/client';
import {apiV2,problemCode} from '../api/client-v2';
import type {components} from '../api/schema-v2';
import {Field} from '../components/Field';
import {Button} from '../components/Button';
import {LineChart} from '../components/Chart';
import {Table} from '../components/Table';
/** The overview never installs this prepared panel while activation is unapproved. */
export const WORKSPACE_ANALYTICS_ENABLED=false;
type Summary=components['schemas']['WorkspaceAnalyticsSummary'];
type Ranking=components['schemas']['WorkspaceTopRoutes'];
type Stats=components['schemas']['WorkspaceTrafficStats'];
const periods={'1h':{label:'Última hora',ms:3600000,interval:'1m'},'6h':{label:'Últimas 6 horas',ms:21600000,interval:'5m'},'24h':{label:'Últimas 24 horas',ms:86400000,interval:'15m'}} as const;
type Period=keyof typeof periods;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid=()=>new Error('Invalid workspace analytics response');
function stats(value:Stats){
 if(!value||![value.requests,value.errors4xx,value.errors5xx].every(n=>Number.isSafeInteger(n)&&n>=0)||value.errors4xx+value.errors5xx>value.requests||value.errorRate!==(value.requests?(value.errors4xx+value.errors5xx)/value.requests:0)||![value.p50Ms,value.p95Ms,value.p99Ms].every(n=>value.requests===0?n===null:typeof n==='number'&&Number.isFinite(n)&&n>=0))throw invalid();
}
function check(summary:Summary,ranking:Ranking,workspaceId:string,window:{from:string;to:string},period:Period){
 for(const value of [summary,ranking])if(!value||value.scope!=='workspace'||value.workspaceId!==workspaceId||!uuid.test(value.instanceId)||value.from!==window.from||value.to!==window.to||!Number.isFinite(Date.parse(value.generatedAt))||value.attributionVersion!=='route-history-v2'||value.retention!=='per-route-1-to-7-days'||value.delivery!=='best-effort')throw invalid();
 if(summary.instanceId!==ranking.instanceId||summary.interval!==periods[period].interval||!Array.isArray(summary.series)||summary.series.length>2000||!Array.isArray(ranking.items)||ranking.items.length>10||ranking.by!=='requests')throw invalid();
 stats(summary.totals);
 const size=periods[period].ms/(period==='1h'?60:period==='6h'?72:96),count=Math.ceil((Date.parse(window.to)-Date.parse(window.from))/size);
 if(summary.series.length!==count)throw invalid();
 summary.series.forEach((point,i)=>{stats(point);if(point.ts!==new Date(Date.parse(window.from)+i*size).toISOString())throw invalid();});
 for(const key of ['requests','errors4xx','errors5xx'] as const)if(summary.series.reduce((sum,p)=>sum+p[key],0)!==summary.totals[key])throw invalid();
 const seen=new Set<string>();for(const row of ranking.items){stats(row);if(!uuid.test(row.routeId)||seen.has(row.routeId)||(row.serviceId!==null&&!uuid.test(row.serviceId))||(row.routeName!==null&&(typeof row.routeName!=='string'||row.routeName.length>255)))throw invalid();seen.add(row.routeId);}
 return{summary,ranking};
}
function range(period:Period){const now=Date.now();return{from:new Date(now-periods[period].ms).toISOString(),to:new Date(now).toISOString()};}
export function WorkspaceAnalyticsPanels(props:{workspaceId:string;principalId:string;authorizationKey?:string;enabled?:boolean}){return <Panels key={`${props.workspaceId}:${props.principalId}:${props.authorizationKey??''}`} {...props}/>;}
function Panels({workspaceId,principalId,authorizationKey='',enabled=false}:{workspaceId:string;principalId:string;authorizationKey?:string;enabled?:boolean}){
 const[period,setPeriod]=useState<Period>('6h'),[window,setWindow]=useState(()=>range('6h'));
 const query=useQuery({queryKey:['workspace-analytics-panels',principalId,authorizationKey,workspaceId,period,window.from,window.to],enabled,retry:false,gcTime:0,staleTime:0,refetchOnMount:'always',
  queryFn:async({signal})=>{
   const cancel=new AbortController(),combined=AbortSignal.any([signal,cancel.signal]);
   try{
    const[summary,ranking]=await Promise.all([
     unwrap(apiV2.GET('/workspaces/{workspaceId}/analytics/summary',{params:{path:{workspaceId},query:{...window,interval:periods[period].interval}},signal:combined})),
     unwrap(apiV2.GET('/workspaces/{workspaceId}/analytics/top-routes',{params:{path:{workspaceId},query:{...window,by:'requests',limit:10}},signal:combined}))]);
    return check(summary,ranking,workspaceId,window,period);
   }catch(error){cancel.abort();throw error;}
  }});
 const denied=query.isError&&query.error instanceof ApiError&&[401,403,404].includes(query.error.status),unavailable=query.isError&&query.error instanceof ApiError&&query.error.status===502&&['analytics-not-ready','analytics-unavailable','analytics-timeout','analytics-budget-exceeded'].includes(problemCode(query.error)??'');
 return <section className="stack" aria-label="Indicadores de tráfego do Workspace">
  <h2>Analytics do Workspace</h2>
  {!enabled?<p role="status">Analytics ainda não ativado. Os indicadores dependem da validação da ingestão.</p>:<>
   <Field label="Período dos indicadores">{id=><select id={id} value={period} onChange={e=>{const value=e.target.value as Period;setPeriod(value);setWindow(range(value));}}>{Object.entries(periods).map(([key,p])=><option key={key} value={key}>{p.label}</option>)}</select>}</Field>
   {query.isPending||query.isFetching?<p role="status">Carregando indicadores…</p>:query.isError?<div role="alert"><h3>{denied?'Acesso negado':unavailable?'Analytics indisponível':'Falha de consulta'}</h3><p>{denied?'Você não pode consultar estes indicadores.':unavailable?'Não há evidência suficiente para apresentar indicadores confiáveis. Isso não significa ausência de tráfego.':'Não foi possível consultar os indicadores.'}</p>{!denied&&<Button onClick={()=>query.refetch()}>Tentar novamente</Button>}</div>:query.data?<>
    {query.data.summary.totals.requests===0&&query.data.ranking.items.length===0&&<p role="status">Nenhuma requisição no período.</p>}
    <div className="workspace-overview-grid">
     <article className="workspace-overview-panel"><h3>Requisições</h3><p className="workspace-overview-count">{query.data.summary.totals.requests.toLocaleString('pt-BR')}</p></article>
     <article className="workspace-overview-panel"><h3>Erros HTTP</h3><p className="workspace-overview-count">{query.data.summary.totals.errors4xx+query.data.summary.totals.errors5xx}</p><p>4xx e 5xx</p></article>
     <article className="workspace-overview-panel"><h3>Latência p95</h3><p className="workspace-overview-count">{query.data.summary.totals.p95Ms===null?'—':`${query.data.summary.totals.p95Ms} ms`}</p></article>
    </div>
    <LineChart title="Requisições por intervalo" points={query.data.summary.series} lines={[{key:'requests',label:'Requisições',color:'var(--accent)'}]}/>
    <Table label="Rotas com mais requisições" focusable><thead><tr><th scope="col">Rota</th><th scope="col">Requisições</th><th scope="col">Erros HTTP</th><th scope="col">Latência p95</th></tr></thead><tbody>{query.data.ranking.items.map(row=><tr key={row.routeId}><td className="mono wrap">{row.routeName??row.routeId}</td><td>{row.requests}</td><td>{row.errors4xx+row.errors5xx}</td><td>{row.p95Ms===null?'—':`${row.p95Ms} ms`}</td></tr>)}</tbody></Table>
    <p className="muted small">Indicadores e ranking podem refletir atualizações diferentes. Ausência de tráfego não comprova a saúde da coleta.</p>
   </>:null}
  </>}
 </section>;
}
