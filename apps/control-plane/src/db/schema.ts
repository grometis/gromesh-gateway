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
    /** Why the draft requires an explicit publish: an import, or a privileged plugin change (contract: autoPublishPausedReason). */
    draftPauseReason: text("draft_pause_reason", { enum: ["import", "privileged"] }),
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

/**
 * The instance's workspace creation policy (GW-ADMIN-01, WS-M0): one row once platform administration sets it. No row:
 * restricted-request without creatorBecomesAdmin, the restrictive default.
 */
export const workspaceCreationPolicy = pgTable(
  "workspace_creation_policy",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    mode: text("mode", { enum: ["restricted-request", "autonomous", "admin-only"] }).notNull(),
    creatorBecomesAdmin: boolean("creator_becomes_admin").notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("workspace_creation_policy_singleton_ck", sql`${t.singleton}`),
    check("workspace_creation_policy_mode_ck", sql`${t.mode} in ('restricted-request', 'autonomous', 'admin-only')`),
  ],
);

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
    // WS-U0: "explicit" for a service written through v2 (bound to an upstream only by upstream_id, its host otherwise
    // plain DNS); null for v1, whose host binds to an upstream of the same name.
    binding: text("binding", { enum: ["explicit"] }),
    upstreamId: uuid("upstream_id"),
    ...timestamps,
  },
  // Referenced with the workspace (composite foreign keys): nothing can point at an entity of another workspace.
  (t) => [
    uniqueIndex("services_env_name_uq").on(t.environmentId, t.name),
    unique("services_env_id_uq").on(t.environmentId, t.id),
    foreignKey({ name: "services_upstream_fk", columns: [t.environmentId, t.upstreamId], foreignColumns: [upstreams.environmentId, upstreams.id] }).onDelete("restrict"),
    check("services_binding_ck", sql`${t.binding} is null or ${t.binding} = 'explicit'`),
    check("services_upstream_binding_ck", sql`${t.upstreamId} is null or ${t.binding} = 'explicit'`),
  ],
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
    // Decision H-14: imported without its key (the stored one is a value nobody knows), out of the compiled config
    // until rotated.
    pendingReprovision: boolean("pending_reprovision").notNull().default(false),
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
    // Decision H-14: HS256 imported without its secret (null), out of the compiled config until rotated.
    pendingReprovision: boolean("pending_reprovision").notNull().default(false),
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
  // The cluster's single active delivery flow (DeliveryProtocolState, decisions D2/D5): changed only by
  // setClusterDeliveryProtocol and by the activation gate (v2-pending -> v2).
  deliveryProtocol: text("delivery_protocol", { enum: ["v1", "v2-pending", "v2"] }).notNull().default("v1"),
  deliveryProtocolChangedAt: timestamp("delivery_protocol_changed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("clusters_env_name_uq").on(t.environmentId, t.name),
  uniqueIndex("clusters_token_uq").on(t.registrationTokenHash),
  check("clusters_delivery_protocol_ck", sql`${t.deliveryProtocol} in ('v1', 'v2-pending', 'v2')`),
]);

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
  // Instance deployments (N3), alongside the v1 columns: the epoch and revision the agent confirmed (even with the same
  // hash) or failed to apply.
  epoch: integer("epoch"),
  appliedRevision: integer("applied_revision"),
  failedRevision: integer("failed_revision"),
  // v2 StatusReport (N3-C4): the deployment hash the agent declares applied with Kong's own config hash, the failure
  // reason, and the highest revision this node was verified at (revision-regression is measured against it).
  deploymentHash: text("deployment_hash"),
  kongConfigHash: text("kong_config_hash"),
  failedDeploymentHash: text("failed_deployment_hash"),
  failureReason: text("failure_reason"),
  verifiedEpoch: integer("verified_epoch"),
  verifiedRevision: integer("verified_revision"),
  // The node's last ConvergenceEvidence, so a divergence is audited once when it opens and once when it clears.
  evidence: text("evidence"),
  error: text("error"),
  kongHealthy: boolean("kong_healthy").notNull().default(false),
  reportedAt: timestamp("reported_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.clusterId, t.nodeId] }), uniqueIndex("cluster_nodes_token_uq").on(t.tokenHash)]);

export type ClusterRow = typeof clusters.$inferSelect;
export type ClusterNodeRow = typeof clusterNodes.$inferSelect;

/**
 * Calls to the v1 operations the controlled migration will cut (decision H-9), per UTC day and API token (null: the
 * sessions, i.e. the UI). Kept 30 days; the cut needs no token call in that window. The token's name and owner are
 * copied, not referenced: deleting the token or its owner must not erase a call from the window.
 */
export const apiV1Usage = pgTable(
  "api_v1_usage",
  {
    day: date("day").notNull(),
    tokenId: uuid("token_id"),
    tokenName: text("token_name"),
    ownerId: uuid("owner_id"),
    calls: integer("calls").notNull(),
  },
  (t) => [unique("api_v1_usage_day_token_uq").on(t.day, t.tokenId).nullsNotDistinct()],
);

// Each control-plane replica counting the v1 calls: from its start, confirmed up to seen_at (its counts written up
// to then); closed once stopped cleanly.
export const apiV1UsageReplicas = pgTable("api_v1_usage_replicas", {
  replicaId: uuid("replica_id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
  closed: boolean("closed").notNull().default(false),
});

export type UpstreamRow = typeof upstreams.$inferSelect;
export type TargetRow = typeof targets.$inferSelect;
export type CertificateRow = typeof certificates.$inferSelect;

/**
 * The instance's own Ed25519 signing keys (B §4.5). kid is the RFC 7638 thumbprint of public_key; private_key holds
 * only the sealed seed (enc:v2, bound to this row). Status follows from the timestamps: revoked, else retired, else active.
 */
export const instanceSigningKeys = pgTable(
  "instance_signing_keys",
  {
    kid: text("kid").primaryKey(),
    publicKey: text("public_key").notNull(),
    privateKey: text("private_key").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("instance_signing_keys_public_key_uq").on(t.publicKey),
    check("instance_signing_keys_sealed_ck", sql`${t.privateKey} like 'enc:v2:%'`),
    check("instance_signing_keys_validity_ck", sql`${t.validUntil} > ${t.validFrom}`),
  ],
);
export type InstanceSigningKeyRow = typeof instanceSigningKeys.$inferSelect;

/**
 * One isolation admission request of a pod in a boot (agent protocol v2), recorded with a new cluster challenge
 * before any decision; granted ones are the admissions (admission_id, state, the signed document and its kid). The
 * acked chain is the probe's reports 1..acked_seq, contiguous and linked by digest; last_* describe its newest report.
 */
export const isolationAdmissions = pgTable(
  "isolation_admissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id").notNull().references(() => clusters.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    podUid: uuid("pod_uid").notNull(),
    podName: text("pod_name").notNull(),
    nodeName: text("node_name").notNull(),
    bootId: uuid("boot_id").notNull(),
    probePublicKey: text("probe_public_key").notNull(),
    challenge: text("challenge").notNull(),
    // Order of the cluster's challenges, assigned under its lock: the current one is the latest pending by this order.
    challengeSeq: integer("challenge_seq").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    outcome: text("outcome", { enum: ["pending", "granted", "refused"] }).notNull().default("pending"),
    reason: text("reason", { enum: ["pendency-open", "chain-not-answered", "timeout", "no-signing-key"] }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    admissionId: uuid("admission_id").unique("isolation_admissions_admission_uq"),
    admission: jsonb("admission").$type<{ protected: string; payload: string; signature: string }>(),
    kid: text("kid"),
    startDeadline: timestamp("start_deadline", { withTimezone: true }),
    state: text("state", { enum: ["open", "closed", "closed-without-proof"] }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason"),
    ackedSeq: integer("acked_seq").notNull().default(0),
    lastDigest: text("last_digest"),
    lastReportAt: timestamp("last_report_at", { withTimezone: true }),
    lastState: text("last_state"),
    lastFailed: jsonb("last_failed").$type<string[]>().notNull().default([]),
    leaseRemainingMs: integer("lease_remaining_ms"),
    lastConclusiveAt: timestamp("last_conclusive_at", { withTimezone: true }),
    kongStopConfirmed: boolean("kong_stop_confirmed"),
    // A released confirmed-violation covers the probe's sticky violation reports until it reports anything else.
    violationReleased: boolean("violation_released").notNull().default(false),
  },
  (t) => [
    uniqueIndex("isolation_admissions_challenge_uq").on(t.challenge),
    uniqueIndex("isolation_admissions_challenge_seq_uq").on(t.clusterId, t.challengeSeq),
    uniqueIndex("isolation_admissions_pod_boot_uq").on(t.clusterId, t.podUid, t.bootId).where(sql`${t.outcome} <> 'refused'`),
    index("isolation_admissions_cluster_idx").on(t.clusterId, t.outcome),
    check("isolation_admissions_granted_ck", sql`(${t.outcome} = 'granted') = (${t.admissionId} is not null and ${t.state} is not null)`),
    check("isolation_admissions_refused_ck", sql`(${t.outcome} = 'refused') = (${t.reason} is not null)`),
  ],
);

/** Every probe report received for an admission, as signed; the chain is checked when it becomes contiguous. */
export const isolationReports = pgTable(
  "isolation_reports",
  {
    admissionId: uuid("admission_id").notNull().references(() => isolationAdmissions.admissionId, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    protected: text("protected").notNull(),
    payload: text("payload").notNull(),
    signature: text("signature").notNull(),
    digest: text("digest").notNull(),
    prevDigest: text("prev_digest"),
    state: text("state").notNull(),
    failedCapabilities: jsonb("failed_capabilities").$type<string[]>().notNull(),
    challenge: text("challenge"),
    leaseRemainingMs: integer("lease_remaining_ms"),
    final: boolean("final").notNull(),
    finalReason: text("final_reason"),
    kongStopConfirmed: boolean("kong_stop_confirmed"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.admissionId, t.seq] }), index("isolation_reports_challenge_idx").on(t.admissionId, t.challenge)],
);

/** IsolationPendencyLifecycle: lifecycle is the contract's state; kind the last kind it had while open. */
export const isolationPendencies = pgTable(
  "isolation_pendencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id").notNull().references(() => clusters.id, { onDelete: "cascade" }),
    lifecycle: text("lifecycle", { enum: ["communication-failure", "confirmed-violation", "unconfirmed-isolation", "closed", "released"] }).notNull(),
    kind: text("kind", { enum: ["communication-failure", "confirmed-violation", "unconfirmed-isolation"] }).notNull(),
    scope: text("scope", { enum: ["cluster", "node"] }).notNull(),
    nodeName: text("node_name"),
    podUid: uuid("pod_uid"),
    admissionId: uuid("admission_id"),
    capability: text("capability"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason", { enum: ["chain-resumed", "released"] }),
    releasedBy: jsonb("released_by").$type<Actor>(),
    justification: text("justification"),
  },
  (t) => [index("isolation_pendencies_cluster_idx").on(t.clusterId, t.lifecycle), index("isolation_pendencies_admission_idx").on(t.admissionId)],
);

/** Signed releases (gromesh-isolation-release+json), served to the cluster's agents until they expire. */
export const isolationReleases = pgTable(
  "isolation_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id").notNull().references(() => clusters.id, { onDelete: "cascade" }),
    pendencyId: uuid("pendency_id").notNull().references(() => isolationPendencies.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["confirmed-violation", "unconfirmed-isolation"] }).notNull(),
    release: jsonb("release").$type<{ protected: string; payload: string; signature: string }>().notNull(),
    kid: text("kid").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("isolation_releases_pendency_uq").on(t.pendencyId), index("isolation_releases_cluster_idx").on(t.clusterId, t.expiresAt)],
);

export type IsolationAdmissionRow = typeof isolationAdmissions.$inferSelect;
export type IsolationPendencyRow = typeof isolationPendencies.$inferSelect;

const digest = (column: unknown) => sql`${column} ~ '^sha256:[0-9a-f]{64}$'`;

/**
 * An immutable version of a workspace (C §4): a trigger refuses UPDATE and DELETE. A rollback copy keeps the content's
 * provenance (content_origin_version, origin_promotion_id); its first activation lives in content_activations.
 * promotion_id, origin_promotion_id and attestation_id name tables that do not exist yet: no foreign key.
 */
export const releases = pgTable(
  "releases",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    version: integer("version").notNull(),
    // The workspace's GatewayState, secrets as references to variables; stored sealed.
    content: jsonb("content").$type<SealedJson | GatewayState>().notNull(),
    contentDigest: text("content_digest").notNull(),
    origin: text("origin", { enum: ["local", "promotion", "rollback", "tombstone", "migration"] }).notNull(),
    promotionId: uuid("promotion_id"),
    rollbackOf: integer("rollback_of"),
    message: text("message"),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    contentOriginVersion: integer("content_origin_version").notNull(),
    originPromotionId: uuid("origin_promotion_id"),
    attestationId: uuid("attestation_id"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.version] }),
    index("releases_content_idx").on(t.workspaceId, t.contentDigest),
    check("releases_version_ck", sql`${t.version} >= 1 and ${t.contentOriginVersion} between 1 and ${t.version}`),
    check("releases_content_digest_ck", digest(t.contentDigest)),
    check("releases_origin_ck", sql`${t.origin} in ('local', 'promotion', 'rollback', 'tombstone', 'migration')`),
    check("releases_promotion_origin_ck", sql`${t.origin} <> 'promotion' or ${t.originPromotionId} is not null`),
  ],
);
export type ReleaseRow = typeof releases.$inferSelect;

/** The first time each content converged here (G-2): insert only. No row: never converged, no emergency rollback. */
export const contentActivations = pgTable(
  "content_activations",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    contentDigest: text("content_digest").notNull(),
    firstActivatedAt: timestamp("first_activated_at", { withTimezone: true }).notNull(),
    deploymentRevision: integer("deployment_revision").notNull(),
    originPromotionId: uuid("origin_promotion_id"),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.contentDigest] }), check("content_activations_digest_ck", digest(t.contentDigest))],
);

/** Content withdrawn for security (G-2), for every release with that digest: insert only. */
export const contentRevocations = pgTable(
  "content_revocations",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    contentDigest: text("content_digest").notNull(),
    reason: text("reason").notNull(),
    revokedBy: jsonb("revoked_by").$type<Actor>().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.contentDigest] }), check("content_revocations_digest_ck", digest(t.contentDigest))],
);

export interface DeploymentMember {
  workspaceId: string;
  releaseVersion: number;
  contentDigest: string;
}

/**
 * A revision of the instance's composed config (C §4), immutable like releases. The epoch changes with the agent
 * protocol (C-18); expected_nodes is fixed when the deployment is created (C-16).
 */
export const deployments = pgTable(
  "deployments",
  {
    epoch: integer("epoch").notNull(),
    revision: integer("revision").notNull(),
    // Ordered.
    members: jsonb("members").$type<DeploymentMember[]>().notNull(),
    expectedNodes: jsonb("expected_nodes").notNull(),
    mandatoryPluginsVersion: integer("mandatory_plugins_version"),
    valuesDigest: text("values_digest"),
    // The composed Kong config; stored sealed.
    config: jsonb("config").$type<SealedJson | KongDeclarativeConfig>().notNull(),
    configHash: text("config_hash").notNull(),
    // md5 of the JCS bytes of config, what Kong reports for them (N3-K1); derived here, never learned from a node.
    kongConfigHash: text("kong_config_hash"),
    reason: text("reason", { enum: ["publish", "promotion", "rollback", "reconcile", "mandatory-plugins", "values"] }).notNull(),
    promotionId: uuid("promotion_id"),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.epoch, t.revision] }),
    check("deployments_revision_ck", sql`${t.epoch} >= 1 and ${t.revision} >= 1`),
    check("deployments_config_hash_ck", digest(t.configHash)),
    check("deployments_kong_config_hash_ck", sql`${t.kongConfigHash} ~ '^[0-9a-f]{32}$'`),
    check("deployments_reason_ck", sql`${t.reason} in ('publish', 'promotion', 'rollback', 'reconcile', 'mandatory-plugins', 'values')`),
  ],
);
export type DeploymentRow = typeof deployments.$inferSelect;

/** The active release of each workspace, materialized from deployments for reading. */
export const workspaceActiveRelease = pgTable(
  "workspace_active_release",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id),
    version: integer("version").notNull(),
    // The revision that last composed it; null between publishRelease and the next createDeployment (D4).
    deploymentRevision: integer("deployment_revision"),
  },
  (t) => [foreignKey({ name: "workspace_active_release_release_fk", columns: [t.workspaceId, t.version], foreignColumns: [releases.workspaceId, releases.version] })],
);

/**
 * One deployment in progress per instance (C-16): a single row, created by the migration, taken in the transaction
 * that creates the deployment and released on converged, failed or deadline. It outlives a control-plane crash.
 */
export const deploymentLease = pgTable(
  "deployment_lease",
  {
    id: boolean("id").primaryKey().default(true),
    revision: integer("revision"),
    operation: text("operation"),
    owner: jsonb("owner"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  },
  (t) => [check("deployment_lease_single_ck", sql`${t.id}`)],
);

/**
 * This control plane's instance (D1, anticipated from N4): one row, created on the first Workspaces deployment with
 * the stage of the configuration, never changed nor removed afterwards (a trigger refuses both). Its signing keys are
 * instance_signing_keys: the identity is this id plus those keys, with no second key pair of its own.
 */
export const instance = pgTable(
  "instance",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    id: uuid("id").notNull().defaultRandom(),
    stage: text("stage", { enum: ["dev", "hml", "prd"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("instance_id_uq").on(t.id), check("instance_singleton_ck", sql`${t.singleton}`), check("instance_stage_ck", sql`${t.stage} in ('dev', 'hml', 'prd')`)],
);
export type InstanceRow = typeof instance.$inferSelect;

/**
 * The DeploymentState machine of each deployment (contract: x-gromesh-transitions), one row per transition: deployments
 * stay immutable and the history is append-only like them. The current state is the highest seq.
 */
export const deploymentStates = pgTable(
  "deployment_states",
  {
    epoch: integer("epoch").notNull(),
    revision: integer("revision").notNull(),
    seq: integer("seq").notNull(),
    state: text("state", { enum: ["composed", "rejected", "active", "converging", "converged", "degraded", "failed", "superseded"] }).notNull(),
    reason: text("reason").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.epoch, t.revision, t.seq] }),
    foreignKey({ name: "deployment_states_deployment_fk", columns: [t.epoch, t.revision], foreignColumns: [deployments.epoch, deployments.revision] }),
    check("deployment_states_seq_ck", sql`${t.seq} >= 1`),
    check("deployment_states_state_ck", sql`${t.state} in ('composed', 'rejected', 'active', 'converging', 'converged', 'degraded', 'failed', 'superseded')`),
  ],
);

