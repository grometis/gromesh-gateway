import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./collector.mjs", import.meta.url), "utf8");
const versions = Object.fromEntries(readFileSync(new URL("./versions.env", import.meta.url), "utf8").split("\n")
  .filter((line) => /^[A-Z0-9_]+=/.test(line)).map((line) => line.split(/=(.*)/s).slice(0, 2)));

// Run the suite's actual image declarations and values builder without its Kubernetes entry point.
function images(pins) {
  const declarations = source.slice(source.indexOf("const CLICKHOUSE_IMAGE ="), source.indexOf('const DP ='));
  const builder = source.slice(source.indexOf("function values("), source.indexOf("const allowed ="));
  return runInNewContext(`${declarations}\n${builder}\n({ clickhouse: CLICKHOUSE_IMAGE, values: values({ clickhousePeers: [] }) })`, {
    assert, versions: pins, AGENT_IMAGE: "local-agent:test", KONG_IMAGE: "local-kong:test",
    clusterId: "cluster", instanceId: "instance", OBS: "observer",
  });
}

test("collector deploys ClickHouse and Vector from the configured digests", () => {
  for (const pins of [versions, { ...versions,
    CLICKHOUSE_IMAGE: `clickhouse/clickhouse-server:test@sha256:${"a".repeat(64)}`,
    VECTOR_IMAGE: `timberio/vector:test@sha256:${"b".repeat(64)}`,
  }]) {
    const actual = images(pins);
    assert.equal(actual.clickhouse, pins.CLICKHOUSE_IMAGE);
    const vector = actual.values.collector.image;
    assert.equal(`${vector.repository}:${vector.tag}@${vector.digest}`, pins.VECTOR_IMAGE);
  }
});

test("collector refuses missing or mutable dependency images before deployment", () => {
  for (const key of ["CLICKHOUSE_IMAGE", "VECTOR_IMAGE"]) {
    for (const bad of [undefined, "image:latest", `image@sha256:${"f".repeat(63)}`]) {
      assert.throws(() => images({ ...versions, [key]: bad }), /must be pinned by digest/);
    }
  }
});

test("external runner requires resolved Kong, agent, ClickHouse and Vector evidence for collector", () => {
  const runner = readFileSync(new URL("./external/run-all.sh", import.meta.url), "utf8");
  const dispatch = runner.split("\n").find((line) => line.includes('then suite collector '));
  assert.ok(dispatch);
  const output = execFileSync("bash", ["-c", `
    suite() { printf '%s\\n' "$2"; }
    KONG_IMAGE=local-kong:test AGENT_v2=local-agent:test
    CLICKHOUSE_DIGEST=sha256:clickhouse VECTOR_DIGEST=sha256:vector
    n2="$1"
    ${dispatch}
    fi
  `, "test", new URL(".", import.meta.url).pathname], { encoding: "utf8" });
  assert.deepEqual(output.trim().split(" "), ["local-kong:test", "local-agent:test", "sha256:clickhouse", "sha256:vector"]);
});
