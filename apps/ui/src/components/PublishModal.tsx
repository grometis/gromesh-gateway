import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Environment, type Schemas } from "../api/client";
import { statusMessage, toFormErrors } from "../api/errors";
import { Modal } from "./Modal";

const CHANGE_LABEL: Record<Schemas["EntityChange"]["change"], string> = { added: "adicionado", removed: "removido", modified: "alterado" };
const KIND_LABEL: Record<Schemas["EntityChange"]["kind"], string> = {
  services: "Service",
  routes: "Route",
  consumers: "Consumer",
  keyauth_credentials: "Credencial",
  plugins: "Plugin",
};

export function PublishModal({ env, onClose }: { env: Environment; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const preview = useQuery({
    queryKey: ["preview", env.id],
    queryFn: () => unwrap(api.GET("/environments/{envId}/publish-preview", { params: { path: { envId: env.id } } })),
  });
  const publish = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/environments/{envId}/snapshots", {
          params: { path: { envId: env.id } },
          body: { ...(message.trim() ? { message: message.trim() } : {}), expectedCurrentVersion: env.currentVersion ?? null },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["environment", env.id] });
      void queryClient.invalidateQueries({ queryKey: ["preview", env.id] });
      onClose();
    },
  });

  const issues = preview.isError ? toFormErrors(preview.error, []) : null;
  return (
    <Modal
      title={`Publicar ${env.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="primary" disabled={!preview.data?.hasChanges || publish.isPending} onClick={() => publish.mutate()}>
            {publish.isPending ? "Publicando…" : "Publicar"}
          </button>
        </>
      }
    >
      {preview.isPending && <p className="muted">Calculando as alterações…</p>}
      {issues && (
        <div className="error" role="alert">
          <p>O rascunho não pode ser publicado:</p>
          <ul>
            {issues.form.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {preview.data && !preview.data.hasChanges && <p className="muted">Nada a publicar: o rascunho é igual à versão publicada.</p>}
      {preview.data && preview.data.changes.length > 0 && (
        <ul className="changes" aria-label="Alterações">
          {preview.data.changes.map((c) => (
            <li key={`${c.kind}:${c.id}`} data-change={c.change}>
              <span className={`badge ${c.change}`}>{CHANGE_LABEL[c.change]}</span> {KIND_LABEL[c.kind]} <strong>{c.label}</strong>
            </li>
          ))}
        </ul>
      )}
      <label className="field">
        <span>Mensagem (opcional)</span>
        <input value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)} placeholder="O que muda nesta versão?" />
      </label>
      {publish.isError && (
        <p className="error" role="alert">
          {statusMessage(publish.error)}
        </p>
      )}
    </Modal>
  );
}
