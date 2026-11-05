import type pg from "pg";
/** Control connections must use the same SQL identity, with their own deadline. */
export function ingestionCancellationConfig(pool:pg.Pool):pg.ClientConfig{
 // pg-pool hides password from enumeration; the driver also gives DSN values precedence over object fields.
 const config:pg.ClientConfig={...pool.options,password:pool.options.password,connectionTimeoutMillis:1000,statement_timeout:1000,query_timeout:1000};
 if(config.connectionString){
  let uri:URL;try{uri=new URL(config.connectionString);}catch{throw Error("Unsupported ingestion cancellation connection options");}
  if(!["postgres:","postgresql:"].includes(uri.protocol))throw Error("Unsupported ingestion cancellation connection options");
  for(const [key,value]of Object.entries({connect_timeout:"1",statement_timeout:"1000",query_timeout:"1000"}))uri.searchParams.set(key,value);
  config.connectionString=uri.toString();
 }
 return config;
}
