/**
 * Workspace slugs (GW-WS-10): the public path prefix of a workspace, `^[a-z][a-z0-9-]{1,39}$`, unique in the instance,
 * never reserved, and immutable after the first release (renaming the workspace keeps the slug).
 */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const MAX = 40;

/** Paths the instance serves itself, or that would read as the platform's (B §3.3), plus every `gromesh-*`. */
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

export interface ProposedSlug {
  slug: string;
  status: "derived" | "adjusted";
  /** Why the normalized name could not be used as is; only when adjusted. */
  reason?: "collision" | "invalid" | "reserved";
}

/**
 * The slug a workspace gets from its name. When the normalized name is invalid, reserved or taken, the slug is
 * adjusted (a `w-` prefix or a `-2`, `-3`… suffix) and the reason is reported: an adjusted slug is never applied
 * silently, the migration report lists it for review before the first release.
 */
export function proposeSlug(name: string, taken: ReadonlySet<string>): ProposedSlug {
  let base = normalizeSlug(name);
  let reason: ProposedSlug["reason"];
  const problem = slugProblem(base);
  if (problem === "invalid") {
    reason = "invalid";
    base = /^[a-z]/.test(base) ? base : trim(`w-${base}`).slice(0, MAX).replace(/-+$/, "");
    if (slugProblem(base) !== null) base = "workspace";
  } else if (problem === "reserved") {
    reason = "reserved";
    // Any suffix keeps a gromesh-* slug reserved, so those get the prefix instead.
    if (base === "gromesh" || base.startsWith("gromesh-")) base = `w-${base}`.slice(0, MAX).replace(/-+$/, "");
  } else if (taken.has(base)) {
    reason = "collision";
  } else {
    return { slug: base, status: "derived" };
  }
  if (slugProblem(base) === null && !taken.has(base)) return { slug: base, status: "adjusted", reason };
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (slugProblem(candidate) === null && !taken.has(candidate)) return { slug: candidate, status: "adjusted", reason };
  }
}

const trim = (s: string) => s.replace(/^-+|-+$/g, "");
