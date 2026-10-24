import { describe, expect, it } from "vitest";
import { privilegedFingerprint, privilegedUses } from "../src/index.js";

const paths = (name: string, config: Record<string, unknown> = {}) => privilegedUses({ name, config }).map((u) => u.path);

describe("privileged plugin capabilities", () => {
  it("reserves plugins that run code or write files in the gateway", () => {
    expect(paths("pre-function", { access: ["return"] })).toEqual(["name"]);
    expect(paths("post-function")).toEqual(["name"]);
    expect(paths("file-log", { path: "/tmp/x" })).toEqual(["name"]);
  });

  it("reserves only the dangerous field of ordinary plugins", () => {
    expect(paths("http-log", { http_endpoint: "http://logs.example.com" })).toEqual([]);
    expect(paths("http-log", { http_endpoint: "http://logs.example.com", custom_fields_by_lua: { a: "return 1" } })).toEqual(["config.custom_fields_by_lua"]);
    expect(paths("tcp-log", { custom_fields_by_lua: {} })).toEqual(["config.custom_fields_by_lua"]);
    expect(paths("rate-limiting", { minute: 5 })).toEqual([]);
  });

  it("reserves plugins that would fall back to the gateway's own cloud credentials", () => {
    expect(paths("aws-lambda", { function_name: "f", aws_region: "us-east-1" })).toEqual(["config.aws_key"]);
    expect(paths("aws-lambda", { function_name: "f", aws_key: "k", aws_secret: "s" })).toEqual([]);
    expect(paths("ai-proxy", { model: { provider: "gemini" }, auth: { gcp_use_service_account: true } })).toEqual(["config.auth.gcp_use_service_account"]);
    expect(paths("ai-proxy", { model: { provider: "bedrock" }, auth: {} })).toEqual(["config.auth.aws_access_key_id"]);
    expect(paths("ai-proxy", { model: { provider: "bedrock" }, auth: { aws_access_key_id: "a", aws_secret_access_key: "b" } })).toEqual([]);
    expect(paths("ai-request-transformer", { llm: { model: { provider: "bedrock" } } })).toEqual(["config.llm.auth.aws_access_key_id"]);
    expect(paths("ai-proxy", { model: { provider: "openai" }, auth: { header_name: "Authorization", header_value: "Bearer x" } })).toEqual([]);
  });

  it("fingerprints only privileged plugins, independent of order", () => {
    const pre = { id: "b", name: "pre-function", config: { access: ["return"] } };
    const cors = { id: "a", name: "cors", config: {} };
    expect(privilegedFingerprint({ plugins: [cors, pre] })).toBe(privilegedFingerprint({ plugins: [pre] }));
    expect(privilegedFingerprint({ plugins: [pre] })).not.toBe(privilegedFingerprint({ plugins: [{ ...pre, config: { access: ["return 1"] } }] }));
    expect(privilegedFingerprint({ plugins: [pre] })).not.toBe(privilegedFingerprint({ plugins: [{ ...pre, enabled: false }] }));
    expect(privilegedFingerprint({ plugins: [cors] })).toBe(privilegedFingerprint({ plugins: [] }));
  });
});
