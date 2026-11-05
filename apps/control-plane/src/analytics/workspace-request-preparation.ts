import { Controller,Get,HttpException,Inject,Module,Param,Query,Req } from "@nestjs/common";
import { and,eq } from "drizzle-orm";
import { RequiredPermission,type AuthenticatedRequest } from "../auth/auth.js";
import { DB,type Db } from "../db/db.js";
import { analyticsRouteHistoryRoutes as history,instance,routes,services,consumers } from "../db/schema.js";
import { uuidParam } from "../environments/environments.js";
import { notFound,unprocessable } from "../common/problem.js";
import { ENCRYPTOR,Encryptor } from "../crypto/crypto.js";
import { parseWorkspaceRequestQuery,WorkspaceRequestCursor } from "./workspace-request-query.js";
const notReady=()=>new HttpException({type:"https://gromesh.dev/problems/analytics-not-ready",title:"Bad Gateway",status:502,code:"analytics-not-ready",detail:"Workspace analytics serving is not activated"},502);
/** Prepared controller ONLY: intentionally absent from AppModule and every operational bootstrap. */
@Controller("api/v2/workspaces/:workspaceId/requests")
export class WorkspaceRequestPreparationController{
 constructor(@Inject(DB)private readonly db:Db,@Inject(ENCRYPTOR)private readonly encryptor:Encryptor){}
 @Get()
 @RequiredPermission("workspace.read","workspace")
 async list(@Param("workspaceId",uuidParam())workspaceId:string,@Query()input:Record<string,unknown>,@Req()request:AuthenticatedRequest):Promise<never>{
  const now=Date.now(),query=parseWorkspaceRequestQuery(input,now);
  const [self]=await this.db.select({id:instance.id}).from(instance);if(!self)throw notReady();
  if(query.cursor)new WorkspaceRequestCursor(value=>this.encryptor.fingerprint(value)).read(query.cursor,{instanceId:self.id,workspaceId,principalId:JSON.stringify([request.user!.id,request.auth!.via,request.auth!.via==="token"?request.auth!.tokenId:null,request.auth!.role]),authorization:[...request.auth!.permissions],query},now);
  // Entity selection cannot bypass Workspace scope, even while positive serving is unavailable.
  if(query.routeId){const [owned]=await this.db.select({id:history.routeId}).from(history).where(and(eq(history.instanceId,self.id),eq(history.workspaceId,workspaceId),eq(history.routeId,query.routeId))).limit(1);const [current]=owned?[]:await this.db.select({id:routes.id}).from(routes).where(and(eq(routes.environmentId,workspaceId),eq(routes.id,query.routeId))).limit(1);if(!owned&&!current)throw notFound("Route");}
  if(query.serviceId){const [owned]=await this.db.select({id:history.serviceId}).from(history).where(and(eq(history.instanceId,self.id),eq(history.workspaceId,workspaceId),eq(history.serviceId,query.serviceId))).limit(1);const [current]=owned?[]:await this.db.select({id:services.id}).from(services).where(and(eq(services.environmentId,workspaceId),eq(services.id,query.serviceId))).limit(1);if(!owned&&!current)throw notFound("Service");}
  if(query.consumerId){const [current]=await this.db.select({id:consumers.id}).from(consumers).where(and(eq(consumers.environmentId,workspaceId),eq(consumers.id,query.consumerId))).limit(1);if(!current)throw notFound("Consumer");}
  if(query.routeId&&query.serviceId){
   const [historical]=await this.db.select({id:history.routeId}).from(history).where(and(eq(history.instanceId,self.id),eq(history.workspaceId,workspaceId),eq(history.routeId,query.routeId),eq(history.serviceId,query.serviceId))).limit(1);
   const [current]=historical?[]:await this.db.select({id:routes.id}).from(routes).where(and(eq(routes.environmentId,workspaceId),eq(routes.id,query.routeId),eq(routes.serviceId,query.serviceId))).limit(1);
   if(!historical&&!current)throw unprocessable("Incompatible request filters",[{path:"serviceId",message:"does not match the selected route"}]);
  }
  // No CH query and no 200/empty placeholder: missing cross-store/source proof remains explicit.
  throw notReady();
 }
}
@Module({controllers:[WorkspaceRequestPreparationController]})
export class WorkspaceRequestPreparationModule{}
