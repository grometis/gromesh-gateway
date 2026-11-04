import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestDom, type TestNode } from "../test/dom";
import { ConfirmDialog, Modal } from "./Modal";

let root: Root | undefined;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; vi.unstubAllGlobals(); });

async function keyboardScreen() {
  const container = installTestDom();
  function Screen() {
    const [open, setOpen] = useState(false);
    const [nested, setNested] = useState(false);
    const [enabled, setEnabled] = useState(false);
    return <>
      <button onClick={() => setOpen(true)}>Abrir</button>
      {open && <Modal title="Publicar" onClose={() => setOpen(false)} footer={<>
        <button onClick={() => setNested(true)}>Outro diálogo</button>
        <button disabled={!enabled}>Confirmar</button>
        <button hidden>Oculto</button>
        <button tabIndex={-1}>Fora da sequência</button>
      </>}>
        <input aria-label="Resumo" />
        <button onClick={() => setEnabled(!enabled)}>Alternar confirmação</button>
        {nested && <Modal title="Aninhado" onClose={() => setNested(false)}><input aria-label="Detalhe" /></Modal>}
      </Modal>}
      <button>Depois</button>
    </>;
  }
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container as unknown as HTMLElement);
  await act(() => root!.render(<Screen />));
  const button = (label: string) => container.findAll((node) => node.tagName === "BUTTON" && node.textContent === label)[0]!;
  const click = async (node: TestNode) => { node.focus(); await act(() => { node.dispatchEvent(new Event("click", { bubbles: true })); }); };
  const key = async (name: string, shiftKey = false) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key: name, shiftKey });
    await act(() => { window.dispatchEvent(event); });
    return event;
  };
  const dialogs = () => container.findAll((node) => node.getAttribute("role") === "dialog");
  await click(button("Abrir"));
  return { container, button, click, key, dialogs };
}

describe("Modal keyboard", () => {
  it("focuses the dialog on opening and restores its opener after Escape", async () => {
    const view = await keyboardScreen();
    expect(view.dialogs()[0]!.contains(document.activeElement as unknown as TestNode)).toBe(true);
    await view.key("Escape");
    expect(view.dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(view.button("Abrir"));
  });

  it("wraps both Tab boundaries, skips unavailable controls and follows enabled state without resetting focus", async () => {
    const view = await keyboardScreen();
    const close = view.container.findAll((node) => node.getAttribute("aria-label") === "Fechar")[0]!;
    close.focus();
    expect((await view.key("Tab", true)).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.button("Outro diálogo"));
    expect((await view.key("Tab")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    const input = view.container.findAll((node) => node.getAttribute("aria-label") === "Resumo")[0]!;
    input.focus();
    expect((await view.key("Tab")).defaultPrevented).toBe(false);
    expect((await view.key("Tab", true)).defaultPrevented).toBe(false);
    await view.click(view.button("Alternar confirmação"));
    expect(document.activeElement).toBe(view.button("Alternar confirmação"));
    close.focus();
    await view.key("Tab", true);
    expect(document.activeElement).toBe(view.button("Confirmar"));
    await view.key("Tab");
    expect(document.activeElement).toBe(close);
  });

  it("traps and closes only the top dialog, then restores focus through both openers", async () => {
    const view = await keyboardScreen();
    await view.click(view.button("Outro diálogo"));
    const nested = view.dialogs()[1]!;
    expect(nested.contains(document.activeElement as unknown as TestNode)).toBe(true);
    const input = nested.findAll((node) => node.tagName === "INPUT")[0]!;
    input.focus();
    await view.key("Tab");
    expect(document.activeElement).toBe(nested.findAll((node) => node.tagName === "BUTTON")[0]);
    await view.key("Escape");
    expect(view.dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe(view.button("Outro diálogo"));
    await view.key("Escape");
    expect(view.dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(view.button("Abrir"));
  });
});

const props = {
  title: "Restaurar v1", message: "Uma nova versão será publicada.", confirmLabel: "Confirmar rollback",
  busy: false, error: null, onConfirm: () => {}, onClose: () => {},
};

describe("ConfirmDialog", () => {
  it("blocks confirmation while a preview is unavailable and keeps it outside the message paragraph", () => {
    const html = renderToStaticMarkup(<ConfirmDialog {...props} confirmDisabled><section aria-label="Diff v2 → v1"><h2>Alterações</h2></section></ConfirmDialog>);
    expect(html).toContain('class="danger" disabled=""');
    expect(html).toContain('<p>Uma nova versão será publicada.</p><section aria-label="Diff v2 → v1">');
    expect(html).toContain('type="button">Cancelar</button>');
  });

  it("retains the existing enabled, busy and error states", () => {
    const enabled = renderToStaticMarkup(<ConfirmDialog {...props} />);
    expect(enabled).toContain('class="danger">Confirmar rollback</button>');
    const busy = renderToStaticMarkup(<ConfirmDialog {...props} busy error="Não foi possível restaurar." />);
    expect(busy).toContain('class="danger" disabled=""');
    expect(busy).toContain('role="alert">Não foi possível restaurar.</p>');
  });
});
