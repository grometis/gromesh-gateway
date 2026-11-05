import { spawn } from 'node:child_process';
import { mkdir, writeFile,readFile,lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredStages } from './policy.mjs';
import { sanitize,collectEvidence } from './evidence.mjs';

export async function runCommand(argv, { cwd, env = process.env, signal, timeoutMs = 3600000, terminationGraceMs = 5000,output,redactions=[] } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(s => typeof s !== 'string' || s.includes('\0'))) throw new Error('Invalid command argv');
  if (signal?.aborted) return { status: 'ABORTED', exitCode: null, durationMs: 0, started: false };
  const start = Date.now();
  if(output)await mkdir(output,{recursive:true,mode:0o700});
  return new Promise(resolve => {
    // A nested executor must stay in the outer supervisor's private process group.
    // Otherwise the outer KILL can remove the inner supervisor before it kills its own group.
    const inheritedGroup=process.env.GROMESH_COMMAND_GROUP_MEMBER==='1';
    const child = spawn(argv[0], argv.slice(1), { cwd, env:{...env,GROMESH_COMMAND_GROUP_MEMBER:'1'}, detached:!inheritedGroup, stdio: output?['ignore','pipe','pipe']:'ignore' });
    const streams={stdout:[],stderr:[]},sizes={stdout:0,stderr:0};let outputTruncated=false;
    if(output)for(const key of ['stdout','stderr'])child[key].on('data',chunk=>{const room=2*1024*1024-sizes[key];if(chunk.length>room)outputTruncated=true;if(room>0){streams[key].push(chunk.subarray(0,room));sizes[key]+=Math.min(chunk.length,room);}});
    let reason = null, cleanup = null, settled = false;
    const terminate = why => {
      if (reason || settled) return;
      reason = why;
      try { inheritedGroup?child.kill('SIGTERM'):process.kill(-child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') reason = 'FAILURE'; }
      cleanup = new Promise(done => setTimeout(() => {
        try { inheritedGroup?child.kill('SIGKILL'):process.kill(-child.pid, 'SIGKILL'); } catch { /* Private group already exited. */ }
        done();
      }, terminationGraceMs));
    };
    const abort = () => terminate('ABORTED');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => terminate('TIMED_OUT'), timeoutMs);
    const finish = async exitCode => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (cleanup) await cleanup;
      let outputFailure=false;
      try {
      const runtimeSecrets=[];
      if(env.GROMESH_CI_STATE){try{const file=join(env.GROMESH_CI_STATE,'redactions.txt'),s=await lstat(file);if(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size<=65536)runtimeSecrets.push(...(await readFile(file,'utf8')).split('\n').filter(Boolean));}catch{}}
      if(output)for(const key of ['stdout','stderr']){
        let raw=Buffer.concat(streams[key]).toString('utf8');if(outputTruncated)raw=raw.slice(0,raw.lastIndexOf('\n')+1);
        const secrets=[...redactions,...runtimeSecrets,...Object.entries(env).filter(([k])=>/password|secret|token|authorization|cookie|encryption|fingerprint/i.test(k)).map(([,v])=>v)];
        await writeFile(join(output,key+'.log'),sanitize(raw,secrets),{mode:0o600});
      }
      }catch{outputFailure=true;}
      resolve({ status: outputFailure?'FAILURE':reason ?? (exitCode === 0 ? 'SUCCESS' : 'FAILURE'), exitCode, durationMs: Date.now() - start, started: Boolean(child.pid),...(output?{outputTruncated,outputFailure}:{}) });
    };
    child.once('error', () => finish(null));
    child.once('close', code => finish(code));
  });
}

export async function runStage(id, { cwd, output, env, signal, timeoutMs } = {}) {
  if (!requiredStages.includes(id)) throw new Error('Unknown CI stage');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const script = fileURLToPath(new URL(`./stages/${id}.sh`, import.meta.url));
  const stageOutput=join(output,id);
  const result = await runCommand(['/bin/bash', script], { cwd, env, signal, timeoutMs,output:stageOutput });
  const evidence=await collectEvidence({id,output:stageOutput,cwd,execution:result});
  const report = { id, ...result, ...evidence };
  await writeFile(join(output, `${id}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
}
