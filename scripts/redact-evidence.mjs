import { isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function* files(directory, optional = false) {
  // POSIX follows links with trailing / or /.; inspect the root itself instead.
  directory = directory.replace(/(?:\/+\.?)+$/, "") || "/";
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    // A failure before tests start may leave either artifact directory absent.
    if (optional && error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory()) throw new Error("Evidence root must be a directory");
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile()) yield file;
    // Artifact upload may follow links: never silently skip an unscanned target.
    else throw new Error("Unsupported evidence entry");
  }
}

function assertSanitizable(file, data) {
  if (/\.(?:zip|gz|tgz|br|zst|7z)$/i.test(file)
    || ["504b0304", "504b0506", "504b0708", "1f8b", "28b52ffd", "377abcaf271c"]
      .some(magic => data.subarray(0, magic.length / 2).equals(Buffer.from(magic, "hex")))) {
    throw new Error("Compressed evidence is unsupported");
  }
  // Playwright packs report JSON into a base64 ZIP inside index.html, not just trace.zip.
  if (/playwrightReportBase64|data:application\/(?:zip|gzip|x-gzip|zstd|x-7z-compressed);base64,/i.test(data.toString("latin1"))) {
    throw new Error("Embedded compressed evidence is unsupported");
  }
}

const jsonString = String.raw`"(?:\\.|[^"\\])*"`;
const singleString = String.raw`'(?:\\.|[^'\\])*'`;
const stringValue = `${jsonString}|${singleString}`;
const authValue = `(?:${stringValue}|\\[(?:${stringValue}|[^\\[\\]"'])*\\])`;
const authNames = "authorization|cookie|set-cookie|x-csrf-token|csrfToken|apikey|api-key|x-api-key";

function redactStringValues(value) {
  return value.replace(new RegExp(stringValue, "g"), quoted => quoted[0] + "REDACTED" + quoted[0]);
}

function redactAuthentication(text) {
  // Text logs may contain escaped JSON fragments without the enclosing string's quotes.
  text = text.replace(/^[^\r\n]*\\"[^\r\n]*/gm, line => {
    let value;
    try { value = JSON.parse('"' + line + '"'); } catch { return line; }
    const redacted = redactAuthentication(value);
    return redacted === value ? line : JSON.stringify(redacted).slice(1, -1);
  });
  // Decode string contents before matching so serialized JSON uses the same rules at every nesting level.
  text = text.replace(new RegExp(jsonString, "g"), quoted => {
    let value;
    try { value = JSON.parse(quoted); } catch { return quoted; }
    const redacted = redactAuthentication(value);
    return redacted === value ? quoted : JSON.stringify(redacted);
  });
  // HAR-style header/cookie records, including reversed name/value order.
  text = text.replace(/\{(?:"(?:\\.|[^"\\])*"|[^{}"])*\}/g, record => {
    if (new RegExp(`"name"\\s*:\\s*"(?:${authNames}|gromesh_session)"`, "i").test(record)) {
      record = record.replace(new RegExp(`("value"\\s*:\\s*)(${authValue})`, "gi"),
        (_match, prefix, value) => prefix + redactStringValues(value));
    }
    // Creation/rotation returns consumerId and keyHint; generic keys without credential context stay useful.
    if (/"(?:consumerId|keyHint)"\s*:/.test(record)) {
      record = record.replace(new RegExp(`("key"\\s*:\\s*)(${jsonString})`, "g"), '$1"REDACTED"');
    }
    return record;
  });
  // Quoted fields never use a line-wide fallback: arrays keep their delimiters and scalars stay intact.
  text = text.replace(new RegExp(`((?:"(?:${authNames})"|'(?:${authNames})')\\s*:\\s*)(${authValue})`, "gi"),
    (_match, prefix, value) => prefix + redactStringValues(value));
  // Skip complete strings here: their decoded contents were already sanitized without eating outer JSON.
  text = text.replace(new RegExp(`${stringValue}|(^[ \\t]*(?:${authNames})[ \\t]*:[ \\t]*)[^\\r\\n]+`, "gim"),
    (match, prefix) => prefix === undefined ? match : prefix + "REDACTED");
  text = text.replace(new RegExp(`${stringValue}|((?<![\\w"'\\\\?&-])(?:${authNames})\\b[ \\t]*[:=][ \\t]*)(${authValue}|[^\\r\\n]+)`, "gi"),
    (match, prefix, value) => prefix === undefined ? match
      : prefix + (/^["'\[]/.test(value) ? redactStringValues(value) : "REDACTED"));
  // A standalone key without metadata is ambiguous; the contract's 32-byte base64url shape is sensitive.
  text = text.replace(/("key"\s*:\s*)"[A-Za-z0-9_-]{43}"/g, '$1"REDACTED"');
  text = text.replace(/([?&](?:apikey|api-key|x-api-key)=)[^&#\s"'<>\\]+/gi, "$1REDACTED");
  // auth.ts TOKEN_PATTERN; sessions.ts uses 32 random bytes in unpadded base64url.
  return text
    .replace(/(\bgromesh_session=)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, "$1REDACTED")
    .replace(/(?<![A-Za-z0-9_-])ggt_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, "REDACTED");
}

function textContent(data) {
  return isUtf8(data) && !data.includes(0) ? data.toString("utf8") : null;
}

export function redactEvidence(directories, variableNames, env = process.env, extraSecrets = []) {
  const secrets = [...new Set(variableNames.map(name => env[name]).filter(Boolean)), ...extraSecrets]
    .map(value => Buffer.from(value)).filter(value => value.length)
    .sort((a, b) => b.length - a.length);
  const replacement = Buffer.from("REDACTED");
  const paths = directories.flatMap(directory => [...files(directory, true)]);
  // Refuse unsupported inputs before changing any evidence.
  for (const file of paths) assertSanitizable(file, readFileSync(file));
  for (const file of paths) {
    let data = readFileSync(file);
    let changed = false;
    const text = textContent(data);
    if (text !== null) {
      const redacted = redactAuthentication(text);
      if (redacted !== text) {
        data = Buffer.from(redacted);
        changed = true;
      }
    }
    for (const secret of secrets) {
      const parts = [];
      let start = 0;
      let index;
      while ((index = data.indexOf(secret, start)) !== -1) {
        parts.push(data.subarray(start, index), replacement);
        start = index + secret.length;
      }
      if (start === 0) continue;
      parts.push(data.subarray(start));
      data = Buffer.concat(parts);
      changed = true;
    }
    if (changed) writeFileSync(file, data);
  }
  // Verify bytes read back from disk, including matches introduced by replacement.
  for (const directory of directories) {
    for (const file of files(directory, true)) {
      const saved = readFileSync(file);
      assertSanitizable(file, saved);
      const text = textContent(saved);
      if (secrets.some(secret => saved.indexOf(secret) !== -1)
        || (text !== null && redactAuthentication(text) !== text)) {
        throw new Error("Secret remains in evidence");
      }
    }
  }
}

function secretValues(input, namespaces) {
  const list = JSON.parse(input);
  if (!Array.isArray(list.items)) throw new Error("Invalid Secret list");
  const values = [];
  for (const secret of list.items) {
    if (!namespaces.includes(secret.metadata?.namespace) || secret.type !== "Opaque") continue;
    if (!secret.data || typeof secret.data !== "object" || Array.isArray(secret.data)) throw new Error("Invalid Secret data");
    for (const [name, encoded] of Object.entries(secret.data)) {
      if (typeof encoded !== "string") throw new Error("Invalid Secret value");
      const value = Buffer.from(encoded, "base64");
      if (value.toString("base64") !== encoded) throw new Error("Invalid Secret encoding");
      // Only credential-named entries of at least 12 bytes become literals, preserving names, URLs and images.
      if (/password|token|key|secret|encryption|fingerprint|apikey/i.test(name) && value.length >= 12) values.push(value);
    }
  }
  if (!values.length) throw new Error("No Secret values recovered");
  return values;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const directories = [];
    while (args.length && !args[0].startsWith("--")) directories.push(args.shift());
    if (!directories.length) throw new Error("Missing evidence roots");
    const options = new Map();
    while (args.length) {
      const option = args.shift();
      if (!["--env", "--secrets-stdin", "--kube-secrets"].includes(option) || options.has(option)) throw new Error("Invalid option");
      const values = [];
      while (args.length && !args[0].startsWith("--")) values.push(args.shift());
      if (!values.length) throw new Error("Missing option values");
      options.set(option, values);
    }
    if (options.has("--secrets-stdin") && options.has("--kube-secrets")) throw new Error("Conflicting Secret inputs");
    let extraSecrets = [];
    if (options.has("--secrets-stdin")) extraSecrets = secretValues(readFileSync(0, "utf8"), options.get("--secrets-stdin"));
    if (options.has("--kube-secrets")) {
      const [context, ...namespaces] = options.get("--kube-secrets");
      if (!context || !namespaces.length) throw new Error("Missing Kubernetes scope");
      // Capture stdout/stderr in memory; never persist or export recovered credentials.
      const result = spawnSync("kubectl", ["--context", context, "get", "secrets", "--all-namespaces", "-o", "json"], {
        encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
      });
      if (result.error || result.status !== 0) throw new Error("Cannot read Kubernetes Secrets");
      extraSecrets = secretValues(result.stdout, namespaces);
    }
    redactEvidence(directories, options.get("--env") ?? [], process.env, extraSecrets);
  } catch {
    // Paths and filesystem errors can themselves contain credentials.
    console.error("Evidence redaction failed.");
    process.exitCode = 1;
  }
}
