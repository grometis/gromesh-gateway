import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { installTestDom } from "../test/dom";
import * as fields from "./Field";
import { ApiError } from "../api/client";
import { gatewayFormErrors } from "../pages/gateway-errors";

describe("form error announcements", () => {
  it("keeps native list semantics inside the alert", async () => {
    const container = installTestDom();
    const root = createRoot(container as unknown as HTMLElement);
    try {
      await act(() => root.render(<fields.FormErrorList messages={["Operação recusada.", "Tente novamente."]} />));
      const alert = container.findAll(node => node.getAttribute("role") === "alert")[0]!;
      expect(alert).toBeDefined();
      const list = alert.findAll(node => node.tagName === "UL")[0]!;
      expect(list).toBeDefined();
      expect(list.getAttribute("role")).toBeNull();
      expect(list.childNodes.map(node => [node.tagName, node.textContent])).toEqual([
        ["LI", "Operação recusada."], ["LI", "Tente novamente."],
      ]);
      await act(() => root.render(<fields.FormErrorList messages={[]} />));
      expect(container.childNodes).toHaveLength(0);
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});

// Both names are recognized by the API error mapper; neither may disappear in a checkbox.
describe("checkbox field errors", () => {
  it.each([["enabled", "Ativo", "service"], ["preserveHost", "Preservar o host original", "route"]] as const)(
    "renders %s errors beside the checkbox and associates them accessibly", (field, label, kind) => {
      const errors = gatewayFormErrors(new ApiError(422, {
        type: "https://gromesh.dev/problems/422", title: "Invalid request", status: 422, errors: [{ path: field, message: "must be boolean" }],
      }), kind);
      const html = renderToStaticMarkup(<fields.CheckboxField label={label} checked onChange={() => {}} errors={errors.fields[field]} />);
      expect(html).toContain('type="checkbox"');
      expect(html).toContain('aria-invalid="true"');
      const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
      expect(describedBy).toBeTruthy();
      expect(html).toContain(`id="${describedBy}"`);
      expect(html).toContain('role="alert"');
      expect(html).toContain(errors.fields[field]![0]);
      expect(errors.form).toEqual([]);
    },
  );
});
