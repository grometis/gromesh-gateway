// The request bodies of the v2 gateway writes, as contracts/control-plane-v2.openapi.yaml closes them
// (WorkspaceServiceWrite: unevaluatedProperties false; WorkspaceRouteWrite: additionalProperties false). The fakes
// refuse anything else with the server's 422, so a suite cannot pass with a body the real API would reject.
const SHAPES = {
  services: {
    required: ["name", "protocol", "host", "port"],
    allowed: ["name", "protocol", "host", "port", "path", "retries", "connectTimeoutMs", "readTimeoutMs", "writeTimeoutMs", "enabled", "tags", "upstreamId"],
  },
  routes: {
    required: ["name", "serviceId", "paths"],
    allowed: ["name", "serviceId", "protocols", "methods", "hosts", "paths", "headers", "stripPath", "preserveHost", "analyticsRetentionDays", "tags"],
  },
} as const;

export function v2BodyErrors(kind: "services" | "routes", body: unknown): { path: string; message: string }[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [{ path: "(body)", message: "must be object" }];
  const { required, allowed } = SHAPES[kind];
  const fields = body as Record<string, unknown>;
  return [
    ...required.filter((k) => fields[k] === undefined).map((k) => ({ path: k, message: "is required" })),
    ...Object.keys(fields).filter((k) => !(allowed as readonly string[]).includes(k)).map(() => ({ path: "(body)", message: "must NOT have additional properties" })),
    ...(kind === "routes" && Array.isArray(fields.paths) && fields.paths.length === 0 ? [{ path: "paths", message: "must NOT have fewer than 1 items" }] : []),
  ];
}

export const invalidBody = (errors: { path: string; message: string }[]) => ({
  status: 422, contentType: "application/problem+json",
  json: { type: "https://gromesh.dev/problems/422", title: "Unprocessable Content", status: 422, errors },
});
