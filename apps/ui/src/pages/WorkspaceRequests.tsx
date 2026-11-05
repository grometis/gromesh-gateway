import "./WorkspaceRequests.css";
import { useRef,useState,type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError,unwrap } from "../api/client";
import { apiV2,problemCode } from "../api/client-v2";
import type { components } from "../api/schema-v2";
import { useAuth } from "../auth";
import { useNavigationContext } from "../navigation/context";
import { PageHeader } from "../components/PageHeader";
import { Field } from "../components/Field";
import { Button } from "../components/Button";
import { Table } from "../components/Table";

/** Activation requires a separate accepted backend/availability decision. No environment or URL bypass. */
export const WORKSPACE_REQUESTS_ENABLED=false;
type Page=components["schemas"]["WorkspaceRequestPage"];
const periods={"1h":{label:"Última hora",ms:3600000},"6h":{label:"Últimas 6 horas",ms:6*3600000},"24h":{label:"Últimas 24 horas",ms:86400000}};
type Period=keyof typeof periods;
type StatusClass="2xx"|"3xx"|"4xx"|"5xx";
interface Filters {routeId?:string;serviceId?:string;status?:number;statusClass?:StatusClass}
interface Draft {routeId:string;serviceId:string;status:string;statusClass:string}
const emptyDraft:Draft={routeId:"",serviceId:"",status:"",statusClass:""};
const snapshot=(period:Period,draft:Draft)=>JSON.stringify([period,draft.routeId,draft.serviceId,draft.status,draft.statusClass]);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function filterValues(draft:Draft){
 const filters:Filters={},errors:Partial<Record<keyof Draft,string>>={};
 for(const key of ["routeId","serviceId"]as const){const value=draft[key].trim();if(value){if(!uuid.test(value))errors[key]=`Informe um ID ${key==="routeId"?"de rota":"de serviço"} no formato UUID.`;else filters[key]=value.toLowerCase();}}
 if(draft.status){if(!/^[1-5][0-9]{2}$/.test(draft.status))errors.status="Informe um status HTTP entre 100 e 599.";else filters.status=Number(draft.status);}
 if(draft.statusClass){if(!["2xx","3xx","4xx","5xx"].includes(draft.statusClass))errors.statusClass="Selecione uma classe de status válida.";else filters.statusClass=draft.statusClass as StatusClass;}
 if(draft.status&&draft.statusClass)errors.status="Escolha status exato ou classe de status.";
 return {filters,errors};
}
function range(period:Period){const to=Date.now();return {from:new Date(to-periods[period].ms).toISOString(),to:new Date(to).toISOString()};}
/** Reject scope contradictions instead of displaying another Workspace's response or an invalid empty state. */
function checked(value:unknown,workspaceId:string,window:{from:string;to:string},filters:Filters):Page{
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid workspace request response");
 const page=value as Partial<Page>;
 if(!page||page.scope!=="workspace"||page.workspaceId!==workspaceId||page.from!==window.from||page.to!==window.to||page.attributionVersion!=="route-history-v2"||page.retention!=="per-route-1-to-7-days"||page.delivery!=="best-effort"||typeof page.instanceId!=="string"||!Array.isArray(page.items)||page.items.length>200||(page.items.length===0&&page.nextCursor!==null)||(page.nextCursor!==null&&(typeof page.nextCursor!=="string"||page.nextCursor.length>4096)))throw Error("Invalid workspace request response");
 if(page.items.some(item=>!item||item.workspaceId!==workspaceId||item.instanceId!==page.instanceId||item.effectiveRevision!==null||typeof item.id!=="string"||typeof item.routeId!=="string"||(item.serviceId!==null&&typeof item.serviceId!=="string")||typeof item.method!=="string"||!Number.isInteger(item.status)||item.status<100||item.status>599||!Number.isFinite(item.latencyTotalMs)||item.latencyTotalMs<0||!Number.isFinite(Date.parse(item.ts))||Date.parse(item.ts)<Date.parse(window.from)||Date.parse(item.ts)>=Date.parse(window.to)||(filters.routeId!==undefined&&item.routeId!==filters.routeId)||(filters.serviceId!==undefined&&item.serviceId!==filters.serviceId)||(filters.status!==undefined&&item.status!==filters.status)||(filters.statusClass!==undefined&&Math.floor(item.status/100)!==Number(filters.statusClass[0]))))throw Error("Invalid workspace request response");
 return page as Page;
}
export function WorkspaceRequestsPage(){
 const context=useNavigationContext(),{user}=useAuth();
 if(!context.workspace||!user)return null;
 return <WorkspaceRequests workspaceId={context.workspace.id} principalId={user.id} enabled={WORKSPACE_REQUESTS_ENABLED&&(context.state==="authorized"||context.state==="archived")}/>;
}
/** Public component for isolated tests; the router only uses the disabled-by-default wrapper above. */
export function WorkspaceRequests(props:{workspaceId:string;principalId:string;enabled?:boolean}){
 return <RequestView key={`${props.workspaceId}:${props.principalId}`} {...props}/>;
}
function RequestView({workspaceId,principalId,enabled=false}:{workspaceId:string;principalId:string;enabled?:boolean}){
 const [period,setPeriod]=useState<Period>("6h"),[window,setWindow]=useState(()=>range("6h"));
 const [draft,setDraft]=useState(emptyDraft),[filters,setFilters]=useState<Filters>({}),[applied,setApplied]=useState(()=>snapshot("6h",emptyDraft));
 const [errors,setErrors]=useState<Partial<Record<keyof Draft,string>>>({});
 const routeRef=useRef<HTMLInputElement>(null),serviceRef=useRef<HTMLInputElement>(null),statusRef=useRef<HTMLInputElement>(null),classRef=useRef<HTMLSelectElement>(null);
 const [cursor,setCursor]=useState(""),[previous,setPrevious]=useState<string[]>([]);
 const dirty=snapshot(period,draft)!==applied,invalid=Object.keys(errors).length>0;
 const query=useQuery({queryKey:["workspace-requests",principalId,workspaceId,window.from,window.to,filters.routeId,filters.serviceId,filters.status,filters.statusClass,cursor],enabled:enabled&&!dirty&&!invalid,retry:false,gcTime:0,staleTime:0,refetchOnMount:"always",
  queryFn:async({signal})=>checked(await unwrap(apiV2.GET("/workspaces/{workspaceId}/requests",{params:{path:{workspaceId},query:{...window,limit:50,...filters,...(cursor?{cursor}:{})}},signal})),workspaceId,window,filters)});
 const apply=(event:FormEvent)=>{
  event.preventDefault();const parsed=filterValues(draft);setErrors(parsed.errors);
  if(Object.keys(parsed.errors).length){(parsed.errors.routeId?routeRef:parsed.errors.serviceId?serviceRef:parsed.errors.status?statusRef:classRef).current?.focus();return;}
  const normalized={...draft,routeId:parsed.filters.routeId??"",serviceId:parsed.filters.serviceId??""};
  setDraft(normalized);setFilters(parsed.filters);setApplied(snapshot(period,normalized));setCursor("");setPrevious([]);setWindow(range(period));
 };
 const clear=()=>{setDraft(emptyDraft);setFilters({});setErrors({});setApplied(snapshot(period,emptyDraft));setCursor("");setPrevious([]);setWindow(range(period));};
 const unavailable=query.isError&&query.error instanceof ApiError&&query.error.status===502&&["analytics-not-ready","analytics-unavailable","analytics-timeout","analytics-budget-exceeded"].includes(problemCode(query.error)??"");
 const denied=query.isError&&query.error instanceof ApiError&&[401,403,404].includes(query.error.status);
 return <section className="final-page stack workspace-requests">
  <PageHeader title="Requisições do Workspace" description="Analytics do Workspace · Requisições"/>
  {!enabled?<p role="status">Analytics ainda não ativado. As consultas estarão disponíveis após a validação da ingestão e da atribuição por Workspace.</p>:<>
   <form className="request-filters" aria-label="Filtros de requisições" noValidate onSubmit={apply}>
    <Field label="Período">{id=><select id={id} value={period} onChange={e=>setPeriod(e.target.value as Period)}>{Object.entries(periods).map(([key,p])=><option key={key} value={key}>{p.label}</option>)}</select>}</Field>
    <Field label="ID da rota" errors={errors.routeId?[errors.routeId]:undefined}>{(id,invalid)=><input ref={routeRef} id={id} name="routeId" value={draft.routeId} maxLength={64} autoComplete="off" aria-invalid={invalid} onChange={e=>{const value=e.target.value;setDraft(v=>({...v,routeId:value}));}}/>}</Field>
    <Field label="ID do serviço" errors={errors.serviceId?[errors.serviceId]:undefined}>{(id,invalid)=><input ref={serviceRef} id={id} name="serviceId" value={draft.serviceId} maxLength={64} autoComplete="off" aria-invalid={invalid} onChange={e=>{const value=e.target.value;setDraft(v=>({...v,serviceId:value}));}}/>}</Field>
    <Field label="Classe de status" errors={errors.statusClass?[errors.statusClass]:undefined}>{(id,invalid)=><select ref={classRef} id={id} value={draft.statusClass} aria-invalid={invalid} onChange={e=>{const value=e.target.value;setDraft(v=>({...v,statusClass:value,status:""}));}}><option value="">Todas</option>{["2xx","3xx","4xx","5xx"].map(status=><option key={status} value={status}>{status}</option>)}</select>}</Field>
    <Field label="Status HTTP exato" errors={errors.status?[errors.status]:undefined}>{(id,invalid)=><input ref={statusRef} id={id} name="status" inputMode="numeric" value={draft.status} maxLength={3} autoComplete="off" aria-invalid={invalid} onChange={e=>{const value=e.target.value;setDraft(v=>({...v,status:value,statusClass:""}));}}/>}</Field>
    <Button type="submit">Consultar</Button><Button type="button" onClick={clear}>Limpar filtros</Button>
   </form>
   {invalid?<p role="alert">Corrija os filtros para consultar as requisições.</p>:dirty?<p role="status">Filtros alterados. Selecione Consultar para atualizar os resultados.</p>:query.isPending||query.isFetching?<p role="status">Carregando requisições…</p>:query.isError?<div role="alert"><h2>{denied?"Acesso negado":unavailable?"Analytics indisponível":"Falha de consulta"}</h2><p>{denied?"Não foi possível acessar as requisições deste Workspace.":unavailable?"Ainda não há evidência suficiente para apresentar uma consulta confiável. Isso não significa ausência de requisições.":"Não foi possível consultar as requisições. Tente novamente."}</p>{!denied&&<Button onClick={()=>query.refetch()}>Tentar novamente</Button>}</div>:<>
    {query.data.items.length===0?<p role="status">Nenhuma requisição no período.</p>:<Table label="Requisições do Workspace" focusable><thead><tr>{["Data e hora","Método","Status HTTP","Rota","Serviço","Latência"].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{query.data.items.map(row=><tr key={row.id}><td><time dateTime={row.ts}>{new Date(row.ts).toLocaleString("pt-BR")}</time></td><td>{row.method}</td><td>{row.status}</td><td className="mono wrap">{row.routeId}</td><td className="mono wrap">{row.serviceId??"—"}</td><td>{row.latencyTotalMs.toLocaleString("pt-BR")} ms</td></tr>)}</tbody></Table>}
    <nav aria-label="Paginação de requisições"><Button disabled={!previous.length||query.isFetching} onClick={()=>{setCursor(previous.at(-1)??"");setPrevious(previous.slice(0,-1));}}>Página anterior</Button><Button disabled={!query.data.nextCursor||query.isFetching} onClick={()=>{setPrevious([...previous,cursor]);setCursor(query.data.nextCursor??"");}}>Próxima página</Button></nav>
   </>}
  </>}
 </section>;
}
