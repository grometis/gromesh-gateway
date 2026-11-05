import test from 'node:test';import assert from 'node:assert/strict';
import {assertImageToolchain} from './image-toolchain.mjs';
const versions={syft:'Application: syft\nVersion: 1.18.1\n',trivy:'Version: 0.69.3\n',buildx:'github.com/docker/buildx v0.25.0 abc'};
test('native scanner accepts exactly the installable reviewed toolchain',()=>{assert.equal(assertImageToolchain(versions),true);});
test('legacy unavailable Trivy binary and unreviewed scanner versions are refused',()=>{for(const v of ['Version: 0.58.1','Version: 0.69.4','Version: 0.74.0'])assert.throws(()=>assertImageToolchain({...versions,trivy:v}),/toolchain/i);});
test('builder and SBOM versions remain pinned independently of scanner correction',()=>{assert.throws(()=>assertImageToolchain({...versions,buildx:'v0.31.1'}),/toolchain/i);assert.throws(()=>assertImageToolchain({...versions,syft:'Version: 1.20.0'}),/toolchain/i);});
