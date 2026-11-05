import test from 'node:test';
import assert from 'node:assert/strict';
import { kongCandidateRequired } from './kong-candidate.mjs';
test('PR Kong candidate reproduces all existing path triggers and never grants publication trust',()=>{
 for(const path of ['images/kong/Dockerfile','.github/workflows/kong-image.yml','.github/workflows/kong-image-build.yml','.github/workflows/kong-image-candidate.yml'])assert.equal(kongCandidateRequired('pull_request',[path]),true);
 assert.equal(kongCandidateRequired('pull_request',['apps/ui/src/App.tsx']),false);assert.equal(kongCandidateRequired('push',['images/kong/Dockerfile']),false);
});
