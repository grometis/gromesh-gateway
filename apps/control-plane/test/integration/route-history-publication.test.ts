import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ADMIN_URL, integrationDatabaseName, createIntegrationDatabase, dropIntegrationDatabase } from "./databases.js";
import { startHarness, uniq, type Harness } from "./harness.js";
import { runMigrations } from "../../src/db/migrate.js";
import { DB, type Db } from "../../src/db/db.js";
import { confirmRouteHistory } from "../../src/analytics/route-history-evidence.js";
vi.setConfig({ testTimeout: 120000, hookTimeout: 180000 });
let h: Harness;
let databaseName: string;
let databaseUrl: string;
let ws: string;
let routeId: string;
beforeAll(async () => {
    databaseName = integrationDatabaseName("r16pub");
    const url = await createIntegrationDatabase(databaseName);
    databaseUrl = url;
    await runMigrations(url);
    h = await startHarness({ databaseUrl: url, workspacesDeployments: { stage: "dev", convergenceDeadlineMs: 600000 } });
    ws = (await h.api("POST", "/environments", { name: uniq("ledger") })).body.id as string;
    const serviceId = (await h.api("POST", `/environments/${ws}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 })).body.id as string;
    routeId = (await h.api("POST", `/environments/${ws}/routes`, { name: uniq("route"), serviceId, paths: ["/echo"] })).body.id as string;
});
afterAll(async () => {
    await h?.close();
    if (databaseName)
        await dropIntegrationDatabase(databaseName);
});
const deploy = (revision: number | null) => h.api("POST", "/../v2/deployments", { expectedRevision: revision, reason: "ledger test" });
const counts = async () => (await h.sql.query<{
    maps: number;
    visible: number;
    deployments: number;
}>(`select (select count(*)::int from analytics_route_history) maps,(select count(*)::int from analytics_route_history_visibility) visible,(select count(*)::int from deployments) deployments`)).rows[0]!;
it("Release publication alone records no revision map", async () => {
    expect((await h.api("POST", `/../v2/workspaces/${ws}/releases`, {})).status).toBe(201);
    expect(await counts()).toEqual({ maps: 0, visible: 0, deployments: 0 });
});
it("records the domain map with deployment, then observes after commit", async () => {
    expect((await deploy(null)).status).toBe(201);
    expect(await counts()).toEqual({ maps: 1, visible: 1, deployments: 1 });
    const routes = (await h.sql.query<{
        route_id: string;
        workspace_id: string;
    }>(`select route_id,workspace_id from analytics_route_history_routes`)).rows;
    expect(routes).toEqual([{ route_id: routeId, workspace_id: ws }]);
    const row = (await h.sql.query<{
        reason: string;
        genesis: boolean;
        chain_complete: boolean;
    }>(`select reason,genesis,chain_complete from analytics_route_history`)).rows[0];
    expect(row).toMatchObject({ reason: "publish", genesis: true, chain_complete: true });
    expect((await h.sql.query(`select state from deployment_states order by revision desc,seq desc limit 1`)).rows[0].state).toBe("active");
});
it("rolls back the deployment if ledger writing fails", async () => {
    await h.sql.query(`create function r16_reject_map() returns trigger language plpgsql as $$ begin raise exception 'injected ledger failure'; end; $$; create trigger r16_reject_map before insert on analytics_route_history for each row execute function r16_reject_map()`);
    try {
        expect((await deploy(1)).status).toBe(500);
        expect(await counts()).toEqual({ maps: 1, visible: 1, deployments: 1 });
    }
    finally {
        await h.sql.query(`drop trigger r16_reject_map on analytics_route_history; drop function r16_reject_map()`);
    }
});
it("keeps a committed deployment successful when the post-commit observer fails", async () => {
    await h.sql.query(`create function r16_reject_visibility() returns trigger language plpgsql as $$ begin raise exception 'injected observer failure'; end; $$; create trigger r16_reject_visibility before insert on analytics_route_history_visibility for each row execute function r16_reject_visibility()`);
    try {
        expect((await deploy(1)).status).toBe(201);
        expect(await counts()).toEqual({ maps: 2, visible: 1, deployments: 2 });
    }
    finally {
        await h.sql.query(`drop trigger r16_reject_visibility on analytics_route_history_visibility; drop function r16_reject_visibility()`);
    }
    const instanceId = (await h.sql.query<{
        id: string;
    }>(`select id from instance`)).rows[0]!.id;
    await confirmRouteHistory(h.app.get<Db>(DB), { actor: { type: "system", id: "reconcile-test" }, role: "admin", ip: null }, { instanceId, epoch: 1, revision: 2 });
    expect(await counts()).toEqual({ maps: 2, visible: 2, deployments: 2 });
});
it("concurrent deployments retain exactly one owner map and predecessor", async () => {
    const replica = await startHarness({ databaseUrl, workspacesDeployments: { stage: "dev", convergenceDeadlineMs: 600000 } });
    let result;
    try {
        result = await Promise.all([deploy(2), replica.api("POST", "/../v2/deployments", { expectedRevision: 2, reason: "ledger replica test" })]);
    }
    finally {
        await replica.close();
    }
    expect(result.map(x => x.status).sort()).toEqual([201, 409]);
    expect(await counts()).toEqual({ maps: 3, visible: 3, deployments: 3 });
    expect((await h.sql.query(`select previous from analytics_route_history where revision=3`)).rows[0].previous).toEqual({ epoch: 1, revision: 2 });
});
