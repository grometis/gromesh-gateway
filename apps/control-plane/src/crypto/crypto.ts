import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config.js";

/** Stored form of a secret: `enc:v1:<keyId>:<iv>:<ciphertext>:<tag>`, all base64url. */
const PREFIX = "enc:v1:";

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

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.writeKeyId)!, iv);
    cipher.setAAD(Buffer.from(this.writeKeyId));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `${PREFIX}${this.writeKeyId}:${iv.toString("base64url")}:${body.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}`;
  }

  /** Plain text passes through: rows written before the encryption migration are read until it re-seals them. */
  open(stored: string): string {
    if (!isSealed(stored)) return stored;
    const [keyId, iv, body, tag] = stored.slice(PREFIX.length).split(":");
    const key = keyId ? this.keys.get(keyId) : undefined;
    if (!keyId || !key || !iv || !body || !tag) throw new Error(`Cannot decrypt: unknown key ${keyId ?? "?"}`);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(keyId));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }

  /** Whether `stored` is already sealed with the current write key (nothing to do on rotation). */
  current(stored: string): boolean {
    return isSealed(stored) && keyIdOf(stored) === this.writeKeyId;
  }

  sealJson(value: unknown): SealedJson {
    return { $enc: this.seal(JSON.stringify(value)) };
  }

  /** A sealed document, or (before the migration ran) the plain document itself. */
  openJson<T>(stored: unknown): T {
    if (isSealedJson(stored)) return JSON.parse(this.open(stored.$enc)) as T;
    return stored as T;
  }

  currentJson(stored: unknown): boolean {
    return isSealedJson(stored) && this.current(stored.$enc);
  }
}

export const isSealed = (v: unknown): v is string => typeof v === "string" && v.startsWith(PREFIX);
export const isSealedJson = (v: unknown): v is SealedJson => typeof v === "object" && v !== null && isSealed((v as SealedJson).$enc);
const keyIdOf = (stored: string) => stored.slice(PREFIX.length).split(":")[0];

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



