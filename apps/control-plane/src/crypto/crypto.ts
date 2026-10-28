import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config.js";

/**
 * Stored form of a secret: `enc:v2:<keyId>:<iv>:<ciphertext>:<tag>`, all base64url. v2 binds the ciphertext to its
 * row (table, column, id) through the associated data, so a sealed value copied to another row no longer opens;
 * v1 (key id only as associated data) is still read and re-sealed as v2 by the next start or rotation.
 */
const PREFIX_V2 = "enc:v2:";
const PREFIX_V1 = "enc:v1:";

/** Where a sealed value lives: part of the associated data of v2. */
export interface SealContext {
  table: string;
  column: string;
  id: string;
}

export const credentialContext = (id: string): SealContext => ({ table: "keyauth_credentials", column: "key", id });
export const pluginSecretContext = (id: string, path: string[]): SealContext => ({ table: "plugins", column: `config.${path.join(".")}`, id });
export const certificateKeyContext = (id: string): SealContext => ({ table: "certificates", column: "key", id });
export const jwtSecretContext = (id: string): SealContext => ({ table: "jwt_credentials", column: "secret", id });
export const basicAuthHashContext = (id: string): SealContext => ({ table: "basicauth_credentials", column: "password_hash", id });
export const instanceSigningKeyContext = (kid: string): SealContext => ({ table: "instance_signing_keys", column: "private_key", id: kid });
export const releaseContext = (workspaceId: string, version: number): SealContext => ({ table: "releases", column: "content", id: `${workspaceId}:${version}` });
export const deploymentContext = (epoch: number, revision: number): SealContext => ({ table: "deployments", column: "config", id: `${epoch}:${revision}` });
export const snapshotContext = (environmentId: string, version: number, column: "config" | "state"): SealContext => ({ table: "snapshots", column, id: `${environmentId}:${version}` });

const aad = (keyId: string, ctx: SealContext | null) => Buffer.from(ctx ? [keyId, ctx.table, ctx.column, ctx.id].join("\0") : keyId);

/** A JSON column holding one sealed document. */
export interface SealedJson {
  $enc: string;
}

/** `GROMESH_ENCRYPTION_KEY` / `GROMESH_ENCRYPTION_KEYS` entries: `<keyId>:<base64 of 32 bytes>`. */
export function parseKey(entry: string): { id: string; key: Buffer } {
  const at = entry.indexOf(":");
  const id = at > 0 ? entry.slice(0, at).trim() : "";
  const key = Buffer.from(at > 0 ? entry.slice(at + 1).trim() : "", "base64");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || key.length !== 32) throw new Error("Encryption keys are `<keyId>:<base64 of 32 bytes>`");
  return { id, key };
}

/** `GROMESH_FINGERPRINT_KEY`: base64 of 32 bytes, separate from the cipher keys so a rotation never reindexes. */
export function parseFingerprintKey(entry: string): Buffer {
  const key = Buffer.from(entry.trim(), "base64");
  if (key.length !== 32) throw new Error("GROMESH_FINGERPRINT_KEY must be the base64 of 32 bytes");
  return key;
}

/**
 * AES-256-GCM with the key id as associated data. One write key, any number of read keys, so a rotation is:
 * add the new key as the write key, keep the old one for reading, re-seal everything, drop the old one.
 */
export class Encryptor {
  private readonly keys: Map<string, Buffer>;

  constructor(
    readonly writeKeyId: string,
    keys: { id: string; key: Buffer }[],
    private readonly fingerprintKey: Buffer,
  ) {
    this.keys = new Map(keys.map((k) => [k.id, k.key]));
    if (!this.keys.has(writeKeyId)) throw new Error(`Write key ${writeKeyId} is not among the known keys`);
  }

  static fromConfig(encryption: NonNullable<AppConfig["encryption"]>): Encryptor {
    const write = parseKey(encryption.writeKey);
    return new Encryptor(write.id, [write, ...encryption.readKeys.map(parseKey)], parseFingerprintKey(encryption.fingerprintKey));
  }

  /** HMAC-SHA256 of a secret: equality and uniqueness checks on data that is stored encrypted. */
  fingerprint(value: string): string {
    return createHmac("sha256", this.fingerprintKey).update(value).digest("hex");
  }

  seal(plain: string, ctx: SealContext): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.writeKeyId)!, iv);
    cipher.setAAD(aad(this.writeKeyId, ctx));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `${PREFIX_V2}${this.writeKeyId}:${iv.toString("base64url")}:${body.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}`;
  }

  /**
   * Plain text passes through: rows written before the encryption migration are read until it re-seals them.
   * A v2 value opens only in the row it was sealed for; a v1 value opens anywhere its key is known.
   */
  open(stored: string, ctx: SealContext): string {
    if (!isSealed(stored)) return stored;
    const v2 = stored.startsWith(PREFIX_V2);
    const [keyId, iv, body, tag] = stored.slice(PREFIX_V2.length).split(":");
    const key = keyId ? this.keys.get(keyId) : undefined;
    if (!keyId || !key || !iv || !body || !tag) throw new Error(`Cannot decrypt: unknown key ${keyId ?? "?"}`);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(aad(keyId, v2 ? ctx : null));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    try {
      return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error(`Cannot decrypt ${ctx.table}.${ctx.column} of ${ctx.id}: the value does not belong to this row`);
    }
  }

  /** Whether `stored` is sealed in the current format with the current write key (nothing to do on rotation). */
  current(stored: string): boolean {
    return stored.startsWith(PREFIX_V2) && keyIdOf(stored) === this.writeKeyId;
  }

  sealJson(value: unknown, ctx: SealContext): SealedJson {
    return { $enc: this.seal(JSON.stringify(value), ctx) };
  }

  /** A sealed document, or (before the migration ran) the plain document itself. */
  openJson<T>(stored: unknown, ctx: SealContext): T {
    if (isSealedJson(stored)) return JSON.parse(this.open(stored.$enc, ctx)) as T;
    return stored as T;
  }

  currentJson(stored: unknown): boolean {
    return isSealedJson(stored) && this.current(stored.$enc);
  }
}

export const isSealed = (v: unknown): v is string => typeof v === "string" && (v.startsWith(PREFIX_V2) || v.startsWith(PREFIX_V1));
/** Sealed in the previous format (no row context): re-sealed as v2 by the next start, whatever the key. */
export const isLegacySealed = (v: unknown): boolean => typeof v === "string" && v.startsWith(PREFIX_V1);
export const isSealedJson = (v: unknown): v is SealedJson => typeof v === "object" && v !== null && isSealed((v as SealedJson).$enc);
// Both prefixes have the same length.
const keyIdOf = (stored: string) => stored.slice(PREFIX_V2.length).split(":")[0];

export const ENCRYPTOR = Symbol("ENCRYPTOR");

@Global()
@Module({
  providers: [
    {
      provide: ENCRYPTOR,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        if (!config.encryption) throw new Error("GROMESH_ENCRYPTION_KEY and GROMESH_FINGERPRINT_KEY are required");
        return Encryptor.fromConfig(config.encryption);
      },
    },
  ],
  exports: [ENCRYPTOR],
})
export class CryptoModule {}



