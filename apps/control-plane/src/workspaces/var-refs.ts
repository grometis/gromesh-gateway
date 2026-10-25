import { unprocessable } from "../common/problem.js";

export type VarRef = { $var: string };
/** `T` with a VarRef allowed on `F`. */
export type WithVarRefs<T, F extends keyof T> = { [K in keyof T]: K extends F ? T[K] | VarRef : T[K] };

const isVarRef = (v: unknown): v is VarRef => typeof v === "object" && v !== null && typeof (v as { $var?: unknown }).$var === "string";

/**
 * A VarRef names a variable declared in the same workspace. No variable can be declared yet
 * (declareWorkspaceVariable is still planned), so every VarRef the contract accepts on `fields` is refused there:
 * after this, those fields hold plain values.
 */
export function refuseVarRefs<T extends object, F extends keyof T & string>(body: WithVarRefs<T, F>, fields: readonly F[]): T {
  const errors = fields.flatMap((f) => {
    const v: unknown = body[f];
    return isVarRef(v) ? [{ path: f, message: `variable ${v.$var} is not declared in this workspace` }] : [];
  });
  if (errors.length > 0) throw unprocessable("Invalid request", errors);
  return body as T;
}
