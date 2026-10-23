import { useEffect, useId, type ReactNode } from "react";

/** Open modals, innermost last: Escape closes only the one on top (a plugin editor opened from a plugin list). */
const openModals: string[] = [];

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const titleId = useId();
  useEffect(() => {
    openModals.push(titleId);
    return () => {
      openModals.splice(openModals.indexOf(titleId), 1);
    };
  }, [titleId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openModals.at(-1) === titleId && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, titleId]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={wide ? "modal wide" : "modal"} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon" aria-label="Fechar" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/** Confirmation for destructive actions; `error` shows why the action failed (e.g. 409). */
export function ConfirmDialog(props: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  confirmDisabled?: boolean;
  children?: ReactNode;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button type="button" className="danger" disabled={props.busy || props.confirmDisabled} onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <p>{props.message}</p>
      {props.children}
      {props.error && <p className="error" role="alert">{props.error}</p>}
    </Modal>
  );
}
