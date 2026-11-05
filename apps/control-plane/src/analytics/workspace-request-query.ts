import { timingSafeEqual } from "node:crypto";
import { unprocessable } from "../common/problem.js";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid=(path:string):never=>{throw unprocessable("Invalid workspace request query",[{path,message:"is invalid"}]);};
function instant(value:unknown,path:string):string{
 if(typeof value!=="string")return invalid(path);
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
 const ms=Date.parse(value);if(!m||!Number.isFinite(ms))return invalid(path);
 const y=Number(m[1]),month=Number(m[2]),day=Number(m[3]),days=[31,y%4===0&&(y%100!==0||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
 if(month<1||month>12||day<1||day>days[month-1]!||Number(m[4])>23||Number(m[5])>59||Number(m[6])>59)return invalid(path);
 return new Date(ms).toISOString();
}
export interface WorkspaceRequestQuery{from:string;to:string;limit:number;routeId?:string;serviceId?:string;consumerId?:string;status?:number;statusClass?:"2xx"|"3xx"|"4xx"|"5xx";cursor?:string}
export function parseWorkspaceRequestQuery(input:Record<string,unknown>,now:number):WorkspaceRequestQuery{
 const allowed=["from","to","limit","routeId","serviceId","consumerId","status","statusClass","cursor"];
 for(const key of Object.keys(input))if(!allowed.includes(key)||typeof input[key]!=="string")return invalid(key);
 const from=instant(input.from,"from"),to=instant(input.to,"to"),start=Date.parse(from),end=Date.parse(to);
 if(start>=end||end-start>7*86400000)return invalid("to");
 if(input.cursor===undefined&&(start<now-7*86400000||end>now))return invalid(start<now-7*86400000?"from":"to");
 const limit=input.limit===undefined?50:typeof input.limit==="string"&&/^[0-9]+$/.test(input.limit)?Number(input.limit):NaN;
 if(!Number.isInteger(limit)||limit<1||limit>200)return invalid("limit");
 const out:WorkspaceRequestQuery={from,to,limit};
 for(const key of ["routeId","serviceId","consumerId"] as const)if(input[key]!==undefined){if(typeof input[key]!=="string"||!uuid.test(input[key]))return invalid(key);out[key]=input[key].toLowerCase();}
 if(input.status!==undefined){if(typeof input.status!=="string"||! /^[1-5][0-9]{2}$/.test(input.status))return invalid("status");out.status=Number(input.status);}
 if(input.statusClass!==undefined){if(typeof input.statusClass!=="string"||!["2xx","3xx","4xx","5xx"].includes(input.statusClass)||out.status!==undefined)return invalid("statusClass");out.statusClass=input.statusClass as WorkspaceRequestQuery["statusClass"];}
 if(input.cursor!==undefined){if(typeof input.cursor!=="string"||!input.cursor||input.cursor.length>4096)return invalid("cursor");out.cursor=input.cursor;}
 return out;
}
export interface RequestCursorContext{instanceId:string;workspaceId:string;principalId:string;authorization:readonly string[];query:WorkspaceRequestQuery}
interface Last{ts:string;id:string}
/** Reuses the existing server HMAC primitive with domain separation; never the unsigned legacy cursor. */
export class WorkspaceRequestCursor{
 constructor(private readonly sign:(value:string)=>string){}
 private context(c:RequestCursorContext){const q=c.query;return JSON.stringify([c.instanceId,c.workspaceId,c.principalId,[...new Set(c.authorization)].sort(),"route-history-v2",q.from,q.to,q.limit,q.routeId??null,q.serviceId??null,q.consumerId??null,q.status??null,q.statusClass??null]);}
 issue(context:RequestCursorContext,last:Last,now:number):string{
  if(!uuid.test(last.id)||instant(last.ts,"cursor")!==last.ts||Date.parse(last.ts)<Date.parse(context.query.from)||Date.parse(last.ts)>=Date.parse(context.query.to)||!Number.isSafeInteger(now))return invalid("cursor");
  const value=Buffer.from(JSON.stringify({v:1,context:this.context(context),issuedAt:now,expiresAt:now+15*60000,last})).toString("base64url");
  const encoded=value+"."+this.sign("analytics-v2/requests/cursor/v1|"+value);if(encoded.length>4096)return invalid("cursor");return encoded;
 }
 read(raw:string,context:RequestCursorContext,now:number):Last{
  try{
   if(raw.length>4096)return invalid("cursor");const [value,mac,...extra]=raw.split(".");if(!value||!mac||extra.length||! /^[A-Za-z0-9_-]+$/.test(value)||! /^[0-9a-f]{64}$/.test(mac))return invalid("cursor");
   const expected=this.sign("analytics-v2/requests/cursor/v1|"+value);if(! /^[0-9a-f]{64}$/.test(expected)||!timingSafeEqual(Buffer.from(mac,"hex"),Buffer.from(expected,"hex")))return invalid("cursor");
   const text=Buffer.from(value,"base64url");if(text.toString("base64url")!==value)return invalid("cursor");const p:unknown=JSON.parse(text.toString("utf8"));
   if(!p||typeof p!=="object"||Array.isArray(p))return invalid("cursor");const item=p as Record<string,unknown>;
   if(Object.keys(item).sort().join(",")!=="context,expiresAt,issuedAt,last,v"||item.v!==1||item.context!==this.context(context)||typeof item.issuedAt!=="number"||typeof item.expiresAt!=="number"||!Number.isSafeInteger(item.issuedAt)||item.expiresAt!==item.issuedAt+15*60000||now<item.issuedAt||now>=item.expiresAt||!item.last||typeof item.last!=="object"||Array.isArray(item.last))return invalid("cursor");
   const last=item.last as Record<string,unknown>;if(Object.keys(last).sort().join(",")!=="id,ts"||typeof last.id!=="string"||!uuid.test(last.id)||typeof last.ts!=="string"||instant(last.ts,"cursor")!==last.ts||Date.parse(last.ts)<Date.parse(context.query.from)||Date.parse(last.ts)>=Date.parse(context.query.to))return invalid("cursor");
   return {id:last.id.toLowerCase(),ts:last.ts};
  }catch{return invalid("cursor");}
 }
}
