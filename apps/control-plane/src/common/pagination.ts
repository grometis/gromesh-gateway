import { unprocessable } from "./problem.js";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Cursor {
  /** sort key of the last item (name) */
  k: string;
  id: string;
}

export function parseLimit(raw: unknown): number {
  if (raw === undefined) return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw unprocessable("Invalid limit", [{ path: "limit", message: "must be an integer between 1 and 200" }]);
  return n;
}

export function decodeCursor(raw: unknown): Cursor | null {
  if (raw === undefined || raw === "") return null;
  try {
    const c = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8")) as Cursor;
    if (typeof c.k === "string" && typeof c.id === "string") return c;
  } catch {}
  throw unprocessable("Invalid cursor", [{ path: "cursor", message: "is not a valid cursor" }]);
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Fetch limit+1 rows, return a page and the cursor for the next one. */
export function toPage<R extends { id: string }, T>(rows: R[], limit: number, key: (r: R) => string, map: (r: R) => T): Page<T> {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice.at(-1);
  return { items: slice.map(map), nextCursor: hasMore && last ? encodeCursor({ k: key(last), id: last.id }) : null };
}
