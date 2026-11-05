import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm,realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { imageWorkspace } from './workspaces.mjs';
test('repeated builds and a retry after partial failure use independent private directories preserving earlier files',async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'j5-workspaces-')));
 try{const one=await imageWorkspace('17',{base});await writeFile(join(one,'partial.oci.tar'),'preserve');const two=await imageWorkspace('18',{base});assert.notEqual(one,two);assert.equal(await readFile(join(one,'partial.oci.tar'),'utf8'),'preserve');assert.equal(await imageWorkspace('18',{base}),two);await assert.rejects(imageWorkspace('../17',{base}));}
 finally{await rm(base,{recursive:true,force:true});}
});
