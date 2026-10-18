import { sql } from "drizzle-orm";
import {
  boolean,
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
  (t) => [uniqueIndex("services_env_name_uq").on(t.environmentId, t.name)],
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
  (t) => [uniqueIndex("upstreams_env_name_uq").on(t.environmentId, t.name)],
);

export const targets = pgTable(
  "targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    upstreamId: uuid("upstream_id")
      .notNull()
      .references(() => upstreams.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
    weight: integer("weight").notNull().default(100),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (t) => [uniqueIndex("targets_upstream_target_uq").on(t.upstreamId, t.target), index("targets_env_idx").on(t.environmentId)],
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
  (t) => [index("certificates_env_idx").on(t.environmentId)],
);

/** One row per server name: the unique index keeps SNIs unique in the environment, races included. */
export const certificateSnis = pgTable(
  "certificate_snis",
  {
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    certificateId: uuid("certificate_id")
      .notNull()
      .references(() => certificates.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.name] }), index("certificate_snis_cert_idx").on(t.certificateId)],
);

export const routes = pgTable(
  "routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    // RESTRICT: a service with routes cannot be deleted (409 for the API).
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    protocols: text("protocols").array().notNull().default(sql`'{http,https}'::text[]`),
    methods: text("methods").array(),
    hosts: text("hosts").array(),
    paths: text("paths").array(),
    headers: jsonb("headers").$type<Record<string, string[]>>(),
    stripPath: boolean("strip_path").notNull().default(true),
    preserveHost: boolean("preserve_host").notNull().default(false),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("routes_env_name_uq").on(t.environmentId, t.name),
    index("routes_service_idx").on(t.serviceId),
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
  ],
);

export const keyAuthCredentials = pgTable(
  "keyauth_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    consumerId: uuid("consumer_id")
      .notNull()
      .references(() => consumers.id, { onDelete: "cascade" }),
    // Kong needs the clear key in the declarative config, so it is stored encrypted (see crypto/), not hashed.
    key: text("key").notNull(),
    // sha256 of the clear key: uniqueness per environment without decrypting.
    keyHash: text("key_hash").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("keyauth_env_key_hash_uq").on(t.environmentId, t.keyHash), index("keyauth_consumer_idx").on(t.consumerId)],
);

export const jwtCredentials = pgTable(
  "jwt_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    consumerId: uuid("consumer_id")
      .notNull()
      .references(() => consumers.id, { onDelete: "cascade" }),
    // The issuer: public, matched against the token's iss claim.
    key: text("key").notNull(),
    algorithm: text("algorithm").notNull(),
    // HS256 only; sealed (enc:v2, context jwt_credentials.secret + id) because Kong needs it in clear.
    secret: text("secret"),
    rsaPublicKey: text("rsa_public_key"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("jwt_env_key_uq").on(t.environmentId, t.key), index("jwt_consumer_idx").on(t.consumerId)],
);

export const basicAuthCredentials = pgTable(
  "basicauth_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    consumerId: uuid("consumer_id")
      .notNull()
      .references(() => consumers.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    // Kong's salted hash, never the password; still a secret, so sealed (enc:v2, context
    // basicauth_credentials.password_hash + id).
    passwordHash: text("password_hash").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("basicauth_env_username_uq").on(t.environmentId, t.username), index("basicauth_consumer_idx").on(t.consumerId)],
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
    // A scoped plugin goes away with the entity it is attached to.
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    routeId: uuid("route_id").references(() => routes.id, { onDelete: "cascade" }),
    consumerId: uuid("consumer_id").references(() => consumers.id, { onDelete: "cascade" }),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    protocols: text("protocols").array(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  // Kong allows one instance of a plugin per (name, service, route, consumer); NULL counts as a value.
  (t) => [unique("plugins_env_scope_uq").on(t.environmentId, t.name, t.serviceId, t.routeId, t.consumerId).nullsNotDistinct()],
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

export type UpstreamRow = typeof upstreams.$inferSelect;
export type TargetRow = typeof targets.$inferSelect;
export type CertificateRow = typeof certificates.$inferSelect;
