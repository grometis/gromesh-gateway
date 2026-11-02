import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { requireValid } from './ci-evidence.mjs';

// Counts are command outcomes, explicitly distinguished from assertion/test counts.
export function runEvidence(command, args, { file, execute = spawnSync, now = () => performance.now() } = {}) {
  const start = now();
  const result = execute(command, args, { stdio: 'inherit' });
  const success = result.status === 0;
  const duration = Math.round(now() - start);
  writeFileSync(file, JSON.stringify({ countUnit: 'commands', stats: {
    expected: success ? 1 : 0, unexpected: result.error ? 0 : success ? 0 : 1, skipped: 0, flaky: 0, duration,
  } }), { flag: 'wx', mode: 0o600 });
  return success ? 0 : 1;
}
if (import.meta.main) {
  try {
    const [file, command, ...args] = process.argv.slice(2);
    requireValid(file && command);
    process.exitCode = runEvidence(command, args, { file });
  } catch { console.error('CI evidence rejected.'); process.exitCode = 1; }
}
