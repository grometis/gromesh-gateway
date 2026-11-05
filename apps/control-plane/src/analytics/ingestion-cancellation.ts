import pg from "pg";
/** Control connections must use the same SQL identity, with their own deadline. */
export function ingestionCancellationConfig(pool:pg.Pool):pg.ClientConfig{
 try{
  // Use the installed driver's parser, including its Unix-socket and hostless DSNs.
  // Resolve once and remove the DSN so parsing cannot override the control deadlines again.
  const client=new pg.Client({...pool.options,password:pool.options.password});
  const parameters:unknown=Reflect.get(client,"connectionParameters");
  if(!parameters||typeof parameters!=="object"||Array.isArray(parameters))throw Error("Missing driver parameters");
  return {...pool.options,...parameters,connectionString:undefined,password:client.password,
   connectionTimeoutMillis:1000,statement_timeout:1000,query_timeout:1000};
 }catch{throw Error("Unsupported ingestion cancellation connection options");}
}
