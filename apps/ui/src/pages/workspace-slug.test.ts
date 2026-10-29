import { describe, expect, it } from "vitest";
import { normalizeSlug, RESERVED_SLUGS, slugProblem } from "./workspace-slug";

// The cases of apps/control-plane/src/workspaces/slug.test.ts: the suggestion must be the slug the server derives.
describe("normalizeSlug", () => {
  it.each([
    ["Gestão de Pagamentos", "gestao-de-pagamentos"],
    ["TVRO", "tvro"],
    ["  Área   Técnica  ", "area-tecnica"],
    ["São João / Recarga_PIX", "sao-joao-recarga-pix"],
    ["Ação---Rápida!!", "acao-rapida"],
    ["Straße", "strasse"],
    ["Æon Ølkompagni Łódź", "aeon-olkompagni-lodz"],
    ["ﬁnanças", "financas"],
    ["Pagamentos 💸 2026", "pagamentos-2026"],
    ["😀", ""],
    ["   ", ""],
    ["a".repeat(50), "a".repeat(40)],
    [`${"a".repeat(39)} b`, "a".repeat(39)],
  ])("%j → %j", (name, slug) => {
    expect(normalizeSlug(name)).toBe(slug);
  });

  it("is stable: the same name always gives the same slug", () => {
    expect(normalizeSlug(normalizeSlug("Gestão de Pagamentos"))).toBe("gestao-de-pagamentos");
  });
});

describe("slugProblem", () => {
  it.each(["tvro", "ab", "gestao-de-pagamentos", "a1", "w-2026", "a".repeat(40)])("accepts %s", (slug) => {
    expect(slugProblem(slug)).toBeNull();
  });

  it.each(["", "a", "1abc", "-abc", "abc-", "a--b", "Abc", "a_b", "a/b", "á", "a".repeat(41)])("refuses %j as invalid", (slug) => {
    expect(slugProblem(slug)).toBe("invalid");
  });

  it.each([...RESERVED_SLUGS, "gromesh-workspace", "gromesh-x"])("refuses %s as reserved", (slug) => {
    expect(slugProblem(slug)).toBe("reserved");
  });

  it("reserves the same slugs as the contract", async () => {
    const { readFileSync } = await import("node:fs");
    const contract = readFileSync(new URL("../../../../contracts/control-plane-v2.openapi.yaml", import.meta.url), "utf8");
    const listed = /x-gromesh-reserved-slugs: \[([^\]]*)\]/.exec(contract)?.[1]?.split(",").map((s) => s.trim()) ?? [];
    expect([...RESERVED_SLUGS].sort()).toEqual(listed.sort());
  });
});
