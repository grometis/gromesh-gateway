import { ApiError, unwrap } from "../api/client";
import { apiV2, problemCode } from "../api/client-v2";
import type { components } from "../api/schema-v2";
import type { FormErrors } from "../api/errors";
import { gatewayErrorMessage } from "./gateway-errors";

export type WorkspaceCertificate = Omit<components["schemas"]["WorkspaceCertificate"], "key">;
export interface CertificateFormValue { cert: string; key: string; snis: string; tags: string }
const split = (value: string) => value.split(",").map(item => item.trim()).filter(Boolean);

export async function listWorkspaceCertificates(workspaceId: string, cursor?: string, signal?: AbortSignal) {
  const page = await unwrap(apiV2.GET("/workspaces/{workspaceId}/certificates", {
    params: { path: { workspaceId }, query: { cursor: cursor || undefined } }, signal,
  }));
  // Even the write-only placeholder is unnecessary in the query cache.
  return { ...page, items: page.items.map(({ key: _key, ...certificate }): WorkspaceCertificate => certificate) };
}

/** Form values stay in the component: never use mutation variables/cache for a PEM key. */
export async function saveWorkspaceCertificate(workspaceId: string, certificateId: string | null, form: CertificateFormValue): Promise<void> {
  if (!certificateId && (!form.key.trim() || form.key.trim() === "REDACTED")) {
    throw new ApiError(422, { type: "about:blank", title: "Invalid certificate", status: 422, errors: [{ path: "key", message: "send the private key itself" }] });
  }
  const body: components["schemas"]["WorkspaceCertificateWrite"] = {
    cert: form.cert, key: certificateId && !form.key.trim() ? "REDACTED" : form.key,
    snis: split(form.snis).map(name => name.toLowerCase()), tags: split(form.tags),
  };
  if (certificateId) await unwrap(apiV2.PUT("/workspaces/{workspaceId}/certificates/{certificateId}", { params: { path: { workspaceId, certificateId } }, body }));
  else await unwrap(apiV2.POST("/workspaces/{workspaceId}/certificates", { params: { path: { workspaceId } }, body }));
}

export async function deleteWorkspaceCertificate(workspaceId: string, certificateId: string): Promise<void> {
  await unwrap(apiV2.DELETE("/workspaces/{workspaceId}/certificates/{certificateId}", { params: { path: { workspaceId, certificateId } } }));
}

/** Errors may echo a submitted key. Translate known rules without returning server values or paths. */
export function certificateErrors(error: unknown): FormErrors {
  const out: FormErrors = { fields: {}, form: [] };
  if (!(error instanceof ApiError)) return { ...out, form: ["Não foi possível falar com o servidor. Tente de novo."] };
  if (error.status === 403) return { ...out, form: ["Você não tem permissão para alterar certificados deste Workspace."] };
  if (error.status === 404) return { ...out, form: ["Certificado ou Workspace não encontrado ou indisponível para sua conta."] };
  if (error.status === 401) return { ...out, form: ["Sua sessão expirou. Entre novamente."] };
  if (error.status === 409) {
    if (["auto-publish", "workspace-archived", "concurrent-update"].includes(problemCode(error) ?? "")) return { ...out, form: [gatewayErrorMessage(error)] };
    return { fields: { snis: ["Um dos SNIs já pertence a outro certificado na instância. Escolha outro nome."] }, form: [] };
  }
  if (error.status !== 422) return { ...out, form: ["Não foi possível concluir a operação. Tente novamente."] };
  for (const { path, message } of error.problem?.errors ?? []) {
    const field = path.split(/[.[]/)[0]!;
    let text: string;
    if (field === "cert" || field === "key") {
      if (/is not declared/i.test(message)) text = "Referências a variáveis ainda não são suportadas neste campo. Envie o PEM literal.";
      else if (field === "cert") text = /expired/i.test(message) ? "O certificado enviado está expirado. Envie um certificado válido." : "Envie uma cadeia de certificados PEM válida, com o certificado do servidor primeiro.";
      else text = /does not match/i.test(message) ? "A chave privada não corresponde ao certificado enviado." : "Envie uma chave privada PEM válida. Na criação, a chave é obrigatória.";
    } else if (field === "snis") text = "Confira os SNIs: nomes válidos, sem repetição; curinga somente no prefixo *.";
    else if (field === "tags") text = "Confira as tags informadas.";
    else { out.form.push("Há um campo inválido na requisição."); continue; }
    (out.fields[field] ??= []).push(text);
  }
  if (!Object.keys(out.fields).length && !out.form.length) out.form.push("Confira os campos do certificado.");
  return out;
}

export function certificateErrorMessage(error: unknown): string {
  const errors = certificateErrors(error);
  return [...errors.form, ...Object.values(errors.fields).flat()].join(" ");
}
