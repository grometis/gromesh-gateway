import { statusMessage } from "../api/errors";
import { ApiError, unwrap, type Plugin, type PluginCatalogEntry } from "../api/client";
import { apiV2 } from "../api/client-v2";
import type { components } from "../api/schema-v2";
import { isObject, type Config, type PluginSchema } from "../schema-form/schema";

type ContractWrite = components["schemas"]["WorkspacePluginWrite"];
export type WorkspacePluginWrite = Omit<ContractWrite, "config"> & { config: Config };
// Contract v2 reservations and plugins.ts:checkWorkspacePlugin/checkWorkspaceAuthentication.
const UNAVAILABLE = new Set(["key-auth", "basic-auth", "jwt", "hmac-auth", "ldap-auth", "session", "oauth2", "acme", "pre-function", "post-function", "file-log", "prometheus", "http-log"]);
export function consumerPluginAllowed(entry: PluginCatalogEntry | undefined, schema?: PluginSchema) {
  return !!entry && entry.supportedInDbless && entry.category !== "authentication"
    && !UNAVAILABLE.has(entry.name) && !entry.name.startsWith("gromesh-") && (!schema || schema.scopes.consumer);
}

/** The UI never offers platform capabilities, even to a platform admin. The server remains authoritative. */
export function consumerPluginConfigErrors(name: string, config: Config): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  const deny = (path: string) => { errors[`config.${path}`] = ["Esta capacidade é reservada à plataforma."]; };
  const walk = (value: unknown, path = "") => {
    if (Array.isArray(value)) value.forEach((child, i) => walk(child, `${path}.${i}`));
    else if (isObject(value)) for (const [key, child] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key;
      if (key.endsWith("_by_lua") && child != null && !(isObject(child) && !Object.keys(child).length)) deny(next);
      else walk(child, next);
    }
  };
  walk(config);
  const present = (value: unknown) => typeof value === "string" && !!value;
  if (name === "aws-lambda" && !(present(config.aws_key) && present(config.aws_secret))) deny("aws_key");
  const prefix = name === "ai-proxy" ? "" : ["ai-request-transformer", "ai-response-transformer"].includes(name) ? "llm." : null;
  if (prefix !== null) {
    const base = prefix ? config.llm : config;
    if (isObject(base)) {
      const auth = isObject(base.auth) ? base.auth : {};
      if (auth.gcp_use_service_account === true) deny(`${prefix}auth.gcp_use_service_account`);
      if (isObject(base.model) && base.model.provider === "bedrock" && !(present(auth.aws_access_key_id) && present(auth.aws_secret_access_key))) deny(`${prefix}auth.aws_access_key_id`);
    }
  }
  return errors;
}

export function consumerPluginMessage(error: unknown) {
  return statusMessage(error instanceof ApiError ? new ApiError(error.status, undefined) : error);
}

const missing = () => new ApiError(404, { type: "about:blank", title: "Not found", status: 404 });
export function requireConsumerPlugin(plugin: Plugin, consumerId: string): Plugin {
  if (plugin.scope?.consumerId !== consumerId) throw missing();
  return plugin;
}
export async function listConsumerPlugins(workspaceId: string, consumerId: string, cursor?: string, signal?: AbortSignal) {
  const page = await unwrap(apiV2.GET("/workspaces/{workspaceId}/plugins", { params: { path: { workspaceId }, query: { consumerId, ...(cursor ? { cursor } : {}) } }, signal }));
  return { ...page, items: page.items.filter(p => p.scope?.consumerId === consumerId) };
}
export async function getConsumerPlugin(workspaceId: string, consumerId: string, pluginId: string, signal?: AbortSignal) {
  return requireConsumerPlugin(await unwrap(apiV2.GET("/workspaces/{workspaceId}/plugins/{pluginId}", { params: { path: { workspaceId, pluginId } }, signal })), consumerId);
}
export async function saveConsumerPlugin(workspaceId: string, consumerId: string, current: Plugin | null, body: WorkspacePluginWrite, authorize: () => void = () => {}) {
  authorize();
  if (current) requireConsumerPlugin(current, consumerId);
  const consumer = await unwrap(apiV2.GET("/workspaces/{workspaceId}/consumers/{consumerId}", { params: { path: { workspaceId, consumerId } } }));
  if (consumer.id !== consumerId) throw missing();
  authorize();
  const fixed = { ...body, scope: current ? { ...current.scope, consumerId } : { consumerId } } as ContractWrite;
  return current
    ? unwrap(apiV2.PUT("/workspaces/{workspaceId}/plugins/{pluginId}", { params: { path: { workspaceId, pluginId: current.id } }, body: fixed }))
    : unwrap(apiV2.POST("/workspaces/{workspaceId}/plugins", { params: { path: { workspaceId } }, body: fixed }));
}
export async function removeConsumerPlugin(workspaceId: string, consumerId: string, pluginId: string, authorize: () => void = () => {}) {
  authorize();
  const plugin = await getConsumerPlugin(workspaceId, consumerId, pluginId);
  if (!consumerPluginAllowed({ name: plugin.name, category: "other", source: "bundled", supportedInDbless: true }) || Object.keys(consumerPluginConfigErrors(plugin.name, plugin.config ?? {})).length || plugin.tags?.some(t => t.startsWith("gromesh-"))) throw new ApiError(403, undefined);
  authorize();
  return unwrap(apiV2.DELETE("/workspaces/{workspaceId}/plugins/{pluginId}", { params: { path: { workspaceId, pluginId } } }));
}
