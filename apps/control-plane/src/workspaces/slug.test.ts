import { describe, expect, it } from "vitest";
import { normalizeSlug, proposeSlug, RESERVED_SLUGS, SLUG_PATTERN, slugProblem } from "./slug.js";

const none = new Set<string>();

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
    expect(normalizeSlug("Gestão de Pagamentos")).toBe(normalizeSlug("Gestão de Pagamentos"));
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
});

describe("proposeSlug", () => {
  it("derives the slug when the normalized name is free", () => {
    expect(proposeSlug("Gestão de Pagamentos", none)).toEqual({ slug: "gestao-de-pagamentos", status: "derived" });
  });

  it.each([
    ["TVRO", ["tvro"], "tvro-2"],
    ["TVRO", ["tvro", "tvro-2", "tvro-3"], "tvro-4"],
    ["T.V.R.O", ["t-v-r-o"], "t-v-r-o-2"],
    ["a".repeat(45), ["a".repeat(40)], `${"a".repeat(38)}-2`],
  ])("adjusts a collision: %s with %j → %s", (name, taken, slug) => {
    expect(proposeSlug(name, new Set(taken))).toEqual({ slug, status: "adjusted", reason: "collision" });
  });

  it.each([
    ["API", "api-2"],
    ["Admin", "admin-2"],
    ["well known", "well-known-2"],
    ["Gromesh", "w-gromesh"],
    ["gromesh workspace", "w-gromesh-workspace"],
  ])("adjusts a reserved name: %s → %s", (name, slug) => {
    expect(proposeSlug(name, none)).toEqual({ slug, status: "adjusted", reason: "reserved" });
  });

  it.each([
    ["2026", "w-2026"],
    ["123 Recargas", "w-123-recargas"],
    ["😀", "workspace"],
    ["x", "workspace"],
    ["", "workspace"],
  ])("adjusts an invalid name: %j → %s", (name, slug) => {
    expect(proposeSlug(name, none)).toEqual({ slug, status: "adjusted", reason: "invalid" });
  });

  it("keeps adjusting until the slug is free, valid and not reserved", () => {
    expect(proposeSlug("😀", new Set(["workspace", "workspace-2"]))).toEqual({ slug: "workspace-3", status: "adjusted", reason: "invalid" });
    expect(proposeSlug("API", new Set(["api-2"]))).toEqual({ slug: "api-3", status: "adjusted", reason: "reserved" });
  });

  it("always proposes a valid, unreserved and free slug", () => {
    const taken = new Set<string>();
    const names = ["TVRO", "tvro", "TVRO ", "Tvrö", "API", "Gromesh", "gromesh-x", "", "1", "a".repeat(60), "a".repeat(61), "😀", "😀"];
    for (const name of names) {
      const { slug } = proposeSlug(name, taken);
      expect(SLUG_PATTERN.test(slug), `${name} → ${slug}`).toBe(true);
      expect(slugProblem(slug), `${name} → ${slug}`).toBeNull();
      expect(taken.has(slug), `${name} → ${slug} repeats`).toBe(false);
      taken.add(slug);
    }
    expect(taken.size).toBe(names.length);
  });
});
