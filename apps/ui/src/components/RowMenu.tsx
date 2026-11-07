import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { Link } from "react-router";

export interface RowMenuItem {
  label: string;
  href?: string;
  onSelect: () => void;
  danger?: boolean;
}

/**
 * "⋯" menu for a row's less common actions (WAI-ARIA menu button): Enter, Space or ↓ open it on the first item,
 * ↑/↓ move, Escape or Tab close it and return focus to the button.
 */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | HTMLAnchorElement | null)[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const move = (from: number, delta: number) => itemRefs.current[(from + delta + items.length) % items.length]?.focus();

  return (
    <div className="row-menu" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="quiet icon-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div role="menu" id={menuId} aria-label={label} className="menu-popover">
          {items.map((item, i) => {
            const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); move(i, e.key === "ArrowDown" ? 1 : -1); }
              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
              else if (e.key === "Tab") setOpen(false);
            };
            const onClick = () => { setOpen(false); item.onSelect(); };
            return item.href ? <Link key={item.label} to={item.href} role="menuitem" tabIndex={-1} ref={el => {itemRefs.current[i]=el;}} onClick={onClick} onKeyDown={onKeyDown}>{item.label}</Link> : <button key={item.label} ref={el => {itemRefs.current[i]=el;}} type="button" role="menuitem" tabIndex={-1} className={item.danger ? "danger-item" : undefined} onClick={onClick} onKeyDown={onKeyDown}>{item.label}</button>;
          })}
        </div>
      )}
    </div>
  );
}
