import createClient, { type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema";

export type Schemas = components["schemas"];
export type Environment = Schemas["Environment"];
export type Service = Schemas["Service"];
export type ServiceWrite = Schemas["ServiceWrite"];
export type Route = Schemas["Route"];
export type RouteWrite = Schemas["RouteWrite"];
export type User = Schemas["User"];
export type PublishPreview = Schemas["PublishPreview"];
export type Problem = Schemas["Problem"];

const TOKEN_KEY = "gromesh.token";

export const tokenStore = {
  get: (): string | null => sessionStorage.getItem(TOKEN_KEY),
  set: (token: string) => sessionStorage.setItem(TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

/** Called when the API answers 401 (expired or revoked session). */
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

const auth: Middleware = {
  onRequest({ request }) {
    const token = tokenStore.get();
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
    return request;
  },
  onResponse({ response, request }) {
    if (response.status === 401 && !request.url.endsWith("/auth/login")) onUnauthorized();
    return response;
  },
};

export const api = createClient<paths>({ baseUrl: "/api/v1" });
api.use(auth);

/** Thrown by `unwrap` so TanStack Query sees a failed request with its problem details. */
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
