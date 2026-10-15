/**
 * Gromesh domain model: what the control plane stores and publishes.
 * Deliberately independent of Kong's schema — the compiler is the only place
 * that knows the Kong declarative format.
 */

export type ServiceProtocol = "http" | "https" | "grpc" | "grpcs" | "tcp" | "tls";
export type RouteProtocol = "http" | "https" | "grpc" | "grpcs";

export interface Service {
  id: string;
  name: string;
  protocol: ServiceProtocol;
  host: string;
  port: number;
  path?: string | null;
  retries?: number;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
  enabled?: boolean;
  tags?: string[];
}

export interface Route {
  id: string;
  name: string;
  serviceId: string;
  protocols?: RouteProtocol[];
  methods?: string[];
  hosts?: string[];
  paths?: string[];
  headers?: Record<string, string[]>;
  stripPath?: boolean;
  preserveHost?: boolean;
  tags?: string[];
}

export interface Consumer {
  id: string;
  username?: string | null;
  customId?: string | null;
  tags?: string[];
}

export interface KeyAuthCredential {
  id: string;
  consumerId: string;
  key: string;
  tags?: string[];
}

export interface PluginScope {
  serviceId?: string | null;
  routeId?: string | null;
  consumerId?: string | null;
}

export interface Plugin {
  id: string;
  name: string;
  enabled?: boolean;
  scope?: PluginScope;
  config?: Record<string, unknown>;
  protocols?: string[];
  tags?: string[];
}

/** Everything that affects traffic in one environment, at one point in time. */
export interface GatewayState {
  services: Service[];
  routes: Route[];
  consumers: Consumer[];
  keyAuthCredentials: KeyAuthCredential[];
  plugins: Plugin[];
}

export interface CompileOptions {
  /** Tag added to every emitted entity so Gromesh-managed config is identifiable. */
  managedTag?: string;
  /**
   * Plugins injected by the platform itself (e.g. prometheus, http-log).
   * They are global unless they carry a scope.
   */
  platformPlugins?: Plugin[];
}

/* ---------- Kong declarative config (format 3.0, flat) ---------- */

export interface KongService {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  path?: string;
  retries?: number;
  connect_timeout?: number;
  read_timeout?: number;
  write_timeout?: number;
  enabled?: boolean;
  tags: string[];
}

export interface KongRoute {
  id: string;
  name: string;
  service: string;
  protocols?: string[];
  methods?: string[];
  hosts?: string[];
  paths?: string[];
  headers?: Record<string, string[]>;
  strip_path?: boolean;
  preserve_host?: boolean;
  tags: string[];
}

export interface KongConsumer {
  id: string;
  username?: string;
  custom_id?: string;
  tags: string[];
}

export interface KongKeyAuthCredential {
  id: string;
  consumer: string;
  key: string;
  tags: string[];
}

export interface KongPlugin {
  id: string;
  name: string;
  enabled: boolean;
  service?: string;
  route?: string;
  consumer?: string;
  config: Record<string, unknown>;
  protocols?: string[];
  tags: string[];
}

export interface KongDeclarativeConfig {
  _format_version: "3.0";
  _transform: true;
  services: KongService[];
  routes: KongRoute[];
  consumers: KongConsumer[];
  keyauth_credentials: KongKeyAuthCredential[];
  plugins: KongPlugin[];
}

/** What the agent downloads and applies. See contracts/snapshot.schema.json. */
export interface SnapshotEnvelope {
  version: number;
  hash: string;
  environmentId: string;
  createdAt: string;
  config: KongDeclarativeConfig;
}
