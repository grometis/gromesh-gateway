import { expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { BoundedCopyReader } from "./bounded-copy-reader.js";

it("enforces five seconds across all database executions instead of granting each query five seconds",async()=>{
 const limits:number[]=[];
 const client={async query(options:{clickhouse_settings:{max_execution_time:number}}){limits.push(options.clickhouse_settings.max_execution_time);const data=limits.length===1?[{row:{id:"00000000-0000-4000-8000-000000000001",tsMs:"4097174400000"}}]:[];
 return {response_headers:{"x-clickhouse-summary":JSON.stringify({read_rows:"1",read_bytes:"1",elapsed_ns:"3000000000"})},async *stream(){yield data.map(row=>({text:JSON.stringify(row),json:()=>row}));},close(){}};
 }} as unknown as ClickHouseClient;
 await expect(new BoundedCopyReader(client).read({instanceId:"00000000-0000-4000-8000-000000000002",from:"2099-11-01T00:00:00.000Z",to:"2099-11-02T00:00:00.000Z",pageSize:1})).rejects.toMatchObject({code:"analytics-budget-exceeded"});
 expect(limits[1]).toBeLessThanOrEqual(2);
});
