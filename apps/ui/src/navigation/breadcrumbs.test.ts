import { describe, expect, it } from "vitest";
import type { NavigationContext } from "./context";
import { breadcrumbDetail, breadcrumbDetailName, buildBreadcrumbs } from "./breadcrumbs";

const context: NavigationContext = {
  route: { kind: "workspace-v2", id: "workspace-id" }, state: "authorized",
  workspace: { id: "workspace-id", key: "workspace-id", name: "Nome visível", slug: "nome", status: "active" },
};

describe("catalog-driven breadcrumb paths", () => {
  it.each([
    ["overview", "Visão geral"], ["services", "Serviços"], ["routes", "Rotas"],
    ["consumers", "Consumidores"], ["plugins", "Plugins"], ["upstreams", "Upstreams"],
    ["certificates", "Certificados"], ["variables", "Variáveis"], ["releases", "Releases"],
  ])("builds the real v2 %s destination without a name-based URL", (section, label) => {
    expect(buildBreadcrumbs(`/workspaces/workspace-id/${section}?cursor=opaque#details`, context)).toEqual([
      { label: "Visão geral da instância", href: "/" },
      { label: "Nome visível", href: "/workspaces/workspace-id" }, { label },
    ]);
  });
  it("keeps the registered entry current before its redirect to overview", () => {
    expect(buildBreadcrumbs("/workspaces/workspace-id", context)).toEqual([
      { label: "Visão geral da instância", href: "/" }, { label: "Nome visível" },
    ]);
  });
  it.each([
    ["services/resource", "Serviços", "Serviço"],
    ["consumers/resource", "Consumidores", "Consumidor"],
  ])("keeps the list ancestor and generic detail for v2 %s", (path, list, detail) => {
    expect(buildBreadcrumbs(`/workspaces/workspace-id/${path}`, context)).toEqual([
      { label: "Visão geral da instância", href: "/" },
      { label: "Nome visível", href: "/workspaces/workspace-id" },
      { label: list, href: `/workspaces/workspace-id/${path.split("/")[0]}` }, { label: detail },
    ]);
  });
  it.each([
    ["workspaces", "ws-consumers", context],
    ["e", "consumers", { route: { kind: "legacy-v1", id: "workspace-id" }, state: "legacy" } as NavigationContext],
  ] as const)("observes only the %s Consumer detail cache", (namespace, family, scope) => {
    expect(breadcrumbDetail(`/${namespace}/workspace-id/consumers/resource`, scope)?.queryKey)
      .toEqual([family, "workspace-id", "detail", "resource"]);
  });
  it.each(["loading", "forbidden", "not-found", "error", "expired"] as const)("ignores retained metadata in %s", (state) => {
    expect(buildBreadcrumbs("/workspaces/workspace-id/services/resource", { ...context, state }, "Nome anterior")).toEqual([
      { label: "Visão geral da instância", href: "/" }, { label: "Serviços" }, { label: "Serviço" },
    ]);
  });
  it.each(["/workspaces/other-id/services", "/e/workspace-id/services"])("rejects stale or cross-namespace context for %s", (url) => {
    expect(buildBreadcrumbs(url, context)).toEqual([{ label: "Visão geral da instância", href: "/" }, { label: "Serviços" }]);
    expect(breadcrumbDetail(`${url}/resource`, context)).toBeUndefined();
  });
  it("encodes the authoritative ID in links and never replaces it with the displayed name", () => {
    const id = "id/with-space";
    const encoded = { ...context, route: { kind: "workspace-v2" as const, id }, workspace: { ...context.workspace!, id } };
    expect(buildBreadcrumbs("/workspaces/id%2Fwith-space/services/resource", encoded)).toEqual([
      { label: "Visão geral da instância", href: "/" }, { label: "Nome visível", href: "/workspaces/id%2Fwith-space" },
      { label: "Serviços", href: "/workspaces/id%2Fwith-space/services" }, { label: "Serviço" },
    ]);
  });
  it.each([
    null, {}, { id: "wrong", name: "Nome errado" },
    { id: "resource", workspaceId: "another-workspace", name: "Nome errado" },
    { id: "resource", name: { secret: "never render" } },
  ])("does not promote unvalidated resource metadata (%j)", (data) => {
    const detail = breadcrumbDetail("/workspaces/workspace-id/services/resource", context)!;
    expect(breadcrumbDetailName(detail, data)).toBeUndefined();
  });
});
