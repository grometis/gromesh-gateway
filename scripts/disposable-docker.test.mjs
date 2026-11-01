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
  return { docker: disposableDocker(execute, run), execute, objects, calls, run };
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

test("standalone entry requires run ID and local daemon, without requiring Compose", async () => {
  const { assertStandalone } = await import("./disposable-docker.mjs");
  let calls = 0;
  const inspect = async () => { calls++; return [{Endpoints: {docker: {Host: "unix:///var/run/docker.sock"}}}]; };
  await assert.rejects(assertStandalone({}, inspect), /GROMESH_DISPOSABLE_ID/);
  assert.equal(calls, 0);
  await assertStandalone({GROMESH_DISPOSABLE_ID: "standalone-run-123"}, inspect);
  assert.equal(calls, 1);
  await assert.rejects(assertStandalone({GROMESH_DISPOSABLE_ID: "standalone-run-123", DOCKER_HOST: "ssh://foreign"}, inspect), /Unix/);
});
test("strict standalone mount proof refuses foreign binds, anonymous volumes and alternate mount syntax", async () => {
  const f = fixture();
  const run = disposableDocker(async args => { f.calls.push(args); return {stdout: ""}; }, f.run, {bindRoots: []});
  for (const args of [["-v", "/tmp/foreign:/data"], ["-v", "/data"], ["--mount", "type=volume,source=foreign,target=/data"], ["--network=host"]]) {
    await assert.rejects(run(["run", "--rm", ...args, "image"]), /ownership/);
  }
  assert.equal(f.calls.length, 0);
});
test("Docker secret assignments move to child environment and errors lose all raw process properties", async () => {
  const { dockerProcess, processFailure } = await import("./private-process.mjs");
  const secret = "rotated-fixture-credential";
  const command = dockerProcess(["run", "-e", `GROMESH_COLLECTOR_TOKEN=${secret}`, "-e", "CLICKHOUSE_PASSWORD=pw-fixture", "image"], {});
  assert.deepEqual(command.args, ["run", "-e", "GROMESH_COLLECTOR_TOKEN", "-e", "CLICKHOUSE_PASSWORD", "image"]);
  assert.equal(command.env.GROMESH_COLLECTOR_TOKEN, secret);
  const error = processFailure({message: secret, stderr: `failed ${secret} pw-fixture`, stdout: secret, cmd: secret}, command.env);
  assert.ok(!String(error.stack).includes(secret));
  assert.ok(!JSON.stringify(error).includes(secret));
  assert.equal(error.cmd, undefined);
});

test("strict standalone cannot label bind-backed foreign storage as its own", async () => {
  const calls = [];
  const run = disposableDocker(async args => {calls.push(args); return {stdout: "[]"};}, "standalone-fixture-run", {bindRoots: []});
  for (const type of ["volume", "network"])
    await assert.rejects(run([type, "create", "--driver", "local", "--opt", "device=/foreign", "own-name"]), /ownership/);
  assert.equal(calls.length, 0);
});
test("strict standalone proves new resources and rejects an implicit image volume", async () => {
  const f = fixture();
  const run = disposableDocker(f.execute, f.run, {bindRoots: []});
  await run(["network", "create", "own-net"]);
  await run(["volume", "create", "own-volume"]);
  f.objects.set("image", {Config: {Volumes: {"/data": {}}}});
  await assert.rejects(run(["run", "--rm", "image"]), /ownership/);
  const result = await run(["run", "-d", "--name", "strict-own", "--network", "own-net", "-v", "own-volume:/data", "image"]);
  await run(["exec", "strict-own", "touch", "/data/fixture"]);
  await run(["rm", "-f", "strict-own"]);
  assert.ok(f.calls.some(args => args[0] === "rm" && args.includes(result.stdout)));
});

test("real failed child cannot expose token/password through its rejection", async () => {
  const {execFile} = await import("node:child_process");
  const {promisify} = await import("node:util");
  const {dockerProcess, processFailure} = await import("./private-process.mjs");
  const command = dockerProcess(["run", "-e", "GROMESH_COLLECTOR_TOKEN=rotated-real-child-fixture", "-e", "CLICKHOUSE_PASSWORD=password-real-child-fixture", "image"], {});
  assert.ok(!command.args.join(" ").includes(command.env.GROMESH_COLLECTOR_TOKEN));
  await assert.rejects(promisify(execFile)(process.execPath, ["-e", "console.error(process.env.GROMESH_COLLECTOR_TOKEN, process.env.CLICKHOUSE_PASSWORD); process.exit(1)"], {env: command.env}).catch(error => {throw processFailure(error, command.env);}), error => {
    assert.match(error.message, /REDACTED/);
    for (const value of Object.values(command.env)) assert.ok(!String(error.stack).includes(value));
    return true;
  });
});
