import {createHash,timingSafeEqual} from 'node:crypto';
import {ProblemException} from '../common/problem.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid=():never=>{throw new ProblemException(409,'Batch identity is invalid, expired or belongs to another admission');};
interface Binding{instanceId:string;streamId:string;authorizationId:string;descriptorDigest:string}
interface Claims extends Binding{position:string}
export function digestAdmissionDescriptor(rows:readonly {copyId:string;id:string;commitment:string;expiresAt:string}[]){return createHash('sha256').update(JSON.stringify(rows.map(r=>[r.copyId,r.id,r.commitment,r.expiresAt]))).digest('hex');}
function validate(c:Claims,now:number){if(![c.instanceId,c.streamId,c.authorizationId].every(x=>uuid.test(x))||!/^[0-9a-f]{64}$/.test(c.descriptorDigest)||!/^[1-9][0-9]{0,18}$/.test(c.position)||BigInt(c.position)>9223372036854775807n||!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(now+900000))invalid();}
/** EXPERIMENTAL: normative proposal requires owner approval; never installed by a runtime factory. */
export class BatchIdentityPolicy{
 constructor(private readonly fingerprint:(value:string)=>string){}
 private mac(domain:string,body:string){const value=this.fingerprint(`analytics-v2/batch-identity/${domain}/v1|${body}`);if(!/^[0-9a-f]{64}$/.test(value))return invalid();return value;}
 private id(body:string){const chars=this.mac('uuid',body).slice(0,32).split('');chars[12]='8';chars[16]=((parseInt(chars[16]!,16)&3)|8).toString(16);const h=chars.join('');return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
 issue(claims:Claims,now:number){validate(claims,now);const body=Buffer.from(JSON.stringify([1,claims.instanceId,claims.streamId,claims.authorizationId,claims.position,claims.descriptorDigest,now,now+900000])).toString('base64url');return{batchId:this.id(body),token:`${body}.${this.mac('token',body)}`};}
 verify(token:string,expected:Binding&{batchId:string},now:number):Readonly<Claims>{
  try{
   if(typeof token!=='string'||token.length>2048)return invalid();const[body,mac,...extra]=token.split('.');if(!body||!mac||extra.length||!/^[A-Za-z0-9_-]+$/.test(body)||!/^[0-9a-f]{64}$/.test(mac))return invalid();
   if(!timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(this.mac('token',body),'hex'))||this.id(body)!==expected.batchId)return invalid();
   const bytes=Buffer.from(body,'base64url');if(bytes.toString('base64url')!==body)return invalid();const a:unknown=JSON.parse(bytes.toString('utf8'));
   if(!Array.isArray(a)||a.length!==8||a[0]!==1||a.slice(1,6).some(v=>typeof v!=='string')||!Number.isSafeInteger(a[6])||!Number.isSafeInteger(a[7])||a[7]!==a[6]+900000||now<a[6]||now>=a[7])return invalid();
   const claims:Claims={instanceId:a[1] as string,streamId:a[2] as string,authorizationId:a[3] as string,position:a[4] as string,descriptorDigest:a[5] as string};validate(claims,now);
   if(claims.instanceId!==expected.instanceId||claims.streamId!==expected.streamId||claims.authorizationId!==expected.authorizationId||claims.descriptorDigest!==expected.descriptorDigest)return invalid();
   return Object.freeze(claims);
  }catch{return invalid();}
 }
}
