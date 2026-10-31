import { describe, expect, it } from "vitest";
import { ApiError, type Problem } from "../api/client";
import { GATEWAY_MESSAGES, gatewayErrorMessage, gatewayFormErrors, gatewayMessage } from "./gateway-errors";
import { CONFLICTS } from "./workspace-errors";

const problem = (status: number, extra: Record<string, unknown> = {}) =>
  new ApiError(status, { type: "about:blank", title: "Problem", status, ...extra } as Problem);
const invalid = (...errors: { path: string; message: string }[]) => problem(422, { errors });

describe("gatewayFormErrors", () => {
  it("puts the v2 service rules on the field the user sees", () => {
    expect(gatewayFormErrors(invalid({ path: "upstreamId", message: "unknown upstream in this workspace" }), "service").fields)
      .toEqual({ upstreamId: ["O upstream escolhido não pertence a este Workspace."] });
    // A DNS host that names an upstream is answered at upstreamId; the DNS form only has the host.
    expect(gatewayFormErrors(invalid({ path: "upstreamId", message: "host orders.upstream is an upstream of this workspace: refer to it by upstreamId" }), "service").fields)
      .toEqual({ host: ["Este host é um upstream do Workspace: escolha “Upstream do Workspace”."] });
    expect(gatewayFormErrors(invalid({ path: "host", message: "must be the upstream's name (orders.upstream) when upstreamId is set" }), "service").fields)
      .toEqual({ host: ["Com um upstream, o host precisa ser o nome dele."] });
    expect(gatewayFormErrors(invalid({ path: "host", message: "variable ORDERS_HOST is not declared in this workspace" }), "service").fields)
      .toEqual({ host: ["Host: variáveis de ambiente ainda não podem ser usadas."] });
    expect(gatewayFormErrors(invalid({ path: "host", message: "loopback address (forbidden destination)" }), "service").fields)
      .toEqual({ host: ["Host: destino proibido pela plataforma."] });
    expect(gatewayFormErrors(invalid({ path: "port", message: "must be <= 65535" }), "service").fields)
      .toEqual({ port: ["Porta: use um valor de no máximo 65535."] });
  });

  it("puts the route rules on serviceId and on paths, numbered from 1", () => {
    expect(gatewayFormErrors(invalid({ path: "serviceId", message: "unknown service in this environment" }), "route").fields)
      .toEqual({ serviceId: ["O service escolhido não pertence a este Workspace."] });
    expect(gatewayFormErrors(invalid(
      { path: "paths.0", message: "must match pattern \"^(/|~/)\"" },
      { path: "paths.1", message: "unbalanced parenthesis at offset 3" },
    ), "route").fields).toEqual({ paths: ["Path 1: precisa começar com / (ou ~/ para expressão regular).", "Path 2: expressão regular recusada pelo servidor."] });
    expect(gatewayFormErrors(invalid({ path: "paths", message: "must NOT have fewer than 1 items" }), "route").fields)
      .toEqual({ paths: ["Paths: valor inválido."] });
  });

  it.each([
    ["auto-publish", GATEWAY_MESSAGES.autoPublish],
    ["concurrent-update", GATEWAY_MESSAGES.concurrent],
    ["workspace-archived", CONFLICTS["workspace-archived"]],
  ])("shows the 409 %s on the form", (code, text) => {
    expect(gatewayFormErrors(problem(409, { code, detail: "English" }), "service")).toEqual({ fields: {}, form: [text] });
    expect(gatewayErrorMessage(problem(409, { code }))).toBe(text);
  });

  it("puts path-compatibility on stripPath and a duplicate on the name", () => {
    expect(gatewayFormErrors(problem(409, { code: "path-compatibility", errors: [{ path: "stripPath", message: "differs from the legacy route's" }] }), "route"))
      .toEqual({ fields: { stripPath: [GATEWAY_MESSAGES.pathCompatibility] }, form: [] });
    expect(gatewayFormErrors(problem(409, { detail: "An entity with the same unique field already exists" }), "route"))
      .toEqual({ fields: { name: [GATEWAY_MESSAGES.duplicate.route] }, form: [] });
    expect(gatewayFormErrors(problem(409, { detail: "An entity with the same unique field already exists" }), "service"))
      .toEqual({ fields: { name: [GATEWAY_MESSAGES.duplicate.service] }, form: [] });
  });

  it.each(["host", "upstreamId", "name"])("puts upstream-captures-service on its %s field", (path) => {
    expect(gatewayFormErrors(problem(409, {
      code: "upstream-captures-service", errors: [{ path, message: "would capture a service's DNS host" }],
    }), "service")).toEqual({ fields: { [path]: [GATEWAY_MESSAGES.upstreamCapturesService] }, form: [] });
  });

  it("puts upstream-captures-service without a path on the DNS host", () => {
    expect(gatewayFormErrors(problem(409, { code: "upstream-captures-service" }), "service"))
      .toEqual({ fields: { host: [GATEWAY_MESSAGES.upstreamCapturesService] }, form: [] });
  });

  it.each([
    ["concurrent-update", GATEWAY_MESSAGES.concurrent], ["auto-publish", GATEWAY_MESSAGES.autoPublish],
  ])("keeps a 409 %s path on its field", (code, text) => {
    expect(gatewayFormErrors(problem(409, { code, errors: [{ path: "host", message: "English" }] }), "service"))
      .toEqual({ fields: { host: [text] }, form: [] });
  });

  it("maps other 409 validation paths to their fields in Portuguese", () => {
    expect(gatewayFormErrors(problem(409, { errors: [{ path: "port", message: "must be <= 65535" }] }), "service"))
      .toEqual({ fields: { port: ["Porta: use um valor de no máximo 65535."] }, form: [] });
  });

  it("names a 403 and never shows the validator's English", () => {
    expect(gatewayFormErrors(problem(403), "route")).toEqual({ fields: {}, form: [GATEWAY_MESSAGES.forbidden] });
    expect(gatewayErrorMessage(problem(403))).toBe(GATEWAY_MESSAGES.forbidden);
    for (const [path, message] of [["name", "is required"], ["tags", "must be array"], ["(body)", "must NOT have additional properties"], ["retries", "whatever"]] as const) {
      expect(gatewayMessage(path, message)).not.toMatch(/must|required|whatever/);
    }
  });
});
