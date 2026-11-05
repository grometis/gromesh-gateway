import {isIP} from 'node:net';
const refuse=s=>{throw new Error('Provisioning refused: '+s);};
const publicCidr=s=>{if(typeof s!=='string'||!s.endsWith('/32'))return false;const ip=s.slice(0,-3);if(isIP(ip)!==4)return false;const [a,b]=ip.split('.').map(Number);return a>0&&a<224&&a!==10&&a!==127&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&!(a===169&&b===254)&&!(a===100&&b>=64&&b<=127);};
const types={'pr-amd64':['BASIC3-X8C-32G','amd64',8,32768],'pr-arm64':['BASIC2-A8C-32G','arm64',8,32768],coordinator:['DEV1-S','amd64',2,2048]};
export function validateProposal(p){
 if(p?.schema!=='gromesh-worker-proposal/v1'||p.provider!=='scaleway'||p.zone!=='fr-par-2'||!/^gromesh-j8-[a-z0-9]{8,24}$/.test(p.generation??'')||!/^[a-f0-9-]{36}$/.test(p.projectId??'')||!/^[a-f0-9]{40}$/.test(p.pipelineSha??'')||p.approved!==false||!publicCidr(p.operatorCidr)||!Array.isArray(p.nodes)||p.nodes.length!==3)refuse('identity/region/approval');
 const seen=new Set();for(const n of p.nodes){const t=types[n.role];if(!t||seen.has(n.role)||n.type!==t[0]||n.architecture!==t[1]||n.cpus!==t[2]||n.memoryMiB!==t[3]||n.bootGB!==35||n.dataGB!==(n.role==='coordinator'?35:216)||n.executors!==1)refuse('native capacity/disk/role');seen.add(n.role);}
 if(p.publicSsh!==false||p.publicRemoting!==false||p.projectQuotaGiB!==150||p.workMount!=='/opt'||!Array.isArray(p.credentials)||p.credentials.length||p.reset!=='new-generation-and-disks'||p.n2Allowed!==false||p.storage?.enabled!==false||![100,250,500].includes(p.storage.budgetGiB))refuse('isolation/credentials/storage');
 return {paidResourceCreationAuthorized:false,runtimeQualified:false,architectures:['amd64','arm64'],nodes:p.nodes.length};
}
export function admitArtifactBytes(p){
 if(!p||![100,250,500].includes(p.budgetGiB)||!['usedBytes','reservedBytes','incomingBytes','requiredEvidenceBytes'].every(k=>Number.isSafeInteger(p[k])&&p[k]>=0))throw Error('Artifact capacity refused');
 const total=p.usedBytes+p.reservedBytes+p.incomingBytes+p.requiredEvidenceBytes;if(!Number.isSafeInteger(total)||total>p.budgetGiB*2**30)throw Error('Artifact capacity refused: authorized budget exceeded; preserve mandatory evidence');return {admitted:true,totalBytes:total,runtimeQuotaEnforced:false};
}
export function validatePeers(peers,role){
 const addresses={controller:'10.89.0.2/32',coordinator:'10.89.0.1/32','pr-amd64':'10.89.0.11/32','pr-arm64':'10.89.0.12/32'};
 if(!Array.isArray(peers)||!['coordinator','pr-amd64','pr-arm64'].includes(role)||peers.length>3)refuse('peers');const seen=new Set(),keys=new Set();
 for(const p of peers){if(!p||Object.keys(p).sort().join(',')!=='allowedIp,publicKey,role'||p.role===role||!addresses[p.role]||p.allowedIp!==addresses[p.role]||typeof p.publicKey!=='string'||!(/^[A-Za-z0-9+/]{43}=$/.test(p.publicKey))||Buffer.from(p.publicKey,'base64').length!==32||seen.has(p.role)||keys.has(p.publicKey)||role!=='coordinator'&&p.role!=='coordinator')refuse('peer identity/key/route');seen.add(p.role);keys.add(p.publicKey);}
 return peers;
}
export function shutdownPlan(p){
 if(!/^gromesh-j8-[a-z0-9]{8,24}$/.test(p?.generation??'')||p.evidenceArchived!==true||p.queueEmpty!==true||!Array.isArray(p.serverIds)||!p.serverIds.length||new Set(p.serverIds).size!==p.serverIds.length||p.serverIds.some(x=>!/^fr-par-2\/[a-f0-9-]{36}$/.test(x)))refuse('exact-ID shutdown authorization');
 return {execute:false,destroyAllowed:false,serverIds:p.serverIds,steps:['AUTHORIZE_EXACT_IDS_AND_UNPROTECT','POWER_OFF_OWN_INSTANCES','VERIFY_STOPPED_AND_STORAGE_IP_BILLING','RESTORE_PROTECTION'],resetTrust:false};
}
