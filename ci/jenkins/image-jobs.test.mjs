import test from 'node:test';
import assert from 'node:assert/strict';
import { imageJobDefinition,renderJobXml } from './jobs.mjs';
test('publisher job uses a separate credential folder and stays disabled',()=>{
 const xml=renderJobXml(imageJobDefinition('a'.repeat(40)));assert.match(xml,/<disabled>true<\/disabled>/);assert.match(xml,/<scriptPath>Jenkinsfile.images<\/scriptPath>/);assert.throws(()=>imageJobDefinition('main'));
});
