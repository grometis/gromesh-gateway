import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Injectable, type PipeTransform } from "@nestjs/common";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { loadConfig } from "../config.js";
import { unprocessable } from "./problem.js";

const CONTRACT_ID = "control-plane";

/**
 * Request bodies are validated against contracts/control-plane.openapi.yaml itself,
 * so the contract is the single source of truth (no duplicated DTO rules).
 */
class ContractRegistry {
  private ajv: Ajv.default | null = null;
  private readonly cache = new Map<string, ValidateFunction>();

  /** `schemaName` is a component name, or a JSON pointer ("#/paths/…") for request bodies defined inline. */
  validator(schemaName: string): ValidateFunction {
    const hit = this.cache.get(schemaName);
    if (hit) return hit;
    const pointer = schemaName.startsWith("#") ? encodeURI(schemaName) : `#/components/schemas/${schemaName}`;
    const fn = this.load().getSchema(`${CONTRACT_ID}${pointer}`);
    if (!fn) throw new Error(`Schema ${schemaName} not found in the control-plane contract`);
    this.cache.set(schemaName, fn);
    return fn;
  }

  private load(): Ajv.default {
    if (this.ajv) return this.ajv;
    const dir = loadContractsDir();
    const doc = parse(readFileSync(resolve(dir, "control-plane.openapi.yaml"), "utf8")) as Record<string, unknown>;
    const snapshot = JSON.parse(readFileSync(resolve(dir, "snapshot.schema.json"), "utf8")) as Record<string, unknown>;
    const ajv = new Ajv.default({ allErrors: true, strict: false, useDefaults: true, coerceTypes: false });
    addFormats.default(ajv);
    ajv.addSchema(snapshot, "./snapshot.schema.json");
    ajv.addSchema({ ...doc, $id: CONTRACT_ID });
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

export const contracts = new ContractRegistry();

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
  constructor(private readonly schemaName: string) {}

  transform(value: unknown): unknown {
    const body = value ?? {};
    const validate = contracts.validator(this.schemaName);
    if (!validate(body)) throw unprocessable("Request body does not match the contract", toFieldErrors(validate.errors));
    return body;
  }
}

/** Usage: `@Body(contractBody("ServiceWrite")) body: ServiceWrite` */
export const contractBody = (schemaName: string) => new ContractBodyPipe(schemaName);

/** JSON pointer to an operation's inline JSON request body schema, e.g. inlineBody("/environments/{envId}/…", "post"). */
export const inlineBody = (path: string, method: string) =>
  `#/paths/${path.replace(/~/g, "~0").replace(/\//g, "~1")}/${method}/requestBody/content/application~1json/schema`;
