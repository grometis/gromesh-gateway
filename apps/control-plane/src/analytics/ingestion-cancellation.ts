import pg from "pg";
/** Control connections must use the same SQL identity, with their own deadline. */
export function ingestionCancellationConfig(pool:pg.Pool):pg.ClientConfig{
 try{
  // Use the installed driver's parser, including its Unix-socket and hostless DSNs.
  // Resolve once and remove the DSN so parsing cannot override the control deadlines again.
  const transport=Reflect.get(pool.options,'stream');
  if(Reflect.get(pool.options,'connection')||(transport&&typeof transport!=='function'))throw Error('Non-independent cancellation transport');
  // Resolving a DSN must not allocate an unused custom socket or reuse the active session socket.
  const client=new pg.Client({...pool.options,stream:undefined,password:pool.options.password});
  const parameters:unknown=Reflect.get(client,"connectionParameters");
  if(!parameters||typeof parameters!=="object"||Array.isArray(parameters))throw Error("Missing driver parameters");
  return {...pool.options,...parameters,connectionString:undefined,password:client.password,
   connectionTimeoutMillis:1000,statement_timeout:1000,query_timeout:1000};
 }catch{throw Error("Unsupported ingestion cancellation connection options");}
}

/** One recovery allowance covers connect, termination and close. Expiry destroys the actual transport. */
export function terminateIngestionBackend(pool:pg.Pool,pid:number,name:string):Promise<boolean>{
 return new Promise(resolve=>{
  let control:pg.Client|undefined,settled=false;
  const finish=(verified:boolean)=>{if(!settled){settled=true;clearTimeout(timer);resolve(verified);}};
  const destroy=()=>{
   if(control){
    const connection:unknown=Reflect.get(control,'connection');
    const stream:unknown=connection&&typeof connection==='object'?Reflect.get(connection,'stream'):undefined;
    if(stream&&typeof stream==='object'&&typeof Reflect.get(stream,'destroy')==='function')Reflect.apply(Reflect.get(stream,'destroy') as (...args:unknown[])=>unknown,stream,[]);
    void control.end().catch(()=>undefined);
   }
   finish(false);
  };
  const timer=setTimeout(destroy,500);
  void(async()=>{
   try{
    control=new pg.Client(ingestionCancellationConfig(pool));
    // A failing control socket must neither crash the process nor expose driver options/credentials.
    control.on('error',destroy);
    await control.connect();
    const result=await control.query<{terminated:boolean}>("select pg_catalog.pg_terminate_backend(pid,250) terminated from pg_catalog.pg_stat_activity where pid=$1 and application_name=$2 and usename=current_user and datname=pg_catalog.current_database()",[pid,name]);
    const verified=result.rowCount===0||result.rows[0]?.terminated===true;
    await control.end();finish(verified);
   }catch{destroy();}
  })();
 });
}
