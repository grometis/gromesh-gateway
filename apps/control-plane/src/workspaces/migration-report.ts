import type { GatewayState } from "@gromesh/compiler";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { type Encryptor, snapshotContext } from "../crypto/crypto.js";
import type { Db, Executor } from "../db/db.js";
import { basicAuthCredentials, certificateSnis, dataMigrations, environments, jwtCredentials, keyAuthCredentials, routes, snapshots, workspaces } from "../db/schema.js";
import { enforceInstanceUniquenessSoon, type UniqueKind, uniqueValues } from "./instance-uniqueness.js";
import { backfillWorkspaces } from "./workspaces.js";

type Source = "draft" | "active-snapshot" | "rollback-candidate";
type EntityType = "key-auth-credential" | "jwt-credential" | "basic-auth-credential" | "certificate";
interface Occurrence {
  workspaceId: string;
  source: Source;
  entityType: EntityType;
  entityId: string;
  snapshotVersion: number | null;
}
export interface UniquenessBlocker {
  kind: UniqueKind;
  occurrences: Occurrence[];
}

const ENTITY: Record<UniqueKind, EntityType> = {
  "key-auth-key": "key-auth-credential",
  "jwt-key": "jwt-credential",
  "basic-auth-username": "basic-auth-credential",
  sni: "certificate",
};

/**
 * Every credential or server name that two workspaces hold, in a draft, in the active version or in a version a
 * rollback could restore (C §8.3): what keeps the instance from being composed. Only identities leave here, never a key,
 * a hash, a username or a server name.
 */
export async function uniquenessBlockers(tx: Executor, enc: Encryptor): Promise<UniquenessBlocker[]> {
  const found = new Map<string, Map<string, Occurrence>>();
  const note = (kind: UniqueKind, value: string, o: Occurrence) => {
    const key = `${kind}\0${value}`;
    const list = found.get(key) ?? new Map<string, Occurrence>();
    list.set(`${o.workspaceId}|${o.source}|${o.entityId}|${o.snapshotVersion ?? ""}`, o);
    found.set(key, list);
  };
  const draft: [UniqueKind, { env: string; id: string; value: string }[]][] = [
    ["key-auth-key", await tx.select({ env: keyAuthCredentials.environmentId, id: keyAuthCredentials.id, value: keyAuthCredentials.keyHash }).from(keyAuthCredentials)],
    ["jwt-key", await tx.select({ env: jwtCredentials.environmentId, id: jwtCredentials.id, value: jwtCredentials.key }).from(jwtCredentials)],
    ["basic-auth-username", await tx.select({ env: basicAuthCredentials.environmentId, id: basicAuthCredentials.id, value: basicAuthCredentials.username }).from(basicAuthCredentials)],
    ["sni", await tx.select({ env: certificateSnis.environmentId, id: certificateSnis.certificateId, value: certificateSnis.name }).from(certificateSnis)],
  ];
  for (const [kind, rows] of draft) for (const r of rows) note(kind, r.value, { workspaceId: r.env, source: "draft", entityType: ENTITY[kind], entityId: r.id, snapshotVersion: null });

  // Every version, opened a batch at a time (they carry the whole configuration).
  for (let after: { env: string; version: number } | null = null; ; ) {
    const page: { env: string; version: number; state: unknown; current: number | null }[] = await tx
      .select({ env: snapshots.environmentId, version: snapshots.version, state: snapshots.state, current: environments.currentVersion })
      .from(snapshots)
      .innerJoin(environments, eq(environments.id, snapshots.environmentId))
      .where(after ? or(gt(snapshots.environmentId, after.env), and(eq(snapshots.environmentId, after.env), gt(snapshots.version, after.version))) : undefined)
      .orderBy(asc(snapshots.environmentId), asc(snapshots.version))
      .limit(50);
    if (page.length === 0) break;
    after = { env: page.at(-1)!.env, version: page.at(-1)!.version };
    for (const v of page) {
    const state = enc.openJson<GatewayState>(v.state as Parameters<Encryptor["openJson"]>[0], snapshotContext(v.env, v.version, "state"));
    const source: Source = v.version === v.current ? "active-snapshot" : "rollback-candidate";
    const values = uniqueValues(state, enc);
    const owners: Record<UniqueKind, string[]> = {
      "key-auth-key": state.keyAuthCredentials.map((k) => k.id),
      "jwt-key": (state.jwtCredentials ?? []).map((j) => j.id),
      "basic-auth-username": (state.basicAuthCredentials ?? []).map((b) => b.id),
      sni: (state.certificates ?? []).flatMap((c) => c.snis.map(() => c.id)),
    };
    for (const kind of Object.keys(values) as UniqueKind[]) {
      values[kind].forEach((value, i) => note(kind, value, { workspaceId: v.env, source, entityType: ENTITY[kind], entityId: owners[kind][i]!, snapshotVersion: v.version }));
    }
    }
  }

  const blockers: UniquenessBlocker[] = [];
  for (const [key, byIdentity] of found) {
    const occurrences = [...byIdentity.values()];
    if (new Set(occurrences.map((o) => o.workspaceId)).size < 2) continue;
    blockers.push({ kind: key.split("\0")[0] as UniqueKind, occurrences: occurrences.sort((a, b) => (a.workspaceId + a.source + a.entityId + (a.snapshotVersion ?? 0)).localeCompare(b.workspaceId + b.source + b.entityId + (b.snapshotVersion ?? 0))) });
  }
  // A stable order that reveals nothing about the values.
  return blockers.sort((a, b) => a.kind.localeCompare(b.kind) || JSON.stringify(a.occurrences).localeCompare(JSON.stringify(b.occurrences)));
}

/**
 * The N1 migration report (contract: getWorkspaceMigrationReport). Reading it also fills in late slugs and puts in
 * force the instance index of every kind no two drafts repeat, each in a short transaction; the report itself is read
 * in a read-only one that holds no lock writers wait on.
 */
export async function migrationReport(db: Db, enc: Encryptor) {
  await db.transaction((tx) => backfillWorkspaces(tx));
  await enforceInstanceUniquenessSoon(db);
  return db.transaction((tx) => readReport(tx, enc), { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function readReport(tx: Executor, enc: Encryptor) {
  const [marker] = await tx.select().from(dataMigrations).where(eq(dataMigrations.name, "n1-workspaces"));
  const blockers = await uniquenessBlockers(tx, enc);
  const rows = await tx
    .select({
      workspaceId: workspaces.id,
      name: environments.name,
      slug: workspaces.slug,
      slugStatus: workspaces.slugStatus,
      slugReason: workspaces.slugReason,
      legacyRoutes: sql<number>`(select count(*)::int from ${routes} r where r.environment_id = ${workspaces.id} and r.path_compatibility = 'legacy-preserved')`,
      routesWithoutPath: sql<number>`(select count(*)::int from ${routes} r where r.environment_id = ${workspaces.id} and coalesce(cardinality(r.paths), 0) = 0)`,
    })
    .from(workspaces)
    .innerJoin(environments, eq(environments.id, workspaces.id))
    .orderBy(asc(environments.createdAt), asc(workspaces.id));
  return {
    migratedAt: marker!.appliedAt.toISOString(),
    status: blockers.length > 0 ? ("blocked" as const) : ("complete" as const),
    blockers,
    workspaces: rows.map((r) => ({
      workspaceId: r.workspaceId,
      name: r.name,
      slug: r.slug!,
      slugStatus: r.slugStatus!,
      ...(r.slugStatus === "adjusted" ? { slugReason: r.slugReason! } : {}),
      legacyRoutes: r.legacyRoutes,
      routesWithoutPath: r.routesWithoutPath,
    })),
    // The role matrix becomes bindings in N1-C3, which reports what changed here.
    accessChanges: [] as { userId: string; change: "implicit-access-dropped" }[],
  };
}
