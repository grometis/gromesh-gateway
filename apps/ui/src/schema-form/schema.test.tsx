import { readdirSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SchemaFields } from "./SchemaForm";
import { configToSubmit, initialConfig, parsePluginSchema, placeErrors, fieldPaths, validateConfig, type NamedField } from "./schema";

// The same files the control plane serves on GET /plugin-schemas/{name}.
const CATALOG = new URL("../../../control-plane/src/plugin-catalog/kong-3.9/", import.meta.url);
const names = readdirSync(CATALOG)
  .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
  .map((f) => f.slice(0, -".json".length))
  .sort();
const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`${name}.json`, CATALOG), "utf8"));

/** Every non-deprecated default the raw schema declares, with its config path (records recurse). */
function declaredDefaults(raw: unknown[], prefix: string[] = []): [string[], unknown][] {
  const out: [string[], unknown][] = [];
  for (const entry of raw as Record<string, Record<string, unknown>>[]) {
    for (const [name, def] of Object.entries(entry)) {
      if ("deprecation" in def) continue;
      if (def.type === "record") {
        // A record's own default overrides the defaults of its fields (the gateway applies it first).
        const own = (def.default ?? {}) as Record<string, unknown>;
        for (const [path, value] of declaredDefaults((def.fields as unknown[]) ?? [], [...prefix, name])) {
          const key = path[prefix.length + 1]!;
          out.push([path, path.length === prefix.length + 2 && key in own ? own[key] : value]);
        }
      }
      else if (def.default !== undefined && def.default !== null) out.push([[...prefix, name], def.default]);
    }
  }
  return out;
}

function at(obj: unknown, path: string[]): unknown {
  return path.reduce<unknown>((o, k) => (typeof o === "object" && o !== null ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function hasOptionalRecordAncestor(raw: unknown[], path: string[]): boolean {
  let fields = raw as Record<string, Record<string, unknown>>[];
  for (const key of path.slice(0, -1)) {
    const def = fields.map((e) => e[key]).find(Boolean);
    if (!def) return false;
    if (def.required !== true && def.default === undefined) return true;
    fields = (def.fields as Record<string, Record<string, unknown>>[]) ?? [];
  }
  return false;
}

describe("plugin config form", () => {
  it("covers the whole catalog", () => {
    expect(names).toHaveLength(45);
  });

  it.each(names)("%s renders and submits its defaults", (name) => {
    const raw = load(name);
    const schema = parsePluginSchema(raw);
    expect(schema.config.length).toBeGreaterThan(0);
    const value = initialConfig(schema.config);

    const html = renderToStaticMarkup(<SchemaFields fields={schema.config} value={value} onChange={() => {}} errors={{}} onJsonError={() => {}} />);
    for (const { name: field, field: def } of schema.config) if (!def.deprecated) expect(html).toContain(field);
    // Labels and help texts never carry the upstream brand (default values such as header names are config, not text).
    expect(html.replace(/value="[^"]*"/g, "")).not.toMatch(/\bKong\b/);

    const sent = configToSubmit(schema.config, value);
    const rawConfig = ((raw as { fields: Record<string, { fields?: unknown[] }>[] }).fields.find((f) => "config" in f)?.config?.fields ?? []) as unknown[];
    for (const [path, expected] of declaredDefaults(rawConfig)) {
      // Optional blocks with unfilled required fields are left out on purpose (see unusedOptionalRecord).
      if (at(sent, path) === undefined && hasOptionalRecordAncestor(rawConfig, path)) continue;
      expect(at(sent, path), path.join(".")).toEqual(expected);
    }
    expect(JSON.stringify(sent)).not.toContain("REDACTED");
  });
});

describe("rate-limiting", () => {
  const schema = parsePluginSchema(load("rate-limiting"));

  it("validates numbers locally and keeps defaults for untouched fields", () => {
    const value = { ...initialConfig(schema.config), minute: -1 };
    expect(validateConfig(schema.config, value)).toEqual({ "config.minute": ["Use um valor maior que 0."] });
    const sent = configToSubmit(schema.config, { ...value, minute: 5 });
    expect(sent).toMatchObject({ minute: 5, limit_by: "consumer", policy: "local", fault_tolerant: true });
  });

  it("places API errors on the nearest field", () => {
    const known = new Set(["scope", "scope.consumerId", ...fieldPaths(schema.config)]);
    const placed = placeErrors(
      [
        { path: "config.minute", message: "must be greater than 0" },
        { path: "config.redis.port[0]", message: "bad" },
        { path: "scope.consumerId", message: "consumer not found" },
        { path: "(body)", message: "at least one of these fields must be non-empty" },
      ],
      known,
    );
    expect(placed.fields["config.minute"]).toEqual(["must be greater than 0"]);
    expect(placed.fields["config.redis.port"]).toEqual(["config.redis.port[0]: bad"]);
    expect(placed.fields["scope.consumerId"]).toEqual(["consumer not found"]);
    expect(placed.form).toEqual(["at least one of these fields must be non-empty"]);
  });
});

describe("secrets", () => {
  const fields: NamedField[] = parsePluginSchema(load("rate-limiting")).config;

  it("never sends the placeholder back and never pre-fills it", () => {
    const saved = { minute: 5, redis: { host: "redis", password: "REDACTED" } };
    const value = initialConfig(fields, saved);
    const sent = configToSubmit(fields, value) as { redis: Record<string, unknown> };
    expect(sent.redis.password).toBeUndefined();
    expect(sent.redis.host).toBe("redis");
    const html = renderToStaticMarkup(<SchemaFields fields={fields} value={value} onChange={() => {}} errors={{}} onJsonError={() => {}} />);
    expect(html).not.toContain("REDACTED");
    expect(html).toContain('type="password"');
  });
});

describe("scopes", () => {
  it("reads which entities a plugin can be applied to", () => {
    expect(parsePluginSchema(load("key-auth")).scopes).toEqual({ service: true, route: true, consumer: false });
    expect(parsePluginSchema(load("rate-limiting")).scopes).toEqual({ service: true, route: true, consumer: true });
  });
});
