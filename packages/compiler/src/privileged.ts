import { canonicalJson } from "./hash.js";
import type { GatewayState, Plugin } from "./model.js";

export interface PrivilegedUse {
  path: string;
  message: string;
}

/** Whole plugins that run code or write files inside the gateway container. */
const PRIVILEGED_PLUGINS = new Set(["pre-function", "post-function", "file-log"]);
const AI_PLUGINS: Record<string, string[]> = {
  "ai-proxy": [],
  "ai-request-transformer": ["llm"],
  "ai-response-transformer": ["llm"],
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const at = (value: unknown, keys: string[]): unknown => keys.reduce<unknown>((cur, key) => (isRecord(cur) ? cur[key] : undefined), value);
const present = (v: unknown) => typeof v === "string" && v.length > 0;

/**
 * What in a plugin is reserved to the platform admin (contract: Privileged plugin capabilities): code run by the
 * gateway can read its environment (the collector token), and a plugin without its own credentials falls back to
 * the pod's (instance metadata, service account). Paths are relative to the plugin, like `config.access`.
 */
export function privilegedUses(plugin: Pick<Plugin, "name" | "config">): PrivilegedUse[] {
  const config = plugin.config ?? {};
  const uses: PrivilegedUse[] = [];
  if (PRIVILEGED_PLUGINS.has(plugin.name)) uses.push({ path: "name", message: `plugin "${plugin.name}" is reserved to the platform admin` });
  // An empty map runs no Lua (a form may send it for an untouched field).
  const lua = config.custom_fields_by_lua;
  if (lua !== undefined && lua !== null && !(isRecord(lua) && Object.keys(lua).length === 0)) {
    uses.push({ path: "config.custom_fields_by_lua", message: "Lua fields are reserved to the platform admin" });
  }
  if (plugin.name === "aws-lambda" && !(present(config.aws_key) && present(config.aws_secret))) {
    uses.push({ path: "config.aws_key", message: "without its own aws_key and aws_secret the plugin uses the gateway's credentials, reserved to the platform admin" });
  }
  const prefix = AI_PLUGINS[plugin.name];
  if (prefix) {
    const base = ["config", ...prefix];
    const auth = at(config, [...prefix, "auth"]);
    if (at(auth, ["gcp_use_service_account"]) === true) {
      uses.push({ path: [...base, "auth", "gcp_use_service_account"].join("."), message: "the gateway's service account is reserved to the platform admin" });
    }
    if (at(config, [...prefix, "model", "provider"]) === "bedrock" && !(present(at(auth, ["aws_access_key_id"])) && present(at(auth, ["aws_secret_access_key"])))) {
      uses.push({ path: [...base, "auth", "aws_access_key_id"].join("."), message: "without its own AWS keys the plugin uses the gateway's credentials, reserved to the platform admin" });
    }
  }
  return uses;
}

/**
 * The privileged plugins of a state with everything that decides what they do (scope, config, enabled), in a
 * stable form: two states with the same value put the same privileged configuration live.
 */
export function privilegedFingerprint(state: Pick<GatewayState, "plugins">): string {
  const privileged = state.plugins
    .filter((p) => privilegedUses(p).length > 0)
    .map((p) => ({ id: p.id, name: p.name, enabled: p.enabled ?? true, scope: p.scope ?? {}, config: p.config ?? {}, protocols: p.protocols ?? [] }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return canonicalJson(privileged);
}
