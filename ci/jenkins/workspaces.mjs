import { mkdir,lstat,realpath,chmod } from 'node:fs/promises';
import { join } from 'node:path';
export async function imageWorkspace(buildId,{base='/workspace/builds'}={}){
 if(!/^[1-9][0-9]*$/.test(buildId??''))throw new Error('Exact image build workspace required');
 await mkdir(base,{recursive:true,mode:0o700});
 const parent=await lstat(base);
 if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid()||await realpath(base)!==base||(parent.mode&0o022)!==0)throw new Error('Private dedicated workspace parent required');
 const path=join(base,buildId);await mkdir(path,{mode:0o700,recursive:true});
 const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||await realpath(path)!==path)throw new Error('Private per-build workspace required');
 await chmod(path,0o700);return path;
}
