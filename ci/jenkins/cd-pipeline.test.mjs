import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { liveLedger,targetProofEnvironment } from './cd-pipeline.mjs';
import { validateImageProof } from './image-proof.mjs';
test('live ledger requires ordered SQL hashes/times, expected DB and completed data backfill',async()=>{
 const source={files:[{name:'0000.sql',sha256:'a'.repeat(64),journalTime:123}]};
 const data={database:'gateway',sql:[{hash:'a'.repeat(64),createdAt:123}],data:['n1-workspaces']};
 assert.equal((await liveLedger(source,async()=>data,'gateway')).verified,true);
 for(const alter of [d=>d.database='other',d=>d.sql[0].hash='b'.repeat(64),d=>d.data=[],d=>d.sql.reverse().push({hash:'foreign',createdAt:0})]){const d=structuredClone(data);alter(d);assert.equal(await liveLedger(source,async()=>d,'gateway'),null);}
 assert.equal(await liveLedger(source,async()=>{throw Error('missing table');},'gateway'),null);
});
test('DEV PLAN/APPLY CLIs refuse this Mac and never need N2 credentials for the disabled APPLY gate',()=>{
 for(const command of ['plan','apply']){const r=spawnSync(process.execPath,[fileURLToPath(new URL('./cd-pipeline.mjs',import.meta.url)),command],{env:{PATH:process.env.PATH},encoding:'utf8'});assert.equal(r.status,78);assert.match(r.stdout,/REFUSED/);}
});
test('image availability proof cannot pull an arbitrary image or use another target context',()=>{
 const c={kubeContext:'dev',namespace:'gateway'},image='docker.io/fabriciobackend/gromesh-ui@sha256:'+'a'.repeat(64);
 assert.doesNotThrow(()=>validateImageProof(image,'dev','gateway',c));
 assert.throws(()=>validateImageProof(image.replace('gromesh-ui','gromesh-control-plane'),'dev','gateway',c));assert.throws(()=>validateImageProof(image,'prod','gateway',c));
});
test('target pull subprocess keeps protected runtime build identity without inheriting unrelated credentials',()=>{
 const e=targetProofEnvironment({PATH:'/tools',KUBECONFIG:'/private/dev'}, {JOB_NAME:'gromesh-gateway/gromesh-dev/gromesh-deploy',BUILD_NUMBER:'1',BUILD_URL:'https://jenkins.grometis.com/job/x/1/',GROMESH_PIPELINE_SHA:'a'.repeat(40),GROMESH_DEV_PLAN_KUBECONFIG:'/private/dev',GH_TOKEN:'unrelated'});
 assert.equal(e.BUILD_NUMBER,'1');assert.equal(e.GROMESH_PIPELINE_SHA,'a'.repeat(40));assert.equal(e.GH_TOKEN,undefined);
});
