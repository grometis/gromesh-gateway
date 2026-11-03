import type { QueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "../api/client";
import { apiV2, problemCode } from "../api/client-v2";
import type { components } from "../api/schema-v2";
import type { FormErrors } from "../api/errors";
import { statusMessage } from "../api/errors";
import { GATEWAY_MESSAGES } from "./gateway-errors";
import { CONFLICTS, ruleMessage } from "./workspace-errors";

export type Upstream = Schemas["Upstream"];
export type UpstreamWrite = components["schemas"]["WorkspaceUpstreamWrite"];
export type Target = components["schemas"]["WorkspaceTarget"];
export type TargetWrite = components["schemas"]["WorkspaceTargetWrite"];
export const upstreamPageKey = (workspaceId: string) => ["ws-upstream-pages", workspaceId] as const;
export const targetPageKey = (workspaceId: string, upstreamId: string) => ["ws-target-pages", workspaceId, upstreamId] as const;
export const upstreamPageQuery = (workspaceId: string, cursor = "") => ({
  queryKey: upstreamPageKey(workspaceId),
  queryFn: ({ signal }: { signal: AbortSignal }) => unwrap(apiV2.GET("/workspaces/{workspaceId}/upstreams", {
    params: { path: { workspaceId }, query: cursor ? { cursor } : {} }, signal,
  })),
});
export const targetPageQuery = (workspaceId: string, upstreamId: string, cursor = "") => ({
  queryKey: targetPageKey(workspaceId, upstreamId),
  queryFn: ({ signal }: { signal: AbortSignal }) => unwrap(apiV2.GET("/workspaces/{workspaceId}/upstreams/{upstreamId}/targets", {
    params: { path: { workspaceId, upstreamId }, query: cursor ? { cursor } : {} }, signal,
  })),
});
// Bounded once per Workspace, never once per Upstream. A cursor makes the association list explicitly partial.
export const upstreamServicesQuery = (workspaceId: string) => ({
  queryKey: ["ws-upstream-services", workspaceId],
  queryFn: ({ signal }: { signal: AbortSignal }) => unwrap(apiV2.GET("/workspaces/{workspaceId}/services", {
    params: { path: { workspaceId }, query: { limit: 200 } }, signal,
  })),
});
export function saveWorkspaceUpstream(workspaceId: string, upstreamId: string | null, body: UpstreamWrite) {
  return upstreamId
    ? unwrap(apiV2.PUT("/workspaces/{workspaceId}/upstreams/{upstreamId}", { params: { path: { workspaceId, upstreamId } }, body }))
    : unwrap(apiV2.POST("/workspaces/{workspaceId}/upstreams", { params: { path: { workspaceId } }, body }));
}
export function deleteWorkspaceUpstream(workspaceId: string, upstreamId: string) {
  return unwrap(apiV2.DELETE("/workspaces/{workspaceId}/upstreams/{upstreamId}", { params: { path: { workspaceId, upstreamId } } }));
}
export function saveWorkspaceTarget(workspaceId: string, upstreamId: string, targetId: string | null, body: TargetWrite) {
  return targetId
    ? unwrap(apiV2.PUT("/workspaces/{workspaceId}/upstreams/{upstreamId}/targets/{targetId}", { params: { path: { workspaceId, upstreamId, targetId } }, body }))
    : unwrap(apiV2.POST("/workspaces/{workspaceId}/upstreams/{upstreamId}/targets", { params: { path: { workspaceId, upstreamId } }, body }));
}
export function deleteWorkspaceTarget(workspaceId: string, upstreamId: string, targetId: string) {
  return unwrap(apiV2.DELETE("/workspaces/{workspaceId}/upstreams/{upstreamId}/targets/{targetId}", { params: { path: { workspaceId, upstreamId, targetId } } }));
}
export function invalidateWorkspaceUpstreams(client: QueryClient, workspaceId: string) {
  for (const key of ["ws-upstream-pages", "ws-upstreams", "ws-target-pages", "ws-upstream-services", "upstreams", "targets", "ws-services", "ws-services-all", "ws-service", "environment", "preview"]) {
    void client.invalidateQueries({ queryKey: [key, workspaceId] });
  }
}
export function upstreamErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return statusMessage(err);
  if (err.status === 401) return "Sua sessão expirou. Entre novamente.";
  if (err.status === 403) return GATEWAY_MESSAGES.forbidden;
  if (err.status === 404) return "Item não encontrado ou indisponível neste Workspace.";
  if (err.status === 409) {
    switch (problemCode(err)) {
      case "auto-publish": return GATEWAY_MESSAGES.autoPublish;
      case "workspace-archived": return CONFLICTS["workspace-archived"];
      case "concurrent-update": return GATEWAY_MESSAGES.concurrent;
      case "upstream-captures-service": return "Já existe um Serviço com destino DNS para este nome. Escolha outro nome ou vincule o Serviço ao Upstream.";
      default: return "Conflito: confira nomes e targets duplicados e Serviços vinculados antes de tentar novamente.";
    }
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}
const labels: Record<string, string> = {
  name: "Nome", algorithm: "Algoritmo", hashOn: "Hash por", hashFallback: "Alternativa", hashOnHeader: "Cabeçalho do hash",
  hashFallbackHeader: "Cabeçalho da alternativa", hashOnCookie: "Cookie", hashOnCookiePath: "Caminho do cookie",
  healthchecks: "Verificações de saúde", tags: "Tags", target: "Target", weight: "Peso",
};
export function upstreamFormErrors(err: unknown): FormErrors {
  if (!(err instanceof ApiError) || err.status !== 422) return { fields: {}, form: [upstreamErrorMessage(err)] };
  const out: FormErrors = { fields: {}, form: [] };
  for (const { path, message } of err.problem?.errors ?? []) {
    const field = path.split(/[.[]/)[0] ?? "";
    let text = ruleMessage(labels[field] ?? "Campo", message);
    if (field === "target" && /variable|varref|not declared/i.test(message)) text = "Target: variáveis ainda não são aceitas. Informe um destino literal host:porta.";
    else if (/forbidden destination|reserved|gromesh\.internal/i.test(message)) text = "Destino reservado ou não permitido pela plataforma.";
    else if (field.startsWith("hash")) text = `${labels[field]}: confira a opção de hash e os campos exigidos pelo algoritmo.`;
    else if (field === "healthchecks") text = "Verificações de saúde: confira tipo, caminho, intervalos e limites.";
    if (labels[field]) (out.fields[field] ??= []).push(text);
    else out.form.push(text);
  }
  if (!(err.problem?.errors?.length)) out.form.push("Confira os campos informados.");
  return out;
}
