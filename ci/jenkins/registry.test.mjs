import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyOciGraph,hubReference,pushArguments } from './registry.mjs';
const digest=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
function fixture(){
 const blobs=new Map();const add=o=>{const b=Buffer.from(JSON.stringify(o));const d={digest:digest(b),size:b.length};blobs.set(d.digest,b);return d;};
 const manifests=['amd64','arm64'].map(architecture=>{const config=add({architecture,os:'linux',config:{Labels:{'org.opencontainers.image.revision':'a'.repeat(40),'org.opencontainers.image.source':'https://github.com/grometis/gromesh-gateway'}}});const layer=add({bytes:'layer'});return {...add({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config,layers:[layer]}),mediaType:'application/vnd.oci.image.manifest.v1+json',platform:{os:'linux',architecture}};});
 const raw=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests}));return {raw,blobs};
}
test('verifies the actual OCI manifest/config/layer bytes for both native architectures',()=>{
 const f=fixture();const out=verifyOciGraph(f,{sha:'a'.repeat(40),platforms:['linux/amd64','linux/arm64']});assert.equal(out.digest,digest(f.raw));assert.equal(out.platforms.length,2);
});
for(const [name,alter] of [['corrupted blob',f=>{const k=f.blobs.keys().next().value;f.blobs.set(k,Buffer.from('tampered'));}],['missing layer',f=>f.blobs.delete([...f.blobs.keys()][1])],['platform spoof',f=>{const i=JSON.parse(f.raw);i.manifests[0].platform.architecture='arm64';f.raw=Buffer.from(JSON.stringify(i));}]])test(`OCI refuses ${name}`,()=>assert.throws(()=>verifyOciGraph(alterFixture(alter),{sha:'a'.repeat(40),platforms:['linux/amd64','linux/arm64']})));
function alterFixture(alter){const f=fixture();alter(f);return f;}
test('all official references use the authorized public namespace and immutable SHA tags',()=>{
 assert.equal(hubReference('ui','a'.repeat(40)),'docker.io/fabriciobackend/gromesh-ui:sha-'+ 'a'.repeat(40));
 for(const x of ['other','ui;echo','../ui'])assert.throws(()=>hubReference(x,'a'.repeat(40)));
 assert.throws(()=>hubReference('ui','latest'));
 const args=pushArguments({component:'ui',sha:'a'.repeat(40),archive:'/workspace/artifact.oci.tar',authfile:'/run/secrets/hub.json'});
 assert.equal(args[0],'copy');assert.ok(args.includes('--preserve-digests'));assert.ok(args.includes('--all'));assert.ok(!args.includes('--dest-tls-verify=false'));
});
