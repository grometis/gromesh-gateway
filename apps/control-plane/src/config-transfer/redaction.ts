import type { ConfigDocument, GatewayState } from "@gromesh/compiler";
import type { FieldError } from "../common/problem.js";
import type { PluginCatalog } from "../plugin-catalog/catalog.js";

/** Validators can interpolate invalid values: redact both submitted and retained secret material in diagnostics. */
export function redactImportErrors(errors: FieldError[], document: ConfigDocument, current: GatewayState, catalog: PluginCatalog): FieldError[] {
  const values = new Set<string>();
  const collect = (value: string | null | undefined) => { if (value && value !== "REDACTED") values.add(value); };
  for (const c of document.consumers) {
    c.keyAuthCredentials.forEach(k => collect(k.key));
    c.jwtCredentials.forEach(j => collect(j.secret));
    c.basicAuthCredentials.forEach(b => collect(b.password));
  }
  current.keyAuthCredentials.forEach(k => collect(k.key));
  current.jwtCredentials?.forEach(j => collect(j.secret));
  current.basicAuthCredentials?.forEach(b => collect(b.passwordHash));
  for (const certificate of [...document.certificates, ...(current.certificates ?? [])]) {
    collect(certificate.key);
    certificate.key?.split("\n").filter(line => line && !line.startsWith("-----")).forEach(collect);
  }
  for (const plugin of [...document.plugins, ...current.plugins]) catalog.mapSecrets(plugin.name, plugin.config ?? {}, value => { collect(value); return value; });
  const secrets = [...values].sort((a, b) => b.length - a.length);
  return errors.map(error => ({ ...error, message: secrets.reduce((message, secret) => message.replaceAll(secret, "REDACTED"), error.message) }));
}
