import { useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { RowMenu } from "./RowMenu";

/** One credential as a card: only what identifies it (a hint, an issuer, a user), never a secret. */
export function CredentialCard({ hint, meta, deleteLabel, onDelete }: { hint: ReactNode; meta: ReactNode; deleteLabel: string; onDelete?: () => void }) {
  return (
    <li className="cred-card">
      <div>
        <div className="cred-hint">{hint}</div>
        <div className="cred-meta">{meta}</div>
      </div>
      {onDelete && <RowMenu label={deleteLabel} items={[{ label: "Excluir", danger: true, onSelect: onDelete }]} />}
    </li>
  );
}

export const createdAt = (iso: string) => `Criada em ${new Date(iso).toLocaleString("pt-BR")}`;

/**
 * A secret shown once, right after the 201: Copiar puts it on the clipboard, "Já copiei" closes the dialog and the
 * secret is gone (it only lived in the caller's mutation result, evicted from the cache).
 */
export function SecretOnce({ title, label, secret, note, closeLabel = "Já copiei", onClose }: { title: string; label: string; secret: string; note: ReactNode; closeLabel?: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="primary" onClick={onClose}>
          {closeLabel}
        </button>
      }
    >
      <p className="warn" role="note">
        {note}
      </p>
      <div className="secret">
        <code className="mono" aria-label={label}>
          {secret}
        </code>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(secret).then(() => setCopied(true)).catch(() => setCopied(false))}>
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
    </Modal>
  );
}
