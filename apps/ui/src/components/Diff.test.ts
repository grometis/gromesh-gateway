import { describe, expect, it } from "vitest";
import { changeTitle } from "./Diff";

describe("changeTitle", () => {
  it("rebuilds the compiler's English labels in pt-BR without repeating the kind", () => {
    expect(changeTitle({ kind: "keyauth_credentials", label: "key-auth credential of consumer partner" })).toBe("Credencial key-auth do consumer partner");
    expect(changeTitle({ kind: "jwt_secrets", label: "JWT credential acme-mobile" })).toBe("Credencial JWT acme-mobile");
    expect(changeTitle({ kind: "basicauth_credentials", label: "basic-auth credential alice" })).toBe("Credencial basic-auth alice");
    expect(changeTitle({ kind: "acls", label: "group gold of consumer partner" })).toBe("Grupo gold do consumer partner");
    expect(changeTitle({ kind: "certificates", label: "certificate api.example.com, *.example.com" })).toBe("Certificado api.example.com, *.example.com");
  });

  it("names the other kinds by their kind and name", () => {
    expect(changeTitle({ kind: "services", label: "orders" })).toBe("Service orders");
    expect(changeTitle({ kind: "targets", label: "echo:80" })).toBe("Target echo:80");
    // A label in an unexpected shape is still shown, prefixed by the kind.
    expect(changeTitle({ kind: "acls", label: "something else" })).toBe("Grupo ACL something else");
  });
});
