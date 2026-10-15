import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Injectable, type PipeTransform } from "@nestjs/common";
import Ajv, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { loadConfig } from "../config.js";
import { toFieldErrors } from "../common/contract.js";
import { unprocessable } from "../common/problem.js";

export interface RegisterRequest {
  nodeId: string; hostname: string; kongVersion: string; agentVersion: string; labels?: Record<string, string>;
}
export interface StatusReport {
  nodeId: string; state: "applying" | "applied" | "failed" | "idle"; kongHealthy: boolean; reportedAt: string;
  appliedVersion?: number | null; appliedHash?: string | null; failedVersion?: number | null; error?: string | null;
}

const validators = new Map<string, ValidateFunction>();
@Injectable()
class AgentBodyPipe implements PipeTransform {
  constructor(private readonly name: string) {}
  transform(body: unknown): unknown {
    let validate = validators.get(this.name);
    if (!validate) {
      const dir = loadConfig({ ...process.env, DATABASE_URL: "unused" }).contractsDir;
      const doc = parse(readFileSync(resolve(dir, "agent-protocol.openapi.yaml"), "utf8")) as Record<string, unknown>;
      const ajv = new Ajv.default({ allErrors: true, strict: false, coerceTypes: false });
      addFormats.default(ajv);
      ajv.addSchema(JSON.parse(readFileSync(resolve(dir, "snapshot.schema.json"), "utf8")) as Record<string, unknown>, "./snapshot.schema.json");
      ajv.addSchema({ ...doc, $id: "agent-protocol" });
      validate = ajv.getSchema(`agent-protocol#/components/schemas/${this.name}`);
      if (!validate) throw new Error("Agent protocol schema not found");
      validators.set(this.name, validate);
    }
    if (!validate(body)) throw unprocessable("Request body does not match the agent contract", toFieldErrors(validate.errors));
    return body;
  }
}
export const agentBody = (name: "RegisterRequest" | "StatusReport") => new AgentBodyPipe(name);
