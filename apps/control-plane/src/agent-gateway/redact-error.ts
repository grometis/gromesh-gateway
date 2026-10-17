import type { GatewayState } from "@gromesh/compiler";
import { tokenHash } from "../clusters/clusters.js";
import type { PluginCatalog } from "../plugin-catalog/catalog.js";

function collectSecrets(original: unknown, redacted: unknown, secrets: Set<string>): void {
  if (redacted === "REDACTED") {
    if (typeof original === "string" && original.length > 0) {
      secrets.add(original);
      // Kong's error body can contain a JSON-escaped copy of the submitted value.
      secrets.add(JSON.stringify(original).slice(1, -1));
    } else if (original !== null && typeof original === "object") {
      for (const value of Object.values(original)) collectSecrets(value, "REDACTED", secrets);
    }
    return;
  }
  if (original === null || redacted === null || typeof original !== "object" || typeof redacted !== "object") return;
  const masked = redacted as Record<string, unknown>;
  for (const [key, value] of Object.entries(original)) collectSecrets(value, masked[key], secrets);
}

export function redactAgentError(
  message: string,
  state: GatewayState | undefined,
  catalog: PluginCatalog,
  nodeToken: string,
  registrationTokenHash: string,
): string {
  const secrets = new Set<string>([nodeToken]);
  if (state) {
    for (const credential of state.keyAuthCredentials) collectSecrets(credential.key, "REDACTED", secrets);
    for (const credential of state.jwtCredentials ?? []) if (credential.secret) collectSecrets(credential.secret, "REDACTED", secrets);
    for (const credential of state.basicAuthCredentials ?? []) collectSecrets(credential.passwordHash, "REDACTED", secrets);
    for (const certificate of state.certificates ?? []) {
      collectSecrets(certificate.key, "REDACTED", secrets);
      // The base64 body of the key, in case Kong quotes it without the PEM armour.
      for (const line of certificate.key.split("\n")) if (line.length >= 32 && !line.startsWith("-----")) secrets.add(line);
    }
    for (const plugin of state.plugins) {
      const config = plugin.config ?? {};
      collectSecrets(config, catalog.redactConfig(plugin.name, config), secrets);
    }
  }

  // Registration tokens are never stored in clear text. Match candidates against
  // the persisted hash, including occurrences embedded in longer diagnostic values.
  for (const match of message.matchAll(/[A-Za-z0-9_-]{43,}/g)) {
    for (let offset = 0; offset <= match[0].length - 43; offset++) {
      const candidate = match[0].slice(offset, offset + 43);
      if (tokenHash(candidate) === registrationTokenHash) {
        secrets.add(candidate);
        offset += 42;
      }
    }
  }
  const pattern = [...secrets]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const redacted = message.replace(new RegExp(pattern, "g"), "REDACTED");
  const bytes = Buffer.from(redacted, "utf8");
  let end = Math.min(bytes.length, 8 * 1024);
  // Do not split a multibyte character when applying the protocol's byte limit.
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
