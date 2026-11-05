import { open,lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { hashVerifiedBlob,verifyOciGraph,byteDigest } from './registry.mjs';
const refuse=reason=>{throw new Error(`OCI archive refused: ${reason}`);};
async function read(handle,offset,length){const b=Buffer.alloc(length);let got=0;while(got<length){const r=await handle.read(b,got,length-got,offset+got);if(!r.bytesRead)refuse('truncated tar');got+=r.bytesRead;}return b;}
const octal=b=>{const value=b.toString('ascii').replace(/\0.*$/,'').trim();if(!/^[0-7]+$/.test(value))refuse('tar numeric field');return parseInt(value,8);};
const text=b=>b.toString('ascii').replace(/\0.*$/,'');
async function* chunks(handle,offset,size){for(let n=0;n<size;n+=65536)yield await read(handle,offset+n,Math.min(65536,size-n));}
export async function readOciArchive(path,{sha,platforms}){
 const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>20*2**30)refuse('regular bounded archive required');
 const handle=await open(path,'r');const entries=new Map(),blobs=new Map();let position=0,ended=false;
 try{
  while(position+1024<=info.size){
   const h=await read(handle,position,512);
   if(h.every(b=>b===0)){const rest=await read(handle,position+512,512);if(!rest.every(b=>b===0))refuse('tar terminator');ended=true;break;}
   const expected=octal(h.subarray(148,156)),copy=Buffer.from(h);copy.fill(32,148,156);if([...copy].reduce((a,b)=>a+b,0)!==expected)refuse('header checksum');
   const name=text(h.subarray(0,100)),prefix=text(h.subarray(345,500)),type=h[156],size=octal(h.subarray(124,136));
   if(prefix||entries.has(name)||!['index.json','oci-layout','blobs','blobs/','blobs/sha256','blobs/sha256/'].includes(name)&&!/^blobs\/sha256\/[a-f0-9]{64}$/.test(name))refuse('tar path/duplicate');
   if(![0,48,53].includes(type)||type===53&&size!==0||position+512+size>info.size)refuse('tar entry type/size');
   if(entries.size>10000)refuse('tar entry count');
   const offset=position+512;
   if(type!==53){const proof=await hashVerifiedBlob(chunks(handle,offset,size));if(name.startsWith('blobs/sha256/')&&proof.digest!=='sha256:'+name.slice(13))refuse('blob filename hash');
    entries.set(name,{offset,size,proof});if(name.startsWith('blobs/sha256/'))blobs.set(proof.digest,proof);
   }
   position+=512+Math.ceil(size/512)*512;
  }
  if(!ended||!entries.has('index.json')||!entries.has('oci-layout'))refuse('OCI layout entries');
  let metadataBytes=0;
  const metadata=async name=>{const entry=entries.get(name);if(!entry||entry.size>1024*1024||(metadataBytes+=entry.size)>16*1024*1024)refuse('metadata budget');return read(handle,entry.offset,entry.size);};
  const layout=JSON.parse((await metadata('oci-layout')).toString());if(layout.imageLayoutVersion!=='1.0.0')refuse('OCI layout version');
  const catalogRaw=await metadata('index.json'),catalog=JSON.parse(catalogRaw.toString());
  if(!Array.isArray(catalog.manifests)||catalog.manifests.length!==1)refuse('one explicitly selected OCI catalog root required');
  const load=async descriptor=>{
   if(!/^sha256:[a-f0-9]{64}$/.test(descriptor?.digest??''))refuse('root/blob descriptor');
   const b=await metadata('blobs/sha256/'+descriptor.digest.slice(7));
   if(byteDigest(b)!==descriptor.digest||b.length!==descriptor.size)refuse('root/blob digest');
   blobs.set(descriptor.digest,b);return JSON.parse(b.toString());
  };
  let descriptor=catalog.manifests[0],root=await load(descriptor),raw=blobs.get(descriptor.digest);
  const selectedDescriptor=descriptor,selectedRaw=raw;
  // A catalog may select an index; resolve bounded, single-root nested indexes until platform entries appear.
  let depth=0;
  while(descriptor.mediaType==='application/vnd.oci.image.index.v1+json'&&root.manifests?.length===1&&root.manifests[0].mediaType==='application/vnd.oci.image.index.v1+json'){
   if(++depth>4)refuse('nested root depth');descriptor=root.manifests[0];root=await load(descriptor);raw=blobs.get(descriptor.digest);
  }
  let index=root;
  if(descriptor.mediaType==='application/vnd.oci.image.manifest.v1+json'){
   const config=await load(root.config);
   index={schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{...descriptor,platform:{os:config.os,architecture:config.architecture}}]};
  }else if(descriptor.mediaType!=='application/vnd.oci.image.index.v1+json')refuse('selected root type');
  if(!Array.isArray(index.manifests)||index.manifests.length>64)refuse('manifest budget');
  for(const d of index.manifests){const m=await load(d);await load(m.config);if(d.platform?.os==='unknown')for(const l of m.layers)await load(l);}
  const proof=verifyOciGraph({raw:Buffer.from(JSON.stringify(index)),blobs},{sha,platforms});
  proof.digest=byteDigest(selectedRaw);proof.rootMediaType=selectedDescriptor.mediaType;
  const archive=await hashVerifiedBlob(createReadStream(path,{start:0,end:info.size-1}));
  const final=await lstat(path);if(final.ino!==info.ino||final.size!==info.size||final.mtimeMs!==info.mtimeMs)refuse('archive changed during verification');
  return {path,raw:selectedRaw,index,catalog,catalogRaw,entries,proof,archiveHash:archive.digest};
 }finally{await handle.close();}
}
function header(name,size){
 const h=Buffer.alloc(512);h.write(name);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(size.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h[156]=48;h.write('ustar\0',257);h.write('00',263);h.write([...h].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);return h;
}
export async function mergeNativeArchives(paths,destination,{sha}){
 if(paths.length!==2||paths.includes(destination))refuse('two separate native archives required');
 const inputs=[];for(const [i,path] of paths.entries())inputs.push(await readOciArchive(path,{sha,platforms:[i===0?'linux/amd64':'linux/arm64']}));
 const index={schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:inputs.flatMap(i=>i.index.manifests)};
 const output=await open(destination,'wx',0o600);
 try{
  const write=async b=>{let p=0;while(p<b.length)p+=(await output.write(b,p,b.length-p)).bytesWritten;};
  const entry=async(name,data)=>{await write(header(name,data.length));await write(data);await write(Buffer.alloc((512-data.length%512)%512));};
  const rootBytes=Buffer.from(JSON.stringify(index)),rootDigest=byteDigest(rootBytes);
  const catalog={schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{mediaType:index.mediaType,digest:rootDigest,size:rootBytes.length,annotations:{'org.opencontainers.image.ref.name':'sha-'+sha}}]};
  await entry('index.json',Buffer.from(JSON.stringify(catalog)));await entry('oci-layout',Buffer.from('{"imageLayoutVersion":"1.0.0"}'));
  await entry('blobs/sha256/'+rootDigest.slice(7),rootBytes);
  const written=new Set(['blobs/sha256/'+rootDigest.slice(7)]);
  for(const input of inputs){const h=await open(input.path,'r');try{for(const [name,e] of input.entries){if(!name.startsWith('blobs/sha256/')||written.has(name))continue;
   written.add(name);await write(header(name,e.size));for await(const b of chunks(h,e.offset,e.size))await write(b);await write(Buffer.alloc((512-e.size%512)%512));
  }}finally{await h.close();}}
  await write(Buffer.alloc(1024));await output.sync();
 }finally{await output.close();}
 return readOciArchive(destination,{sha,platforms:['linux/amd64','linux/arm64']});
}
