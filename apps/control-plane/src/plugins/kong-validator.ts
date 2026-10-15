import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { compile, type GatewayState, type Plugin } from "@gromesh/compiler";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { ProblemException, unprocessable, type FieldError } from "../common/problem.js";

// Placeholders for the entities a scoped plugin points at, so the compiler accepts a one-plugin state.
const STUB_SERVICE_ID = "00000000-0000-4000-8000-00000000f001";

/** Kong's own field names → paths in our PluginWrite body. */
const PATHS: Record<string, string> = {
  "@entity": "(body)",
  service: "scope.serviceId",
  route: "scope.routeId",
  consumer: "scope.consumerId",
};

/** Flattens Kong's nested `fields` ({ config: { minute: "expected a number" } }) into errors[] with dotted paths. */
export function kongFieldErrors(fields: unknown, prefix = ""): FieldError[] {
  if (typeof fields === "string") return [{ path: prefix || "(body)", message: fields }];
  if (Array.isArray(fields)) return fields.flatMap((f) => kongFieldErrors(f, prefix));
  if (!fields || typeof fields !== "object") return [];
  return Object.entries(fields).flatMap(([k, v]) => {
    const path = prefix ? (k === "@entity" ? prefix : `${prefix}.${k}`) : (PATHS[k] ?? k);
    return kongFieldErrors(v, path);
  });
}

/** Delegates plugin config validation to a Kong of the pinned version (KONG_VALIDATOR_URL). */
@Injectable()
export class KongValidator {
  private readonly logger = new Logger("KongValidator");

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async validatePlugin(plugin: Plugin): Promise<void> {
    if (!this.config.kongValidatorUrl) throw new ProblemException(HttpStatus.BAD_GATEWAY, "Plugin validation is not configured (KONG_VALIDATOR_URL)");
    let res: Response;
    try {
      res = await fetch(`${this.config.kongValidatorUrl}/schemas/plugins/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(adminEntity(plugin)),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      this.logger.error(`Kong validator unreachable: ${String(err)}`);
      throw new ProblemException(HttpStatus.BAD_GATEWAY, "Plugin validator is unreachable");
    }
    if (res.ok) return;
    const body = (await res.json().catch(() => null)) as { fields?: unknown; message?: string } | null;
    if (res.status === 400 && body?.fields) throw unprocessable("Plugin config is invalid", kongFieldErrors(body.fields));
    this.logger.error(`Kong validator answered HTTP ${res.status}: ${body?.message ?? ""}`);
    throw new ProblemException(HttpStatus.BAD_GATEWAY, `Plugin validator failed (HTTP ${res.status})`);
  }
}

/**
 * The plugin as Kong's Admin API expects it. The Kong field mapping comes from the compiler (rule 2);
 * only the foreign-key shape differs: the declarative format uses ids, the Admin API `{ id }`.
 */
function adminEntity(plugin: Plugin): Record<string, unknown> {
  const s = plugin.scope ?? {};
  const serviceId = s.serviceId ?? (s.routeId ? STUB_SERVICE_ID : null);
  const state: GatewayState = {
    services: serviceId ? [{ id: serviceId, name: "validate", protocol: "http", host: "validate.invalid", port: 80 }] : [],
    routes: s.routeId ? [{ id: s.routeId, name: "validate", serviceId: serviceId!, paths: ["/"] }] : [],
    consumers: s.consumerId ? [{ id: s.consumerId, username: "validate" }] : [],
    keyAuthCredentials: [],
    plugins: [plugin],
  };
  const { service, route, consumer, ...rest } = compile(state).plugins[0]!;
  return {
    ...rest,
    ...(service ? { service: { id: service } } : {}),
    ...(route ? { route: { id: route } } : {}),
    ...(consumer ? { consumer: { id: consumer } } : {}),
  };
}
