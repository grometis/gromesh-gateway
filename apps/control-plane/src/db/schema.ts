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
import type { GatewayState, KongDeclarativeConfig } from "@gromesh/compiler";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export interface Actor {
  type: "user" | "system" | "agent";
  id: string;
  name?: string;
}

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    publishMode: text("publish_mode", { enum: ["manual", "auto"] }).notNull().default("manual"),
    currentVersion: integer("current_version"),
    hasUnpublishedChanges: boolean("has_unpublished_changes").notNull().default(false),
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
    // Kong needs the clear key in the declarative config, so it cannot be stored hashed.
    key: text("key").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("keyauth_env_key_uq").on(t.environmentId, t.key), index("keyauth_consumer_idx").on(t.consumerId)],
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
    config: jsonb("config").$type<KongDeclarativeConfig>().notNull(),
    // Source state, so a rollback can restore the draft exactly.
    state: jsonb("state").$type<GatewayState>().notNull(),
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
