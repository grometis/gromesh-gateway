import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { GatewayState, KongDeclarativeConfig, UpstreamHealthchecks } from "@gromesh/compiler";
import type { SealedJson } from "../crypto/crypto.js";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export interface Actor {
  type: "user" | "system" | "agent";
  id: string;
  name?: string;
  /** How a user authenticated; a token also names itself, so the audit log says which one acted. */
  via?: "session" | "token";
  tokenId?: string;
  tokenName?: string;
}

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stored lowercase; the unique index makes the e-mail case-insensitive.
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role", { enum: ["viewer", "editor", "admin"] }).notNull(),
    active: boolean("active").notNull().default(true),
    passwordHash: text("password_hash").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    // sha256 of the cookie value: a database read never yields a usable session id.
    idHash: text("id_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

/** Failed logins per key ("ip:<addr>" or "email:<addr>"), shared by every replica. */
/** API tokens: only the keyed hash of the value is stored; the role is capped by the owner's current role at use. */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role", { enum: ["viewer", "editor", "admin"] }).notNull(),
    // HMAC-SHA256 of the token with GROMESH_FINGERPRINT_KEY: a database read never yields a usable token.
    tokenHash: text("token_hash").notNull(),
    tokenHint: text("token_hint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_tokens_hash_uq").on(t.tokenHash), index("api_tokens_user_idx").on(t.userId)],
);
export type ApiTokenRow = typeof apiTokens.$inferSelect;

export const loginAttempts = pgTable("login_attempts", {
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    publishMode: text("publish_mode", { enum: ["manual", "auto"] }).notNull().default("manual"),
    currentVersion: integer("current_version"),
    hasUnpublishedChanges: boolean("has_unpublished_changes").notNull().default(false),
    // Imports remain drafts until an explicit publish, even after subsequent edits or a replica restart.
    draftRequiresPublish: boolean("draft_requires_publish").notNull().default(false),
    // Last draft edit; auto-publish fires once it is older than the debounce delay.
    draftChangedAt: timestamp("draft_changed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("environments_name_uq").on(t.name)],
);

/**
 * The workspace each environment is (N1): the same id, so every entity's `environment_id` is the workspace it belongs
 * to. A trigger inserts the row with each environment; the application fills in the slug (`proposeSlug`), in the
 * same transaction on creation and in `backfillWorkspaces` for the rows the migration created.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => environments.id, { onDelete: "cascade" }),
    // Logical identity shared by the same workspace across instances.
    key: uuid("key").notNull().defaultRandom(),
    slug: text("slug"),
    slugStatus: text("slug_status", { enum: ["derived", "adjusted"] }),
    slugReason: text("slug_reason", { enum: ["collision", "invalid", "reserved"] }),
    // Set by the first release: the slug never changes afterwards.
    slugLockedAt: timestamp("slug_locked_at", { withTimezone: true }),
    status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
    // Set on the rows the N1 migration created from the environments that already existed.
    migratedAt: timestamp("migrated_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workspaces_key_uq").on(t.key),
    uniqueIndex("workspaces_slug_uq").on(t.slug),
    check("workspaces_slug_ck", sql`${t.slug} ~ '^[a-z][a-z0-9-]{1,39}$'`),
    // A slug always comes with its status, and an adjusted one with the reason (and only then).
    check("workspaces_slug_status_ck", sql`(${t.slug} is null) = (${t.slugStatus} is null) and (${t.slugReason} is not null) = (${t.slugStatus} is not distinct from 'adjusted')`),
    check("workspaces_status_ck", sql`${t.status} in ('active', 'archived')`),
  ],
);
export type WorkspaceRow = typeof workspaces.$inferSelect;

/**
/**
 * Never written: an import locks it (EXCLUSIVE, as its first statement) so imports run one at a time and each sees
 * the conflicts the previous one counted. A table lock does not freeze the serializable snapshot; a row lock would.
 */
export const importQueue = pgTable("import_queue", {
  id: integer("id").primaryKey(),
});

/**
 * Who may do what (decision H-9: one authorization for both APIs). A user's permissions in a workspace are its global
 * v1 role translated, replaced there by its v1 environment role (environment_roles, read as it is: none is a deny that
 * prevails over every grant there), plus these v2 grants of the workspace and of the instance. A grant names a
 * built-in role or permissions and allows; groups, custom roles and denies are later phases. Revoking keeps the row
 * (revoked_at) for the audit trail.
 */
export const roleBindings = pgTable(
  "role_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: text("subject_type", { enum: ["user"] }).notNull().default("user"),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopeType: text("scope_type", { enum: ["instance", "workspace"] }).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role"),
    permissions: text("permissions").array(),
    // Fixed when granted: the grantor held platform.admin, so only platform administration revokes it.
    grantedByPlatform: boolean("granted_by_platform").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    justification: text("justification"),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("role_bindings_subject_idx").on(t.subjectId),
    index("role_bindings_workspace_idx").on(t.workspaceId),
    check("role_bindings_scope_ck", sql`(${t.scopeType} = 'workspace') = (${t.workspaceId} is not null)`),
    check("role_bindings_grant_ck", sql`(${t.role} is null) <> (${t.permissions} is null)`),
    check("role_bindings_subject_type_ck", sql`${t.subjectType} = 'user'`),
  ],
);
export type RoleBindingRow = typeof roleBindings.$inferSelect;

/** Data migrations that changed the meaning of existing rows, by name ("n1-workspaces"), with when they ran. */
export const dataMigrations = pgTable("data_migrations", {
  name: text("name").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A role that replaces the user's global role in one environment; `none` hides the environment. */
export const environmentRoles = pgTable(
  "environment_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor", "admin", "none"] }).notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.environmentId] }),
    index("environment_roles_env_idx").on(t.environmentId),
    check("environment_roles_role_ck", sql`${t.role} in ('viewer', 'editor', 'admin', 'none')`),
  ],
);

export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    protocol: text("protocol").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    path: text("path"),
    retries: integer("retries"),
    connectTimeoutMs: integer("connect_timeout_ms"),
    readTimeoutMs: integer("read_timeout_ms"),
    writeTimeoutMs: integer("write_timeout_ms"),
    enabled: boolean("enabled").notNull().default(true),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  // Referenced with the workspace (composite foreign keys): nothing can point at an entity of another workspace.
  (t) => [uniqueIndex("services_env_name_uq").on(t.environmentId, t.name), unique("services_env_id_uq").on(t.environmentId, t.id)],
);

/** Load-balancing pools; a service whose host equals `name` balances across the targets. */
export const upstreams = pgTable(
  "upstreams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    algorithm: text("algorithm").notNull().default("round-robin"),
    hashOn: text("hash_on").notNull().default("none"),
    hashFallback: text("hash_fallback").notNull().default("none"),
    hashOnHeader: text("hash_on_header"),
    hashFallbackHeader: text("hash_fallback_header"),
    hashOnCookie: text("hash_on_cookie"),
    hashOnCookiePath: text("hash_on_cookie_path"),
    // { active, passive } with defaults filled in; null halves are off.
    healthchecks: jsonb("healthchecks").$type<{ active: NonNullable<UpstreamHealthchecks["active"]> | null; passive: NonNullable<UpstreamHealthchecks["passive"]> | null }>().notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (t) => [uniqueIndex("upstreams_env_name_uq").on(t.environmentId, t.name), unique("upstreams_env_id_uq").on(t.environmentId, t.id)],
);

export const targets = pgTable(
  "targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    upstreamId: uuid("upstream_id").notNull(),
    target: text("target").notNull(),
    weight: integer("weight").notNull().default(100),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("targets_upstream_target_uq").on(t.upstreamId, t.target),
    index("targets_env_idx").on(t.environmentId),
    foreignKey({ name: "targets_upstream_fk", columns: [t.environmentId, t.upstreamId], foreignColumns: [upstreams.environmentId, upstreams.id] }).onDelete("cascade"),
  ],
);

/** TLS certificates; `key` is sealed (enc:v2, context certificates.key + id) and never leaves the API. */
export const certificates = pgTable(
  "certificates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    cert: text("cert").notNull(),
    key: text("key").notNull(),
    subject: text("subject").notNull(),
    issuer: text("issuer").notNull(),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
    fingerprintSha256: text("fingerprint_sha256").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (t) => [index("certificates_env_idx").on(t.environmentId), unique("certificates_env_id_uq").on(t.environmentId, t.id)],
);

/** One row per server name: the unique index keeps SNIs unique in the environment, races included. */
export const certificateSnis = pgTable(
  "certificate_snis",
  {
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    certificateId: uuid("certificate_id").notNull(),
    name: text("name").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.environmentId, t.name] }),
    index("certificate_snis_cert_idx").on(t.certificateId),
    foreignKey({ name: "certificate_snis_certificate_fk", columns: [t.environmentId, t.certificateId], foreignColumns: [certificates.environmentId, certificates.id] }).onDelete("cascade"),
  ],
);

export const routes = pgTable(
  "routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    // RESTRICT (composite foreign key below): a service with routes cannot be deleted (409 for the API).
    serviceId: uuid("service_id").notNull(),
    name: text("name").notNull(),
    protocols: text("protocols").array().notNull().default(sql`'{http,https}'::text[]`),
    methods: text("methods").array(),
    hosts: text("hosts").array(),
    paths: text("paths").array(),
    headers: jsonb("headers").$type<Record<string, string[]>>(),
    stripPath: boolean("strip_path").notNull().default(true),
    preserveHost: boolean("preserve_host").notNull().default(false),
    analyticsRetentionDays: integer("analytics_retention_days"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    // legacy-preserved: an existing route, or one created through v1, keeps its strip_path until
    // convertRoutePathCompatibility; workspace-default (v2) always has a path.
    pathCompatibility: text("path_compatibility", { enum: ["legacy-preserved", "workspace-default"] }).notNull().default("legacy-preserved"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("routes_env_name_uq").on(t.environmentId, t.name),
    index("routes_service_idx").on(t.serviceId),
    unique("routes_env_id_uq").on(t.environmentId, t.id),
    foreignKey({ name: "routes_service_fk", columns: [t.environmentId, t.serviceId], foreignColumns: [services.environmentId, services.id] }).onDelete("restrict"),
    check("routes_path_compatibility_ck", sql`${t.pathCompatibility} in ('legacy-preserved', 'workspace-default')`),
    check("routes_workspace_default_paths_ck", sql`${t.pathCompatibility} = 'legacy-preserved' or coalesce(cardinality(${t.paths}), 0) > 0`),
  ],
);

export const consumers = pgTable(
  "consumers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    username: text("username"),
    customId: text("custom_id"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    // Replaced as a whole by PUT acl-groups; the compiler emits one Kong acl per group.
    aclGroups: text("acl_groups").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("consumers_env_username_uq").on(t.environmentId, t.username),
    uniqueIndex("consumers_env_custom_id_uq").on(t.environmentId, t.customId),
    unique("consumers_env_id_uq").on(t.environmentId, t.id),
  ],
);

export const keyAuthCredentials = pgTable(
  "keyauth_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    consumerId: uuid("consumer_id").notNull(),
    // Kong needs the clear key in the declarative config, so it is stored encrypted (see crypto/), not hashed.
    key: text("key").notNull(),
    // sha256 of the clear key: uniqueness per environment without decrypting.
    keyHash: text("key_hash").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("keyauth_env_key_hash_uq").on(t.environmentId, t.keyHash),
    index("keyauth_consumer_idx").on(t.consumerId),
    foreignKey({ name: "keyauth_consumer_fk", columns: [t.environmentId, t.consumerId], foreignColumns: [consumers.environmentId, consumers.id] }).onDelete("cascade"),
  ],
);

export const jwtCredentials = pgTable(
  "jwt_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    consumerId: uuid("consumer_id").notNull(),
    // The issuer: public, matched against the token's iss claim.
    key: text("key").notNull(),
    algorithm: text("algorithm").notNull(),
    // HS256 only; sealed (enc:v2, context jwt_credentials.secret + id) because Kong needs it in clear.
    secret: text("secret"),
    rsaPublicKey: text("rsa_public_key"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jwt_env_key_uq").on(t.environmentId, t.key),
    index("jwt_consumer_idx").on(t.consumerId),
    foreignKey({ name: "jwt_consumer_fk", columns: [t.environmentId, t.consumerId], foreignColumns: [consumers.environmentId, consumers.id] }).onDelete("cascade"),
  ],
);

export const basicAuthCredentials = pgTable(
  "basicauth_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    consumerId: uuid("consumer_id").notNull(),
    username: text("username").notNull(),
    // Kong's salted hash, never the password; still a secret, so sealed (enc:v2, context
    // basicauth_credentials.password_hash + id).
    passwordHash: text("password_hash").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("basicauth_env_username_uq").on(t.environmentId, t.username),
    index("basicauth_consumer_idx").on(t.consumerId),
    foreignKey({ name: "basicauth_consumer_fk", columns: [t.environmentId, t.consumerId], foreignColumns: [consumers.environmentId, consumers.id] }).onDelete("cascade"),
  ],
);

export const plugins = pgTable(
  "plugins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // A scoped plugin goes away with the entity it is attached to, always one of its own workspace (foreign keys below).
    serviceId: uuid("service_id"),
    routeId: uuid("route_id"),
    consumerId: uuid("consumer_id"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    protocols: text("protocols").array(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  // Kong allows one instance of a plugin per (name, service, route, consumer); NULL counts as a value.
  (t) => [
    unique("plugins_env_scope_uq").on(t.environmentId, t.name, t.serviceId, t.routeId, t.consumerId).nullsNotDistinct(),
    // A null scope column is not checked (MATCH SIMPLE): an unscoped plugin references nothing.
    foreignKey({ name: "plugins_service_fk", columns: [t.environmentId, t.serviceId], foreignColumns: [services.environmentId, services.id] }).onDelete("cascade"),
    foreignKey({ name: "plugins_route_fk", columns: [t.environmentId, t.routeId], foreignColumns: [routes.environmentId, routes.id] }).onDelete("cascade"),
    foreignKey({ name: "plugins_consumer_fk", columns: [t.environmentId, t.consumerId], foreignColumns: [consumers.environmentId, consumers.id] }).onDelete("cascade"),
  ],
);

export const snapshots = pgTable(
  "snapshots",
  {
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    hash: text("hash").notNull(),
    // Both documents carry secrets: stored sealed (crypto/), opened only where served or compiled.
    config: jsonb("config").$type<SealedJson | KongDeclarativeConfig>().notNull(),
    // Source state, so a rollback can restore the draft exactly.
    state: jsonb("state").$type<SealedJson | GatewayState>().notNull(),
    message: text("message"),
    // Routes that were workspace-default when this version was published: a rollback restores exactly that
    // (before N1 every route was legacy-preserved, so older versions hold none).
    workspaceDefaultRoutes: uuid("workspace_default_routes").array().notNull().default(sql`'{}'::uuid[]`),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    rollbackOf: integer("rollback_of"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.version] })],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actor: jsonb("actor").$type<Actor>().notNull(),
    action: text("action").notNull(),
    environmentId: uuid("environment_id"),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
  },
  (t) => [index("audit_events_at_idx").on(t.at), index("audit_events_env_idx").on(t.environmentId)],
);

export type EnvironmentRow = typeof environments.$inferSelect;
export type EnvironmentRoleRow = typeof environmentRoles.$inferSelect;
export type ServiceRow = typeof services.$inferSelect;
export type RouteRow = typeof routes.$inferSelect;
export type ConsumerRow = typeof consumers.$inferSelect;
export type KeyAuthCredentialRow = typeof keyAuthCredentials.$inferSelect;
export type JwtCredentialRow = typeof jwtCredentials.$inferSelect;
export type BasicAuthCredentialRow = typeof basicAuthCredentials.$inferSelect;
export type PluginRow = typeof plugins.$inferSelect;
export type SnapshotRow = typeof snapshots.$inferSelect;

export const clusters = pgTable("clusters", {
  id: uuid("id").primaryKey().defaultRandom(),
  environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  registrationTokenHash: text("registration_token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("clusters_env_name_uq").on(t.environmentId, t.name), uniqueIndex("clusters_token_uq").on(t.registrationTokenHash)]);

export const clusterNodes = pgTable("cluster_nodes", {
  clusterId: uuid("cluster_id").notNull().references(() => clusters.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  hostname: text("hostname").notNull(),
  kongVersion: text("kong_version").notNull(),
  agentVersion: text("agent_version").notNull(),
  labels: jsonb("labels").$type<Record<string, string>>().notNull().default({}),
  state: text("state", { enum: ["applying", "applied", "failed", "idle"] }).notNull().default("idle"),
  appliedVersion: integer("applied_version"),
  appliedHash: text("applied_hash"),
  failedVersion: integer("failed_version"),
  error: text("error"),
  kongHealthy: boolean("kong_healthy").notNull().default(false),
  reportedAt: timestamp("reported_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.clusterId, t.nodeId] }), uniqueIndex("cluster_nodes_token_uq").on(t.tokenHash)]);

export type ClusterRow = typeof clusters.$inferSelect;
export type ClusterNodeRow = typeof clusterNodes.$inferSelect;

/**
 * Calls to the v1 operations the controlled migration will cut (decision H-9), per UTC day and API token (null: the
 * sessions, i.e. the UI). Kept 30 days; the cut needs no token call in that window.
 */
export const apiV1Usage = pgTable(
  "api_v1_usage",
  {
    day: date("day").notNull(),
    tokenId: uuid("token_id").references(() => apiTokens.id, { onDelete: "cascade" }),
    calls: integer("calls").notNull(),
  },
  (t) => [unique("api_v1_usage_day_token_uq").on(t.day, t.tokenId).nullsNotDistinct()],
);

export type UpstreamRow = typeof upstreams.$inferSelect;
export type TargetRow = typeof targets.$inferSelect;
export type CertificateRow = typeof certificates.$inferSelect;
