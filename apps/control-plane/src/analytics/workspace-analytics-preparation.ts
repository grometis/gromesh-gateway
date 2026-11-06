import {Controller,Get,Inject,Module,Optional,Param,Query,Req,type DynamicModule} from '@nestjs/common';
import type pg from 'pg';
import {RequiredPermission,type AuthenticatedRequest} from '../auth/auth.js';
import {DB,PG_POOL,type Db} from '../db/db.js';
import {ENCRYPTOR,Encryptor} from '../crypto/crypto.js';
import {uuidParam} from '../environments/environments.js';
import {WorkspaceRequestPreparationController} from './workspace-request-preparation.js';
import {WORKSPACE_REQUEST_SERVING,type WorkspaceRequestServing} from './workspace-request-serving.js';
import {parseWorkspaceAggregateQuery,type AggregateOperation} from './workspace-aggregates.js';
/** Prepared controllers only. No operational module/bootstrap imports this module. */
@Controller('api/v2/workspaces/:workspaceId/analytics')
export class WorkspaceAnalyticsPreparationController{
 constructor(@Inject(DB)private readonly db:Db,@Inject(ENCRYPTOR)private readonly encryptor:Encryptor,@Inject(PG_POOL)private readonly connection:{pool:pg.Pool},@Optional()@Inject(WORKSPACE_REQUEST_SERVING)private readonly serving?:WorkspaceRequestServing){}
 private run(operation:AggregateOperation,workspaceId:string,raw:Record<string,unknown>,request:AuthenticatedRequest){
  const now=Date.now(),query=parseWorkspaceAggregateQuery(operation,raw,now);
  const serving=this.serving;
  const controller=new WorkspaceRequestPreparationController(this.db,this.encryptor,this.connection,serving?{budgetProfile:serving.budgetProfile,query:input=>serving.query({...input,aggregation:query})}:undefined);
  return controller.execute(workspaceId,{from:query.from,to:query.to,limit:'200',...(query.routeId?{routeId:query.routeId}:{}),...(query.serviceId?{serviceId:query.serviceId}:{})},request,now);
 }
 @Get('summary') @RequiredPermission('workspace.read','workspace')
 summary(@Param('workspaceId',uuidParam())workspaceId:string,@Query()raw:Record<string,unknown>,@Req()request:AuthenticatedRequest){return this.run('summary',workspaceId,raw,request);}
 @Get('timeseries') @RequiredPermission('workspace.read','workspace')
 timeseries(@Param('workspaceId',uuidParam())workspaceId:string,@Query()raw:Record<string,unknown>,@Req()request:AuthenticatedRequest){return this.run('timeseries',workspaceId,raw,request);}
 @Get('top-routes') @RequiredPermission('workspace.read','workspace')
 topRoutes(@Param('workspaceId',uuidParam())workspaceId:string,@Query()raw:Record<string,unknown>,@Req()request:AuthenticatedRequest){return this.run('top-routes',workspaceId,raw,request);}
}
@Module({controllers:[WorkspaceAnalyticsPreparationController]})
export class WorkspaceAnalyticsPreparationModule{
 static withServing(serving:WorkspaceRequestServing):DynamicModule{return{module:WorkspaceAnalyticsPreparationModule,providers:[{provide:WORKSPACE_REQUEST_SERVING,useValue:serving}]};}
}
