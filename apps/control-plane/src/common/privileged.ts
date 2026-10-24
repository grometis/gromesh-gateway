import { HttpStatus } from "@nestjs/common";
import { privilegedUses, type Plugin } from "@gromesh/compiler";
import type { RequestContext } from "../auth/auth.js";
import { ProblemException, type FieldError } from "./problem.js";

/** 403 unless the caller is the platform admin (contract: Privileged plugin capabilities). */
export function requirePlatformAdmin(ctx: RequestContext, errors: FieldError[]): void {
  if (errors.length > 0 && !ctx.platformAdmin) {
    throw new ProblemException(HttpStatus.FORBIDDEN, "Privileged plugin capabilities require the platform admin", errors);
  }
}

/** The privileged uses of a plugin, at `prefix` (`config.access`, or `document.plugins.0.config.access`). */
export function pluginPrivilegedIssues(plugin: Pick<Plugin, "name" | "config">, prefix = ""): FieldError[] {
  return privilegedUses(plugin).map((u) => ({ path: prefix ? `${prefix}.${u.path}` : u.path, message: u.message }));
}
