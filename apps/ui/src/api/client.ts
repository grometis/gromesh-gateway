import createClient, { type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema";

export type Schemas = components["schemas"];
export type Environment = Schemas["Environment"];
export type Service = Schemas["Service"];
export type ServiceWrite = Schemas["ServiceWrite"];
export type Route = Schemas["Route"];
export type RouteWrite = Schemas["RouteWrite"];
export type Consumer = Schemas["Consumer"];
export type ConsumerWrite = Schemas["ConsumerWrite"];
export type KeyAuthCredential = Schemas["KeyAuthCredential"];
export type JwtCredential = Schemas["JwtCredential"];
export type BasicAuthCredential = Schemas["BasicAuthCredential"];
export type Plugin = Schemas["Plugin"];
export type PluginWrite = Schemas["PluginWrite"];
export type PluginScope = Schemas["PluginScope"];
export type PluginCatalogEntry = Schemas["PluginCatalogEntry"];
export type User = Schemas["User"];
export type UserCreate = Schemas["UserCreate"];
export type UserUpdate = Schemas["UserUpdate"];
export type AuditEvent = Schemas["AuditEvent"];
export type PublishPreview = Schemas["PublishPreview"];
export type Problem = Schemas["Problem"];

let csrf: Promise<string> | null = null;
let sessionVersion = 0;

export function clearCsrfToken(): void {
  sessionVersion++;
  csrf = null;
}

/** Only memory: concurrent mutations share one token fetch, bound to the current session. */
export async function getCsrfToken(): Promise<string> {
  const version = sessionVersion;
  if (!csrf) {
    const pending = unwrap(api.GET("/auth/csrf")).then((data) => data.csrfToken);
    csrf = pending;
    void pending.catch(() => {
      if (csrf === pending) csrf = null;
    });
  }
  const token = await csrf;
  if (version !== sessionVersion) throw new ApiError(401, undefined);
  return token;
}

/** Called when the API answers 401 (expired or revoked session). */
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
  return () => {
    if (onUnauthorized === fn) onUnauthorized = () => {};
  };
};

const auth: Middleware = {
  async onRequest({ request }) {
    // Login starts the session and is the contract's sole unauthenticated mutation.
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !request.url.endsWith("/auth/login")) {
      request.headers.set("X-CSRF-Token", await getCsrfToken());
    }
    return request;
  },
  onResponse({ response, request }) {
    if (response.status === 401) {
      clearCsrfToken();
      onUnauthorized();
    } else if (response.ok && (request.url.endsWith("/auth/login") || request.url.endsWith("/auth/logout"))) {
      clearCsrfToken();
    }
    return response;
  },
};

export const api = createClient<paths>({ baseUrl: "/api/v1", credentials: "include" });
api.use(auth);

/** Thrown by `unwrap` so TanStack Query sees a failed request with its problem details. */
/**
 * Retry only when the request never got an answer: fetch rejects with a TypeError on a network failure. An HTTP
 * error (5xx included) or an unreadable body (a SyntaxError from the JSON parser) is the server's answer:
 * repeating it only delays what the screen should say (e.g. the analytics store is down).
 */
export const retryNetworkErrorsOnly = (count: number, err: unknown) => err instanceof TypeError && count < 2;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | undefined,
  ) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${status}`);
  }
}

/** Turns an openapi-fetch result into data or an ApiError. */
export async function unwrap<T>(call: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) throw new ApiError(response.status, isProblem(error) ? error : undefined);
  return data as T;
}

function isProblem(v: unknown): v is Problem {
  return typeof v === "object" && v !== null && "status" in v && "title" in v;
}
