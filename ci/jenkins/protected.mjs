import { lstat,readFile,readdir,realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSha } from './policy.mjs';
const refuse=()=>{throw new Error('Protected runtime/configuration/credential required');};
export async function protectedFile(path){
 const s=await lstat(path),parent=await lstat(dirname(path));
 if(!s.isFile()||s.uid!==0||(s.mode&0o022)!==0||s.size>2*1024*1024||parent.uid!==0||(parent.mode&0o022)!==0||await realpath(path)!==path)refuse();
 return s;
}
async function protectedTree(path){
 const s=await lstat(path);if(s.uid!==0||(s.mode&0o022)!==0||s.isSymbolicLink())refuse();
 if(s.isDirectory())for(const name of await readdir(path))await protectedTree(join(path,name));else if(!s.isFile())refuse();
}
export async function runtimeConfig(name,role){
 if(!/^[a-z-]+\.json$/.test(name)||dirname(fileURLToPath(import.meta.url))!=='/opt/gromesh/jenkins'||!process.getuid||process.getuid()<1000)refuse();
 await protectedTree('/opt/gromesh/jenkins');
 await protectedFile('/etc/gromesh-jenkins/'+name);
 const config=JSON.parse(await readFile('/etc/gromesh-jenkins/'+name,'utf8'));
 const revision=JSON.parse(await readFile('/opt/gromesh/jenkins/revision.json','utf8'));
 const url='https://jenkins.grometis.com'+(process.env.JOB_NAME??'').split('/').map(n=>'/job/'+n).join('')+'/'+process.env.BUILD_NUMBER+'/';
 if(config.enabled!==true||config.role!==role||config.hostname!==hostname()||!isSha(revision.sha)||revision.sha!==config.pipelineSha||revision.sha!==process.env.GROMESH_PIPELINE_SHA
  ||!config.allowedJobs?.includes(process.env.JOB_NAME)||!/^[1-9][0-9]*$/.test(process.env.BUILD_NUMBER??'')||process.env.BUILD_URL!==url)refuse();
 return config;
}
export async function privateCredential(path){
 const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0||s.size>65536)refuse();
 return readFile(path);
}
