import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as fields from "./Field";
import { ApiError } from "../api/client";
import { gatewayFormErrors } from "../pages/gateway-errors";

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
