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
  tags?: string[];
}

export interface PublishRequest {
  message?: string;
  expectedCurrentVersion?: number | null;
}
