// Request shapes from contracts/control-plane.openapi.yaml (validated at runtime by ContractBodyPipe).
export interface EnvironmentWrite {
  name: string;
  description?: string | null;
  publishMode?: "manual" | "auto";
}

export interface ServiceWrite {
  name: string;
  protocol: "http" | "https" | "grpc" | "grpcs" | "tcp" | "tls";
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

export interface RouteWrite {
  name: string;
  serviceId: string;
  protocols?: ("http" | "https" | "grpc" | "grpcs")[];
  methods?: string[];
  hosts?: string[];
  paths?: string[];
  headers?: Record<string, string[]>;
  stripPath?: boolean;
  preserveHost?: boolean;
  analyticsRetentionDays?: number | null;
  tags?: string[];
}

export interface PublishRequest {
  message?: string;
  expectedCurrentVersion?: number | null;
}

export interface ConsumerWrite {
  username?: string | null;
  customId?: string | null;
  tags?: string[];
}

export interface KeyAuthCredentialWrite {
  key?: string;
  tags?: string[];
}

export interface JwtCredentialCreate {
  key?: string;
  algorithm: "HS256" | "RS256" | "ES256";
  secret?: string;
  rsaPublicKey?: string;
  tags?: string[];
}

export interface BasicAuthCredentialCreate {
  username: string;
  password: string;
  tags?: string[];
}

export interface AclGroups {
  groups: string[];
}

export interface PluginScope {
  serviceId?: string | null;
  routeId?: string | null;
  consumerId?: string | null;
}

export interface PluginWrite {
  name: string;
  enabled?: boolean;
  scope?: PluginScope;
  config: Record<string, unknown>;
  protocols?: string[];
  tags?: string[];
}

export interface UserCreate {
  email: string;
  name: string;
  role: "viewer" | "editor" | "admin";
  password: string;
}

export interface UserUpdate {
  name?: string;
  role?: "viewer" | "editor" | "admin";
  active?: boolean;
  password?: string;
}

export interface EnvironmentRoles {
  items: { environmentId: string; role: "viewer" | "editor" | "admin" | "none" }[];
}

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

export interface UpstreamWrite {
  name: string;
  algorithm?: "round-robin" | "least-connections" | "consistent-hashing" | "latency";
  hashOn?: HashOn;
  hashFallback?: HashOn;
  hashOnHeader?: string;
  hashFallbackHeader?: string;
  hashOnCookie?: string;
  hashOnCookiePath?: string;
  healthchecks?: UpstreamHealthchecks;
  tags?: string[];
}

export interface TargetWrite {
  target: string;
  weight?: number;
  tags?: string[];
}

export interface CertificateWrite {
  cert: string;
  key: string;
  snis: string[];
  tags?: string[];
}

