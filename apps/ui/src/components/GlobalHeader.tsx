import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "react-router";
import { statusMessage } from "../api/errors";
import { effectiveRole, useAuth } from "../auth";
import { useOptionalNavigationContext } from "../navigation/context";
import { globalDestinations, type GlobalDestination, type GlobalSection } from "../navigation/global-destinations";
import { Brand } from "./Brand";
import { InstanceContext } from "./InstanceContext";

const SECTIONS = { operations: "Operações", instance: "Administração", account: "Minha conta" } as const;
const ROLE_LABELS = { viewer: "Leitor", editor: "Editor", admin: "Administrador", none: "Sem acesso" } as const;
type FocusContext = GlobalSection | "toggle" | null;

export function GlobalHeader({ selectors }: { selectors?: ReactNode }) {
  const context = useOptionalNavigationContext();
  const { user, logout } = useAuth();
  const { envId } = useParams();
  const role = effectiveRole(user, envId);
  const signOut = useMutation({ mutationFn: logout });
  const location = useLocation();
  const prefix = useId();
  const header = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const shortcuts = useRef<HTMLElement>(null);
  const workspacesLink = useRef<HTMLAnchorElement>(null);
  const groups = useRef<Partial<Record<GlobalSection, HTMLDivElement | null>>>({});
  const triggers = useRef<Partial<Record<GlobalSection, HTMLButtonElement | null>>>({});
  const lastFocus = useRef<FocusContext>(null);
  const lastGroup = useRef<GlobalSection>("instance");
  const pendingFocus = useRef<FocusContext>(null);
  const pointerActive = useRef(false);
  const [open, setOpen] = useState<GlobalSection | null>(null);
  const [compact, setCompact] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setOpen(null);
    setMobileOpen(false);
  }, [location]);

  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(max-width: 600px)");
    setCompact(media.matches);
    const change = () => {
      const previous = lastFocus.current;
      setCompact(media.matches);
      setOpen(null);
      setMobileOpen(false);
      // CSS may have blurred a hidden link already. focusin retains its group until real focus leaves.
      if (previous) pendingFocus.current = media.matches ? "toggle" : previous === "toggle" ? lastGroup.current : previous;
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "toggle") toggle.current?.focus();
    else if (target) triggers.current[target]?.focus();
  }, [compact]);

  useEffect(() => {
    const pointerdown = () => {
      pointerActive.current = true;
    };
    const endPointer = () => { pointerActive.current = false; };
    const click = (event: MouseEvent) => {
      pointerActive.current = false;
      const target = event.target as Node;
      setOpen((current) => current && !groups.current[current]?.contains(target) ? null : current);
      if (!header.current?.contains(target)) {
        setMobileOpen(false);
        lastFocus.current = null;
      }
    };
    const focusin = (event: FocusEvent) => {
      const target = event.target as Node;
      // Losing a node to responsive CSS can temporarily put focus on body before matchMedia.change.
      if (target === document.body || target === document.documentElement) {
        if (!pointerActive.current) { setOpen(null); setMobileOpen(false); }
        return;
      }
      const section = (Object.keys(SECTIONS) as GlobalSection[]).find((key) => groups.current[key]?.contains(target));
      if (section) lastGroup.current = section;
      lastFocus.current = section ?? (target === toggle.current || shortcuts.current?.contains(target) || workspacesLink.current?.contains(target) ? "toggle" : null);
      // Compact groups are in document flow: defer a pointer-driven collapse until its click lands.
      if (pointerActive.current) return;
      if (open && !groups.current[open]?.contains(target)) setOpen(null);
      if (!header.current?.contains(target)) setMobileOpen(false);
    };
    const focusout = (event: FocusEvent) => {
      if (event.relatedTarget === null && !pointerActive.current && header.current?.contains(event.target as Node)) {
        setOpen(null);
        setMobileOpen(false);
      }
    };
    document.addEventListener("pointerdown", pointerdown);
    document.addEventListener("pointerup", endPointer);
    document.addEventListener("pointercancel", endPointer);
    document.addEventListener("keydown", endPointer);
    document.addEventListener("click", click);
    document.addEventListener("focusin", focusin);
    document.addEventListener("focusout", focusout);
    return () => {
      document.removeEventListener("pointerdown", pointerdown);
      document.removeEventListener("pointerup", endPointer);
      document.removeEventListener("pointercancel", endPointer);
      document.removeEventListener("keydown", endPointer);
      document.removeEventListener("click", click);
      document.removeEventListener("focusin", focusin);
      document.removeEventListener("focusout", focusout);
    };
  }, [open]);

  return <header className={`global-header${context?.route.kind === "workspace-v2" || context?.route.kind === "legacy-v1" ? " is-contextual" : ""}`} ref={header} onKeyDown={(event) => {
    if (event.key !== "Escape") return;
    if (open) {
      event.preventDefault();
      setOpen(null);
      triggers.current[open]?.focus();
    } else if (compact && mobileOpen) {
      event.preventDefault();
      setMobileOpen(false);
      toggle.current?.focus();
    }
  }}>
    <Brand inverse />
    <InstanceContext compact />
    <Link ref={workspacesLink} className="global-workspaces" to="/workspaces" aria-label="Abrir Workspaces" aria-current={location.pathname === "/workspaces" ? "page" : undefined}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg><span>Workspaces</span></Link>
    {selectors && <div className="global-selector">{selectors}</div>}
        <nav className="global-quick-links" aria-label="Acessos diretos" ref={shortcuts} hidden={compact && !mobileOpen}>
          {globalDestinations("operations", context, user?.role, location.pathname).filter(item => ["N16", "N17", "v2-N17"].includes(item.id)).map(item => item.href
            ? <Link key={item.id} to={item.href} aria-label={`Abrir ${item.label}`} aria-current={item.active ? "page" : undefined}>{item.label}</Link>
            : <span key={item.id} role="link" aria-disabled="true" title={item.requirement} aria-label={`${item.label}: ${item.requirement}`}>{item.label}</span>)}
    </nav>
    <nav className="global-navigation" aria-label="Navegação global">
      <div id={`${prefix}-groups`} className={`global-groups${mobileOpen ? " is-open" : ""}`} hidden={compact && !mobileOpen}>

        {(Object.keys(SECTIONS) as GlobalSection[]).map((section) => {
          const items = globalDestinations(section, context, user?.role, location.pathname);
          const active = items.some((item) => item.active);
          return <div className={`global-group global-${section}`} key={section} ref={(node) => { groups.current[section] = node; }}>
            <button type="button" className="global-trigger" ref={(node) => { triggers.current[section] = node; }}
              id={`${prefix}-${section}-trigger`} aria-controls={`${prefix}-${section}-panel`} aria-expanded={open === section}
              data-active={active} aria-describedby={active ? `${prefix}-${section}-active` : undefined}
              onClick={() => setOpen(open === section ? null : section)}>{SECTIONS[section]}</button>
            {active && <span className="visually-hidden" id={`${prefix}-${section}-active`}>Seção atual</span>}
            <div id={`${prefix}-${section}-panel`} className="global-panel" hidden={open !== section}
              role="region" aria-labelledby={`${prefix}-${section}-trigger`} tabIndex={section === "operations" ? 0 : undefined}>
              {section === "operations" && <p className="global-panel-context">
                {context?.workspace ? `Workspace v2: ${context.workspace.name}` : context?.environment ? `Ambiente (legado): ${context.environment.name}` : "Selecione um contexto para consultar operações."}
              </p>}
              {section === "account" && <div className="global-panel-context">
                <strong>{user?.name}</strong><span>{user?.email}</span>
                <span>Papel legado: {role ? ROLE_LABELS[role] : "Não informado"}</span>
              </div>}
              <ul>{items.filter((item) => !item.legacy).map((item) => <GlobalItem key={item.id} item={item} prefix={prefix} close={() => { setOpen(null); setMobileOpen(false); }} />)}</ul>
              {items.some((item) => item.legacy) && <>
                <h2 className="global-panel-heading">Legado v1</h2>
                <ul>{items.filter((item) => item.legacy).map((item) => <GlobalItem key={item.id} item={item} prefix={prefix} close={() => { setOpen(null); setMobileOpen(false); }} />)}</ul>
              </>}
              {section === "account" && <>
                <button type="button" className="global-logout" disabled={signOut.isPending} onClick={() => signOut.mutate()}>{signOut.isPending ? "Saindo…" : "Sair"}</button>
              </>}
            </div>
          </div>;
        })}
      </div>
    </nav>
    <button type="button" className="global-toggle" ref={toggle} aria-expanded={mobileOpen} aria-controls={`${prefix}-groups`}
      onClick={() => { setMobileOpen(!mobileOpen); setOpen(null); }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg><span className="visually-hidden">Menus globais</span></button>
    {signOut.isError && <p className="global-logout-error" role="alert">{statusMessage(signOut.error)}</p>}
  </header>;
}

function GlobalItem({ item, prefix, close }: { item: GlobalDestination; prefix: string; close: () => void }) {
  return <li className={item.href ? undefined : "global-unavailable"}>{item.href
    ? <Link to={item.href} aria-current={item.active ? "page" : undefined} onClick={close}>{item.label}</Link>
    : <><span role="link" aria-disabled="true" aria-describedby={`${prefix}-${item.id}-requirement`}>{item.label}</span>
      <small id={`${prefix}-${item.id}-requirement`}>{item.requirement}</small></>}</li>;
}
