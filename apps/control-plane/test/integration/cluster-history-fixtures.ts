import { ADMIN_URL, integrationDatabaseName, createIntegrationDatabase, dropIntegrationDatabase } from "./databases.js";
import { startHarness, type Harness } from "./harness.js";
import { runMigrations } from "../../src/db/migrate.js";
import { DB, type Db } from "../../src/db/db.js";
import type { RequestContext } from "../../src/auth/auth.js";
import { awaitDatabaseDisconnect } from "./postgres-disconnect.js";
/** Synthetic disposable fixture: real CP-issued UUIDs/tokens/deployment; direct v2 state is NOT activation proof. */
export async function clusterHistoryFixture() {
    const name = integrationDatabaseName("r17cluster");
    const url = await createIntegrationDatabase(name);
    let h: Harness | undefined;
    try {
        await runMigrations(url);
        h = await startHarness({ databaseUrl: url, workspacesDeployments: { stage: "dev", convergenceDeadlineMs: 600000 } });
        const api = h.api;
        const workspaceId = (await api("POST", "/environments", { name: "history-fixture-a" })).body.id as string;
        const serviceId = (await api("POST", `/environments/${workspaceId}/services`, { name: "fixture-service", protocol: "http", host: "echo", port: 80 })).body.id as string;
        const routeId = (await api("POST", `/environments/${workspaceId}/routes`, { name: "fixture-route", serviceId, paths: ["/same"] })).body.id as string;
        const published = await api("POST", `/../v2/workspaces/${workspaceId}/releases`, {});
        if (published.status !== 201)
            throw Error("Fixture release failed");
        const otherWorkspaceId = (await api("POST", "/environments", { name: "history-fixture-b" })).body.id as string;
        const otherServiceId = (await api("POST", `/environments/${otherWorkspaceId}/services`, { name: "fixture-service-b", protocol: "http", host: "echo", port: 80 })).body.id as string;
        const otherRouteId = (await api("POST", `/environments/${otherWorkspaceId}/routes`, { name: "fixture-route-b", serviceId: otherServiceId, paths: ["/same"] })).body.id as string;
        if ((await api("POST", `/../v2/workspaces/${otherWorkspaceId}/releases`, {})).status !== 201)
            throw Error("Fixture second release failed");
        const deployed = await api("POST", "/../v2/deployments", { expectedRevision: null, reason: "synthetic cluster history fixture" });
        if (deployed.status !== 201)
            throw Error("Fixture deployment failed");
        const instanceId = (await h.sql.query<{
            id: string;
        }>("select id from instance")).rows[0]!.id;
        const db = h.app.get<Db>(DB);
        const base = (await h.app.getUrl()).replace("[::1]", "127.0.0.1");
        let number = 0;
        const registered = async (protocol: "v1" | "v2" = "v2") => {
            const created = await api("POST", `/environments/${workspaceId}/clusters`, { name: `fixture-cluster-${++number}` });
            if (created.status !== 201)
                throw Error("Fixture cluster failed");
            const clusterId = created.body.id as string;
            const nodeId = `fixture-node-${number}`;
            const res = await fetch(`${base}/agent/v1/register`, { method: "POST", headers: { authorization: `Bearer ${created.body.registrationToken as string}`, "content-type": "application/json" }, body: JSON.stringify({ nodeId, hostname: "synthetic-host-not-identity", kongVersion: "3.9.4", agentVersion: "0.3.0" }) });
            if (res.status !== 200)
                throw Error("Fixture registration failed");
            const body = await res.json() as {
                nodeToken: string;
            };
            await h!.sql.query("update clusters set delivery_protocol=$2 where id=$1", [clusterId, protocol]);
            const source = { instanceId, clusterId, nodeId, nodeToken: body.nodeToken, epoch: 1, revision: 1, configHash: deployed.body.configHash as string };
            const ctx: RequestContext = { actor: { type: "agent", id: nodeId }, role: "viewer", ip: null };
            return { source, ctx, token: body.nodeToken };
        };
        return { h, db, url, base, instanceId, workspaceId, serviceId, routeId, otherWorkspaceId, otherServiceId, otherRouteId, registered, close: async () => {
                await h!.close();
                await awaitDatabaseDisconnect(url);
                await dropIntegrationDatabase(name);
            } };
    }
    catch (error) {
        await h?.close();
        await dropIntegrationDatabase(name);
        throw error;
    }
}
