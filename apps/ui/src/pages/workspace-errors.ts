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

export const FORBIDDEN = {
  edit: "Você não tem permissão para editar este Workspace.",
  archive: "Só a administração da plataforma arquiva Workspaces.",
} as const;

const LABELS: Record<string, string> = { name: "Nome", description: "Descrição", slug: "Slug" };

/** A 422 message of the contract validator (or the service) in Portuguese; the field is named when the rule is unknown. */
export function validationMessage(path: string, message: string): string {
  const field = path.split(/[.[]/)[0] ?? "";
  if (field === "slug") return /reserved/i.test(message) ? "Slug reservado pela plataforma. Escolha outro." : "Slug inválido: confira a regra abaixo.";
  if (path === "(body)") return /additional properties/i.test(message) ? "A requisição tem campos não aceitos." : "Requisição inválida.";
  const label = LABELS[field] ?? field;
  if (/is required/i.test(message)) return `${label}: campo obrigatório.`;
  const max = /more than (\d+) characters/i.exec(message);
  if (max) return `${label}: use no máximo ${max[1]} caracteres.`;
  const min = /fewer than (\d+) characters/i.exec(message);
  if (min) return min[1] === "1" ? `${label}: campo obrigatório.` : `${label}: use no mínimo ${min[1]} caracteres.`;
  if (/must match|format/i.test(message)) return `${label}: formato inválido.`;
  if (/must be /i.test(message)) return `${label}: tipo de valor inválido.`;
  return `${label}: valor inválido.`;
}

/**
 * 409 by its `code` (the field it concerns, or the form), 422 by `errors[].path` (in Portuguese), 403 with `forbidden`
 * when the action has its own words, anything else on the form.
 */
export function workspaceFormErrors(err: unknown, forbidden?: string): WorkspaceFormErrors {
  const { code, suggestedSlug } = workspaceProblem(err);
  if (err instanceof ApiError && err.status === 409 && code) {
    const field = FIELD_OF[code];
    return {
      fields: field ? { [field]: [CONFLICTS[code]] } : {},
      form: field ? [] : [CONFLICTS[code]],
      suggestedSlug: field ? suggestedSlug : null,
    };
  }
  if (err instanceof ApiError && err.status === 403 && forbidden) return { fields: {}, form: [forbidden], suggestedSlug: null };
  const items = err instanceof ApiError && err.status === 422 ? err.problem?.errors ?? [] : [];
  if (items.length === 0) return { ...toFormErrors(err, WORKSPACE_FIELDS), suggestedSlug: null };
  const out: WorkspaceFormErrors = { fields: {}, form: [], suggestedSlug: null };
  for (const { path, message } of items) {
    const field = path.split(/[.[]/)[0] ?? "";
    const text = validationMessage(path, message);
    if ((WORKSPACE_FIELDS as readonly string[]).includes(field)) {
      const list = (out.fields[field] ??= []);
      if (!list.includes(text)) list.push(text);
    } else out.form.push(text);
  }
  return out;
}

/** The reason an action on a workspace (archive) was refused, in words the caller can act on. */
export function workspaceErrorMessage(err: unknown, forbidden?: string): string {
  const { code } = workspaceProblem(err);
  if (err instanceof ApiError && err.status === 409 && code) return CONFLICTS[code];
  if (err instanceof ApiError && err.status === 403 && forbidden) return forbidden;
  return statusMessage(err);
}
