import {AnalyticsRequestBudget} from "./analytics-request-budget.js";
import { Controller,Get,HttpException,Inject,Module,Optional,Param,Query,Req,type DynamicModule } from "@nestjs/common";
import { and,eq } from "drizzle-orm";
import { RequiredPermission,type AuthenticatedRequest } from "../auth/auth.js";
import type pg from "pg";
import { withIngestionReadSnapshot } from "./ingestion-read-snapshot.js";
import { WORKSPACE_REQUEST_SERVING,type WorkspaceRequestServing } from "./workspace-request-serving.js";
import { StorageConsistencyError } from "./storage-consistency.js";
import { DB,PG_POOL,type Db } from "../db/db.js";
import { analyticsRouteHistoryRoutes as history,instance,routes,services,consumers } from "../db/schema.js";
import { uuidParam } from "../environments/environments.js";
import { notFound,unprocessable } from "../common/problem.js";
import { ENCRYPTOR,Encryptor } from "../crypto/crypto.js";
import { parseWorkspaceRequestQuery,WorkspaceRequestCursor } from "./workspace-request-query.js";
const notReady=()=>new HttpException({type:"https://gromesh.dev/problems/analytics-not-ready",title:"Bad Gateway",status:502,code:"analytics-not-ready",detail:"Workspace analytics serving is not activated"},502);
/** Prepared controller ONLY: intentionally absent from AppModule and every operational bootstrap. */
@Controller("api/v2/workspaces/:workspaceId/requests")
export class WorkspaceRequestPreparationController{
 constructor(@Inject(DB)private readonly db:Db,@Inject(ENCRYPTOR)private readonly encryptor:Encryptor,@Inject(PG_POOL)private readonly connection:{pool:pg.Pool},@Optional()@Inject(WORKSPACE_REQUEST_SERVING)private readonly serving?:WorkspaceRequestServing){}
 @Get()
 @RequiredPermission("workspace.read","workspace")
 async list(@Param("workspaceId",uuidParam())workspaceId:string,@Query()input:Record<string,unknown>,@Req()request:AuthenticatedRequest):Promise<unknown>{
  return this.execute(workspaceId,input,request,Date.now());
 }
 /** Internal operation runner: the public aggregate controllers reuse scope, cursor policy, errors and budget. */
 async execute(workspaceId:string,input:Record<string,unknown>,request:AuthenticatedRequest,now:number):Promise<unknown>{
  const started=performance.now(),query=parseWorkspaceRequestQuery(input,now);
  const cancel=new AbortController(),signal=AbortSignal.any([cancel.signal,AbortSignal.timeout(4500)]);
  const budget=new AnalyticsRequestBudget(signal);
  const aborted=()=>cancel.abort(),closed=()=>{if(!request.res?.writableEnded)cancel.abort();};
  request.once("aborted",aborted);request.res?.once("close",closed);
  try{
   const cursor=new WorkspaceRequestCursor(value=>this.encryptor.fingerprint(value));
   const scope=await withIngestionReadSnapshot(this.connection.pool,async db=>{
    const [self]=await db.select({id:instance.id}).from(instance);if(!self)throw notReady();
    const context={instanceId:self.id,workspaceId,principalId:JSON.stringify([request.user!.id,request.auth!.via,request.auth!.via==="token"?request.auth!.tokenId:null,request.auth!.role]),authorization:[...request.auth!.permissions],query};
    const after=query.cursor?cursor.read(query.cursor,context,now):undefined;
  // Entity selection cannot bypass Workspace scope, even while positive serving is unavailable.
  if(query.routeId){const [owned]=await db.select({id:history.routeId}).from(history).where(and(eq(history.instanceId,self.id),eq(history.workspaceId,workspaceId),eq(history.routeId,query.routeId))).limit(1);const [current]=owned?[]:await db.select({id:routes.id}).from(routes).where(and(eq(routes.environmentId,workspaceId),eq(routes.id,query.routeId))).limit(1);if(!owned&&!current)throw notFound("Route");}
  if(query.serviceId){const [owned]=await db.select({id:history.serviceId}).from(history).where(and(eq(history.instanceId,self.id),eq(history.workspaceId,workspaceId),eq(history.serviceId,query.serviceId))).limit(1);const [current]=owned?[]:await db.select({id:services.id}).from(services).where(and(eq(services.environmentId,workspaceId),eq(services.id,query.serviceId))).limit(1);if(!owned&&!current)throw notFound("Service");}
  if(query.consumerId){const [current]=await db.select({id:consumers.id}).from(consumers).where(and(eq(consumers.environmentId,workspaceId),eq(consumers.id,query.consumerId))).limit(1);if(!current)throw notFound("Consumer");}
  if(query.routeId&&query.serviceId){
   const [historical]=await db.select({id:history.routeId}).from(history).where(and(eq(history.instanceId,self.id),eq(history.workspaceId,workspaceId),eq(history.routeId,query.routeId),eq(history.serviceId,query.serviceId))).limit(1);
   const [current]=historical?[]:await db.select({id:routes.id}).from(routes).where(and(eq(routes.environmentId,workspaceId),eq(routes.id,query.routeId),eq(routes.serviceId,query.serviceId))).limit(1);
   if(!historical&&!current)throw unprocessable("Incompatible request filters",[{path:"serviceId",message:"does not match the selected route"}]);
  }

    return {instanceId:self.id,context,after};
   },budget.signal,budget);
   if(!this.serving)throw notReady();
   const result=await this.serving.query({instanceId:scope.instanceId,workspaceId,principalId:request.user!.id,role:request.auth!.role,query,after:scope.after,signal:budget.signal,budget,issueCursor:last=>cursor.issue(scope.context,last,now)});
   budget.check();
   if(performance.now()-started>=5000||Buffer.byteLength(JSON.stringify(result))>2*1024*1024)throw new StorageConsistencyError("analytics-budget-exceeded","Workspace request budget exceeded");
   budget.serialize(result);return result;
  }catch(error){
   if(error instanceof HttpException&&!signal.aborted){if(error.getStatus()===429)request.res?.setHeader("Retry-After","1");throw error;}
   let budgetError:unknown;try{budget.check();}catch(e){budgetError=e;}
   if(budgetError instanceof StorageConsistencyError)error=budgetError;
   const code=signal.aborted?"analytics-timeout":error instanceof StorageConsistencyError?error.code:"analytics-unavailable";
   throw new HttpException({type:`https://gromesh.dev/problems/${code}`,title:"Bad Gateway",status:502,code,detail:"Workspace analytics query could not be verified"},502);
  }finally{budget.close();request.removeListener("aborted",aborted);request.res?.removeListener("close",closed);}

 }
}
@Module({controllers:[WorkspaceRequestPreparationController]})
export class WorkspaceRequestPreparationModule{
 static withServing(serving:WorkspaceRequestServing):DynamicModule{return {module:WorkspaceRequestPreparationModule,providers:[{provide:WORKSPACE_REQUEST_SERVING,useValue:serving}]};}
}
