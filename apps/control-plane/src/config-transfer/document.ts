import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { createParamDecorator, HttpException, type ExecutionContext, type PipeTransform } from "@nestjs/common";
import { isAlias, parseAllDocuments, visit } from "yaml";
import { type ConfigDocument, type EntityChange } from "@gromesh/compiler";
import type { ErrorObject } from "ajv";
import { contracts, toFieldErrors } from "../common/contract.js";
import type { FieldError } from "../common/problem.js";

export interface ImportRequest { document: ConfigDocument | Record<string, unknown>; sourceFormat?: "gromesh/v1" | "kong-declarative-3.0"; mode: "merge" | "replace"; dryRun: boolean }
export const emptyReport = (errors: FieldError[]) => ({ added: [] as EntityChange[], modified: [] as EntityChange[], removed: [] as EntityChange[], errors });
export const importFailure = (errors: FieldError[]) => new HttpException({ type: "https://gromesh.dev/problems/422", title: "Unprocessable Content", status: 422, detail: "The import was not applied", ...emptyReport(errors) }, 422);
const LIMIT = 5_242_880;
export const schemaErrors = (errors: ErrorObject[] | null | undefined, prefix = "document"): FieldError[] => (errors ?? []).filter(e => !["if", "oneOf", "anyOf"].includes(e.keyword)).map(e => {
  const field = toFieldErrors([e])[0]!;
  const extra = e.keyword === "additionalProperties" ? String(e.params.additionalProperty) : e.keyword === "unevaluatedProperties" ? String(e.params.unevaluatedProperty) : undefined;
  const path = field.path === "(body)" ? "" : field.path;
  return { path: [prefix, path, extra].filter(Boolean).join(".") || "document", message: e.keyword === "additionalProperties" ? "unknown field" : field.message };
});

const RAW_IMPORT_ENVELOPE = Symbol("raw-import-envelope");
interface ImportEnvelopeRequest extends Request { [RAW_IMPORT_ENVELOPE]?: Buffer }

/** Parameter decorators and pipes run after auth, CSRF and RBAC guards. */
export const ImportBody = createParamDecorator((_data: unknown, context: ExecutionContext): unknown => {
  const request = context.switchToHttp().getRequest<ImportEnvelopeRequest>();
  const buffer = request[RAW_IMPORT_ENVELOPE];
  delete request[RAW_IMPORT_ENVELOPE];
  if (buffer) {
    // JSON.parse erases duplicate mapping keys, so validate the retained envelope before using its parsed body.
    const documents = parseAllDocuments(buffer.toString("utf8"), { uniqueKeys: true, strict: true });
    if (documents.length !== 1 || documents[0]!.errors.length) throw importFailure([{ path: "document", message: "duplicate keys or invalid JSON envelope" }]);
  }
  return request.body;
});

/** Validates the contract envelope and serialization; unlike ordinary bodies every failure carries an import report. */
export class ImportBodyPipe implements PipeTransform {
  transform(input: unknown): ImportRequest {
    const envelope = contracts.validator("EnvironmentImportRequest");
    // Envelope validation may fill nested write defaults; those bytes were never submitted.
    if (!envelope(structuredClone(input))) throw importFailure(schemaErrors(envelope.errors, ""));
    const request = input as { document: unknown; sourceFormat?: ImportRequest["sourceFormat"]; mode: ImportRequest["mode"]; dryRun: boolean };
    let document = request.document;
    const encoded = typeof document === "string" ? document : JSON.stringify(document);
    if (Buffer.byteLength(encoded, "utf8") > LIMIT) throw importFailure([{ path: "document", message: "exceeds the 5 MiB UTF-8 limit" }]);
    if (typeof document === "string") {
      try {
        const docs = parseAllDocuments(document, { uniqueKeys: true, strict: true });
        if (docs.length !== 1 || docs[0]!.errors.length) throw new Error();
        visit(docs[0]!, (_key, node) => {
          if (isAlias(node) || (node && typeof node === "object" && "tag" in node && typeof node.tag === "string" && !/^tag:yaml.org,2002:(str|int|float|bool|null|map|seq)$/.test(node.tag))) throw new Error();
        });
        document = docs[0]!.toJS({ maxAliasCount: 0 }) as unknown;
      } catch { throw importFailure([{ path: "document", message: "must be one valid YAML/JSON mapping without duplicate keys, aliases or custom tags" }]); }
    }
    if (Buffer.byteLength(JSON.stringify(document) ?? "", "utf8") > LIMIT) throw importFailure([{ path: "document", message: "decoded document exceeds the 5 MiB UTF-8 limit" }]);
    const validate = contracts.validator(request.sourceFormat === "kong-declarative-3.0" ? "KongDeclarativeConfigV3" : "GromeshConfigV1");
    if (!validate(document)) throw importFailure(schemaErrors(validate.errors));
    return { ...request, document } as ImportRequest;
  }
}

/** A larger parser only for the import envelope; ordinary API bodies retain Nest's usual limit. */
export function configureImportParser(app: NestExpressApplication) {
  const isImport = (request: { method?: string; url?: string }) => request.method === "POST" && /^\/api\/v1\/environments\/[^/]+\/import\/?(?:\?|$)/i.test(request.url ?? "");
  const isJson = (request: { headers: { [key: string]: unknown } }) => /^\s*application\/json\s*(?:;|$)/i.test(String(request.headers["content-type"] ?? ""));
  app.useBodyParser("json", { limit: "100kb", type: request => !isImport(request) && isJson(request) });
  app.useBodyParser("json", {
    limit: LIMIT + 1024 * 1024, type: request => isImport(request) && isJson(request),
    verify: (request: ImportEnvelopeRequest, _response: unknown, buffer: Buffer) => {
      request[RAW_IMPORT_ENVELOPE] = buffer;
    },
  });
  app.use((error: unknown, request: Request, response: Response, next: NextFunction) => {
    if (!isImport(request)) { next(error); return; }
    const failure = importFailure([{ path: "document", message: "invalid JSON envelope or document size limit exceeded" }]);
    response.status(422).type("application/problem+json").send(failure.getResponse());
  });
}
