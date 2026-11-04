import { ApiError, api, unwrap, type ConsumerWrite } from "./client";
import { apiV2, problemCode } from "./client-v2";
import type { components } from "./schema";

type Schemas = components["schemas"];

/** Both APIs share response shapes; paths and request bodies stay checked by their generated contracts. */
export function consumerApi(v2: boolean, id: string, beforeWrite: () => void = () => {}, afterWrite: () => void = () => {}) {
  const path = { envId: id, workspaceId: id };
  async function call<T>(read: () => Promise<T>, write = false): Promise<T> {
    try {
      if (write) beforeWrite();
      const result = await read();
      if (write) afterWrite();
      return result;
    } catch (error) {
      if (!v2 || !(error instanceof ApiError)) throw error;
      // Credential errors may echo input. Only fixed messages and known field paths reach UI/cache.
      const code = problemCode(error);
      const detail = code === "auto-publish" ? "Este Workspace publica automaticamente pelo fluxo legado. Mude para publicação manual antes de editar por aqui."
        : code === "workspace-archived" ? "Somente leitura: este Workspace está arquivado."
        : error.status === 409 ? "Conflito com o estado atual. Verifique os identificadores e tente novamente."
        : error.status === 422 ? "Confira os campos informados." : undefined;
      const known = ["username", "customId", "tags", "key", "algorithm", "rsaPublicKey", "password", "groups"];
      throw new ApiError(error.status, { type: "about:blank", status: error.status, title: "Requisição recusada", ...(detail ? { detail } : {}),
        errors: error.status === 422 ? (error.problem?.errors ?? []).flatMap(({ path }) => {
          const field = path.split(/[.[]/)[0]!;
          return known.includes(field) ? [{ path: field, message: "Valor inválido. Confira este campo." }] : [];
        }) : [],
      });
    }
  }
  return {
    list: (q = "", cursor = "") => {
      const query = { ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) };
      return call(() => v2
        ? unwrap(apiV2.GET("/workspaces/{workspaceId}/consumers", { params: { path, query } }))
        : unwrap(api.GET("/environments/{envId}/consumers", { params: { path, query } })));
    },
    get: (consumerId: string) => call(() => v2
      ? unwrap(apiV2.GET("/workspaces/{workspaceId}/consumers/{consumerId}", { params: { path: { ...path, consumerId } } }))
      : unwrap(api.GET("/environments/{envId}/consumers/{consumerId}", { params: { path: { ...path, consumerId } } }))),
    save: (consumerId: string | null, body: ConsumerWrite) => call(() => v2
      ? (consumerId
        ? unwrap(apiV2.PUT("/workspaces/{workspaceId}/consumers/{consumerId}", { params: { path: { ...path, consumerId } }, body }))
        : unwrap(apiV2.POST("/workspaces/{workspaceId}/consumers", { params: { path }, body })))
      : (consumerId
        ? unwrap(api.PUT("/environments/{envId}/consumers/{consumerId}", { params: { path: { ...path, consumerId } }, body }))
        : unwrap(api.POST("/environments/{envId}/consumers", { params: { path }, body }))), true),
    remove: (consumerId: string) => call(() => v2
      ? unwrap(apiV2.DELETE("/workspaces/{workspaceId}/consumers/{consumerId}", { params: { path: { ...path, consumerId } } }))
      : unwrap(api.DELETE("/environments/{envId}/consumers/{consumerId}", { params: { path: { ...path, consumerId } } })), true),
    listKeys: (consumerId: string) => call(() => v2
      ? unwrap(apiV2.GET("/workspaces/{workspaceId}/consumers/{consumerId}/key-auth", { params: { path: { ...path, consumerId } } }))
      : unwrap(api.GET("/environments/{envId}/consumers/{consumerId}/key-auth", { params: { path: { ...path, consumerId } } }))),
    createKey: (consumerId: string) => call(() => v2
      ? unwrap(apiV2.POST("/workspaces/{workspaceId}/consumers/{consumerId}/key-auth", { params: { path: { ...path, consumerId } }, body: {} }))
      : unwrap(api.POST("/environments/{envId}/consumers/{consumerId}/key-auth", { params: { path: { ...path, consumerId } }, body: {} })), true),
    rotateKey: (consumerId: string, credentialId: string) => call(() => v2
      ? unwrap(apiV2.POST("/workspaces/{workspaceId}/consumers/{consumerId}/key-auth/{credentialId}/rotate", { params: { path: { ...path, consumerId, credentialId } } }))
      : unwrap(api.POST("/environments/{envId}/consumers/{consumerId}/key-auth/{credentialId}/rotate", { params: { path: { ...path, consumerId, credentialId } } })), true),
    removeKey: (consumerId: string, credentialId: string) => call(() => v2
      ? unwrap(apiV2.DELETE("/workspaces/{workspaceId}/consumers/{consumerId}/key-auth/{credentialId}", { params: { path: { ...path, consumerId, credentialId } } }))
      : unwrap(api.DELETE("/environments/{envId}/consumers/{consumerId}/key-auth/{credentialId}", { params: { path: { ...path, consumerId, credentialId } } })), true),
    listJwt: (consumerId: string) => call(() => v2
      ? unwrap(apiV2.GET("/workspaces/{workspaceId}/consumers/{consumerId}/jwt", { params: { path: { ...path, consumerId } } }))
      : unwrap(api.GET("/environments/{envId}/consumers/{consumerId}/jwt", { params: { path: { ...path, consumerId } } }))),
    createJwt: (consumerId: string, body: Schemas["JwtCredentialCreate"]) => call(() => v2
      ? unwrap(apiV2.POST("/workspaces/{workspaceId}/consumers/{consumerId}/jwt", { params: { path: { ...path, consumerId } }, body }))
      : unwrap(api.POST("/environments/{envId}/consumers/{consumerId}/jwt", { params: { path: { ...path, consumerId } }, body })), true),
    rotateJwt: (consumerId: string, credentialId: string) => call(() => v2
      ? unwrap(apiV2.POST("/workspaces/{workspaceId}/consumers/{consumerId}/jwt/{credentialId}/rotate", { params: { path: { ...path, consumerId, credentialId } } }))
      : unwrap(api.POST("/environments/{envId}/consumers/{consumerId}/jwt/{credentialId}/rotate", { params: { path: { ...path, consumerId, credentialId } } })), true),
    removeJwt: (consumerId: string, credentialId: string) => call(() => v2
      ? unwrap(apiV2.DELETE("/workspaces/{workspaceId}/consumers/{consumerId}/jwt/{credentialId}", { params: { path: { ...path, consumerId, credentialId } } }))
      : unwrap(api.DELETE("/environments/{envId}/consumers/{consumerId}/jwt/{credentialId}", { params: { path: { ...path, consumerId, credentialId } } })), true),
    listBasic: (consumerId: string) => call(() => v2
      ? unwrap(apiV2.GET("/workspaces/{workspaceId}/consumers/{consumerId}/basic-auth", { params: { path: { ...path, consumerId } } }))
      : unwrap(api.GET("/environments/{envId}/consumers/{consumerId}/basic-auth", { params: { path: { ...path, consumerId } } }))),
    createBasic: (consumerId: string, body: Schemas["BasicAuthCredentialCreate"]) => call(() => v2
      ? unwrap(apiV2.POST("/workspaces/{workspaceId}/consumers/{consumerId}/basic-auth", { params: { path: { ...path, consumerId } }, body }))
      : unwrap(api.POST("/environments/{envId}/consumers/{consumerId}/basic-auth", { params: { path: { ...path, consumerId } }, body })), true),
    removeBasic: (consumerId: string, credentialId: string) => call(() => v2
      ? unwrap(apiV2.DELETE("/workspaces/{workspaceId}/consumers/{consumerId}/basic-auth/{credentialId}", { params: { path: { ...path, consumerId, credentialId } } }))
      : unwrap(api.DELETE("/environments/{envId}/consumers/{consumerId}/basic-auth/{credentialId}", { params: { path: { ...path, consumerId, credentialId } } })), true),
    getGroups: (consumerId: string) => call(() => v2
      ? unwrap(apiV2.GET("/workspaces/{workspaceId}/consumers/{consumerId}/acl-groups", { params: { path: { ...path, consumerId } } }))
      : unwrap(api.GET("/environments/{envId}/consumers/{consumerId}/acl-groups", { params: { path: { ...path, consumerId } } }))),
    replaceGroups: (consumerId: string, groups: string[]) => call(() => v2
      ? unwrap(apiV2.PUT("/workspaces/{workspaceId}/consumers/{consumerId}/acl-groups", { params: { path: { ...path, consumerId } }, body: { groups } }))
      : unwrap(api.PUT("/environments/{envId}/consumers/{consumerId}/acl-groups", { params: { path: { ...path, consumerId } }, body: { groups } })), true),
  };
}
