import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { statusMessage, toFormErrors } from "./errors";

const problem = (status: number, errors?: { path: string; message: string }[], detail?: string) =>
  new ApiError(status, { type: "x", title: "t", status, ...(detail ? { detail } : {}), ...(errors ? { errors } : {}) });

describe("toFormErrors", () => {
  it("maps 422 paths onto known fields by their first segment", () => {
    const err = problem(422, [
      { path: "name", message: "must match pattern" },
      { path: "paths.0", message: "must start with '/'" },
      { path: "(body)", message: "must define at least one of paths, hosts, methods or headers" },
      { path: "weird.thing", message: "is invalid" },
    ]);
    expect(toFormErrors(err, ["name", "paths"])).toEqual({
      fields: { name: ["must match pattern"], paths: ["paths.0: must start with '/'"] },
      form: ["must define at least one of paths, hosts, methods or headers", "weird.thing: is invalid"],
    });
  });

  it("falls back to a status message when there are no field errors", () => {
    expect(toFormErrors(problem(409, undefined, "Service is used by 2 route(s)"), ["name"]).form).toEqual(["Service is used by 2 route(s)"]);
    expect(toFormErrors(new TypeError("fetch failed"), []).form).toEqual(["Não foi possível falar com o servidor. Tente de novo."]);
  });
});

describe("statusMessage", () => {
  it("explains common statuses in Portuguese", () => {
    expect(statusMessage(problem(403))).toBe("Você não tem permissão para esta ação.");
    expect(statusMessage(problem(404))).toMatch(/não encontrado/);
    expect(statusMessage(problem(500))).toBe("Erro inesperado (HTTP 500).");
  });
});
