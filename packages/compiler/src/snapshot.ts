import { compile } from "./compile.js";
import { hashConfig } from "./hash.js";
import type { CompileOptions, GatewayState, SnapshotEnvelope } from "./model.js";

export interface SnapshotMeta {
  version: number;
  environmentId: string;
  createdAt?: string;
}

export function buildSnapshot(state: GatewayState, meta: SnapshotMeta, options?: CompileOptions): SnapshotEnvelope {
  if (!Number.isInteger(meta.version) || meta.version < 1) {
    throw new RangeError("version must be a positive integer");
  }
  const config = compile(state, options);
  return {
    version: meta.version,
    hash: hashConfig(config),
    environmentId: meta.environmentId,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    config,
  };
}
