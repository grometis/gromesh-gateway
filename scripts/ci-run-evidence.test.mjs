import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runEvidence } from './ci-run-evidence.mjs';

for (const exit of [0, 1, 7]) {
  test(`measures a real shell command exiting ${exit} and its duration`, t => {
    const temp = mkdtempSync(join(realpathSync(tmpdir()), 'command-evidence-'));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const file = join(temp, 'report.json');
    const status = runEvidence('sh', ['-c', `exit ${exit}`], { file });
    const report = JSON.parse(readFileSync(file));
    assert.equal(status, exit === 0 ? 0 : 1);
    assert.equal(report.countUnit, 'commands');
    assert.deepEqual({ ...report.stats, duration: 0 }, { expected: exit === 0 ? 1 : 0, unexpected: exit === 0 ? 0 : 1,
      skipped: 0, flaky: 0, duration: 0 });
    assert.ok(Number.isInteger(report.stats.duration) && report.stats.duration >= 0);
    assert.throws(() => runEvidence('sh', ['-c', 'exit 0'], { file }));
  });
}

test('does not count a command that failed to spawn', t => {
  const temp = mkdtempSync(join(realpathSync(tmpdir()), 'command-evidence-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const file = join(temp, 'report.json');
  assert.equal(runEvidence('/nonexistent-ci-command', [], { file }), 1);
  assert.equal(JSON.parse(readFileSync(file)).stats.unexpected, 0);
});
