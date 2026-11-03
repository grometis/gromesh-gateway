import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import type { NavigationContext } from "../navigation/context";
import { gatewayDestinations, type GatewayDestination } from "../navigation/gateway-destinations";

export function GatewaySidebar({ context, selectors, focusContent }: {
  context: NavigationContext; selectors: ReactNode; focusContent: () => void;
}) {
  const location = useLocation();
  const prefix = useId();
  const desktop = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia?.("(max-width: 900px)").matches ?? false);
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const items = gatewayDestinations(context, location.pathname);
  const workspace = context.workspace;
  const name = workspace?.name ?? context.environment?.name ?? "";
  const description = workspace ? `Workspace ${name}` : `Ambiente legado ${name}`;

  useEffect(() => {
    const focusin = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      // CSS may hide and blur a focused node before matchMedia.change fires.
      if (target === document.body || target === document.documentElement) return;
      lastFocus.current = desktop.current?.contains(target) || dialog.current?.contains(target)
        ? target.getAttribute("href") ?? (target.id || "content")
        : target === trigger.current ? "trigger" : null;
    };
    document.addEventListener("focusin", focusin);
    return () => {
      document.removeEventListener("focusin", focusin);
      if (lastFocus.current) focusContent();
    };
  }, [focusContent]);

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 900px)");
    if (!media) return;
    const change = () => {
      pendingFocus.current = lastFocus.current ? media.matches ? "trigger" : lastFocus.current : null;
      dialog.current?.close();
      setOpen(false);
      setMobile(media.matches);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useLayoutEffect(() => {
    const key = pendingFocus.current;
    pendingFocus.current = null;
    if (!key) return;
    if (mobile) trigger.current?.focus();
    else {
      const target = Array.from(desktop.current?.querySelectorAll<HTMLElement>("a,button,select") ?? [])
        .find((node) => (node.getAttribute("href") ?? node.id) === key);
      if (target) target.focus();
      else focusContent();
    }
  }, [mobile, focusContent]);

  useLayoutEffect(() => {
    if (!open || !mobile) return;
    const node = dialog.current!;
    const previousOverflow = document.body.style.overflow;
    node.showModal();
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    return () => {
      node.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [open, mobile]);

  useEffect(() => {
    setOpen(false);
    // Navigation returns focus to the new page, not the previous context trigger.
    focusContent();
  }, [location, focusContent]);

  const close = () => {
    dialog.current?.close();
    setOpen(false);
    if (trigger.current) trigger.current.focus();
    else focusContent();
  };
  const body = (compact: boolean) => <>
    <div className="gateway-context">
      <h2>Gateway</h2>
      <strong>{name}</strong>
      {workspace ? <p className="workspace-context" role="status">Workspace v2 · /{workspace.slug} · {context.state === "archived" ? "arquivado · somente leitura" : "ativo"}</p>
        : <p>Ambiente (legado)</p>}
      {selectors}
    </div>
    <nav id={`${prefix}-links`} aria-label="Menu principal">
      <ul>{items.map((item) => <GatewayItem key={item.id} item={item} collapsed={compact} prefix={prefix} onNavigate={() => { dialog.current?.close(); setOpen(false); focusContent(); }} />)}</ul>
    </nav>
    <footer className="gateway-footer">
      <Link to="/" onClick={() => { dialog.current?.close(); setOpen(false); }}>Voltar à visão geral da instância</Link>
      {!mobile && <button type="button" id={`${prefix}-collapse`} aria-controls={`${prefix}-links`} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? "Expandir" : "Recolher"} menu Gateway
      </button>}
    </footer>
  </>;

  if (!items.length) return null;
  if (!mobile) return <aside className={`menu gateway-sidebar gateway-desktop${collapsed ? " is-collapsed" : ""}`} aria-label={`Gateway do ${description}`} ref={desktop}>{body(collapsed)}</aside>;
  return <>
    <div className="gateway-mobile">
      <button type="button" ref={trigger} aria-controls={`${prefix}-drawer`} aria-expanded={open} aria-label={`Abrir menu Gateway do ${description}`}
        onClick={() => { trigger.current?.focus(); setOpen(true); }}>Gateway · {name}</button>
    </div>
    {open && <dialog id={`${prefix}-drawer`} ref={dialog} className="menu gateway-sidebar gateway-drawer" aria-label={`Navegação Gateway do ${description}`}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("a,button,select"))
          .filter((node) => !node.hasAttribute("disabled") && node.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom) close();
      }}>
      <button type="button" className="gateway-close" ref={closeButton} onClick={close}>Fechar menu Gateway</button>
      {body(false)}
    </dialog>}
  </>;
}

function GatewayItem({ item, collapsed, prefix, onNavigate }: { item: GatewayDestination; collapsed: boolean; prefix: string; onNavigate: () => void }) {
  const [tooltipDismissed, setTooltipDismissed] = useState(false);
  const tooltipId = `${prefix}-${item.id}-tooltip`;
  const reasonId = `${prefix}-${item.id}-reason`;
  return <li className="gateway-item" data-tooltip-dismissed={tooltipDismissed}
    onMouseEnter={() => setTooltipDismissed(false)} onFocus={() => setTooltipDismissed(false)}
    onKeyDown={(event) => { if (event.key === "Escape") setTooltipDismissed(true); }}>
    {item.href ? <Link to={item.href} aria-label={item.label} aria-current={item.active ? "page" : undefined}
      aria-describedby={collapsed ? tooltipId : undefined} onClick={onNavigate}>
      <span aria-hidden="true">{collapsed ? item.shortLabel : item.label}</span>
    </Link> : <span role="link" aria-disabled="true" aria-label={item.label} tabIndex={collapsed ? 0 : undefined} aria-describedby={collapsed ? `${reasonId} ${tooltipId}` : reasonId}>
      <span aria-hidden="true">{collapsed ? item.shortLabel : item.label}</span>
      <small id={reasonId}>{item.requirement}</small>
    </span>}
    {collapsed && <span id={tooltipId} role="tooltip" className="gateway-tooltip">{item.label}</span>}
  </li>;
}
