import { expect, test } from "vitest";
import type { ConfigDocument, KongDeclarativeConfig } from "@gromesh/compiler";
import { api, sleep } from "./stack.js";
import { normalizedConfig, normalizedHash } from "../integration/config-normalization.js";

test("exports a draft, previews/imports it into an auto environment, then publishes only on explicit request", async () => {
  const created = await api("POST", "/environments", { name: `export-${Date.now().toString(36)}` });
  expect(created.status).toBe(201);
  const source = `/environments/${created.body.id}`;
  const target = await api("POST", "/environments", { name: `import-${Date.now().toString(36)}`, publishMode: "auto" });
  expect(target.status).toBe(201);
  const destination = `/environments/${target.body.id}`;
  try {
    const service = await api("POST", `${source}/services`, { name: "echo", protocol: "http", host: "echo", port: 80 });
    expect(service.status).toBe(201);
    expect((await api("POST", `${source}/routes`, { name: "echo", serviceId: service.body.id, paths: ["/import-export"] })).status).toBe(201);
    const exported = await api<ConfigDocument>("GET", `${source}/export?format=json`);
    expect(exported.status).toBe(200);
    const dryRun = await api<{ errors: unknown[]; added: unknown[] }>("POST", `${destination}/import`, { document: exported.body, mode: "replace", dryRun: true });
    expect(dryRun.status).toBe(200);
    expect(dryRun.body.errors).toEqual([]);
    expect(dryRun.body.added).toHaveLength(2);
    expect((await api<{ items: unknown[] }>("GET", `${destination}/services`)).body.items).toEqual([]);
    expect((await api("POST", `${destination}/import`, { document: exported.body, mode: "replace", dryRun: false })).status).toBe(200);
    await sleep(4500);
    expect((await api<{ items: unknown[] }>("GET", `${destination}/snapshots`)).body.items).toEqual([]);
    const configs: KongDeclarativeConfig[] = [];
    for (const base of [source, destination]) {
      const published = await api<{ version: number }>("POST", `${base}/snapshots`, {});
      expect(published.status).toBe(201);
      configs.push((await api<{ config: KongDeclarativeConfig }>("GET", `${base}/snapshots/${published.body.version}`)).body.config);
    }
    const original = normalizedConfig(configs[0]!), copy = normalizedConfig(configs[1]!);
    expect(copy).toEqual(original);
    expect(normalizedHash(copy)).toBe(normalizedHash(original));
    const invalid = await api<{ errors: { path: string }[]; added: unknown[] }>("POST", `${destination}/import`, { sourceFormat: "kong-declarative-3.0", document: { _format_version: "3.0", vaults: [] }, mode: "replace", dryRun: false });
    expect(invalid.status).toBe(422);
    expect(invalid.body.added).toEqual([]);
    expect(invalid.body.errors).toContainEqual(expect.objectContaining({ path: "document.vaults" }));
  } finally {
    await api("DELETE", destination);
    await api("DELETE", source);
  }
});
