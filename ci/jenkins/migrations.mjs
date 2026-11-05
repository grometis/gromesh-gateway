import { readFile,readdir,lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export async function inventoryMigrations(root,ledger){
 const bytes=await readFile(join(root,'meta/_journal.json'));const journal=JSON.parse(bytes);
 if(!Array.isArray(journal.entries)||!journal.entries.length)throw new Error('Migration journal missing');
 const names=new Set(),files=[];
 for(const [index,entry] of journal.entries.entries()){
  if(entry.idx!==index||!/^\d{4}_[a-z0-9_]+$/.test(entry.tag)||names.has(entry.tag))throw new Error('Invalid migration journal sequence');
  names.add(entry.tag);const name=entry.tag+'.sql',path=join(root,name),s=await lstat(path);
  if(!s.isFile()||s.isSymbolicLink()||s.size>8*1024*1024)throw new Error('Invalid migration SQL');
  const sql=await readFile(path);files.push({name,sha256:createHash('sha256').update(sql).digest('hex'),journalTime:entry.when,
   classification:/\b(drop|truncate|delete)\b/i.test(sql.toString())?'DESTRUCTIVE_CANDIDATE_REQUIRES_REVIEW':'REQUIRES_SCHEMA_COMPATIBILITY_REVIEW'});
 }
 if((await readdir(root)).filter(n=>n.endsWith('.sql')).some(n=>!files.some(f=>f.name===n)))throw new Error('SQL missing from journal');
 const journalHash=createHash('sha256').update(bytes).digest('hex');
 if(!ledger)return {status:'UNKNOWN_LIVE_SCHEMA',liveSchemaVerified:false,journalHash,files,pending:null};
 // ledger is collected by the protected read-only DB adapter, not a parameter or candidate artifact.
 if(ledger.verified!==true||ledger.source!=='authenticated-plan-identity'||!Array.isArray(ledger.files)||ledger.files.length>files.length)throw new Error('Unverified migration history');
 for(const [i,file] of ledger.files.entries())if(file.name!==files[i].name||file.sha256!==files[i].sha256)throw new Error('Modified or divergent migration history');
 const pending=files.slice(ledger.files.length);
 return {status:pending.length?'PENDING_MIGRATIONS':'NO_PENDING_MIGRATIONS',liveSchemaVerified:true,journalHash,files,pending};
}
