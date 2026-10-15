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
export type SnapshotRow = typeof snapshots.$inferSelect;
