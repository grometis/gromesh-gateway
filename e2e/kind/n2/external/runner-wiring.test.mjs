import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { f3Unadopted, negativeReplay } from "./scenario-checks.mjs";

test("all N2 scripts parse without executing any runner", () => {
  const root = new URL("../", import.meta.url).pathname;
  for (const file of readdirSync(root, { recursive: true }).filter((p) => p.endsWith(".mjs"))) execFileSync(process.execPath, ["--check", join(root, file)]);
  for (const file of ["external/run-all.sh", "external/host-check.sh", "cluster.sh"]) execFileSync("bash", ["-n", join(root, file)]);
  execFileSync("python3", ["-c", 'import sys; compile(open(sys.argv[1]).read(),sys.argv[1],"exec")', join(root, "external/host-ops.py")]);
});

// Exercise the actual F3 orchestration: no deletion/log/DB operation is executed outside these fixtures.
const source = readFileSync(new URL("../components/f3.mjs", import.meta.url), "utf8");
const f3Scenario = source.slice(source.indexOf("async function deleteRightAfterGrant()"), source.indexOf("/** F3 test 2:"));
async function f3Run(adopted, deletionCode = 0) {
  const it = { failures: [], measures: {}, negative: [], notes: [] }, order = [];
  const fate = { state: "closed", closeReason: "kong-stop-confirmed", chain: adopted ? [{ seq: 1, final: false }, { seq: 2, final: true }] : [{ seq: 1, final: true, kongStopConfirmed: true }], closeAudit: { neverServed: !adopted } };
  await runInNewContext(`${f3Scenario}\ndeleteRightAfterGrant()`, {
    item: () => it, s: String, BUDGET: { heldGrant: 26_000 }, Date: { now: () => 100 },
    live: async () => [{ uid: "base" }], replace: async () => ({ name: "new", uid: "new" }),
    Follower: class { lines = adopted ? [{ at: 90, text: "admitted: a" }] : []; constructor() { order.push("follow"); } }, followers: [],
    grantedFast: async () => { order.push("grant"); return { admission_id: "a", decided: 90, requested: 80 }; },
    deletePod: async () => { order.push("delete"); return { code: deletionCode }; }, mark: () => {}, goneOf: async () => {},
    waitFor: async (name) => name.includes("next replacement") ? { name: "next", uid: "next" } : { state: "closed", close_reason: "kong-stop-confirmed", closed: 120 },
    admissionRow: async () => ({}), ctx: {}, fate: async () => fate, openPendencies: async () => [],
    firstLine: (lines, regex) => lines.find((l) => regex.test(l.text)), f3Unadopted, negativeReplay,
    expect: (it, ok, why) => { if (!ok) it.failures.push(why); }, done: () => {},
  });
  return { it, order };
}
test("F3 log follower precedes grant and delete; unadopted final passes the real scenario", async () => {
  const { it, order } = await f3Run(false);
  assert.deepEqual(order.slice(0, 3), ["follow", "grant", "delete"]);
  assert.equal(it.measures.verdict.result, "PASS"); assert.deepEqual(it.failures, []);
});
test("F3 real scenario records adopted-before-delete as INVALID", async () => {
  assert.equal((await f3Run(true)).it.measures.verdict.result, "INVALID");
});
test("F3 unacknowledged deletion is INVALID before observing a replacement", async () => {
  const { it, order } = await f3Run(false, 1);
  assert.equal(it.measures.verdict.result, "INVALID");
  assert.equal(order.length, 3);
});

const v2 = readFileSync(new URL("../components/v2.mjs", import.meta.url), "utf8");
const snapshot = v2.slice(v2.indexOf("  async snapshot(p)"), v2.indexOf("  async stopProbe(p)")).trim().replace("async snapshot", "async function snapshot").replace(/,$/, "");
function readSnapshot(error) {
  return runInNewContext(`${snapshot}\nsnapshot({ name: "victim", uid: "uid" })`, {
    json: async () => ({ metadata: { uid: "uid" }, spec: { nodeName: "node" }, status: { initContainerStatuses: [{ name: "isolation-probe", containerID: "p" }], containerStatuses: [{ name: "kong", containerID: "k" }] } }),
    docker: async (args) => {
      const path = args.at(-1);
      if (path.endsWith("/lease.json")) return { code: 1, stdout: "", stderr: error };
      if (path.endsWith("/probe-state.json")) return { code: 0, stdout: JSON.stringify({ admissionId: "a", chain: { seq: 2 }, passes: 1, proven: [] }) };
      return { code: 0, stdout: path.endsWith("/uptime") ? "10.00 1.00" : "boot" };
    }, NS: { dp: "dp" }, vmNow: async () => 1000, podReady: () => true,
  });
}
test("F4 actual collector rejects permission/runtime errors as proof of lease withdrawal", async () => {
  await assert.rejects(readSnapshot("permission denied"), /presence could not be established/);
});
test("F4 actual collector recognizes kernel-confirmed missing lease", async () => {
  const result = await readSnapshot("cat: lease.json: No such file or directory");
  assert.equal(result.leasePresent, false); assert.equal(result.lease, false);
});

// Python host operations run with fake clocks, process and systemd functions in a separate process. No sudo, SSH,
// clock_settime, systemctl or runtime action reaches the OS; this verifies ordering and cleanup on the real script.
function clockOperation(failWatchdog = false, failNtp = false) {
  const script = String.raw`
import json, sys, types
ns = {'__name__': 'synthetic_host_ops'}
exec(compile(open(sys.argv[1]).read(),sys.argv[1],'exec'), ns)
calls = []
ns['os'].path.exists = lambda p: False
ns['clock'] = lambda: dict(wall=2000000,mono=10000,boot='b',machine='m')
ns['subprocess'].run = lambda args, **kw: (calls.append(args) or types.SimpleNamespace(returncode=1))
def call(*args):
    calls.append(list(args))
    if args == ('timedatectl','show','-p','NTP','--value'): return 'yes'
    if args[0:2] == ('systemctl','is-active') and sys.argv[2] == 'True': raise RuntimeError('watchdog missing')
    if args == ('timedatectl','set-ntp','false') and sys.argv[3] == 'True': raise RuntimeError('cannot disable NTP')
    return 'active'
ns['call'] = call
ns['time'].clock_settime = lambda *args: calls.append(['clock_settime', *args])
try:
    result = ns['main']('rollback', {'run': 'a'*16})
except RuntimeError as e:
    result = {'error': str(e)}
print(json.dumps(dict(result=result,calls=calls)))
`;
  return JSON.parse(execFileSync("python3", ["-c", script, new URL("./host-ops.py", import.meta.url).pathname, failWatchdog ? "True" : "False", failNtp ? "True" : "False"], { encoding: "utf8" }));
}
test("clock safety timer is installed and confirmed before NTP or realtime changes", () => {
  const { calls, result } = clockOperation();
  const schedule = calls.findIndex((a) => a[0] === "systemd-run");
  const active = calls.findIndex((a) => a[1] === "is-active");
  const ntp = calls.findIndex((a) => a[1] === "set-ntp");
  const step = calls.findIndex((a) => a[0] === "clock_settime");
  assert.ok(schedule >= 0 && schedule < active && active < ntp && ntp < step);
  assert.equal(result.restoreUnit, `gromesh-n2-clock-${"a".repeat(16)}`);
  assert.ok(calls[schedule].includes("--on-active=55s"));
});
test("failed watchdog does not alter NTP or the clock", () => {
  const { calls, result } = clockOperation(true);
  assert.equal(result.error, "watchdog missing");
  assert.ok(!calls.some((a) => a[0] === "clock_settime" || a[1] === "set-ntp"));
});
test("clock preparation failure starts the restore service immediately", () => {
  const { calls, result } = clockOperation(false, true);
  assert.equal(result.error, "cannot disable NTP");
  assert.ok(calls.some((a) => a[0] === "systemctl" && a[1] === "start" && a[2].endsWith(".service")));
});
