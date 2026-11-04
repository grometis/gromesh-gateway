import { useEffect, useId, useRef, type ReactNode } from "react";

/** Open modals, innermost last: Escape closes only the one on top (a plugin editor opened from a plugin list). */
const openModals: string[] = [];

export function Modal({ title, onClose, children, footer, wide, bodyLabel }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; bodyLabel?: string }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    openModals.push(titleId);
    // Start on static context, so Enter cannot accidentally confirm or close a newly opened dialog.
    dialogRef.current?.focus();
    return () => {
      openModals.splice(openModals.indexOf(titleId), 1);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [titleId]);
  useEffect(() => {
    const onFocus = () => {
      const dialog = dialogRef.current;
      // Context revalidation can recreate navigation and focus the page behind this dialog.
      if (openModals.at(-1) === titleId && dialog && !dialog.contains(document.activeElement)) dialog.focus();
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [titleId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (openModals.at(-1) !== titleId) return;
      if (e.key === "Escape") { onClose(); return; }
      const dialog = dialogRef.current;
      if (e.key !== "Tab" || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]"))
        .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      const active = document.activeElement;
      if (!first || !dialog.contains(active) || (e.shiftKey ? active === first || active === dialog : active === last)) {
        e.preventDefault();
        (e.shiftKey ? last ?? dialog : first ?? dialog).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, titleId]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} tabIndex={-1} className={wide ? "modal wide" : "modal"} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon" aria-label="Fechar" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body" role={bodyLabel ? "region" : undefined} tabIndex={bodyLabel ? 0 : undefined} aria-label={bodyLabel}>{children}</div>
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
