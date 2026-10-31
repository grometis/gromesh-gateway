/** Exact, mergeable content bounds for ONE request id; not a retention policy or a serving watermark. */
export interface RequestCopyState {
  readonly id: string;
  readonly minContent: string;
  readonly maxContent: string;
}

function scalar(value: unknown): readonly [string, string] {
  if (value === null) return ["null", ""];
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "bigint") return [typeof value, String(value)];
  if (typeof value === "number" && Number.isFinite(value)) return ["number", Object.is(value, -0) ? "-0" : String(value)];
  throw new TypeError("Expected a finite stored scalar; decode UInt64 columns as bigint or lossless strings");
}

/**
 * Input is a decoded, flat stored row, without id or ingestion metadata. No UUID/date/IP normalisation is done here:
 * the storage adapter must supply canonical typed values, and decode UInt64 without passing through JS numbers.
 * Field names and scalar types are retained, including future columns. The encoding is internal, not a wire format.
 */
export function copyStateOf(id: string, content: Readonly<Record<string, unknown>>): RequestCopyState {
  const encoded = JSON.stringify(Object.keys(content).sort().map((key) => [key, ...scalar(content[key])]));
  return { id, minContent: encoded, maxContent: encoded };
}

/** Min/max are associative, commutative and idempotent, so retries and block boundaries cannot erase a conflict. */
export function mergeCopyStates(a: RequestCopyState, b: RequestCopyState): RequestCopyState {
  if (a.id !== b.id) throw new TypeError("Cannot merge different request ids");
  return {
    id: a.id,
    minContent: a.minContent < b.minContent ? a.minContent : b.minContent,
    maxContent: a.maxContent > b.maxContent ? a.maxContent : b.maxContent,
  };
}

/** A conflict intentionally exposes no representative that attribution could accidentally choose. */
export function readCopyState(state: RequestCopyState): { kind: "identical"; content: string } | { kind: "conflicting-copies" } {
  return state.minContent === state.maxContent
    ? { kind: "identical", content: state.minContent }
    : { kind: "conflicting-copies" };
}
