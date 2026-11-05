import { createHmac } from "node:crypto";
import { it,expect } from "vitest";
import { parseWorkspaceRequestQuery,WorkspaceRequestCursor } from "./workspace-request-query.js";
const now=Date.parse("2026-11-05T03:00:00.000Z"),query={from:"2026-11-05T01:00:00.000Z",to:"2026-11-05T02:00:00.000Z"};
const id="11111111-1111-4111-8111-111111111111";
const cursor=new WorkspaceRequestCursor(value=>createHmac("sha256",Buffer.alloc(32,1)).update(value).digest("hex"));
it("normalizes offset timestamps and preserves explicit filters",()=>{expect(parseWorkspaceRequestQuery({...query,from:"2026-11-04T22:00:00-03:00",limit:"200",status:"503",routeId:id},now)).toMatchObject({...query,limit:200,status:503,routeId:id});});
it.each([{...query,environmentId:id},{...query,instanceId:id},{...query,workspaceId:id},{...query,method:"GET"},{...query,status:"2e2"},{...query,status:"200",statusClass:"2xx"},{...query,limit:"201"},{...query,limit:["1","2"]},{...query,from:"2026-11-05T01:00:00"},{...query,from:"2026-11-05T01:00:00.0001Z"},{...query,from:"2026-02-30T00:00:00Z"},{...query,to:query.from},{...query,from:"2026-10-01T00:00:00Z"},{...query,to:"2099-01-01T00:00:00Z"},{...query,routeId:"unknown"},{...query,cursor:""}])("rejects invalid or scope-expanding query %j",input=>{expect(()=>parseWorkspaceRequestQuery(input,now)).toThrow();});
it("binds cursor to the whole query and authorization context and rejects tampering, expiry and foreign scope",()=>{
 const parsed=parseWorkspaceRequestQuery(query,now),context={instanceId:id,workspaceId:id,principalId:"synthetic-user",authorization:["workspace.read"],query:parsed};
 const last={ts:"2026-11-05T01:30:00.000Z",id},encoded=cursor.issue(context,last,now);expect(cursor.read(encoded,context,now)).toEqual(last);
 for(const changed of [{...context,workspaceId:"22222222-2222-4222-8222-222222222222"},{...context,principalId:"other"},{...context,authorization:[]},{...context,query:{...parsed,limit:51}},{...context,query:{...parsed,status:500}}])expect(()=>cursor.read(encoded,changed,now)).toThrow();
 expect(()=>cursor.read(encoded.slice(0,-1)+(encoded.endsWith("a")?"b":"a"),context,now)).toThrow();expect(()=>cursor.read(encoded,context,now+15*60000)).toThrow();expect(()=>cursor.read(encoded,context,now-1)).toThrow();
});
