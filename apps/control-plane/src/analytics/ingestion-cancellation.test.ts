import pg from "pg";
import{expect,it}from"vitest";
import{ingestionCancellationConfig}from"./ingestion-cancellation.js";
it('preserves a nonenumerable password configured directly on a pool',async()=>{
 const pool=new pg.Pool({user:'synthetic',database:'synthetic',password:'synthetic-only-secret'});
 try{expect(Object.getOwnPropertyDescriptor(pool.options,'password')?.enumerable).toBe(false);expect(Reflect.get(new pg.Client(ingestionCancellationConfig(pool)),'password')==='synthetic-only-secret').toBe(true);}finally{await pool.end();}
});
it('preserves a dynamic password provider without invoking or serializing it',async()=>{
 const password=async()=>'synthetic-only-secret',pool=new pg.Pool({password});try{expect(ingestionCancellationConfig(pool).password).toBe(password);}finally{await pool.end();}
});
it('imposes control deadlines after the driver applies DSN precedence and preserves the source pool',async()=>{
 const connectionString='postgres://synthetic:synthetic@127.0.0.1/synthetic?query_timeout=600000&statement_timeout=600000&connect_timeout=600000',pool=new pg.Pool({connectionString});
 try{const parameters:unknown=Reflect.get(new pg.Client(ingestionCancellationConfig(pool)),'connectionParameters');if(!parameters||typeof parameters!=='object'||!('query_timeout'in parameters)||!('statement_timeout'in parameters)||!('connect_timeout'in parameters))throw Error('Missing driver parameters');expect(Number(parameters.query_timeout)).toBe(1000);expect(Number(parameters.statement_timeout)).toBe(1000);expect(Number(parameters.connect_timeout)).toBe(1);expect(pool.options.connectionString).toBe(connectionString);}finally{await pool.end();}
});
it('sanitizes invalid DSNs instead of exposing credential-bearing native URL errors',async()=>{
 const pool=new pg.Pool({connectionString:'postgres://synthetic:private-sentinel@/bad'});try{let error:unknown;try{ingestionCancellationConfig(pool);}catch(e){error=e;}expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('private-sentinel');expect(error).not.toHaveProperty('input');expect(error).not.toHaveProperty('cause');}finally{await pool.end();}
});
