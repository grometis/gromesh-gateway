import {HttpException} from '@nestjs/common';
import type {Request,RequestHandler} from 'express';
export interface AnalyticsHttpObservation{
 elapsedMs:number;deadlineMs:number;deadlineExceeded:boolean;completion:'finished'|'closed'|'error';status:number;operationMs:number|null;
}
interface Context{signal:AbortSignal;check:()=>void;beginOperation:()=>()=>void}
const contexts=new WeakMap<Request,Context>();
export const analyticsHttpContext=(request:Request)=>contexts.get(request);
const path=/^\/api\/v2\/workspaces\/[^/]+\/(?:requests|analytics\/(?:summary|timeseries|top-routes))\/?$/i;
/** Opt-in composition hook. Observation includes guards; it cannot preempt their uninstrumented SQL or HTTP transport. */
export function observeAnalyticsHttp(options:{deadlineMs?:number;onObserved?:(value:AnalyticsHttpObservation)=>void}={}):RequestHandler{
 const deadlineMs=options.deadlineMs??8000;
 if(!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>8000)throw Error('Invalid analytics HTTP observation deadline');
 return(request,response,next)=>{
  const started=performance.now();if(!path.test(request.path)){next();return;}
  const abort=new AbortController();let complete=false,operationStarted:number|undefined,operationMs:number|null=null;
  const elapsed=()=>Math.max(0,performance.now()-started);
  const timer=setTimeout(()=>abort.abort(),deadlineMs);
  const check=()=>{
   if(elapsed()>=deadlineMs)abort.abort();
   if(abort.signal.aborted)throw new HttpException({type:'https://gromesh.dev/problems/analytics-timeout',title:'Bad Gateway',status:502,code:'analytics-timeout',detail:'Workspace analytics HTTP observation deadline exceeded'},502);
  };
  contexts.set(request,{signal:abort.signal,check,beginOperation:()=>{check();operationStarted=performance.now();let ended=false;return()=>{if(!ended){ended=true;operationMs=Math.max(0,performance.now()-operationStarted!);}};}});
  const disconnected=()=>abort.abort();
  const finish=(completion:AnalyticsHttpObservation['completion'])=>{
   if(complete)return;complete=true;clearTimeout(timer);if(completion!=='finished')abort.abort();
   // A guard may still resume after close: keep its aborted context until the weak request key is collected.
   const elapsedMs=elapsed();if(completion==='finished')contexts.delete(request);request.removeListener('aborted',disconnected);response.removeListener('finish',finished);response.removeListener('close',closed);response.removeListener('error',failed);
   // Diagnostic consumers must not change an already completed response or expose request contents.
   try{options.onObserved?.({elapsedMs,deadlineMs,deadlineExceeded:elapsedMs>=deadlineMs,completion,status:response.statusCode,operationMs});}catch{/* Observation is not serving evidence. */}
  };
  const finished=()=>finish('finished'),closed=()=>finish('closed'),failed=()=>finish('error');
  request.once('aborted',disconnected);response.once('finish',finished);response.once('close',closed);response.once('error',failed);next();
 };
}
