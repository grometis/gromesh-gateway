import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";
import { installTestDom, type TestNode } from "../test/dom";
import { GatewaySidebar } from "./GatewaySidebar";
import type { NavigationContext } from "../navigation/context";

let root: Root;
afterEach(async () => { if (root) await act(() => root.unmount()); vi.unstubAllGlobals(); });
async function screen(mobile = false) {
  const container = installTestDom();
  const media = Object.assign(new EventTarget(), { matches: mobile });
  Object.assign(window, { matchMedia: () => media });
  const [{ createMemoryRouter, RouterProvider }, { createRoot }] = await Promise.all([import("react-router"), import("react-dom/client")]);
  const context: NavigationContext = { route: { kind: "workspace-v2", id: "W" }, state: "authorized", workspace: { id: "W", key: "W", name: "Pedidos", slug: "pedidos", status: "active", activeRelease: null } };
  const router = createMemoryRouter([{ path: "*", element: <GatewaySidebar context={context} selectors={<button>Trocar Workspace</button>} focusContent={() => document.body.focus()} /> }], { initialEntries: ["/workspaces/W/services/S"] });
  root = createRoot(container as unknown as HTMLElement);
  await act(() => root.render(<RouterProvider router={router} />));
  const all = (predicate: (n: TestNode) => boolean) => container.findAll(predicate);
  const button = (label: string) => all((n) => n.tagName === "BUTTON" && (n.getAttribute("aria-label") === label || n.textContent === label))[0]!;
  const click = async (node: TestNode) => { await act(() => { node.dispatchEvent(new Event("click", { bubbles: true })); }); };
  const focus = async (node: TestNode) => { await act(() => { node.focus(); node.dispatchEvent(new Event("focusin", { bubbles: true })); }); };
  const resize = async (matches: boolean) => { await act(() => { media.matches = matches; media.dispatchEvent(new Event("change")); }); };
  return { all, button, click, focus, resize, container, router };
}
describe("Gateway sidebar interactions", () => {
  it("includes the visible Gateway label in the drawer trigger's accessible name", async () => {
    const view = await screen(true);
    const trigger = view.all((n) => n.tagName === "BUTTON" && n.getAttribute("aria-controls")?.endsWith("-drawer") === true)[0]!;
    expect(trigger.getAttribute("aria-label")).toContain(trigger.textContent);
  });
  it("keeps every visible link label within its accessible name, expanded and collapsed", async () => {
    const view = await screen();
    for (const collapsed of [false, true]) {
      if (collapsed) await view.click(view.button("Recolher menu Gateway"));
      const links = view.all((node) => node.getAttribute("aria-label") !== null
        && (node.tagName === "A" || node.getAttribute("role") === "link"));
      expect(links).toHaveLength(9);
      for (const link of links) {
        expect(link.getAttribute("aria-label")!.toLocaleLowerCase("pt-BR"))
          .toContain(link.textContent.toLocaleLowerCase("pt-BR"));
      }
    }
  });
  it("describes unavailable links separately from their visible labels, expanded and collapsed", async () => {
    const view = await screen();
    for (const collapsed of [false, true]) {
      if (collapsed) await view.click(view.button("Recolher menu Gateway"));
      const unavailable = view.all((n) => n.getAttribute("aria-disabled") === "true");
      expect(unavailable).toHaveLength(4);
      for (const item of unavailable) {
        const reasonId = item.getAttribute("aria-describedby")!.split(" ")[0];
        const reason = view.all((n) => n.getAttribute("id") === reasonId)[0]!;
        expect(reason.textContent).toBe("Disponível no ambiente legado");
        expect(reason.getAttribute("hidden") !== null).toBe(collapsed);
        expect(item.contains(reason)).toBe(false);
        expect(item.getAttribute("href")).toBeNull();
      }
    }
  });
  it("hides context selectors while collapsed and restores them on expansion", async () => {
    const view = await screen();
    expect(view.button("Trocar Workspace")).toBeDefined();
    await view.click(view.button("Recolher menu Gateway"));
    expect(view.button("Trocar Workspace")).toBeUndefined();
    await view.click(view.button("Expandir menu Gateway"));
    expect(view.button("Trocar Workspace")).toBeDefined();
  });
  it("collapses without changing accessible names, hrefs, active parent or toggle focus", async () => {
    const view = await screen();
    const toggle = view.button("Recolher menu Gateway");
    await view.focus(toggle);
    await view.click(toggle);
    expect(view.button("Expandir menu Gateway").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    const service = view.all((n) => n.tagName === "A" && n.getAttribute("aria-label") === "Serviços")[0]!;
    expect(service.getAttribute("href")).toBe("/workspaces/W/services");
    expect(service.getAttribute("aria-current")).toBe("page");
    expect(service.getAttribute("aria-describedby")).not.toBeNull();
    expect(view.all((n) => n.getAttribute("role") === "tooltip").map((n) => n.textContent)).toContain("Serviços");
    await view.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
  it("starts closed, opens modal at Close, and restores trigger on Escape/close/backdrop", async () => {
    const view = await screen(true);
    const trigger = view.button("Abrir menu Gateway · Pedidos — Workspace");
    expect(view.all((n) => n.tagName === "DIALOG")).toHaveLength(0);
    for (const method of ["escape", "close", "backdrop"] as const) {
      await view.focus(trigger);
      await view.click(trigger);
      const dialog = view.all((n) => n.tagName === "DIALOG")[0]!;
      expect(dialog.getAttribute("open")).not.toBeNull();
      expect(document.activeElement).toBe(view.button("Fechar menu Gateway"));
      expect(document.body.style.overflow).toBe("hidden");
      if (method === "escape") await act(() => { dialog.dispatchEvent(new Event("cancel", { cancelable: true })); });
      else if (method === "close") await view.click(view.button("Fechar menu Gateway"));
      else await act(() => {
        const event = new Event("click", { bubbles: true });
        Object.assign(event, { clientX: 300, clientY: 200 });
        dialog.dispatchEvent(event);
      });
      expect(view.all((n) => n.tagName === "DIALOG")).toHaveLength(0);
      expect(document.activeElement).toBe(trigger);
      expect(document.body.style.overflow).not.toBe("hidden");
    }
  });
  it("wraps Tab and Shift+Tab within the visible dialog controls", async () => {
    const view = await screen(true);
    await view.click(view.button("Abrir menu Gateway · Pedidos — Workspace"));
    const close = view.button("Fechar menu Gateway");
    const home = view.all((n) => n.tagName === "A" && n.getAttribute("href") === "/")[0]!;
    const key = async (node: TestNode, shiftKey: boolean) => {
      await act(() => {
        const event = new Event("keydown", { bubbles: true, cancelable: true });
        Object.assign(event, { key: "Tab", shiftKey });
        node.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      });
    };
    await key(close, true);
    expect(document.activeElement).toBe(home);
    await key(home, false);
    expect(document.activeElement).toBe(close);
  });
  it("closes on route navigation and releases the scroll lock", async () => {
    const view = await screen(true);
    await view.click(view.button("Abrir menu Gateway · Pedidos — Workspace"));
    await act(async () => { await view.router.navigate("/workspaces/W/routes"); });
    expect(view.all((n) => n.tagName === "DIALOG")).toHaveLength(0);
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(document.activeElement).toBe(document.body);
  });
  it("remembers focusin before CSS blurs on resize and transfers focus both ways", async () => {
    const view = await screen();
    const service = () => view.all((n) => n.tagName === "A" && n.getAttribute("aria-label") === "Serviços")[0]!;
    await view.focus(service());
    document.body.focus(); // CSS can hide the previous surface before matchMedia.change.
    await view.resize(true);
    const trigger = view.button("Abrir menu Gateway · Pedidos — Workspace");
    expect(document.activeElement).toBe(trigger);
    await view.click(trigger);
    await view.focus(service());
    document.body.focus();
    await view.resize(false);
    expect(document.activeElement).toBe(service());
    expect(view.all((n) => n.tagName === "DIALOG")).toHaveLength(0);
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});
