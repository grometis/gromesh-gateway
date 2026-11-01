import { test } from "node:test";
import assert from "node:assert/strict";
import { kindProblems, listeningPorts, assertKindStack } from "./kind-stack-guard.mjs";
function fixture() {
  const env = { KIND_CLUSTER_NAME: "gromesh-mvp-123-1", KUBECONFIG: "/tmp/owned-kubeconfig", GROMESH_DISPOSABLE_ID: "kind-fixture-run-123" };
  const current = { "current-context": "kind-" + env.KIND_CLUSTER_NAME, contexts: [{ context: { cluster: "kind-" + env.KIND_CLUSTER_NAME } }], clusters: [{ cluster: { server: "https://127.0.0.1:12345", "certificate-authority-data": "fixture-ca" } }] };
  const node = { Config: { Labels: { "io.x-k8s.kind.cluster": env.KIND_CLUSTER_NAME } }, State: { Running: true }, NetworkSettings: { Ports: { "6443/tcp": [{ HostPort: "12345", HostIp: "127.0.0.1" }] } } };
  return { env, current, node, exported: structuredClone(current) };
}
test("CI kind identity requires node label, owned kubeconfig endpoint and matching CA", () => {
  const f = fixture();
  assert.deepEqual(kindProblems(f.env, f.node, f.current, f.exported), []);
  for (const mutate of [f => { f.node.Config.Labels["io.x-k8s.kind.cluster"] = "foreign"; }, f => { f.exported.clusters[0].cluster["certificate-authority-data"] = "foreign"; }, f => { f.current.clusters[0].cluster.server = "https://127.0.0.1:55555"; }, f => { f.node.NetworkSettings.Ports["6443/tcp"][0].HostIp = "127.0.0.2"; }, f => { delete f.env.KUBECONFIG; }, f => { delete f.env.GROMESH_DISPOSABLE_ID; }]) {
    const f = fixture();
    mutate(f);
    assert.ok(kindProblems(f.env, f.node, f.current, f.exported).length > 0);
  }
});
test("missing kind config fails before any subprocess", async () => { await assert.rejects(assertKindStack("acceptance", {}), /refused before any write/); });
test("port-forward proof accepts only listening loopback sockets held by the actual process", () => {
  const row = (host, state, inode) => ` 0: ${host}:4680 00000000:0000 ${state} 0:0 00:0 0 1000 0 ${inode} 1`;
  const read = () => ["header", row("0100007F", "0A", "123"), row("0100007F", "0A", "999"), row("0200007F", "0A", "123"), row("0100007F", "01", "123")].join("\n");
  assert.deepEqual([...listeningPorts("123", read, () => ["4"], () => "socket:[123]")], [18048]);
});
