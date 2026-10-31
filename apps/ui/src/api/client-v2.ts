import createClient from "openapi-fetch";
import { ApiError, sessionMiddleware } from "./client";
import type { components, paths } from "./schema-v2";

type Schemas = components["schemas"];
export type Workspace = Schemas["Workspace"];
export type WorkspaceWrite = Schemas["WorkspaceWrite"];
export type WorkspacePage = Schemas["WorkspacePage"];
export type WorkspaceCreationPolicy = Schemas["WorkspaceCreationPolicy"];
export type WorkspaceProblemCode = Schemas["WorkspaceProblem"]["code"];
export type WorkspaceService = Schemas["WorkspaceService"];
export type WorkspaceServiceWrite = Schemas["WorkspaceServiceWrite"];
export type WorkspaceRoute = Schemas["WorkspaceRoute"];
export type WorkspaceRouteWrite = Schemas["WorkspaceRouteWrite"];
export type RouteProblemCode = Schemas["RouteProblem"]["code"];

/** Workspaces API (`/api/v2`): same session, CSRF and `unwrap`/`ApiError` handling as v1. */
export const apiV2 = createClient<paths>({ baseUrl: "/api/v2", credentials: "include" });
apiV2.use(sessionMiddleware);

const CODES: readonly WorkspaceProblemCode[] = [
  "workspaces-mode-disabled", "creation-policy", "slug-taken", "name-taken", "workspace-archived",
  "active-release", "deployed", "published-configuration", "clusters", "request-decided",
];

/** The `code` and `suggestedSlug` of a WorkspaceProblem; ApiError keeps them, typed only as the v1 Problem. */
export function workspaceProblem(err: unknown): { code: WorkspaceProblemCode | null; suggestedSlug: string | null } {
  const problem: unknown = err instanceof ApiError ? err.problem : undefined;
  if (typeof problem !== "object" || problem === null) return { code: null, suggestedSlug: null };
  const { code, suggestedSlug } = problem as Record<string, unknown>;
  return {
    code: CODES.find((c) => c === code) ?? null,
    suggestedSlug: typeof suggestedSlug === "string" ? suggestedSlug : null,
  };
}

/** The `code` of a problem (RouteProblem and the gateway's 409s), or null; unknown codes are kept for the caller to ignore. */
export function problemCode(err: unknown): string | null {
  const problem: unknown = err instanceof ApiError ? err.problem : undefined;
  if (typeof problem !== "object" || problem === null) return null;
  const { code } = problem as Record<string, unknown>;
  return typeof code === "string" ? code : null;
}
