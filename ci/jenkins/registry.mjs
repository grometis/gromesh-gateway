import { createHash } from 'node:crypto';
import { isSha,isDigest,canonicalJson } from './policy.mjs';
const refuse=reason=>{throw new Error(`OCI refused: ${reason}`);};
export const byteDigest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const components=['control-plane','ui','agent','kong'];
const streamedBlobs=new WeakSet();
export async function hashVerifiedBlob(chunks){
 const hash=createHash('sha256');let size=0;for await(const b of chunks){if(!Buffer.isBuffer(b))refuse('blob stream');size+=b.length;hash.update(b);}
 const proof={digest:'sha256:'+hash.digest('hex'),size};streamedBlobs.add(proof);return proof;
}
export function hubReference(component,sha,publication){
 if(!components.includes(component)||!isSha(sha))refuse('authorized component/full source SHA');
 if(publication&&(!['CANDIDATE','OFFICIAL'].includes(publication.class)||publication.class==='CANDIDATE'&&!/^[1-9][0-9]*$/.test(publication.buildId??'')))refuse('publication class/build');
 const tag=publication?.class==='CANDIDATE'?`ci-${sha}-${publication.buildId}`:`sha-${sha}`;
 return `docker.io/fabriciobackend/gromesh-${component}:${tag}`;
}
export function pushArguments({component,sha,archive,authfile,publication}){
 if(!/^\/workspace\/[a-zA-Z0-9._/-]+\.oci\.tar$/.test(archive)||archive.includes('..')
  ||!(authfile==='/run/secrets/hub.json'||/^\/workspace\/builds\/[1-9][0-9]*@tmp\/secretFiles\/[a-zA-Z0-9-]+\/[A-Za-z0-9._-]+$/.test(authfile)))refuse('publisher paths');
 return ['copy','--all','--preserve-digests','--authfile',authfile,`oci-archive:${archive}`,`docker://${hubReference(component,sha,publication)}`];
}
export function verifyOciGraph({raw,blobs},{sha,platforms}){
 if(!isSha(sha)||!Buffer.isBuffer(raw)||!(blobs instanceof Map)||raw.length>1024*1024)refuse('graph input');
 const parse=b=>{if(!Buffer.isBuffer(b))refuse('bounded JSON bytes required');try{return JSON.parse(b.toString('utf8'));}catch{refuse('invalid JSON');}};
 const blob=descriptor=>{
  if(!descriptor||!isDigest(descriptor.digest)||!Number.isSafeInteger(descriptor.size)||descriptor.size<1)refuse('descriptor');
  const bytes=blobs.get(descriptor.digest);
  if(streamedBlobs.has(bytes)){if(bytes.size!==descriptor.size||bytes.digest!==descriptor.digest)refuse('streamed blob digest');return bytes;}
  if(!Buffer.isBuffer(bytes)||bytes.length!==descriptor.size||byteDigest(bytes)!==descriptor.digest)refuse('blob bytes/digest');
  return bytes;
 };
 const index=parse(raw);if(index.schemaVersion!==2||index.mediaType!=='application/vnd.oci.image.index.v1+json'||!Array.isArray(index.manifests))refuse('OCI index');
 const actual=[];const images=new Set(),imageProofs=[];
 for(const descriptor of index.manifests){
  if(descriptor.mediaType!=='application/vnd.oci.image.manifest.v1+json')refuse('manifest type');
  const manifest=parse(blob(descriptor));
  if(manifest.schemaVersion!==2||!Array.isArray(manifest.layers))refuse('manifest schema');
  const config=parse(blob(manifest.config));for(const layer of manifest.layers)blob(layer);
  const platform=`${descriptor.platform?.os}/${descriptor.platform?.architecture}`;
  if(platform==='unknown/unknown')continue; // validated below against a known image subject.
  if(config.os!==descriptor.platform?.os||config.architecture!==descriptor.platform?.architecture
    ||config.config?.Labels?.['org.opencontainers.image.revision']!==sha
    ||config.config?.Labels?.['org.opencontainers.image.source']!=='https://github.com/grometis/gromesh-gateway'
    ||actual.includes(platform))refuse('platform/config/source labels');
  actual.push(platform);images.add(descriptor.digest);
  imageProofs.push({platform,digest:descriptor.digest,configDigest:manifest.config.digest});
 }
 for(const d of index.manifests.filter(d=>d.platform?.os==='unknown'&&d.platform?.architecture==='unknown')){
  if(d.annotations?.['vnd.docker.reference.type']!=='attestation-manifest'||!images.has(d.annotations?.['vnd.docker.reference.digest']))refuse('unknown descriptor is not bound provenance');
  const m=parse(blob(d));if(!m.layers.length)refuse('empty provenance');
  for(const l of m.layers){const statement=parse(blob(l));if(statement._type!=='https://in-toto.io/Statement/v0.1'&&statement._type!=='https://in-toto.io/Statement/v1')refuse('provenance statement');
   if(!statement.subject?.some(s=>'sha256:'+s.digest?.sha256===d.annotations['vnd.docker.reference.digest']))refuse('provenance subject');}
 }
 if(canonicalJson(actual.sort())!==canonicalJson([...platforms].sort()))refuse('complete native platform matrix');
 return {digest:byteDigest(raw),platforms:actual,images:imageProofs,verifiedGraph:true};
}
