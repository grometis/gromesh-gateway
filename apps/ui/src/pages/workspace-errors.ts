import { ApiError } from "../api/client";
import { workspaceProblem, type WorkspaceProblemCode } from "../api/client-v2";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";

export const WORKSPACE_FIELDS = ["name", "description", "slug"] as const;

export const CONFLICTS: Record<WorkspaceProblemCode, string> = {
  "workspaces-mode-disabled": "A criação de Workspaces está desativada nesta instância: ela só existe no laboratório isolado autorizado.",
  "creation-policy": "A política de criação desta instância não permite esta ação.",
  "slug-taken": "Este slug já está em uso nesta instância (Workspaces arquivados incluídos).",
  "name-taken": "Já existe um Workspace com este nome nesta instância.",
  "workspace-archived": "Este Workspace está arquivado e não aceita alterações.",
  "active-release": "O Workspace tem uma release ativa com entidades. Remova-a com uma promoção de tombstone antes de arquivar.",
  deployed: "O Workspace faz parte do deployment mais recente desta instância e ainda pode estar sendo servido. Retire-o do deployment antes de arquivar.",
  "published-configuration": "Uma configuração já foi publicada neste Workspace. Nesta fase, um Workspace que publicou não pode ser arquivado.",
  clusters: "Há um cluster registrado neste Workspace. Remova os clusters antes de arquivar.",
  "request-decided": "Esta solicitação já foi decidida.",
};

const FIELD_OF: Partial<Record<WorkspaceProblemCode, (typeof WORKSPACE_FIELDS)[number]>> = { "slug-taken": "slug", "name-taken": "name" };

export interface WorkspaceFormErrors extends FormErrors {
  /** A free slug the server proposes after slug-taken or name-taken: offered, never applied by itself. */
  suggestedSlug: string | null;
}

/** 409 by its `code` (the field it concerns, or the form), 422 by `errors[].path`, anything else on the form. */
export function workspaceFormErrors(err: unknown): WorkspaceFormErrors {
  const { code, suggestedSlug } = workspaceProblem(err);
  if (err instanceof ApiError && err.status === 409 && code) {
    const field = FIELD_OF[code];
    return {
      fields: field ? { [field]: [CONFLICTS[code]] } : {},
      form: field ? [] : [CONFLICTS[code]],
      suggestedSlug: field ? suggestedSlug : null,
    };
  }
  const out = toFormErrors(err, WORKSPACE_FIELDS);
  if (out.fields.slug && err instanceof ApiError) {
    const reserved = err.problem?.errors?.some((e) => e.path === "slug" && /reserved/i.test(e.message));
    out.fields.slug = [reserved ? "Slug reservado pela plataforma. Escolha outro." : "Slug inválido: confira a regra abaixo."];
  }
  return { ...out, suggestedSlug: null };
}

/** The reason an action on a workspace (archive) was refused, in words the caller can act on. */
export function workspaceErrorMessage(err: unknown): string {
  const { code } = workspaceProblem(err);
  return err instanceof ApiError && err.status === 409 && code ? CONFLICTS[code] : statusMessage(err);
}
