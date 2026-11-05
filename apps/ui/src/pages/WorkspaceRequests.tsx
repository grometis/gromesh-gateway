import "./WorkspaceRequests.css";
import { useState } from "react";
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
const periods={"1h":{label:"Última hora",ms:3600000},"6h":{label:"Últimas 6 horas",ms:6*3600000},"24h":{label:"Últimas 24 horas",ms:86400000},"7d":{label:"Últimos 7 dias",ms:7*86400000}};
type Period=keyof typeof periods;
function range(period:Period){const to=Date.now();return {from:new Date(to-periods[period].ms).toISOString(),to:new Date(to).toISOString()};}
/** Reject scope contradictions instead of displaying another Workspace's response or an invalid empty state. */
function checked(value:unknown,workspaceId:string,window:{from:string;to:string}):Page{
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid workspace request response");
 const page=value as Partial<Page>;
 if(!page||page.scope!=="workspace"||page.workspaceId!==workspaceId||page.from!==window.from||page.to!==window.to||page.attributionVersion!=="route-history-v2"||page.retention!=="per-route-1-to-7-days"||page.delivery!=="best-effort"||typeof page.instanceId!=="string"||!Array.isArray(page.items)||page.items.length>200||(page.items.length===0&&page.nextCursor!==null)||(page.nextCursor!==null&&(typeof page.nextCursor!=="string"||page.nextCursor.length>4096)))throw Error("Invalid workspace request response");
 if(page.items.some(item=>!item||item.workspaceId!==workspaceId||item.instanceId!==page.instanceId||item.effectiveRevision!==null||typeof item.id!=="string"||typeof item.routeId!=="string"||(item.serviceId!==null&&typeof item.serviceId!=="string")||typeof item.method!=="string"||!Number.isInteger(item.status)||item.status<100||item.status>599||!Number.isFinite(item.latencyTotalMs)||item.latencyTotalMs<0||!Number.isFinite(Date.parse(item.ts))||Date.parse(item.ts)<Date.parse(window.from)||Date.parse(item.ts)>=Date.parse(window.to)))throw Error("Invalid workspace request response");
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
 const [period,setPeriod]=useState<Period>("6h"),[statusClass,setStatusClass]=useState(""),[window,setWindow]=useState(()=>range("6h"));
 const [cursor,setCursor]=useState(""),[previous,setPrevious]=useState<string[]>([]);
 const query=useQuery({queryKey:["workspace-requests",principalId,workspaceId,window.from,window.to,statusClass,cursor],enabled,retry:false,
  queryFn:async({signal})=>checked(await unwrap(apiV2.GET("/workspaces/{workspaceId}/requests",{params:{path:{workspaceId},query:{...window,limit:50,...(statusClass?{statusClass:statusClass as "2xx"|"3xx"|"4xx"|"5xx"}:{}),...(cursor?{cursor}:{})}},signal})),workspaceId,window)});
 const unavailable=query.isError&&query.error instanceof ApiError&&query.error.status===502&&["analytics-not-ready","analytics-unavailable","analytics-timeout","analytics-budget-exceeded"].includes(problemCode(query.error)??"");
 const denied=query.isError&&query.error instanceof ApiError&&[401,403,404].includes(query.error.status);
 return <section className="final-page stack workspace-requests">
  <PageHeader title="Requisições do Workspace" description="Analytics do Workspace · Requisições"/>
  {!enabled?<p role="status">Analytics ainda não ativado. As consultas estarão disponíveis após a validação da ingestão e da atribuição por Workspace.</p>:<>
   <form className="request-filters" aria-label="Filtros de requisições" onSubmit={event=>{event.preventDefault();setCursor("");setPrevious([]);setWindow(range(period));}}>
    <Field label="Período">{id=><select id={id} value={period} onChange={e=>setPeriod(e.target.value as Period)}>{Object.entries(periods).map(([key,p])=><option key={key} value={key}>{p.label}</option>)}</select>}</Field>
    <Field label="Classe de status">{id=><select id={id} value={statusClass} onChange={e=>{setStatusClass(e.target.value);setCursor("");setPrevious([]);}}><option value="">Todas</option>{["2xx","3xx","4xx","5xx"].map(status=><option key={status} value={status}>{status}</option>)}</select>}</Field>
    <Button type="submit">Consultar</Button>
   </form>
   {query.isPending?<p role="status">Carregando requisições…</p>:query.isError?<div role="alert"><h2>{denied?"Acesso negado":unavailable?"Analytics indisponível":"Falha de consulta"}</h2><p>{denied?"Não foi possível acessar as requisições deste Workspace.":unavailable?"Ainda não há evidência suficiente para apresentar uma consulta confiável. Isso não significa ausência de requisições.":"Não foi possível consultar as requisições. Tente novamente."}</p>{!denied&&<Button onClick={()=>query.refetch()}>Tentar novamente</Button>}</div>:<>
    {query.data.items.length===0?<p role="status">Nenhuma requisição no período.</p>:<Table label="Requisições do Workspace" focusable><thead><tr>{["Data e hora","Método","Status HTTP","Rota","Serviço","Latência"].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{query.data.items.map(row=><tr key={row.id}><td><time dateTime={row.ts}>{new Date(row.ts).toLocaleString("pt-BR")}</time></td><td>{row.method}</td><td>{row.status}</td><td className="mono wrap">{row.routeId}</td><td className="mono wrap">{row.serviceId??"—"}</td><td>{row.latencyTotalMs.toLocaleString("pt-BR")} ms</td></tr>)}</tbody></Table>}
    <nav aria-label="Paginação de requisições"><Button disabled={!previous.length||query.isFetching} onClick={()=>{setCursor(previous.at(-1)??"");setPrevious(previous.slice(0,-1));}}>Página anterior</Button><Button disabled={!query.data.nextCursor||query.isFetching} onClick={()=>{setPrevious([...previous,cursor]);setCursor(query.data.nextCursor??"");}}>Próxima página</Button></nav>
   </>}
  </>}
 </section>;
}
