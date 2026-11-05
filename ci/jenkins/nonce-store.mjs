import { lstat,readdir,open,realpath } from 'node:fs/promises';
import { join } from 'node:path';
export class NonceStore {
 constructor(directory){this.directory=directory;}
 async validate(){const s=await lstat(this.directory);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0||await realpath(this.directory)!==this.directory)throw new Error('Private provisioned durable nonce directory required');}
 async read(){await this.validate();return new Set((await readdir(this.directory)).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>n.slice(0,-5)));}
 async reserve(nonce,planHash){
  if(!/^[a-f0-9]{32}$/.test(nonce??'')||!/^[a-f0-9]{64}$/.test(planHash??''))throw new Error('Exact nonce/plan hash required');await this.validate();
  const file=await open(join(this.directory,nonce+'.json'),'wx',0o600);
  try{await file.writeFile(JSON.stringify({nonce,planHash,reservedAt:new Date().toISOString()})+'\n');await file.sync();}finally{await file.close();}
  const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}
 }
}
