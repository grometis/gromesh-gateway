import { useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { useOptionalNavigationContext, type NavigationContext } from "../navigation/context";
import { breadcrumbDetail, breadcrumbDetailName, buildBreadcrumbs, type Breadcrumb } from "../navigation/breadcrumbs";
import "./Breadcrumbs.css";

export function Breadcrumbs() {
  const { pathname } = useLocation();
  const context = useOptionalNavigationContext();
  const detail = breadcrumbDetail(pathname, context);
  return detail ? <DetailBreadcrumbs key={`${context?.route.kind}/${pathname}`} url={pathname} context={context} detail={detail} />
    : <Trail items={buildBreadcrumbs(pathname, context)} />;
}

function DetailBreadcrumbs({ url, context, detail }: { url: string; context: NavigationContext | null; detail: NonNullable<ReturnType<typeof breadcrumbDetail>> }) {
  // Observe only the exact page query. No fetch, list lookup, or name retained from a prior visit.
  const cache = useQueryClient().getQueryCache();
  const resource = useSyncExternalStore(cache.subscribe, () => cache.find({ queryKey: detail.queryKey, exact: true })?.state);
  const initialUpdates = useRef(resource?.dataUpdateCount ?? 0);
  const name = resource?.status === "success" && resource.dataUpdateCount > initialUpdates.current ? breadcrumbDetailName(detail, resource.data) : undefined;
  return <Trail items={buildBreadcrumbs(url, context, name)} />;
}

function Trail({ items }: { items: Breadcrumb[] }) {
  return <nav className="breadcrumbs" aria-label="Trilha">
    <ol role="list">{items.map((item, index) => <li key={index}>
      {item.href ? <Link to={item.href}>{item.label}</Link> : <span aria-current={index === items.length - 1 ? "page" : undefined}>{item.label}</span>}
    </li>)}</ol>
  </nav>;
}
