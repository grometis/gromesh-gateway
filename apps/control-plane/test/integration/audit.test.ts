import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, uniq, type Harness } from "./harness.js";

interface AuditEvent {
  id: string;
  at: string;
  actor: { id: string; name: string };
  action: string;
  environmentId: string | null;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
}
interface Page { items: AuditEvent[]; nextCursor: string | null }

describe("audit events", () => {
  let h: Harness;
  const environmentId = randomUUID();
  const otherEnvironmentId = randomUUID();
  const actorId = randomUUID();
  const otherActorId = randomUUID();
  const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003"];

  beforeAll(async () => {
    h = await startHarness();
    for (const [index, id] of ids.entries()) {
      await h.sql.query(
        `insert into audit_events (id, at, actor, action, environment_id, entity_type, entity_id, before, after)
         values ($1, $2, $3, 'service.update', $4, $5, $6, $7, $8)`,
        [id, index === 0 ? "2026-01-01T12:00:00.123455Z" : "2026-01-01T12:00:00.123456Z",
          JSON.stringify({ type: "user", id: index === 0 ? otherActorId : actorId, name: "Ana" }),
          index === 0 ? otherEnvironmentId : environmentId, index === 0 ? "route" : "service", id,
          JSON.stringify({ host: "old.internal" }), JSON.stringify({ host: "new.internal" })],
      );
    }
  });
  afterAll(async () => {
    await h.sql.query("delete from audit_events where id = any($1::uuid[])", [ids]);
    await h.close();
  });

  it("paginates newest first without losing ties or timestamp microseconds", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 3; i++) {
      const response: { status: number; body: Page } = await h.api<Page>("GET", `/audit-events?from=2026-01-01T12:00:00Z&to=2026-01-01T12:00:01Z&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(1);
      seen.push(response.body.items[0]!.id);
      cursor = response.body.nextCursor;
      expect(cursor === null).toBe(i === 2);
    }
    expect(seen).toEqual([ids[2], ids[1], ids[0]]);
  });

  it("applies each contract filter and keeps the before/after values", async () => {
    for (const filter of [`environmentId=${environmentId}`, `actorId=${actorId}`, "entityType=service&from=2026-01-01T12:00:00Z&to=2026-01-01T12:00:01Z"] ) {
      const response = await h.api<Page>("GET", `/audit-events?${filter}`);
      expect(response.status).toBe(200);
      expect(response.body.items.map((event) => event.id)).toEqual([ids[2], ids[1]]);
      expect(response.body.items[0]).toMatchObject({ before: { host: "old.internal" }, after: { host: "new.internal" } });
    }
    const combined = await h.api<Page>("GET", `/audit-events?environmentId=${environmentId}&actorId=${otherActorId}`);
    expect(combined.body).toEqual({ items: [], nextCursor: null });
    const outside = await h.api<Page>("GET", `/audit-events?environmentId=${environmentId}&from=2026-01-02T00:00:00Z`);
    expect(outside.body.items).toEqual([]);
    const before = await h.api<Page>("GET", `/audit-events?environmentId=${environmentId}&to=2026-01-01T00:00:00Z`);
    expect(before.body.items).toEqual([]);
  });

  it("rejects invalid query values with field errors instead of database errors", async () => {
    for (const [query, field] of [
      ["environmentId=invalid", "environmentId"], ["actorId=invalid", "actorId"],
      ["from=yesterday", "from"], ["to=2026-02-30T00:00:00Z", "to"],
      ["from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z", "to"],
      ["limit=0", "limit"], ["limit=201", "limit"], ["limit=1.5", "limit"],
      ["actorId=a&actorId=b", "actorId"], ["cursor=bad", "cursor"],
      ["limit[value]=1", "limit"], ["actorId[value]=invalid", "actorId"],
      ["cursor[value]=bad", "cursor"],
      [`cursor=${Buffer.from(JSON.stringify({ k: "not-a-date", id: actorId })).toString("base64url")}`, "cursor"],
      [`cursor=${Buffer.from(JSON.stringify({ k: "2026-01-01T00:00:00Z", id: "invalid" })).toString("base64url")}`, "cursor"],
    ]) {
      const response = await h.api<{ errors: { path: string }[] }>("GET", `/audit-events?${query}`);
      expect(response.status, query).toBe(422);
      expect(response.contentType).toContain("application/problem+json");
      expect(response.body.errors).toContainEqual(expect.objectContaining({ path: field }));
    }
  });

  it("shows a real publication with its author", async () => {
    const env = await h.api<{ id: string }>("POST", "/environments", { name: uniq("audit"), publishMode: "manual" });
    const me = (await h.api<{ id: string; name: string }>("GET", "/me")).body;
    try {
      const publication = await h.api<{ version: number }>("POST", `/environments/${env.body.id}/snapshots`, { message: "Audit acceptance" });
      expect(publication.status).toBe(201);
      const response = await h.api<Page>("GET", `/audit-events?environmentId=${env.body.id}&entityType=snapshot&actorId=${me.id}`);
      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        action: "snapshot.publish", entityId: String(publication.body.version),
        actor: { id: me.id, name: me.name }, after: { version: publication.body.version, message: "Audit acceptance" },
      });
    } finally {
      await h.api("DELETE", `/environments/${env.body.id}`);
    }
  });

  it("requires authentication and the admin role", async () => {
    expect((await h.anonymous("GET", "/audit-events")).status).toBe(401);
    expect(((await (await h.as("editor")).api("GET", "/audit-events")).status)).toBe(403);
  });
});
