import { describe, expect, it } from "vitest";
import { ApiError, type Problem } from "../api/client";
import { CONFLICTS, FORBIDDEN, validationMessage, workspaceErrorMessage, workspaceFormErrors } from "./workspace-errors";

const conflict = (code: string, extra: Record<string, unknown> = {}) => {
  const problem = { type: `https://gromesh.dev/problems/${code}`, title: "Conflict", status: 409, code, detail: "English detail", ...extra };
  return new ApiError(409, problem as Problem);
};
const invalid = (errors: { path: string; message: string }[]) => new ApiError(422, { type: "about:blank", title: "Unprocessable", status: 422, errors });

describe("workspaceFormErrors", () => {
  it("puts slug-taken on the slug and offers the suggestion without applying it", () => {
    const out = workspaceFormErrors(conflict("slug-taken", { errors: [{ path: "slug", message: "English detail" }], suggestedSlug: "tvro-2" }));
    expect(out).toEqual({ fields: { slug: [CONFLICTS["slug-taken"]] }, form: [], suggestedSlug: "tvro-2" });
  });

  it("puts name-taken on the name, with the slug suggestion when the server sends one", () => {
    expect(workspaceFormErrors(conflict("name-taken", { suggestedSlug: "pagamentos-2" }))).toEqual({
      fields: { name: [CONFLICTS["name-taken"]] }, form: [], suggestedSlug: "pagamentos-2",
    });
    expect(workspaceFormErrors(conflict("name-taken")).suggestedSlug).toBeNull();
  });

  it.each(["workspaces-mode-disabled", "workspace-archived", "creation-policy"])("shows %s on the form, in Portuguese", (code) => {
    const out = workspaceFormErrors(conflict(code, { suggestedSlug: "ignored" }));
    expect(out.fields).toEqual({});
    expect(out.form).toEqual([CONFLICTS[code as keyof typeof CONFLICTS]]);
    expect(out.form[0]).not.toContain("English");
    expect(out.suggestedSlug).toBeNull();
  });

  it("maps 422 errors[].path onto the fields, explaining slug refusals", () => {
    expect(workspaceFormErrors(invalid([{ path: "slug", message: "reserved slug" }])).fields).toEqual({ slug: ["Slug reservado pela plataforma. Escolha outro."] });
    expect(workspaceFormErrors(invalid([{ path: "slug", message: "must match ^[a-z][a-z0-9-]{1,39}$" }])).fields).toEqual({ slug: ["Slug inválido: confira a regra abaixo."] });
    const out = workspaceFormErrors(invalid([
      { path: "name", message: "must NOT have more than 100 characters" },
      { path: "description", message: "must be string" },
      { path: "(body)", message: "must NOT have additional properties" },
    ]));
    expect(out.fields).toEqual({ name: ["Nome: use no máximo 100 caracteres."], description: ["Descrição: tipo de valor inválido."] });
    expect(out.form).toEqual(["A requisição tem campos não aceitos."]);
  });

  it.each([
    ["name", "is required", "Nome: campo obrigatório."],
    ["name", "must NOT have fewer than 1 characters", "Nome: campo obrigatório."],
    ["name", "must NOT have fewer than 3 characters", "Nome: use no mínimo 3 caracteres."],
    ["name", "must NOT have more than 100 characters", "Nome: use no máximo 100 caracteres."],
    ["description", "must match format \"x\"", "Descrição: formato inválido."],
    ["description", "something new", "Descrição: valor inválido."],
    ["slug", "must match pattern \"^[a-z]\"", "Slug inválido: confira a regra abaixo."],
    ["(body)", "anything", "Requisição inválida."],
  ])("translates %s: %s", (path, message, text) => {
    expect(validationMessage(path, message)).toBe(text);
  });

  it("never shows the validator's English", () => {
    for (const message of ["is required", "must NOT have more than 100 characters", "must be string", "must match pattern", "weird"]) {
      expect(validationMessage("name", message)).not.toMatch(/must|required|weird/);
    }
  });

  it("names a 403 with the action's own words when given", () => {
    const forbidden = new ApiError(403, { type: "about:blank", title: "Forbidden", status: 403 });
    expect(workspaceFormErrors(forbidden, FORBIDDEN.edit)).toEqual({ fields: {}, form: [FORBIDDEN.edit], suggestedSlug: null });
    expect(workspaceErrorMessage(forbidden, FORBIDDEN.archive)).toBe(FORBIDDEN.archive);
  });

  it("keeps a 403 and a network failure on the form", () => {
    expect(workspaceFormErrors(new ApiError(403, { type: "about:blank", title: "Forbidden", status: 403 })).form).toEqual(["Você não tem permissão para esta ação."]);
    expect(workspaceFormErrors(new TypeError("fetch failed")).form).toEqual(["Não foi possível falar com o servidor. Tente de novo."]);
  });
});

describe("workspaceErrorMessage", () => {
  it.each(["active-release", "deployed", "published-configuration", "clusters"] as const)("explains an archive refused by %s", (code) => {
    expect(workspaceErrorMessage(conflict(code))).toBe(CONFLICTS[code]);
  });

  it("falls back to the status message for anything else", () => {
    expect(workspaceErrorMessage(new ApiError(403, { type: "about:blank", title: "Forbidden", status: 403 }))).toBe("Você não tem permissão para esta ação.");
    expect(workspaceErrorMessage(conflict("not-a-workspace-code"))).toBe("English detail");
  });
});
