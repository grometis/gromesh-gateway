import { ApiError } from "./client";

export interface FormErrors {
  /** Messages per form field, keyed by the first segment of the API path ("paths.0" → "paths"). */
  fields: Record<string, string[]>;
  /** Messages that belong to no known field (including "(body)"). */
  form: string[];
}

/** Maps a 422 problem's `errors[].path` onto the fields a form knows; everything else is a form-level message. */
export function toFormErrors(err: unknown, knownFields: readonly string[]): FormErrors {
  const out: FormErrors = { fields: {}, form: [] };
  if (!(err instanceof ApiError)) {
    out.form.push("Não foi possível falar com o servidor. Tente de novo.");
    return out;
  }
  const items = err.problem?.errors ?? [];
  for (const { path, message } of items) {
    const field = path.split(/[.[]/)[0] ?? "";
    if (knownFields.includes(field)) (out.fields[field] ??= []).push(path.includes(".") ? `${path}: ${message}` : message);
    else out.form.push(path === "(body)" ? message : `${path}: ${message}`);
  }
  if (items.length === 0) out.form.push(statusMessage(err));
  return out;
}

export function statusMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Não foi possível falar com o servidor. Tente de novo.";
  switch (err.status) {
    case 403:
      return "Você não tem permissão para esta ação.";
    case 404:
      return "Item não encontrado. Ele pode ter sido excluído.";
    case 409:
      return err.problem?.detail ?? "Conflito com o estado atual. Recarregue e tente de novo.";
    default:
      return err.problem?.detail ?? `Erro inesperado (HTTP ${err.status}).`;
  }
}
