import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Injectable, type PipeTransform } from "@nestjs/common";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { loadConfig } from "../config.js";
import { unprocessable } from "./problem.js";

/** Every contract file is registered under this base, so their relative `$ref`s ("./control-plane.openapi.yaml#…") resolve. */
const BASE = "https://gromesh.dev/contracts/";

/**
 * Request bodies are validated against the contract itself (contracts/*.openapi.yaml), so the contract is the single
 * source of truth (no duplicated DTO rules).
 */
class ContractRegistry {
  private ajv: Ajv.default | null = null;
  private readonly cache = new Map<string, ValidateFunction>();

  /** `main` is the contract the schema names refer to; `files`, every contract it reaches through `$ref`. */
  constructor(
    private readonly main: string,
    private readonly files: readonly string[],
  ) {}

  /** `schemaName` is a component name, or a JSON pointer ("#/paths/…") for request bodies defined inline. */
  validator(schemaName: string): ValidateFunction {
    const hit = this.cache.get(schemaName);
    if (hit) return hit;
    const pointer = schemaName.startsWith("#") ? encodeURI(schemaName) : `#/components/schemas/${schemaName}`;
    const fn = this.load().getSchema(`${BASE}${this.main}${pointer}`);
    if (!fn) throw new Error(`Schema ${schemaName} not found in ${this.main}`);
    this.cache.set(schemaName, fn);
    return fn;
  }

  private load(): Ajv.default {
    if (this.ajv) return this.ajv;
    const dir = loadContractsDir();
    const ajv = new Ajv.default({ allErrors: true, strict: false, useDefaults: true, coerceTypes: false });
    addFormats.default(ajv);
    for (const file of this.files) {
      const text = readFileSync(resolve(dir, file), "utf8");
      const doc = (file.endsWith(".json") ? JSON.parse(text) : parse(text)) as Record<string, unknown>;
      ajv.addSchema({ ...doc, $id: `${BASE}${file}` });
    }
    this.ajv = ajv;
    return ajv;
  }
}

function loadContractsDir(): string {
  try {
    return loadConfig().contractsDir;
  } catch {
    return loadConfig({ ...process.env, DATABASE_URL: "unused" }).contractsDir;
  }
}

export const contracts = new ContractRegistry("control-plane.openapi.yaml", ["control-plane.openapi.yaml", "snapshot.schema.json"]);
/** control-plane-v2 (Workspaces), with the v1 contract, the agent protocol and the snapshot schemas it refers to. */
export const contractsV2 = new ContractRegistry("control-plane-v2.openapi.yaml", [
  "control-plane-v2.openapi.yaml",
  "control-plane.openapi.yaml",
  "agent-protocol-v2.openapi.yaml",
  "snapshot.schema.json",
  "snapshot-v2.schema.json",
]);

export function toFieldErrors(errors: ErrorObject[] | null | undefined): { path: string; message: string }[] {
  return (errors ?? []).map((e) => {
    const base = e.instancePath.replace(/^\//, "").replace(/\//g, ".");
    const missing = e.keyword === "required" ? (e.params as { missingProperty: string }).missingProperty : null;
    const path = missing ? (base ? `${base}.${missing}` : missing) : base || "(body)";
    return { path, message: missing ? "is required" : e.message ?? "is invalid" };
  });
}

@Injectable()
export class ContractBodyPipe implements PipeTransform {
  constructor(
    private readonly schemaName: string,
    private readonly registry: ContractRegistry = contracts,
  ) {}

  transform(value: unknown): unknown {
    const body = value ?? {};
    const validate = this.registry.validator(this.schemaName);
    if (!validate(body)) throw unprocessable("Request body does not match the contract", toFieldErrors(validate.errors));
    return body;
  }
}

/** Usage: `@Body(contractBody("ServiceWrite")) body: ServiceWrite` */
export const contractBody = (schemaName: string) => new ContractBodyPipe(schemaName);
/** The same against control-plane-v2. */
export const contractBodyV2 = (schemaName: string) => new ContractBodyPipe(schemaName, contractsV2);

/** JSON pointer to an operation's inline JSON request body schema, e.g. inlineBody("/environments/{envId}/…", "post"). */
export const inlineBody = (path: string, method: string) =>
  `#/paths/${path.replace(/~/g, "~0").replace(/\//g, "~1")}/${method}/requestBody/content/application~1json/schema`;
