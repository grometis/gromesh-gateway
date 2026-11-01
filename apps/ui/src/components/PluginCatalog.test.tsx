import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CatalogPicker } from "./PluginCatalog";

it("groups the catalog and explains unavailable plugins without enabling them", () => {
  const client = new QueryClient();
  client.setQueryData(["plugin-catalog"], { items: [
    { name: "rate-limiting", category: "traffic-control", supportedInDbless: true, source: "bundled" },
    { name: "oauth2", category: "authentication", supportedInDbless: false, source: "bundled" },
  ] });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><CatalogPicker onPick={() => {}} onClose={() => {}} /></QueryClientProvider>);
  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-label="Buscar plugin"');
  expect(html).toContain("Autenticação");
  expect(html).toContain("Controle de tráfego");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*><span class="mono">oauth2/);
  expect(html).toContain("Indisponível: depende de banco de dados no data plane, que roda sem banco.");
  client.clear();
});
