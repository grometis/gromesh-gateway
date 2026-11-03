import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { User } from "../api/client";
import { UsersPage } from "./Users";

const users: User[] = [
  { id: "user-1", name: "Ana Souza", email: "ana@example.test", role: "admin", active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" },
  { id: "user-2", name: "Rui Prado", email: "rui@example.test", role: "viewer", active: false, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" },
];

describe("user row actions", () => {
  it("includes each visible text label in the accessible name and retains native keyboard semantics", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(["users"], { pages: [{ items: users, nextCursor: null }], pageParams: [""] });
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><UsersPage /></QueryClientProvider>);
    const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].filter((row) => row[1]!.includes('class="identity-actions"'));
    expect(rows).toHaveLength(users.length);

    for (const [index, row] of rows.entries()) {
      const buttons = [...row[1]!.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
      expect(buttons).toHaveLength(4);
      for (const [, attributes, content] of buttons) {
        expect(attributes).toContain('type="button"');
        expect(attributes).not.toMatch(/\bdisabled|\btabindex="-1"/i);
        const text = content!.replace(/<[^>]*>/g, "").trim();
        const label = /aria-label="([^"]*)"/.exec(attributes!)?.[1];
        if (text === "⋯") {
          // This is an icon, not a textual label under WCAG 2.5.3.
          expect(label).toBe(`Mais ações para ${users[index]!.name}`);
        } else {
          expect(text).not.toBe("");
          expect((label ?? text).startsWith(text)).toBe(true);
          if (text === "Ambientes (legado)") expect(label).toBe(`Ambientes (legado) de ${users[index]!.name}`);
        }
      }
    }
    client.clear();
  });
});
