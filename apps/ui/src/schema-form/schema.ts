/**
 * The plugin schemas served by GET /plugin-schemas/{name} are the gateway's own schema format: an ordered list of
 * one-key objects `{ fieldName: definition }`. This module reads that format without trusting its shape.
 */

export interface SchemaField {
  type: string;
  required: boolean;
  default?: unknown;
  oneOf?: unknown[];
  between?: [number, number];
  gt?: number;
  lenMin?: number;
  lenMax?: number;
  encrypted: boolean;
  deprecated: boolean;
  description?: string;
  /** `eq: null` on a foreign field means the plugin cannot be scoped to that entity. */
  forbidden: boolean;
  fields?: NamedField[];
  elements?: SchemaField;
  values?: SchemaField;
}

export interface NamedField {
  name: string;
  field: SchemaField;
}

export type Config = Record<string, unknown>;

export const SECRET_PLACEHOLDER = "REDACTED";

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

export function parseField(raw: unknown): SchemaField {
  const d = isObject(raw) ? raw : {};
  const between = Array.isArray(d.between) && d.between.length === 2 && d.between.every((n) => typeof n === "number") ? (d.between as [number, number]) : undefined;
  return {
    type: typeof d.type === "string" ? d.type : "unknown",
    required: d.required === true,
    ...("default" in d ? { default: d.default } : {}),
    ...(Array.isArray(d.one_of) ? { oneOf: d.one_of } : {}),
    ...(between ? { between } : {}),
    ...(num(d.gt) !== undefined ? { gt: num(d.gt) } : {}),
    ...(num(d.len_min) !== undefined ? { lenMin: num(d.len_min) } : {}),
    ...(num(d.len_max) !== undefined ? { lenMax: num(d.len_max) } : {}),
    encrypted: d.encrypted === true,
    deprecated: "deprecation" in d,
    ...(typeof d.description === "string" ? { description: cleanDescription(d.description) } : {}),
    forbidden: "eq" in d && d.eq === null,
    ...(Array.isArray(d.fields) ? { fields: parseFields(d.fields) } : {}),
    ...(isObject(d.elements) ? { elements: parseField(d.elements) } : {}),
    ...(isObject(d.values) ? { values: parseField(d.values) } : {}),
  };
}

export function parseFields(raw: unknown): NamedField[] {
  if (!Array.isArray(raw)) return [];
  const out: NamedField[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    for (const [name, def] of Object.entries(entry)) out.push({ name, field: parseField(def) });
  }
  return out;
}

/** The schema descriptions are upstream text: keep them, but never show the upstream brand in the UI. */
function cleanDescription(text: string): string {
  return text.replace(/\bKong\b/g, "the gateway");
}

export interface PluginSchema {
  config: NamedField[];
  /** Protocols the plugin accepts, and its default protocols. */
  protocols: { options: string[]; default: string[] } | null;
  scopes: { service: boolean; route: boolean; consumer: boolean };
}

export function parsePluginSchema(raw: unknown): PluginSchema {
  const top = parseFields(isObject(raw) ? raw.fields : undefined);
  const get = (name: string) => top.find((f) => f.name === name)?.field;
  const config = get("config");
  const protocols = get("protocols");
  const options = (protocols?.elements?.oneOf ?? []).filter((p): p is string => typeof p === "string");
  const defaults = Array.isArray(protocols?.default) ? protocols.default.filter((p): p is string => typeof p === "string") : options;
  return {
    config: config?.fields ?? [],
    protocols: options.length > 0 ? { options, default: defaults } : null,
    scopes: { service: !get("service")?.forbidden, route: !get("route")?.forbidden, consumer: !get("consumer")?.forbidden },
  };
}

/* ---------------- defaults ---------------- */

export function defaultFor(field: SchemaField): unknown {
  if (field.type === "record") {
    const nested = defaultsOf(field.fields ?? []);
    return isObject(field.default) ? { ...nested, ...structuredClone(field.default) } : nested;
  }
  return field.default === undefined || field.default === null ? undefined : structuredClone(field.default);
}

/** What the gateway would fill in for an empty record. Deprecated fields are left to their replacements. */
export function defaultsOf(fields: NamedField[]): Config {
  const out: Config = {};
  for (const { name, field } of fields) {
    if (field.deprecated) continue;
    const v = defaultFor(field);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/** Initial form value: the saved config (if any) over the schema defaults. */
export function initialConfig(fields: NamedField[], saved?: Config): Config {
  return mergeDefaults(fields, saved ?? {});
}

function mergeDefaults(fields: NamedField[], saved: Config): Config {
  const out: Config = { ...saved };
  for (const { name, field } of fields) {
    if (field.deprecated) continue;
    if (field.type === "record") {
      const current = saved[name];
      if (current === null && !field.required) continue;
      out[name] = isObject(current) ? mergeDefaults(field.fields ?? [], current) : defaultFor(field);
    } else if (!(name in saved)) {
      const v = defaultFor(field);
      if (v !== undefined) out[name] = v;
    }
  }
  return out;
}

/* ---------------- submit ---------------- */

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasRequiredWithoutDefault(fields: NamedField[]): boolean {
  return fields.some(({ field }) => !field.deprecated && field.required && field.default === undefined && field.type !== "record");
}

/**
 * An optional record the user never touched, holding required fields that have no default, is a feature not in use
 * (e.g. an optional connection block): it is left out instead of being sent half-filled.
 */
function unusedOptionalRecord(field: SchemaField, value: unknown): boolean {
  return field.type === "record" && !field.required && hasRequiredWithoutDefault(field.fields ?? []) && deepEqual(value, defaultFor(field));
}

/**
 * The config the form sends: no empty strings, nulls or blank list items. A secret still showing the placeholder is
 * sent as the placeholder: the API keeps the stored value (leaving it out would remove it, as in any PUT).
 */
export function configToSubmit(fields: NamedField[], value: Config): Config {
  const out: Config = {};
  const known = new Map(fields.map((f) => [f.name, f.field]));
  for (const [name, v] of Object.entries(value)) {
    const field = known.get(name);
    if (field && unusedOptionalRecord(field, v)) continue;
    const cleaned = field ? clean(field, v) : v;
    if (cleaned !== undefined) out[name] = cleaned;
  }
  return out;
}

function clean(field: SchemaField, v: unknown): unknown {
  if (v === undefined || v === null) return undefined;
  // A cleared text field is left to the gateway's default, unless the default itself is the empty string.
  if (v === "" && field.default !== "") return undefined;
  if (field.type === "record" && isObject(v)) return configToSubmit(field.fields ?? [], v);
  if ((field.type === "array" || field.type === "set") && Array.isArray(v)) return v.filter((x) => x !== "" && x !== null && x !== undefined);
  return v;
}

/* ---------------- local validation ---------------- */

export type FieldErrors = Record<string, string[]>;

/** Checks the gateway would also make; the API stays the authority (422 with `errors[].path`). */
export function validateConfig(fields: NamedField[], value: Config, path = "config"): FieldErrors {
  const errors: FieldErrors = {};
  const add = (p: string, m: string) => (errors[p] ??= []).push(m);
  const walk = (fs: NamedField[], obj: Config, prefix: string) => {
    for (const { name, field } of fs) {
      if (field.deprecated) continue;
      const p = `${prefix}.${name}`;
      const v = obj[name];
      if (field.type === "record") {
        if (isObject(v) && !unusedOptionalRecord(field, v)) walk(field.fields ?? [], v, p);
        continue;
      }
      // The placeholder stands for a stored secret: not empty.
      const empty = v === undefined || v === null || v === "";
      if (empty) {
        if (field.required) add(p, "Campo obrigatório.");
        continue;
      }
      if ((field.type === "number" || field.type === "integer") && typeof v === "number") {
        if (field.type === "integer" && !Number.isInteger(v)) add(p, "Use um número inteiro.");
        if (field.between && (v < field.between[0] || v > field.between[1])) add(p, `Use um valor entre ${field.between[0]} e ${field.between[1]}.`);
        if (field.gt !== undefined && !(v > field.gt)) add(p, `Use um valor maior que ${field.gt}.`);
      }
      if (field.type === "string" && typeof v === "string") {
        if (field.lenMin !== undefined && v.length < field.lenMin) add(p, `Use pelo menos ${field.lenMin} caracteres.`);
        if (field.lenMax !== undefined && v.length > field.lenMax) add(p, `Use no máximo ${field.lenMax} caracteres.`);
      }
    }
  };
  walk(fields, value, path);
  return errors;
}

/** Every path the form renders a control for, so a 422 `errors[].path` can land on the right field. */
export function fieldPaths(fields: NamedField[], prefix = "config"): Set<string> {
  const out = new Set<string>([prefix]);
  for (const { name, field } of fields) {
    const p = `${prefix}.${name}`;
    out.add(p);
    if (field.type === "record") for (const sub of fieldPaths(field.fields ?? [], p)) out.add(sub);
  }
  return out;
}

/** Maps API error paths ("config.redis.port", "scope.consumerId", "config.paths.0") onto the nearest known path. */
export function placeErrors(items: { path: string; message: string }[], known: Set<string>): { fields: FieldErrors; form: string[] } {
  const fields: FieldErrors = {};
  const form: string[] = [];
  for (const { path, message } of items) {
    let p = path.replace(/\[(\d+)\]/g, ".$1");
    while (p && !known.has(p)) p = p.includes(".") ? p.slice(0, p.lastIndexOf(".")) : "";
    if (p) (fields[p] ??= []).push(p === path ? message : `${path}: ${message}`);
    else form.push(path === "(body)" ? message : `${path}: ${message}`);
  }
  return { fields, form };
}
