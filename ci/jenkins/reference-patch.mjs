import { assertDeployableRelease,verifyEnvelope } from './release.mjs';
import { resolveHubDigest } from './hub.mjs';
import { canonicalHash,isSha,isDigest } from './policy.mjs';
export const referenceFiles=Object.freeze(['deploy/helm/control-plane/values.yaml','deploy/helm/data-plane/values.yaml','deploy/compose/docker-compose.yml','e2e/security-checklist.md','e2e/kind/run.sh','scripts/bump-image-digests.mjs']);
export async function prepareReferenceEdits(envelope,key,files,{lookup=resolveHubDigest}={}){
 const release=assertDeployableRelease(verifyEnvelope(envelope,{...key,purpose:'release'}));
 if(!isSha(release.source?.sha)||!Array.isArray(release.artifacts)||release.artifacts.length!==4||!(files instanceof Map)||referenceFiles.some(p=>typeof files.get(p)!=='string'))throw Error('Complete signed release and source files required');
 const images=new Map();
 for(const component of ['control-plane','ui','agent','kong']){
  const matches=release.artifacts.filter(a=>a.component===component),a=matches[0];
  if(matches.length!==1||!isDigest(a?.indexDigest)||await lookup(component,a.indexDigest)!==a.indexDigest||await lookup(component,'sha-'+release.source.sha)!==a.indexDigest)throw Error('Real registry readback for each exact release digest/tag required');
  images.set(component,{repository:'docker.io/fabriciobackend/gromesh-'+component,digest:a.indexDigest,tag:'sha-'+release.source.sha});
 }
 const edits=[];
 for(const path of referenceFiles){
  const before=files.get(path);let after=before;
  for(const [component,image]of images){
   const block=new RegExp('^(\\s*)repository: (?:ghcr\\.io/grometis|docker\\.io/fabriciobackend)/gromesh-'+component+'\\n((?:\\s*#.*\\n)*)(\\s*)tag: "[^"\\n]*"\\n((?:\\s*#.*\\n)*)(\\s*)digest: "sha256:[a-f0-9]{64}"','gm');
   after=after.replace(block,(_match,i1,c1,i2,c2,i3)=>`${i1}repository: ${image.repository}\n${c1}${i2}tag: "${image.tag}"\n${c2}${i3}digest: "${image.digest}"`);
   after=after.replaceAll(new RegExp('(?:ghcr\\.io/grometis|docker\\.io/fabriciobackend)/gromesh-'+component+'@sha256:[a-f0-9]{64}','g'),image.repository+'@'+image.digest);
   after=after.replaceAll(new RegExp('(?:ghcr\\.io/grometis|docker\\.io/fabriciobackend)/gromesh-'+component+':[A-Za-z0-9._-]+','g'),image.repository+':'+image.tag);
  }
  if(path==='scripts/bump-image-digests.mjs')after=after.replace('const REGISTRY = "ghcr.io/grometis";','const REGISTRY = "docker.io/fabriciobackend";');
  if(after!==before)edits.push({path,beforeHash:canonicalHash(before),afterHash:canonicalHash(after),after});
 }
 return {schema:'gromesh-reference-edits/v1',sourceSha:release.source.sha,releaseHash:canonicalHash(envelope),edits,writesPerformed:false,requiresIndependentPrReview:true};
}
