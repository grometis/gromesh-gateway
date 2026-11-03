import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { destinationHref, resolveDestination, visibleDestinations, type Destination, type NavGroupId } from "../navigation/destinations";

const GROUPS = {
  platform: ["Plataforma", "Plataforma"],
  workspace: ["Workspace selecionado", "Workspace"],
  gateway: ["Gateway", "Gateway"],
  operations: ["Operações e publicações", "Operações"],
  administration: ["Administração da instância", "Admin."],
  account: ["Minha conta", "Conta"],
} as const;
const OPERATION_ORDER = ["N17", "N16", "N11", "N12", "N13", "N15"];

function NavLabel({ full, short }: { full: string; short: string }) {
  return <><span className="nav-label-full" aria-hidden="true">{full}</span><span className="nav-label-short" aria-hidden="true">{short}</span></>;
}

export function NavItem({ item, envId, activeId }: { item: Destination; envId: string; activeId?: string }) {
  const active = item.id === activeId;
  return (
    <li>
      <Link to={destinationHref(item, envId)} className={active ? "nav-item active" : "nav-item"} aria-current={active ? "page" : undefined} aria-label={item.label} title={item.label}>
        <NavLabel full={item.label} short={item.shortLabel} />
        {item.legacy && <span className="nav-legacy-short" aria-hidden="true"> (legado)</span>}
      </Link>
    </li>
  );
}

export function NavGroup({ group, children }: { group: NavGroupId; children: ReactNode }) {
  const [label, short] = GROUPS[group];
  return (
    <section className={`menu-group nav-${group}`} aria-labelledby={`nav-${group}-title`}>
      <h2 id={`nav-${group}-title`} aria-label={label}><NavLabel full={label} short={short} /></h2>
      {children}
    </section>
  );
}

export function ContextHeader({ children }: { children: ReactNode }) {
  return <div className="context-header">{children}</div>;
}

export function NavTree({ envId, role, context, account }: { envId: string; role?: string; context: ReactNode; account: ReactNode }) {
  const { pathname } = useLocation();
  const resolved = resolveDestination(pathname);
  const activeId = resolved?.activeId;
  const contextTitle = resolved?.destination.scope === "workspace" ? "Workspace selecionado" : "Último Workspace visitado";
  const items = visibleDestinations(role, envId);
  const list = (group: NavGroupId) => {
    const grouped = items.filter((item) => item.group === group);
    if (group === "operations") grouped.sort((a, b) => OPERATION_ORDER.indexOf(a.id) - OPERATION_ORDER.indexOf(b.id));
    return <ul>{grouped.map((item) => <NavItem key={item.id} item={item} envId={envId} activeId={activeId} />)}</ul>;
  };
  return (
    <nav id="main-navigation" aria-label="Menu principal">
      <NavGroup group="platform">{list("platform")}</NavGroup>
      <div className="workspace-navigation">
        <ContextHeader>
          {envId && <h2 className="context-title" aria-label={contextTitle}><NavLabel full={contextTitle} short="Workspace" /></h2>}
          {context}
        </ContextHeader>
        {envId && <>
          <div className="menu-group nav-overview">{list("workspace")}</div>
          <NavGroup group="gateway">{list("gateway")}</NavGroup>
          <NavGroup group="operations">{list("operations")}</NavGroup>
        </>}
      </div>
      {items.some((item) => item.group === "administration") && <NavGroup group="administration">{list("administration")}</NavGroup>}
      <NavGroup group="account">{list("account")}{account}</NavGroup>
    </nav>
  );
}
