import {useRef,useState,type FormEvent} from 'react';
import type {WorkspaceRoute} from '../api/client-v2';
import {Modal} from '../components/Modal';
import {Field} from '../components/Field';
import {Button} from '../components/Button';
import {buildRouteCurl} from './route-curl';

export function RouteCurl({route}:{route:WorkspaceRoute}){
 const [open,setOpen]=useState(false),[entry,setEntry]=useState(''),[method,setMethod]=useState(route.methods?.[0]??'GET');
 const [state,setState]=useState<'idle'|'copying'|'copied'>('idle'),[error,setError]=useState<string|null>(null);
 const attempt=useRef(0);
 const close=()=>{attempt.current++;setOpen(false);setState('idle');};
 const supported=route.protocols.some(p=>p==='http'||p==='https');
 const copy=async(event:FormEvent)=>{
  event.preventDefault();setError(null);setState('idle');
  let command:string;try{command=buildRouteCurl(route,entry,method);}catch(err){setError(err instanceof Error?err.message:'Não foi possível preparar o cURL.');return;}
  const current=++attempt.current;setState('copying');
  try{await navigator.clipboard.writeText(command);if(attempt.current===current)setState('copied');}
  catch{if(attempt.current===current){setState('idle');setError('Não foi possível copiar. Verifique a permissão da área de transferência e tente novamente.');}}
 };
 return <>
  <button type="button" className="copy-route" aria-label={`Copiar cURL de ${route.name}`} title="Copiar cURL" onClick={()=>{attempt.current++;setError(null);setState('idle');setOpen(true);}}>
   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>
  </button>
  {open&&<Modal title={`Copiar cURL de ${route.name}`} onClose={close}>
   {!supported?<p role="status">Esta rota exige gRPC. O comando cURL HTTP não está disponível.</p>:<form className="form" onSubmit={event=>void copy(event)}>
    <p>Informe a entrada pública completa da rota, com o prefixo do Workspace quando existir. Não use a URL administrativa nem o endereço interno do serviço.</p>
    <Field label="URL pública da rota">{id=><input id={id} type="url" required placeholder="https://api.exemplo.com/workspace/caminho" value={entry} disabled={state==='copying'} onChange={e=>{setEntry(e.target.value);setState('idle');setError(null);}}/>}</Field>
    <Field label="Método">{id=><select id={id} value={method} disabled={state==='copying'} onChange={e=>{setMethod(e.target.value);setState('idle');}}>{(route.methods?.length?route.methods:['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']).map(m=><option key={m}>{m}</option>)}</select>}</Field>
    <p className="muted">Valores de cabeçalhos são substituídos por &lt;VALOR&gt;. Copiar não executa a requisição.</p>
    {error&&<p className="error" role="alert">{error}</p>}
    <p role="status">{state==='copied'?'cURL copiado':state==='copying'?'Copiando…':''}</p>
    <div className="form-actions"><Button onClick={close}>Fechar</Button><Button type="submit" variant="primary" disabled={state==='copying'}>Copiar comando</Button></div>
   </form>}
  </Modal>}
 </>;
}
