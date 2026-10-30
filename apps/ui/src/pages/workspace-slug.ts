// Same rules as the control plane (apps/control-plane/src/workspaces/slug.ts, GW-WS-10): the server decides, this
// only suggests the slug while the name is typed and explains a refusal before sending it.
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const MAX = 40;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api", "admin", "agent", "status", "metrics", "health", "healthz", "ready", "gromesh", "kong", "well-known", "static", "assets",
]);

// Letters NFKD does not decompose into a base letter plus a mark.
const LIGATURES: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ð: "d", ł: "l", þ: "th", ı: "i" };

export type SlugProblem = "invalid" | "reserved";

export function slugProblem(slug: string): SlugProblem | null {
  if (!SLUG_PATTERN.test(slug) || slug.endsWith("-") || slug.includes("--")) return "invalid";
  if (RESERVED_SLUGS.has(slug) || slug.startsWith("gromesh-")) return "reserved";
  return null;
}

/** The name normalized (NFKD, no diacritics, lowercase, anything else → `-`, collapsed and trimmed, at most 40). */
export function normalizeSlug(name: string): string {
  const folded = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, (c) => LIGATURES[c] ?? "-");
  return trim(folded.replace(/[^a-z0-9]+/g, "-")).slice(0, MAX).replace(/-+$/, "");
}

const trim = (s: string) => s.replace(/^-+|-+$/g, "");
