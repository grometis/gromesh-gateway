import pg from "pg";
import { expect,it } from "vitest";
import { reconciliationPoolConfig } from "./ingestion-reconciler.js";
it("bounds effective client settings even when the DSN attempts to override them",async()=>{
 const source=new pg.Pool({connectionString:"postgres://synthetic@127.0.0.1/test?statement_timeout=600000&query_timeout=600000&idle_in_transaction_session_timeout=600000"});
 try{const config=reconciliationPoolConfig(source);const actual=Reflect.get(new pg.Client(config),"connectionParameters") as Record<string,unknown>;
  expect(Number(actual.statement_timeout)).toBe(5000);expect(Number(actual.query_timeout)).toBe(6000);expect(Number(actual.idle_in_transaction_session_timeout)).toBe(5000);expect(actual.options).toBe("-c lock_timeout=1000");expect(config.connectionTimeoutMillis).toBe(1000);expect(config.max).toBe(1);
 }finally{await source.end();}
});
it("preserves a non-enumerable directly configured password without exposing it",async()=>{
 const password="synthetic-only-test-secret",source=new pg.Pool({host:"127.0.0.1",user:"synthetic",database:"test",password});
 try{expect(Object.keys(source.options)).not.toContain("password");const actual=Reflect.get(new pg.Client(reconciliationPoolConfig(source)),"connectionParameters") as Record<string,unknown>;expect(actual.password).toBe(password);}finally{await source.end();}
});
it("refuses unreviewed startup options that could disable server budgets",async()=>{
 for(const input of [{connectionString:"postgres://synthetic@127.0.0.1/test?options=-c%20lock_timeout%3D0"},{host:"127.0.0.1",options:"-c statement_timeout=0"}]){
  const source=new pg.Pool(input);try{expect(()=>reconciliationPoolConfig(source)).toThrow("Unsupported reconciliation connection options");}finally{await source.end();}
 }
});
