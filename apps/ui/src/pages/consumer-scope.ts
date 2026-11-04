import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { consumerApi } from "../api/consumers";
import { useCanEdit } from "../auth";
import { useIsWorkspaceRoute, workspaceQuery } from "../navigation/context";
import { canWriteWorkspaceGateway } from "./workspace-gateway";

/** No v1 metadata establishes v2 permissions; the server decides effective gateway.write. */
export function useConsumerScope(id: string) {
  const v2 = useIsWorkspaceRoute();
  const legacyCanEdit = useCanEdit();
  const client = useQueryClient();
  const workspace = useQuery({ ...workspaceQuery(id), enabled: false });
  const canEdit = v2 ? workspace.isSuccess && workspace.data.id === id && workspace.data.status === "active" && workspace.fetchStatus === "idle" : legacyCanEdit;
  const reason = !v2 || canEdit ? null : workspace.data?.status === "archived"
    ? "Somente leitura: este Workspace está arquivado."
    : "Somente leitura enquanto verificamos o estado do Workspace.";
  const key = (family: string, ...parts: unknown[]) => [v2 ? `ws-${family}` : family, id, ...parts];
  const invalidate = (...families: string[]) => {
    for (const family of families) {
      void client.invalidateQueries({ queryKey: [family, id] });
      if (v2) void client.invalidateQueries({ queryKey: [`ws-${family}`, id] });
    }
    for (const family of v2 ? ["environment", "preview", "ws-plugin-choices"] : ["environment", "preview"]) {
      void client.invalidateQueries({ queryKey: [family, id] });
    }
  };
  const transport = consumerApi(v2, id, () => {
    if (v2 && !canWriteWorkspaceGateway(client, id, true)) throw new ApiError(409, { type: "about:blank", title: "Workspace indisponível", status: 409, detail: "Somente leitura: confirme o estado do Workspace antes de alterar." });
  }, () => { if (v2) invalidate("consumers", "keyauth", "jwt", "basicauth", "aclgroups", "plugins"); });
  return { v2, canEdit, reason, key, invalidate, transport };
}
