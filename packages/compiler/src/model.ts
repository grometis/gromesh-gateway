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
  /**
   * WS-U0: "explicit" for a service written through v2, which balances across an upstream only by upstreamId (its
   * host is otherwise ordinary DNS, never captured by an upstream of the same name). Absent: the v1 binding by name.
   */
  binding?: "explicit";
  upstreamId?: string | null;
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
  analyticsRetentionDays?: number | null;
  tags?: string[];
}

export interface Consumer {
  id: string;
  username?: string | null;
  customId?: string | null;
  /** ACL group names (`^[a-z0-9_-]{1,64}$`), matched by the acl plugin's allow/deny. */
  aclGroups?: string[];
  tags?: string[];
}

export interface KeyAuthCredential {
  id: string;
  consumerId: string;
  key: string;
  tags?: string[];
  /**
   * Decision H-14: imported without its key (an import never sets one), so `key` is a value nobody knows and the
   * credential is left out of the compiled config until it is rotated.
   */
  pendingReprovision?: boolean;
}

export type JwtAlgorithm = "HS256" | "RS256" | "ES256";

/** HS256 verifies with the shared `secret`; RS256/ES256 with `rsaPublicKey` (an EC key for ES256). */
export interface JwtCredential {
  id: string;
  consumerId: string;
  /** Matched against the token's `iss` claim. */
  key: string;
  algorithm: JwtAlgorithm;
  secret?: string | null;
  rsaPublicKey?: string | null;
  tags?: string[];
  /** HS256 imported without its secret (decision H-14): left out of the compiled config until it is rotated. */
  pendingReprovision?: boolean;
}

export interface BasicAuthCredential {
  id: string;
  consumerId: string;
  username: string;
  /** Kong's salted hash (see basicAuthPasswordHash), never the password itself. */
  passwordHash: string;
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

export type UpstreamAlgorithm = "round-robin" | "least-connections" | "consistent-hashing" | "latency";
export type HashOn = "none" | "consumer" | "ip" | "header" | "cookie";

export interface UpstreamHealthchecks {
  active?: {
    type: "http" | "https" | "tcp";
    httpPath?: string;
    intervalSeconds?: number;
    healthyThreshold?: number;
    unhealthyThreshold?: number;
    timeoutSeconds?: number;
  } | null;
  passive?: { unhealthyHttpFailures?: number; unhealthyTimeouts?: number } | null;
}

/** A load-balancing pool: a service whose host equals `name` balances across its targets. */
export interface Upstream {
  id: string;
  name: string;
  algorithm?: UpstreamAlgorithm;
  hashOn?: HashOn;
  hashFallback?: HashOn;
  hashOnHeader?: string | null;
  hashFallbackHeader?: string | null;
  hashOnCookie?: string | null;
  hashOnCookiePath?: string | null;
  healthchecks?: UpstreamHealthchecks;
  tags?: string[];
}

export interface Target {
  id: string;
  upstreamId: string;
  /** host:port, IPv6 in brackets */
  target: string;
  weight?: number;
  tags?: string[];
}

/** A TLS certificate (leaf first, then intermediates) with its private key and server names. */
export interface Certificate {
  id: string;
  cert: string;
  key: string;
  snis: string[];
  tags?: string[];
}

/** Everything that affects traffic in one environment, at one point in time. */
export interface GatewayState {
  services: Service[];
  routes: Route[];
  consumers: Consumer[];
  keyAuthCredentials: KeyAuthCredential[];
  /** Absent in states stored before JWT and basic-auth existed: treated as empty. */
  jwtCredentials?: JwtCredential[];
  basicAuthCredentials?: BasicAuthCredential[];
  plugins: Plugin[];
  /** Absent in states stored before load balancing and TLS existed: treated as empty. */
  upstreams?: Upstream[];
  targets?: Target[];
  certificates?: Certificate[];
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

export interface KongJwtSecret {
  id: string;
  consumer: string;
  key: string;
  algorithm: string;
  secret?: string;
  rsa_public_key?: string;
  tags: string[];
}

export interface KongBasicAuthCredential {
  id: string;
  consumer: string;
  username: string;
  /** Already hashed: the config is applied with `_transform: false`. */
  password: string;
  tags: string[];
}

export interface KongAcl {
  id: string;
  consumer: string;
  group: string;
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

export interface KongUpstream {
  id: string;
  name: string;
  algorithm: string;
  hash_on?: string;
  hash_fallback?: string;
  hash_on_header?: string;
  hash_fallback_header?: string;
  hash_on_cookie?: string;
  hash_on_cookie_path?: string;
  healthchecks?: Record<string, unknown>;
  tags: string[];
}

export interface KongTarget {
  id: string;
  upstream: string;
  target: string;
  weight: number;
  tags: string[];
}

export interface KongCertificate {
  id: string;
  cert: string;
  key: string;
  tags: string[];
}

export interface KongSni {
  id: string;
  name: string;
  certificate: string;
  tags: string[];
}

/**
 * The credential, load-balancing and TLS arrays are emitted only when non-empty, so older configs keep their hash.
 * `_transform` is false only when basic-auth credentials are present (their passwords are already hashed).
 */
export interface KongDeclarativeConfig {
  _format_version: "3.0";
  _transform: boolean;
  services: KongService[];
  routes: KongRoute[];
  consumers: KongConsumer[];
  keyauth_credentials: KongKeyAuthCredential[];
  jwt_secrets?: KongJwtSecret[];
  basicauth_credentials?: KongBasicAuthCredential[];
  acls?: KongAcl[];
  plugins: KongPlugin[];
  upstreams?: KongUpstream[];
  targets?: KongTarget[];
  certificates?: KongCertificate[];
  snis?: KongSni[];
}

/** What the agent downloads and applies. See contracts/snapshot.schema.json. */
export interface SnapshotEnvelope {
  version: number;
  hash: string;
  environmentId: string;
  createdAt: string;
  config: KongDeclarativeConfig;
}
