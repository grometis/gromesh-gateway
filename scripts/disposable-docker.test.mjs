import { test } from "node:test";
import assert from "node:assert/strict";
import { disposableDocker } from "./disposable-docker.mjs";
import { disposableLabel } from "./stack-guard.mjs";
function fixture() {
  const objects = new Map(), calls = [];
  let counter = 0;
  const run = "standalone-fixture-run";
  const execute = async (args) => {
    calls.push(args);
    if (args[0] === "inspect" || args[1] === "inspect") {
      const key = args.at(-1);
      if (!objects.has(key))
        throw Error("not found");
      return { stdout: JSON.stringify([objects.get(key)]) };
    }
    const label = args.find(a => a.startsWith(disposableLabel + "="))?.slice(disposableLabel.length + 1);
    if (["network", "volume"].includes(args[0]) && args[1] === "create")
      objects.set(args.at(-1), { Labels: { [disposableLabel]: label } });
    if (args[0] === "run") {
      const id = (++counter).toString(16).padStart(64, "0");
      const obj = { Config: { Labels: { [disposableLabel]: label } } };
      objects.set(id, obj);
      const index = args.indexOf("--name");
      if (index >= 0)
        objects.set(args[index + 1], obj);
      return { stdout: id };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { docker: disposableDocker(execute, run), objects, calls, run };
}
test("standalone resources get labels and only verified resources can be attached/changed/removed", async () => {
  const f = fixture();
  await f.docker(["network", "create", "own-net"]);
  await f.docker(["volume", "create", "own-volume"]);
  const r = await f.docker(["run", "-d", "--name", "own", "--network", "own-net", "-v", "own-volume:/data", "image"]);
  await f.docker(["exec", "-e", "KEY", "own", "touch", "/data/file"]);
  await f.docker(["kill", "--signal", "STOP", "own"]);
  await f.docker(["stop", "--time", "20", "own"]);
  await f.docker(["rm", "-f", "own"]);
  assert.ok(f.calls.some(c => c[0] === "rm" && c[2] === r.stdout));
  assert.ok(f.calls.filter(c => c[0] === "run" || c[1] === "create").every(c => c.includes(`${disposableLabel}=${f.run}`)));
});
test("first-start pre-removal and failed-create cleanup never remove a foreign named container", async () => {
  const f = fixture();
  f.objects.set("existing", { Config: { Labels: { [disposableLabel]: "foreign" } } });
  await f.docker(["rm", "-f", "existing"]);
  assert.ok(!f.calls.some(c => c[0] === "rm"));
  await assert.rejects(f.docker(["exec", "existing", "touch", "/file"]), /ownership/);
});
test("pre-existing volumes and networks are never adopted, overwritten or cleaned", async () => {
  for (const type of ["volume", "network"]) {
    const f = fixture();
    f.objects.set("collision", { Labels: { [disposableLabel]: "foreign" } });
    await assert.rejects(f.docker([type, "create", "collision"]), /ownership/);
    await assert.rejects(f.docker([type, "rm", "collision"]), /ownership/);
    assert.ok(!f.calls.some(c => c[1] === "create" || c[1] === "rm"));
  }
});
test("unknown volumes/network namespaces and relabelled containers fail before writes", async () => {
  const f = fixture();
  await assert.rejects(f.docker(["run", "--network", "container:foreign", "image"]), /ownership/);
  await assert.rejects(f.docker(["run", "-v", "foreign:/data", "image"]), /ownership/);
  await f.docker(["run", "-d", "--name", "own", "image"]);
  f.objects.get("own").Config.Labels[disposableLabel] = "foreign";
  await assert.rejects(f.docker(["exec", "own", "touch", "/file"]), /ownership/);
  assert.ok(!f.calls.some(c => c[0] === "exec"));
});
