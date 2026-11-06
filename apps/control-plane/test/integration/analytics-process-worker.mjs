import {registerHooks} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {transformSync} from '@swc/core';
// Match Vitest's decorator transform in this test-owned process without building or activating the product.
const source=new URL('../../src/',import.meta.url).href;
registerHooks({
 resolve(specifier,context,next){
  if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL){const candidate=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(candidate.href.startsWith(source)&&existsSync(candidate))return{url:candidate.href,shortCircuit:true};}
  return next(specifier,context);
 },
 load(url,context,next){if(url.startsWith(source)&&url.endsWith('.ts'))return{format:'module',source:transformSync(readFileSync(new URL(url),'utf8'),{filename:new URL(url).pathname,jsc:{target:'es2022',parser:{syntax:'typescript',decorators:true},transform:{legacyDecorator:true,decoratorMetadata:true}},module:{type:'es6'}}).code,shortCircuit:true};return next(url,context);}
});
await import('reflect-metadata');
const [{Module,RequestMethod},{NestFactory},{AppModule},{WorkspaceRequestPreparationModule},{WorkspaceAnalyticsPreparationModule},{createVerifiedWorkspaceRequests},{openTrustedIngestion},{BatchIdentityPolicy},{AgentGatewayService},{ENCRYPTOR},{observeAnalyticsHttp},{default:pg},{drizzle},schema]=await Promise.all([
 import('@nestjs/common'),import('@nestjs/core'),import('../../src/app.module.js'),import('../../src/analytics/workspace-request-preparation.js'),import('../../src/analytics/workspace-analytics-preparation.js'),import('../../src/analytics/workspace-request-serving.js'),import('../../src/analytics/trusted-ingestion.js'),import('../../src/analytics/batch-identity.js'),import('../../src/agent-gateway/agent-gateway.js'),import('../../src/crypto/crypto.js'),import('../../src/analytics/analytics-http-observation.js'),import('pg'),import('drizzle-orm/node-postgres'),import('../../src/db/schema.js')
]);
let app,serving,producer,pool;const observations=[];
process.on('SIGTERM',()=>{void(async()=>{await Promise.allSettled([app?.close(),serving?.close(),producer?.close()]);await pool?.end();process.exit(0);})();});
process.on('message',message=>{void(async()=>{
 const {id,op,data}=message;let stage=op;
 try{
  let value;
  if(op==='pid')value=process.pid;
  else if(op==='boot'){
   if(app)throw Error('Already booted');
   const cp=new URL(data.config.databaseUrl),runtime=new URL(data.runtimeUrl);
   if(data.config.migrateOnStart!==false||!/^\/gromesh_test_[a-z0-9_]+_[0-9a-f]{24}$/.test(cp.pathname)||cp.hostname!==runtime.hostname||cp.port!==runtime.port||cp.pathname!==runtime.pathname||!/^gromesh_test_[0-9a-f]{24}$/.test(data.settings.databaseName))throw Error('Disposable bootstrap required');
   pool=new pg.Pool({connectionString:data.runtimeUrl,max:2});stage='serving';serving=await createVerifiedWorkspaceRequests({pool,settings:data.settings,capacity:1,budgetProfile:'operational-v1-proposed'});
   class Root{}Module({imports:[AppModule.forRoot(data.config),WorkspaceRequestPreparationModule.withServing(serving),WorkspaceAnalyticsPreparationModule.withServing(serving)]})(Root);
   stage='app';app=await NestFactory.create(Root,{logger:false});app.use(observeAnalyticsHttp({onObserved:value=>observations.push(value)}));app.getHttpAdapter().getInstance().set('query parser','simple');app.setGlobalPrefix('api/v1',{exclude:[{path:'api/v2/{*splat}',method:RequestMethod.ALL}]});await app.init();await app.listen(0,'127.0.0.1');
   stage='producer';const key=app.get(ENCRYPTOR);producer=await openTrustedIngestion({db:drizzle(pool,{schema}),gateway:app.get(AgentGatewayService),settings:data.settings,experimentalIdentityPolicy:new BatchIdentityPolicy(value=>key.fingerprint(value))});value={url:await app.getUrl(),pid:process.pid};
  }else if(op==='mint')value=await producer.issueIdentity(data.token,data.streamId,data.copies);
  else if(op==='persist')value=await producer.persist(data.token,data.streamId,data.identity.batchId,data.copies,{identityTicket:data.identity.token});
  else if(op==='observations')value=observations;
  else throw Error('Unknown test command');
  process.send?.({id,ok:true,value});
 }catch(error){process.send?.({id,ok:false,stage,error:error instanceof Error?error.name:'unknown',status:typeof error?.getStatus==='function'?error.getStatus():undefined});}
})();});
process.send?.({loaded:true});
