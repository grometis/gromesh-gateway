import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readOciArchive,mergeNativeArchives } from './oci-archive.mjs';
const sha='a'.repeat(40),digest=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
function archive(architecture,unsafe=false){
 const entries=new Map(),add=o=>{const bytes=Buffer.from(JSON.stringify(o)),d={digest:digest(bytes),size:bytes.length};entries.set('blobs/sha256/'+d.digest.slice(7),bytes);return d;};
 const config=add({architecture,os:'linux',config:{Labels:{'org.opencontainers.image.revision':sha,'org.opencontainers.image.source':'https://github.com/grometis/gromesh-gateway'}}}),layer=add({fixture:'layer'});
 const manifest=add({schemaVersion:2,config,layers:[layer]});
 const attestation=add({_type:'https://in-toto.io/Statement/v1',subject:[{name:'gromesh-fixture',digest:{sha256:manifest.digest.slice(7)}}],predicateType:'https://slsa.dev/provenance/v0.2',predicate:{}});
 const attestationManifest=add({schemaVersion:2,config:add({architecture:'unknown',os:'unknown'}),layers:[attestation]});
 const root=add({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{...manifest,mediaType:'application/vnd.oci.image.manifest.v1+json',platform:{architecture,os:'linux'}},{...attestationManifest,mediaType:'application/vnd.oci.image.manifest.v1+json',platform:{os:'unknown',architecture:'unknown'},annotations:{'vnd.docker.reference.type':'attestation-manifest','vnd.docker.reference.digest':manifest.digest}}]});
 entries.set('index.json',Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{...root,mediaType:'application/vnd.oci.image.index.v1+json',annotations:{'org.opencontainers.image.ref.name':'fixture'}}]})));
 entries.set('oci-layout',Buffer.from('{"imageLayoutVersion":"1.0.0"}'));if(unsafe)entries.set('../escape',Buffer.from('bad'));
 const chunks=[];for(const [name,b] of entries){const h=Buffer.alloc(512);h.write(name);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(b.length.toString(8).padStart(11,'0')+'\0',124);h.fill(32,148,156);h[156]=48;h.write('ustar\0',257);h.write([...h].reduce((a,c)=>a+c,0).toString(8).padStart(6,'0')+'\0 ',148);chunks.push(h,b,Buffer.alloc((512-b.length%512)%512));}chunks.push(Buffer.alloc(1024));return Buffer.concat(chunks);
}
test('reads real OCI tar bytes and combines native manifests without rebuilding or changing layers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'j5-oci-'));
 try{for(const arch of ['amd64','arm64'])await writeFile(join(dir,arch+'.tar'),archive(arch));
  const a=await readOciArchive(join(dir,'amd64.tar'),{sha,platforms:['linux/amd64']});assert.equal(a.proof.platforms[0],'linux/amd64');
  const merged=await mergeNativeArchives([join(dir,'amd64.tar'),join(dir,'arm64.tar')],join(dir,'merged.tar'),{sha});
  assert.deepEqual(merged.proof.platforms,['linux/amd64','linux/arm64']);assert.equal(merged.proof.verifiedGraph,true);
  assert.equal(merged.catalog.manifests.length,1);assert.equal(merged.catalog.manifests[0].digest,merged.proof.digest);assert.notEqual(digest(merged.catalogRaw),merged.proof.digest);
  const bad=archive('amd64');bad[600]^=1;await writeFile(join(dir,'bad.tar'),bad);await assert.rejects(readOciArchive(join(dir,'bad.tar'),{sha,platforms:['linux/amd64']}));
  await writeFile(join(dir,'escape.tar'),archive('amd64',true));await assert.rejects(readOciArchive(join(dir,'escape.tar'),{sha,platforms:['linux/amd64']}),/path/i);
 }finally{await rm(dir,{recursive:true,force:true});}
});
