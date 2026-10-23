import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmDialog } from "./Modal";

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
