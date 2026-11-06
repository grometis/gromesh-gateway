import {fork} from 'node:child_process';
/** Owned test process only. Sensitive bootstrap/producer data uses IPC, never logs or temporary files. */
export async function createAnalyticsTestProcess(){
 const child=fork(new URL('./analytics-process-worker.mjs',import.meta.url),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
 let sequence=0,stopped=false;
 const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 let loadedResolve:()=>void,loadedReject:(error:Error)=>void;
 const loaded=new Promise<void>((resolve,reject)=>{loadedResolve=resolve;loadedReject=reject;});
 const readyTimer=setTimeout(()=>loadedReject(Error('Analytics test process loading deadline')),5000);
 const fail=()=>{for(const value of pending.values()){clearTimeout(value.timer);value.reject(Error('Analytics test process exited'));}pending.clear();loadedReject(Error('Analytics test process exited before loading'));};
 const exit=new Promise<void>(resolve=>child.once('close',()=>{stopped=true;clearTimeout(readyTimer);fail();resolve();}));
 child.on('error',()=>{fail();});
 child.on('message',(raw:unknown)=>{
  if(!raw||typeof raw!=='object')return;
  if('loaded'in raw){clearTimeout(readyTimer);loadedResolve();return;}
  if(!('id'in raw)||typeof raw.id!=='number')return;const value=pending.get(raw.id);if(!value)return;pending.delete(raw.id);clearTimeout(value.timer);
  if('ok'in raw&&raw.ok===true&&'value'in raw)value.resolve(raw.value);
  else value.reject(Object.assign(Error('Analytics worker failed at '+('stage'in raw?String(raw.stage):'unknown')+('error'in raw?': '+String(raw.error):'')),{status:'status'in raw&&typeof raw.status==='number'?raw.status:undefined}));
 });
 const close=async(crash=false)=>{
  if(stopped)return;const force=setTimeout(()=>child.kill('SIGKILL'),1000);
  try{child.kill(crash?'SIGKILL':'SIGTERM');await exit;}finally{clearTimeout(force);}
 };
 try{await loaded;}catch(error){await close(true);throw error;}
 return{pid:child.pid!,exited:()=>stopped,close,call:<T=unknown>(op:string,data?:unknown)=>new Promise<T>((resolve,reject)=>{
  if(stopped||!child.connected){reject(Error('Analytics test process is unavailable'));return;}
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Analytics test process command deadline'));},7500);
  pending.set(id,{resolve:value=>resolve(value as T),reject,timer});child.send({id,op,data},error=>{if(error){const value=pending.get(id);pending.delete(id);if(value){clearTimeout(timer);value.reject(Error('Analytics test process send failed'));}}});
 })};
}
