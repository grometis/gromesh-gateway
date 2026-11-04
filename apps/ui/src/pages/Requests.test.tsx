import { act } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTestDom, type TestNode } from "../test/dom";

const ENV = "11111111-1111-4111-8111-111111111111";
const ROUTE = "22222222-2222-4222-8222-222222222222";
const SERVICE = "33333333-3333-4333-8333-333333333333";
const CONSUMER = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-11-03T12:00:00.000Z";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let root: Root | undefined;
let client: QueryClient | undefined;
let sent: URL[];

beforeEach(() => {
  sent = [];
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(NOW));
});

afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  client?.clear();
  client = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const url of sent) {
    expect(url.pathname).toBe(`/api/v1/environments/${ENV}/requests`);
    expect(url.searchParams.has("status") && url.searchParams.has("statusClass"), url.search).toBe(false);
  }
});

async function screen(options: { search?: string; respond?: (url: URL) => Promise<Response> } = {}) {
  vi.resetModules();
  const container = installTestDom();
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init);
    }
  });
  vi.stubGlobal("fetch", async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/requests")) {
      sent.push(url);
      return options.respond ? options.respond(url) : Response.json({ items: [], nextCursor: null });
    }
    if (url.pathname.endsWith("/routes")) return Response.json({ items: [{ id: ROUTE, name: "orders", serviceId: SERVICE }], nextCursor: null });
    if (url.pathname.endsWith("/services")) return Response.json({ items: [{ id: SERVICE, name: "orders-api" }], nextCursor: null });
    if (url.pathname.endsWith("/consumers")) return Response.json({ items: [{ id: CONSUMER, username: "Ana" }], nextCursor: null });
    throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
  });
  const { RequestsPage } = await import("./Requests");
  const { createMemoryRouter, RouterProvider } = await import("react-router");
  const router = createMemoryRouter([{ path: "/e/:envId/requests", element: <RequestsPage /> }], {
    initialEntries: [`/e/${ENV}/requests${options.search ?? ""}`],
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root!.render(<QueryClientProvider client={client!}><RouterProvider router={router} /></QueryClientProvider>);
    await tick();
  });
  await act(async () => { await tick(); });
  const field = (label: string): TestNode => {
    const node = container.findAll((n) => n.tagName === "LABEL" && n.textContent === label)[0]!;
    return container.findAll((n) => n.getAttribute("id") === node.getAttribute("for"))[0]!;
  };
  const input = async (label: string, value: string) => {
    await act(async () => {
      const node = field(label);
      node.value = value;
      node.dispatchEvent(new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
      await tick();
    });
  };
  const submit = async () => {
    await act(async () => {
      container.findAll((n) => n.tagName === "FORM")[0]!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await tick();
    });
    await act(async () => { await tick(); });
  };
  return { container, field, input, submit, query: () => Object.fromEntries(sent.at(-1)!.searchParams) };
}

describe("request status filters", () => {
  it("starts with only the default period and shows an empty result without losing the controls", async () => {
    const view = await screen();
    expect(view.query()).toEqual({ from: "2026-11-03T06:01:00.000Z", to: "2026-11-03T12:01:00.000Z" });
    expect(view.container.textContent).toContain("Nenhuma requisição no período.");
    expect(view.field("Classe de status").getAttribute("disabled")).toBeNull();
    expect(view.field("Status exato").value).toBe("");
  });

  it.each(["2xx", "3xx", "4xx", "5xx"])("sends only the chosen class %s after applying", async (statusClass) => {
    const view = await screen();
    await view.input("Classe de status", statusClass);
    expect(sent).toHaveLength(1);
    await view.submit();
    expect(view.query()).toMatchObject({ statusClass });
    expect(view.query()).not.toHaveProperty("status");
  });

  it.each(["100", "404", "599"])("sends exact status %s with an accessible reason for the disabled class", async (status) => {
    const view = await screen();
    await view.input("Status exato", status);
    const select = view.field("Classe de status");
    expect(select.getAttribute("disabled")).not.toBeNull();
    const reasonId = select.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(view.container.findAll((n) => n.getAttribute("id") === reasonId)[0]?.textContent).toContain("Limpe o status exato");
    await view.submit();
    expect(view.query()).toMatchObject({ status });
    expect(view.query()).not.toHaveProperty("statusClass");
  });

  it("replaces an applied class with exact status and never restores the old class when exact is cleared", async () => {
    const view = await screen();
    await view.input("Classe de status", "5xx");
    await view.submit();
    await view.input("Status exato", "500");
    await view.submit();
    expect(view.query().status).toBe("500");
    expect(view.query()).not.toHaveProperty("statusClass");
    await view.input("Status exato", "");
    expect(view.field("Classe de status").getAttribute("disabled")).toBeNull();
    await view.submit();
    expect(view.query()).not.toHaveProperty("status");
    expect(view.query()).not.toHaveProperty("statusClass");
  });

  it("switches from exact to class after clearing exact and reapplies without incompatible parameters", async () => {
    const view = await screen();
    await view.input("Status exato", "404");
    await view.submit();
    await view.input("Status exato", "");
    await view.input("Classe de status", "4xx");
    await view.submit();
    const previous = view.query();
    await view.submit();
    expect(view.query()).toEqual(previous);
    expect(view.query().statusClass).toBe("4xx");
    expect(view.query()).not.toHaveProperty("status");
    await view.input("Classe de status", "");
    await view.submit();
    expect(view.query()).not.toHaveProperty("statusClass");
  });

  it.each(["99", "600", "0", "-1", "404.5", "abc", "NaN", "4e2", "0x194", "   "])("rejects invalid status %j before sending and recovers after correction", async (status) => {
    const view = await screen();
    await view.input("Status exato", status);
    await view.submit();
    expect(sent).toHaveLength(1);
    expect(view.field("Status exato").getAttribute("aria-invalid")).toBe("true");
    expect(view.container.findAll((n) => n.getAttribute("role") === "alert").map((n) => n.textContent).join(" ")).toContain("100 e 599");
    await view.input("Status exato", "200");
    await view.submit();
    expect(view.query().status).toBe("200");
    expect(view.field("Status exato").getAttribute("aria-invalid")).toBe("false");
  });

  it("preserves the route from the query string, scope and period through status changes and clearing", async () => {
    const view = await screen({ search: `?routeId=${ROUTE}` });
    expect(view.query().routeId).toBe(ROUTE);
    await view.input("Serviço", SERVICE);
    await view.input("Consumidor", CONSUMER);
    await view.input("Período", "24h");
    await view.input("Classe de status", "5xx");
    await view.submit();
    for (const status of ["500", ""]) {
      await view.input("Status exato", status);
      await view.submit();
      expect(view.query()).toMatchObject({ routeId: ROUTE, serviceId: SERVICE, consumerId: CONSUMER, from: "2026-11-02T12:01:00.000Z", to: "2026-11-03T12:01:00.000Z" });
    }
  });

  it("keeps the loading state visible while the request is pending", async () => {
    const view = await screen({ respond: () => new Promise(() => {}) });
    expect(view.container.textContent).toContain("Carregando…");
    expect(view.container.textContent).not.toContain("Nenhuma requisição");
  });

  it.each([403, 422, 502])("shows HTTP %s as an error, preserves filters and does not turn it into an empty result", async (status) => {
    const view = await screen({ respond: async (url) => url.searchParams.has("status")
      ? Response.json({ title: "Query failed", status, errors: status === 422 ? [{ path: "status", message: "Filtro recusado pelo servidor" }] : undefined }, { status })
      : Response.json({ items: [], nextCursor: null }) });
    await view.input("Status exato", "404");
    await view.submit();
    expect(view.container.findAll((n) => n.getAttribute("role") === "alert").length).toBeGreaterThan(0);
    expect(view.container.textContent).not.toContain("Nenhuma requisição no período.");
    expect(view.field("Status exato").value).toBe("404");
    if (status === 422) expect(view.container.textContent).toContain("Filtro recusado pelo servidor");
  });

  it("shows a 422 without field details as a form error", async () => {
    const view = await screen({ respond: async () => Response.json({ title: "Unprocessable Content", status: 422, detail: "Consulta recusada" }, { status: 422 }) });
    expect(view.container.findAll((n) => n.getAttribute("role") === "alert").map((n) => n.textContent)).toContain("Consulta recusada");
  });
});
