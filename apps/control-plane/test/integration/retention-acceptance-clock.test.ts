import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../../../scripts/stack-guard.mjs", () => ({ assertStack: async () => {} }));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test("the TTL acceptance uses one old UTC timestamp and its partition even across midnight", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T23:59:59Z"));
  const queries: string[] = [];
  let cleaned = false;
  vi.stubGlobal("fetch", async (_url: unknown, options: { body: string }) => {
    const query = options.body;
    queries.push(query);
    if (query.startsWith("SELECT formatDateTime")) {
      vi.setSystemTime(new Date("2026-10-19T00:00:01Z"));
      return new Response("2026-10-16 23:59:59\n");
    }
    if (query.startsWith("ALTER TABLE")) cleaned = true;
    if (query.startsWith("SELECT path")) return new Response(JSON.stringify({ data: cleaned ? [] : [
      { path: "/kept-seven", retention_days: 7 }, { path: "/legacy-default", retention_days: 7 }, { path: "/recent-short", retention_days: 1 },
    ] }));
    return new Response("");
  });
  const { retentionAcceptance } = await import(new URL("../../../../e2e/route-retention.mjs", import.meta.url).href) as { retentionAcceptance: () => Promise<string> };
  await retentionAcceptance();
  const inserts = queries.filter((query) => query.startsWith("INSERT"));
  expect(inserts).toHaveLength(2);
  expect(inserts[0]!.match(/2026-10-16 23:59:59/g)).toHaveLength(2);
  expect(inserts[1]).toContain("2026-10-16 23:59:59");
  expect(queries).toContain("OPTIMIZE TABLE gromesh.requests PARTITION '2026-10-16' FINAL SETTINGS optimize_skip_merged_partitions = 0");
  expect(cleaned).toBe(true);
});
