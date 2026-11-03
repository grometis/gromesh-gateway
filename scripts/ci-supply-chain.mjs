import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { directoryPath, readRegularFile, requireValid, RejectionCode, checkedOperation, rejectionArtifact, rejectionLine } from "./ci-evidence.mjs";

// Resource budget, not an extension allowlist: 16 MiB bounds parsing of image inventories;
// independent collection/text caps below also bound a compact or highly nested document.
export const maximumSbomBytes = 16 * 1024 * 1024;
const applicationNames = ["control-plane", "ui", "agent"];
const architectures = ["amd64", "arm64"];
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const creators = ["Organization: Anchore, Inc", "Tool: syft-1.18.1"];
const embeddedRuntimes = new Set(["node"]);
const semverNumber = "(?:0|[1-9][0-9]*)";
const prereleaseIdentifier = `(?:${semverNumber}|[0-9]*[A-Za-z-][A-Za-z0-9-]*)`;
const semver = new RegExp(`^${semverNumber}\\.${semverNumber}\\.${semverNumber}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*)?$`);
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const credentialPattern = /(?:synthetic[_ -](?:secret|password|token)|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]+|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|BEGIN [A-Z ]*PRIVATE KEY)/i;

const sensitiveTextPattern = /(?:secret|password|passwd|authorization|cookie|credential|api[ _-]?key|private[ _-]?key|access[ _-]?key|token|bearer|synthetic|gh[pousr]_|github_pat_|AKIA|ASIA|sk-[a-z])/i;
const referenceNamePattern = /\b(?:secrets?|token|password|passwd|api[\W_]*key|access[\W_]*key|private[\W_]*key|credentials?|auth|authorization|bearer|session)\b/i;

function normalizeIdentifiers(value) {
  return value.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_0-9-]+/g, " ").replace(/ +/g, " ");
}
function referencePath(parts, packageParts = [], kind = "download") {
  // Check names even without a following value: this also closes name/value path pairs.
  for (const part of parts) {
    const sensitive = [part, normalizeIdentifiers(part)].some(spelling => referenceNamePattern.test(spelling)) ||
      encodedCredential(part, referenceNamePattern);
    if (kind === "cpe") requireValid(!sensitive || packageParts.includes(part), RejectionCode.CPE_SENSITIVE);
    else if (kind === "image") requireValid(!sensitive || packageParts.includes(part), RejectionCode.IMAGE_PATH_SENSITIVE);
    else requireValid(!sensitive || packageParts.includes(part), RejectionCode.DOWNLOAD_PATH_SENSITIVE);
  }
}
function tokenPackage(pkg) {
  // These npm products describe lexer tokens. Bind exceptions to package coordinates,
  // never to arbitrary segments called "token" or a credential-bearing suffix.
  if (!["@tokenizer/token", "token-types"].includes(pkg?.name) ||
    typeof pkg.versionInfo !== "string" || !semver.test(pkg.versionInfo)) return false;
  return Array.isArray(pkg.externalRefs) && pkg.externalRefs.some(ref =>
    ref?.referenceCategory === "PACKAGE-MANAGER" && ref.referenceType === "purl" &&
    [pkg.name, pkg.name.replace("@", "%40")].some(name => ref.referenceLocator === `pkg:npm/${name}@${pkg.versionInfo}`));
}
function tokenRepository(parts, pkg) {
  const repo = pkg?.name === "@tokenizer/token" ? "tokenizer-token" : "token-types";
  return tokenPackage(pkg) && parts.length === 2 && parts[0] === "Borewit" &&
    [repo, `${repo}.git`].includes(parts[1]);
}
const sensitiveTokens = new Set(["auth", "authorization", "session", "secret", "secrets", "token",
  "password", "passwd", "apikey", "accesskey", "privatekey", "credential", "credentials",
  "bearer", "basic", "digest", "cookie", "cookies"]);
function proseTokens(value) {
  const tokens = [];
  for (const match of value.matchAll(/[\p{L}\p{M}0-9]+/gu)) {
    const splits = [...match[0].matchAll(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/g)];
    const boundaries = [0, ...splits.map(part => part.index), match[0].length];
    for (let i = 1; i < boundaries.length; i++) {
      const start = match.index + boundaries[i - 1];
      const end = match.index + boundaries[i];
      tokens.push({ name: value.slice(start, end).toLowerCase(), start, end });
    }
  }
  return tokens;
}
function credentialValue(value) {
  if (/[0-9]/.test(value) || /^[a-f]+$/i.test(value)) return true;
  const classes = [/[a-z]/, /[A-Z]/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(value)).length;
  if (value.length >= 6 && classes >= 2) return true;
  // Plain words also fit the base64 alphabet. Require canonical encoding and
  // textual decoded data or encoding punctuation before treating them as values.
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  const canonical = decoded.toString("base64url");
  return canonical === value.replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_") &&
    (/^[\x20-\x7e]+$/.test(decoded.toString("latin1")) || /[=+/_-]/.test(value));
}
function tokenCredential(value, prose = false) {
  // The captured libsm description names X11 session management. Bind the
  // exception to the complete description; appended values must still fail.
  if (prose && value === "X11 Session Management library") return false;
  const tokens = proseTokens(value);
  for (let i = 0; i < tokens.length; i++) {
    let name = "";
    for (let j = i; j < tokens.length && j < i + 13; j++) {
      if (j > i && !/^[ _-]*$/.test(value.slice(tokens[j - 1].end, tokens[j].start))) break;
      name += tokens[j].name.replace(/[0-9]/g, "");
      if (name.length > 13) break;
      if (!sensitiveTokens.has(name)) continue;
      const tail = value.slice(tokens[j].end);
      const separators = /^[\s:="'\[\]{}(),]*/.exec(tail)[0];
      const rest = tail.slice(separators.length);
      // Keep the prior rejection of assignments, including short/punctuation values.
      if (separators.includes("=") && /\S/.test(tail.slice(tail.indexOf("=") + 1))) return true;
      const candidate = /^[\p{L}\p{M}0-9+/_~.-]+={0,2}/u.exec(rest)?.[0];
      if (prose && candidate && credentialValue(candidate)) return true;
      // Digest uses auth-param pairs rather than a single token68 payload.
      if (prose && name === "digest" && /^[A-Za-z][A-Za-z0-9_-]*[\s"']*=[\s"']*[A-Za-z0-9+/_~.-]+/.test(rest)) return true;
    }
  }
  return false;
}
function encodedCredential(value, pattern = sensitiveTextPattern) {
  // Inspect the whole spelling and its components: '/' is both base64 data and
  // a path separator, while '-'/'_' can be either base64url data or identifier separators.
  for (const fragment of [value, ...value.split(/[/.:@\\]+/), ...value.split(/[/.:@\\_+-]+/)]) {
    for (const encoded of fragment.match(/[A-Za-z0-9+/_-]{4,}={0,2}/g) ?? []) {
      const decoded = [Buffer.from(encoded, "base64url").toString("utf8")];
      const hex = encoded.replace(/^0x/i, "");
      if (/^(?:[0-9a-f]{2})+$/i.test(hex)) decoded.push(Buffer.from(hex, "hex").toString("utf8"));
      if (decoded.some(item => pattern.test(item) ||
        pattern.test(normalizeIdentifiers(item)) || credentialPattern.test(item))) return true;
    }
  }
  return false;
}

function exactDigest(value) {
  requireValid(typeof value === "string" && value.length === 71 && digestPattern.test(value), RejectionCode.DIGEST_FORMAT);
}
function shape(value, required, optional = []) {
  requireValid(value !== null && typeof value === "object" && !Array.isArray(value), RejectionCode.OBJECT_TYPE);
  // Every object is closed, so sensitive names (even with innocuous values) cannot add a channel.
  requireValid(Object.keys(value).every(key => required.includes(key) || optional.includes(key)), RejectionCode.OBJECT_FIELDS);
  requireValid(required.every(key => Object.hasOwn(value, key)), RejectionCode.OBJECT_REQUIRED);
}
function list(value, maximum, minimum = 0) {
  requireValid(Array.isArray(value) && value.length >= minimum && value.length <= maximum, RejectionCode.ARRAY_BUDGET);
}
function text(value, maximum, pattern, unicode = false, prose = false) {
  requireValid(typeof value === "string" && value.length > 0 && value.length <= maximum, RejectionCode.TEXT_BUDGET);
  requireValid((unicode ? /^[\x20-\x7e\p{L}\p{M}]+$/u : /^[\x20-\x7e]+$/).test(value) && !credentialPattern.test(value), RejectionCode.TEXT_CHARACTERS);
  if (prose) {
    requireValid(!tokenCredential(value, true), RejectionCode.PROSE_CREDENTIAL);
    requireValid(!encodedCredential(value), RejectionCode.PROSE_ENCODED_CREDENTIAL);
  } else {
    requireValid(!tokenCredential(value) && !encodedCredential(value), RejectionCode.TEXT_CHARACTERS);
  }
  if (pattern) requireValid(pattern.test(value), RejectionCode.TEXT_PATTERN);
}
function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  return [...counts.values()].reduce((sum, n) => sum - (n / value.length) * Math.log2(n / value.length), 0);
}
export function safeText(value, maximum = 160) {
  text(value, maximum, /^[A-Za-z0-9 .,():/+_@=*~-]+$/);
  requireValid(!sensitiveTextPattern.test(value) && !sensitiveTextPattern.test(normalizeIdentifiers(value)), RejectionCode.SAFE_TEXT_SENSITIVE);
  requireValid(!value.includes("://") && !value.includes(".."), RejectionCode.SAFE_TEXT_LOCATION);
  // Free text is never exempt just because it resembles a hash/base64 string.
  for (const word of value.match(/[A-Za-z0-9_+/=-]+/g) ?? []) {
    requireValid(word.length < 32 && (word.length < 20 || entropy(word) < 3.5), RejectionCode.SAFE_TEXT_WORD_BUDGET);
  }
  requireValid(value.length < 32 || entropy(value) < 4.5, RejectionCode.SAFE_TEXT_ENTROPY);
}
function syftProse(value, unicode = false) {
  text(value, 160, /^[\p{L}\p{M}0-9 .,():/+_@=*~`'"!?&;[\]-]+$/u, unicode, true);
  requireValid(!value.includes("://") && !value.includes(".."), RejectionCode.PROSE_LOCATION);
  // Project descriptions legitimately mention cookie parsing and tokenizers. Reject
  // credential words/phrases, and short encoded credential markers regardless of entropy.
  const normalized = normalizeIdentifiers(value);
  requireValid(![value, normalized].some(spelling => /\b(?:password|passwd|authorization|credentials?|api[ _-]?key|private[ _-]?key|access[ _-]?key|bearer|secret)\b/i.test(spelling)), RejectionCode.PROSE_CREDENTIAL);
  const terminology = value.replace(/\btoken types\b/ig, "types")
    .replace(/\bdefinition for [a-z0-9-]+ token$/ig, "definition")
    .replace(/\bcookie parsing\b/ig, "parsing");
  requireValid(![terminology, normalizeIdentifiers(terminology)].some(spelling => /\b(?:token|cookie)\b/i.test(spelling)), RejectionCode.PROSE_TERMINOLOGY);
  for (const word of value.match(/[\p{L}\p{M}0-9_+/=-]+/gu) ?? []) {
    // Descriptions contain camelCase API identifiers; comments keep the stricter 3.5 budget.
    requireValid(word.length < 32 && (word.length < 20 || entropy(word) < 4), RejectionCode.PROSE_WORD_BUDGET);
  }
  // Author names plus email addresses naturally have high whole-string entropy;
  // their individual words and credential patterns remain bounded above.
}
function structuredText(value, maximum, pattern, unicode = false) {
  text(value, maximum, pattern, unicode);
  requireValid(!value.includes(".."), RejectionCode.STRUCTURED_TRAVERSAL);
  // Package/path separators carry structure. Apply token budgets to their components,
  // while comments/annotations keep the stricter whole-value budget in safeText.
  for (const word of value.split(/[/.@+_:=~-]+/).filter(Boolean)) {
    requireValid(word.length < 32 && (word.length < 20 || entropy(word) < 3.5), RejectionCode.STRUCTURED_WORD_BUDGET);
  }
}
function packageVersion(value, maximum = 100) {
  if (value === "(devel)") return;
  structuredText(value, maximum, /^[A-Za-z0-9._+~-]+$/);
}
function downloadRef(value) {
  text(value, 100, /^[A-Za-z0-9._+-]+$/);
  requireValid(!sensitiveTextPattern.test(value) && !sensitiveTextPattern.test(normalizeIdentifiers(value)) && !value.includes(".."), RejectionCode.DOWNLOAD_REF_SENSITIVE);
  referencePath([value]);
  if (/^[0-9a-f]{7,40}$/.test(value)) return;
  // Numeric release tags include v1.2.3, release-1.2.3 and upstream's libidn2.
  // Unstructured words and opaque high-entropy fragments are not refs.
  requireValid(semver.test(value.replace(/^v/, "")) || /^(?:[A-Za-z][A-Za-z_-]{0,39})?[0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(value), RejectionCode.DOWNLOAD_REF_FORMAT);
  structuredText(value, 100);
}
function githubRepository(value, pkg) {
  structuredText(value, 141, /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\/[A-Za-z0-9._-]+$/);
  const [owner, repo] = value.split("/");
  requireValid(owner.length <= 39 && repo.length <= 100 && repo !== "." && repo !== "..", RejectionCode.GITHUB_REPOSITORY);
  referencePath([owner, repo], tokenRepository([owner, repo], pkg) ? [repo] : []);
}
function downloadHost(value) {
  text(value, 253, /^[a-z0-9.-]+$/);
  const labels = value.split(".");
  requireValid(labels.length >= 2 && isIP(value) === 0 && /[a-z]/.test(labels.at(-1)), RejectionCode.DOWNLOAD_HOST);
  for (const label of labels) {
    requireValid(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) && !label.startsWith("xn--"), RejectionCode.DOWNLOAD_HOST_LABEL);
    requireValid(![label, normalizeIdentifiers(label)].some(spelling => /\b(?:password|passwd|authorization|cookie|credentials?|secrets?|api[ _-]?key|private[ _-]?key|access[ _-]?key|token|bearer|synthetic)\b/i.test(spelling)), RejectionCode.DOWNLOAD_HOST_SENSITIVE);
    requireValid(label.length < 20 || entropy(label) < 3.5, RejectionCode.DOWNLOAD_HOST_ENTROPY);
  }
}
function downloadLocation(value, pkg) {
  if (["NOASSERTION", "NONE"].includes(value)) return;
  text(value, 512);
  if (!value.includes("://")) {
    const shorthand = /^(?:github:)?([^#]+)(?:#([^#]+))?$/.exec(value);
    requireValid(shorthand !== null, RejectionCode.DOWNLOAD_SHORTHAND);
    githubRepository(shorthand[1], pkg);
    if (shorthand[2] !== undefined) downloadRef(shorthand[2]);
    return;
  }
  // Parse the raw spelling first: URL normalizes traversal, empty queries,
  // default ports and hostname case, which must not hide rejected input.
  const match = /^(https|http|git|git\+https|git\+ssh):\/\/([a-z0-9.-]+)(?::([0-9]+))?(\/[A-Za-z0-9._!@+/-]*)?(?:#([^#]+))?$/.exec(value);
  requireValid(match !== null, RejectionCode.DOWNLOAD_URL);
  downloadHost(match[2]);
  const defaults = { https: "443", http: "80", git: "9418", "git+https": "443", "git+ssh": "22" };
  requireValid(match[3] === undefined || match[3] === defaults[match[1]], RejectionCode.DOWNLOAD_PORT);
  const url = checkedOperation(RejectionCode.DOWNLOAD_URL, () => new URL(value));
  requireValid(!url.username && !url.password && !url.search && url.hostname === match[2], RejectionCode.DOWNLOAD_URL);
  const path = match[4] ?? "";
  structuredText(path || "/", 400, /^\/[A-Za-z0-9._!@+/-]*$/);
  const parts = path.replace(/^\//, "").replace(/\/$/, "").split("/");
  requireValid(path === "" || path === "/" || parts.every(part => part.length > 0 && part !== "."), RejectionCode.DOWNLOAD_PATH);
  requireValid(parts.every(part => ![part, normalizeIdentifiers(part)].some(spelling => /^cookie$/i.test(spelling))), RejectionCode.DOWNLOAD_PATH_SENSITIVE);
  referencePath(parts, match[2] === "github.com" && tokenRepository(parts, pkg) ? [parts[1]] : []);
  if (match[5] !== undefined) downloadRef(match[5]);
}
function homepageLocation(value, pkg) {
  text(value, 512, /^https?:\/\//);
  // npm's repository landing-page anchor is metadata, not a download ref.
  downloadLocation(value.endsWith("#readme") ? value.slice(0, -7) : value, pkg);
}
function identifier(value, fileName) {
  // Syft appends a 16-hex ID hash to the file path. Validate these separately only
  // when that prefix matches the actual fileName: Irkutsk-<hash> is not an sk- key.
  // Credentials in the filename or in an unrelated ID still hit the original detector.
  const prefix = typeof fileName === "string" ? `SPDXRef-File-${fileName.replaceAll("/", "-")}-` : undefined;
  if (prefix && typeof value === "string" && value.startsWith(prefix) && /^[0-9a-f]{16}$/.test(value.slice(prefix.length))) {
    requireValid(value.length <= 200, RejectionCode.IDENTIFIER_BUDGET);
    text(value.slice(0, -17), 183, /^SPDXRef-[A-Za-z0-9.-]+$/);
    text(value.slice(-16), 16, /^[0-9a-f]{16}$/);
  } else text(value, 200, /^SPDXRef-[A-Za-z0-9.-]+$/);
}
function timestamp(value) {
  text(value, 20, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
  const parsed = Date.parse(value);
  requireValid(Number.isFinite(parsed) && new Date(parsed).toISOString() === value.replace("Z", ".000Z"), RejectionCode.TIMESTAMP);
}
function imagePath(value, inventory = false, tokenPackages = []) {
  text(value, 512, /^\/?[\p{L}\p{M}0-9@+_.,/=-]+$/u, true);
  const parts = value.replace(/^\//, "").split("/");
  requireValid(parts.every(part => part !== ".." && part !== "." && part.length > 0), RejectionCode.IMAGE_PATH_SEGMENTS);
  // Only image filesystem roots, never runner mounts, home directories, credentials or host paths.
  requireValid(["app", "usr", "bin", "sbin", "lib", "lib64", "etc", "opt", "var", "gromesh", "gromesh-agent"].includes(parts[0]), RejectionCode.IMAGE_PATH_ROOT);
  // The public image inventory includes the standard account database path, never its contents.
  // This exception is only for file metadata, not sourceInfo or arbitrary shadow paths.
  requireValid((inventory && ["etc/shadow", "/etc/shadow"].includes(value)) || !/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.aws|\.ssh|\.docker|credentials|secrets?|shadow|gshadow|kubeconfig)(?:\/|$)/i.test(value), RejectionCode.IMAGE_PATH_SENSITIVE);
  requireValid(!/(?:^|\/)(?:home|Users|runner|github|host|proc|sys|dev|mnt)(?:\/|$)/.test(value), RejectionCode.IMAGE_PATH_HOST);
  const path = parts.join("/");
  const metadataParts = [];
  // Captured file inventories name the public account database and this Mozilla CA.
  // Exempt only the complete file locations, never sourceInfo or child/sibling paths.
  if (inventory && ["etc/passwd", "usr/share/ca-certificates/mozilla/GDCA_TrustAUTH_R5_ROOT.crt"].includes(path)) {
    metadataParts.push(parts.at(-1));
  }
  // Lexer packages have token-named pnpm manifests in the control-plane inventory.
  // Bind to their npm coordinates and complete manifest path; versions stay checked.
  for (const pkg of tokenPackages) {
    if (!tokenPackage(pkg)) continue;
    const coordinate = `${pkg.name.replace("/", "+")}@${pkg.versionInfo}`;
    if (path !== `app/apps/control-plane/node_modules/.pnpm/${coordinate}/node_modules/${pkg.name}/package.json`) continue;
    referencePath([pkg.versionInfo], [], "image");
    metadataParts.push(coordinate, ...pkg.name.split("/"));
  }
  referencePath(parts, metadataParts, "image");
  for (const part of parts) {
    // pnpm truncates long peer-dependency coordinates and appends a 32-hex hash.
    // Only that path component has a hash suffix; all remaining text stays checked.
    const coordinate = parts.includes(".pnpm") ? part.replace(/_[0-9a-f]{32}$/, "") : part;
    structuredText(coordinate, 256, /^[\p{L}\p{M}0-9@+_.,=-]+$/u, true);
  }
}
function checksum(value) {
  shape(value, ["algorithm", "checksumValue"]);
  const length = { SHA1: 40, SHA256: 64, SHA512: 128, MD5: 32 }[value.algorithm];
  requireValid(length !== undefined, RejectionCode.CHECKSUM_ALGORITHM);
  text(value.checksumValue, length, /^[0-9a-f]+$/);
  requireValid(value.checksumValue.length === length, RejectionCode.CHECKSUM_LENGTH);
}
function checksums(value) {
  list(value, 4, 1);
  value.forEach(checksum);
  requireValid(new Set(value.map(item => item.algorithm)).size === value.length, RejectionCode.CHECKSUM_UNIQUE);
}
function externalRef(value, context, pkg) {
  shape(value, ["referenceCategory", "referenceType", "referenceLocator"]);
  text(value.referenceLocator, 512);
  if (value.referenceType === "purl") {
    requireValid(value.referenceCategory === "PACKAGE-MANAGER", RejectionCode.PURL_CATEGORY);
    // The root checksum and PURL must independently bind to the selected source.
    if (value.referenceLocator.startsWith("pkg:oci/")) {
      requireValid(pkg.primaryPackagePurpose === "CONTAINER", RejectionCode.OCI_PACKAGE);
      requireValid(pkg.name === context.sourceName, RejectionCode.OCI_SOURCE_NAME);
      const imageChecksum = pkg.checksums?.find(item => item.algorithm === "SHA256")?.checksumValue;
      requireValid(typeof imageChecksum === "string" && /^[0-9a-f]{64}$/.test(imageChecksum), RejectionCode.OCI_CHECKSUM);
      requireValid(imageChecksum === context.sbomDigest.slice(7), RejectionCode.OCI_ROOT_CHECKSUM);
      const locator = /^pkg:oci\/([^@?]+)@(sha256:[0-9a-f]{64})\?arch=([^&]*)(?:&tag=([^&]+))?$/.exec(value.referenceLocator);
      requireValid(locator !== null, RejectionCode.OCI_LOCATOR);
      requireValid(locator[1] === context.sourceName, RejectionCode.OCI_SOURCE_NAME);
      requireValid(locator[2] === context.sbomDigest, RejectionCode.OCI_PURL_DIGEST);
      // The archive provider in stereoscope v0.0.11 leaves arch empty; the saved config supplies the platform check.
      requireValid(locator[3] === (context.sourceKind === "docker-archive" ? "" : context.arch), RejectionCode.OCI_PURL_ARCH);
      requireValid(locator[4] === (context.sourceKind === "docker-archive" ? undefined : context.digest.slice(7)), RejectionCode.OCI_SOURCE_TAG);
      return;
    }
    // Parse delimiters before decoding components: %2f and %26 cannot create
    // a namespace or a second qualifier that was absent from the original purl.
    function component(raw) {
      const decoded = checkedOperation(RejectionCode.PURL_ENCODING, () => decodeURIComponent(raw));
      requireValid(!/[\/%?#&=]/.test(decoded) && !decoded.includes(".."), RejectionCode.PURL_COMPONENT);
      return decoded;
    }
    const match = /^pkg:(apk|npm|golang|generic)\/([^?#]+)(?:\?([^#]+))?(?:#([^?#]+))?$/.exec(value.referenceLocator);
    requireValid(match !== null, RejectionCode.PURL_GRAMMAR);
    const coordinate = match[2];
    const separator = coordinate.lastIndexOf("@");
    const versioned = separator > 0;
    requireValid(!versioned || separator < coordinate.length - 1, RejectionCode.PURL_VERSION);
    const name = (versioned ? coordinate.slice(0, separator) : coordinate).split("/").map(component).join("/");
    const version = versioned ? component(coordinate.slice(separator + 1)) : undefined;
    requireValid(name.split("/").every(part => part.length > 0 && part !== "." && part !== ".."), RejectionCode.PURL_NAME);
    structuredText(name, 200, /^@?[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/);
    referencePath(name.split("/"),
      match[1] === "npm" && tokenPackage(pkg) && name === pkg.name && version === pkg.versionInfo ? name.split("/") : []);
    if (version !== undefined) {
      packageVersion(version);
      referencePath([version]);
    }
    if (match[1] === "generic") {
      requireValid(embeddedRuntimes.has(name) && typeof version === "string" && semver.test(version), RejectionCode.RUNTIME_VERSION);
      requireValid(pkg.name === name && pkg.versionInfo === version, RejectionCode.RUNTIME_PACKAGE);
    }
    if (match[1] === "apk") requireValid(/^alpine\/[A-Za-z0-9._+-]+$/.test(name), RejectionCode.APK_NAME);
    if (match[1] === "npm") requireValid(/^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(name), RejectionCode.NPM_NAME);
    if (match[4] !== undefined) {
      requireValid(match[1] === "golang", RejectionCode.PURL_SUBPATH);
      const parts = match[4].split("/").map(component);
      structuredText(parts.join("/"), 200, /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/);
      referencePath(parts);
    }
    if (match[3] !== undefined) {
      const seen = new Set();
      for (const qualifier of match[3].split("&")) {
        const pair = /^([a-z_]+)=([^=]+)$/.exec(qualifier);
        requireValid(pair !== null && !seen.has(pair[1]), RejectionCode.PURL_QUALIFIER);
        seen.add(pair[1]);
        const key = pair[1];
        const entry = component(pair[2]);
        requireValid(/^[A-Za-z0-9._+-]+$/.test(entry), RejectionCode.PURL_QUALIFIER_VALUE);
        requireValid(match[1] === "apk" && ["arch", "distro", "epoch", "upstream"].includes(key), RejectionCode.PURL_QUALIFIER_KEY);
        safeText(entry, 100);
        if (key === "arch") requireValid([context.arch, context.arch === "amd64" ? "x86_64" : "aarch64", "all", "noarch"].includes(entry), RejectionCode.APK_ARCH);
        if (key === "distro") requireValid(/^alpine-[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(entry), RejectionCode.APK_DISTRO);
        if (key === "epoch") requireValid(/^[0-9]{1,6}$/.test(entry), RejectionCode.APK_EPOCH);
      }
    }
  } else {
    requireValid(value.referenceCategory === "SECURITY", RejectionCode.CPE_CATEGORY);
    requireValid(["cpe22Type", "cpe23Type"].includes(value.referenceType), RejectionCode.CPE_TYPE);
    const locator = value.referenceLocator;
    const parts = locator.match(/(?:\\.|[^:\\])+/g) ?? [];
    requireValid(parts.join(":") === locator, RejectionCode.CPE_GRAMMAR);
    if (value.referenceType === "cpe23Type") {
      requireValid(parts.length === 13 && parts[0] === "cpe" && parts[1] === "2.3", RejectionCode.CPE23_GRAMMAR);
    } else {
      requireValid(parts.length >= 4 && parts.length <= 8 && parts[0] === "cpe" && /^\/[aho]$/.test(parts[1]), RejectionCode.CPE22_GRAMMAR);
    }
    const offset = value.referenceType === "cpe23Type" ? 3 : 2;
    if (offset === 3) requireValid(["a", "h", "o"].includes(parts[2]), RejectionCode.CPE_PART);
    const decoded = parts.map(part => part.replace(/\\(.)/g, "$1"));
    const tokenCpe = offset === 3 && parts[2] === "a" && tokenPackage(pkg) &&
      decoded[5] === pkg.versionInfo && decoded.slice(6).every(part => part === "*") &&
      (pkg.name === "@tokenizer/token" ? [pkg.name, "Borewit"].includes(decoded[3]) && decoded[4] === pkg.name :
        ["token-types", "token_types", "token"].includes(decoded[3]) && ["token-types", "token_types"].includes(decoded[4]));
    for (const [index, part] of parts.entries()) {
      if (index < offset) continue;
      // CPE formatted strings escape punctuation, including Go subpaths and (devel).
      text(part, 200, /^(?:\*|-|(?:[A-Za-z0-9._-]|\\[\\!"#$%&'()+,/:;<=>?@[\]^`{|}~*-])+)$/);
      structuredText(part.replace(/\\(.)/g, "$1"), 200);
      // cookie, tokenizer and similar words are real npm products, not credentials.
      // Reject credential labels without rejecting every product containing them.
      requireValid(![part, normalizeIdentifiers(part)].some(spelling => /\b(?:password|passwd|authorization|credential|secret|api[ _-]?key|private[ _-]?key|access[ _-]?key)\b/i.test(spelling)), RejectionCode.CPE_SENSITIVE);
      const segments = decoded[index].split("/");
      referencePath(segments, tokenCpe && [3, 4].includes(index) ? segments : [], "cpe");
    }
    const language = parts[offset === 3 ? 8 : 7];
    if (language !== undefined) text(language, 15, /^(?:\*|-|[A-Za-z]{2,3}(?:-(?:[A-Za-z]{2}|[0-9]{3}))?)$/);
  }
}
function annotations(value) {
  // These Syft inventories have no annotations. No arbitrary text is uploadable here.
  list(value, 0);
}
function licenseId(value) {
  structuredText(value, 100, /^[A-Za-z0-9][A-Za-z0-9.-]*\+?$/);
  requireValid(!sensitiveTextPattern.test(value) && !sensitiveTextPattern.test(normalizeIdentifiers(value)), RejectionCode.LICENSE_SENSITIVE);
}
function licenseExpression(value, licenseIds) {
  text(value, 160, /^[A-Za-z0-9.()+ -]+$/);
  const tokens = value.match(/[A-Za-z0-9.-]+\+?|[()]/g) ?? [];
  requireValid(tokens.join("") === value.replaceAll(" ", ""), RejectionCode.LICENSE_TOKENS);
  requireValid(tokens.length > 0 && tokens.length <= 128, RejectionCode.LICENSE_TOKEN_BUDGET);
  requireValid(tokens.length === 1 || !tokens.some(token => ["NONE", "NOASSERTION"].includes(token)), RejectionCode.LICENSE_SENTINEL);
  let position = 0;
  function term() {
    const id = tokens[position++];
    licenseId(id);
    requireValid(!["AND", "OR", "WITH"].includes(id), RejectionCode.LICENSE_TERM);
    if (id.startsWith("LicenseRef-")) requireValid(licenseIds.has(id), RejectionCode.LICENSE_REFERENCE);
  }
  function atom() {
    if (tokens[position] === "(") {
      position++;
      expression();
      requireValid(tokens[position++] === ")", RejectionCode.LICENSE_PARENTHESES);
    } else {
      term();
      if (tokens[position] === "WITH") {
        position++;
        term();
      }
    }
  }
  function expression() {
    atom();
    while (["AND", "OR"].includes(tokens[position])) {
      position++;
      atom();
    }
  }
  expression();
  requireValid(position === tokens.length, RejectionCode.LICENSE_EXPRESSION);
}
function extractedLicenses(value) {
  const ids = new Set();
  if (value === undefined) return ids;
  list(value, 256);
  for (const item of value) {
    shape(item, ["licenseId", "extractedText"]);
    licenseId(item.licenseId);
    requireValid(/^LicenseRef-[A-Za-z0-9.-]+$/.test(item.licenseId) && !ids.has(item.licenseId), RejectionCode.EXTRACTED_LICENSE_ID);
    // Syft emits unrecognized license tokens here, not arbitrary license bodies.
    requireValid(item.extractedText === item.licenseId.slice("LicenseRef-".length), RejectionCode.EXTRACTED_LICENSE_TEXT);
    ids.add(item.licenseId);
  }
  return ids;
}
function optionalMetadata(value, licenseIds, inventory = false) {
  if (value.comment !== undefined) {
    if (inventory && typeof value.comment === "string" && value.comment.startsWith("layerID:")) {
      text(value.comment, 80, /^layerID: sha256:[0-9a-f]{64}$/);
    } else requireValid(false, RejectionCode.COMMENT);
  }
  if (value.copyrightText !== undefined) requireValid(["NOASSERTION", "NONE"].includes(value.copyrightText), RejectionCode.COPYRIGHT);
  for (const key of ["licenseConcluded", "licenseDeclared"]) {
    if (value[key] !== undefined) licenseExpression(value[key], licenseIds);
  }
  if (value.annotations !== undefined) annotations(value.annotations);
  if (value.checksums !== undefined) checksums(value.checksums);
}

function localIdentity(env) {
  exactDigest(env.LOCAL_IMAGE_ID);
  exactDigest(env.LOCAL_SBOM_DIGEST);
  requireValid(["docker-archive", "docker-daemon"].includes(env.LOCAL_IDENTITY_KIND), RejectionCode.LOCAL_IDENTITY_KIND);
  return env.LOCAL_SBOM_DIGEST;
}

export function jobContext(env = process.env, kong = false, mode = "images") {
  const name = env.IMAGE_NAME;
  const arch = env.TARGET_ARCH;
  const sha = env.GITHUB_SHA;
  requireValid((kong ? ["kong"] : applicationNames).includes(name) && architectures.includes(arch), RejectionCode.JOB_IMAGE_ARCH);
  requireValid({ X64: "amd64", ARM64: "arm64" }[env.RUNNER_ARCH] === arch, RejectionCode.JOB_RUNNER_ARCH);
  text(sha, 40, /^[0-9a-f]{40}$/);
  if (mode === "pr") {
    requireValid(!kong, RejectionCode.JOB_PR_KONG);
    const sbomDigest = localIdentity(env);
    return { name, arch, sha, mode, sbomDigest, sourceKind: env.LOCAL_IDENTITY_KIND, digest: env.LOCAL_IMAGE_ID,
      sourceName: `gromesh-${name}-${arch}-${sha}-${env.LOCAL_IMAGE_ID.slice(7)}` };
  }
  requireValid(mode === "images", RejectionCode.JOB_MODE);
  requireValid(env.PUBLISHED_SHA === sha && env.PUBLISHED_ARCH === arch, RejectionCode.PUBLISHED_CONTEXT);
  exactDigest(env.EXPECTED_DIGEST);
  text(env.GITHUB_REPOSITORY_OWNER, 39, /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/);
  const image = `ghcr.io/${env.GITHUB_REPOSITORY_OWNER.toLowerCase()}/gromesh-${name}:${kong ? "3.9.4-" : ""}${sha}-${arch}`;
  requireValid(env.PUBLISHED_IMAGE === image, RejectionCode.PUBLISHED_IMAGE);
  const sbomDigest = kong ? undefined : localIdentity(env);
  if (!kong) requireValid(env.PUBLISHED_CONFIG_ID === env.LOCAL_IMAGE_ID, RejectionCode.PUBLISHED_CONFIG);
  return { name, arch, sha, mode, sbomDigest, sourceKind: env.LOCAL_IDENTITY_KIND, digest: env.EXPECTED_DIGEST,
    sourceName: `gromesh-${name}-${arch}-${sha}-${env.EXPECTED_DIGEST.slice(7)}` };
}
function exactFile(directory, name, maximum) {
  const root = directoryPath(directory);
  const entries = checkedOperation(RejectionCode.FILE_ACCESS, () => readdirSync(root));
  requireValid(entries.length === 1 && entries[0] === name, RejectionCode.EXACT_FILE);
  return readRegularFile(join(root, name), maximum);
}
export function validateDigest(directory, context, kong = false) {
  exactDigest(context.digest);
  const name = kong ? `${context.arch}.txt` : `${context.name}-${context.arch}.txt`;
  const bytes = exactFile(directory, name, 72);
  const value = bytes.toString("utf8");
  requireValid(value === context.digest || value === `${context.digest}\n`, RejectionCode.DIGEST_CONTENT);
}
function parseSpdx(bytes) {
  // Accept Syft's indented JSON, but no alternate escapes, duplicate keys or discarded values.
  // Strip JSON whitespace only outside strings, preserving all uploaded string bytes for comparison.
  const source = bytes.toString("utf8");
  let compact = "";
  let quoted = false;
  let escaped = false;
  for (const char of source) {
    if (!quoted && /[ \t\r\n]/.test(char)) continue;
    compact += char;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
  }
  const doc = checkedOperation(RejectionCode.JSON_SYNTAX, () => JSON.parse(source));
  requireValid(JSON.stringify(doc) === compact, RejectionCode.JSON_CANONICAL);
  return doc;
}
export function validateSbom(directory, context) {
  const bytes = exactFile(directory, `gromesh-${context.name}-${context.arch}.spdx.json`, maximumSbomBytes);
  const doc = parseSpdx(bytes);
  shape(doc, ["spdxVersion", "dataLicense", "SPDXID", "name", "documentNamespace", "creationInfo", "packages", "relationships"],
    ["files", "documentDescribes", "comment", "annotations", "hasExtractedLicensingInfos"]);
  requireValid(doc.spdxVersion === "SPDX-2.3" && doc.dataLicense === "CC0-1.0" && doc.SPDXID === "SPDXRef-DOCUMENT", RejectionCode.SPDX_HEADER);
  // --source-name is set explicitly by the Syft step. Its image namespace adds a UUID-v4 suffix.
  requireValid(doc.name === context.sourceName, RejectionCode.SPDX_NAME);
  const prefix = `https://anchore.com/syft/image/${context.sourceName}-`;
  requireValid(typeof doc.documentNamespace === "string" && doc.documentNamespace.startsWith(prefix), RejectionCode.SPDX_NAMESPACE);
  text(doc.documentNamespace.slice(prefix.length), 36, new RegExp(`^${uuid}$`));
  shape(doc.creationInfo, ["created", "creators"], ["licenseListVersion"]);
  timestamp(doc.creationInfo.created);
  list(doc.creationInfo.creators, 2, 2);
  requireValid(creators.every(creator => doc.creationInfo.creators.includes(creator)), RejectionCode.SPDX_CREATORS);
  if (doc.creationInfo.licenseListVersion !== undefined) text(doc.creationInfo.licenseListVersion, 10, /^[0-9]{1,3}\.[0-9]{1,3}$/);
  const licenseIds = extractedLicenses(doc.hasExtractedLicensingInfos);
  optionalMetadata(doc, licenseIds);
  // Largest captured inventory: 154 packages, 952 files, 1,245 relationships.
  // Independent ~10x budgets permit growth without unbounded compact arrays.
  list(doc.packages, 2_000, 1);
  const ids = new Set([doc.SPDXID]);
  const packageIds = new Set();
  function register(id, fileName) {
    identifier(id, fileName);
    requireValid(!ids.has(id), RejectionCode.SPDX_ID_UNIQUE);
    ids.add(id);
  }
  for (const pkg of doc.packages) {
    shape(pkg, ["SPDXID", "name", "downloadLocation", "filesAnalyzed"], ["versionInfo", "sourceInfo", "licenseConcluded", "licenseDeclared", "copyrightText", "externalRefs", "checksums", "primaryPackagePurpose", "comment", "annotations", "description", "supplier", "originator", "packageVerificationCode", "homepage"]);
    register(pkg.SPDXID);
    packageIds.add(pkg.SPDXID);
    if (pkg.homepage !== undefined) {
      requireValid(Array.isArray(pkg.externalRefs) && pkg.externalRefs.some(ref => ref?.referenceType === "purl" && typeof ref.referenceLocator === "string" && ref.referenceLocator.startsWith("pkg:npm/")), RejectionCode.HOMEPAGE_PACKAGE);
      homepageLocation(pkg.homepage, pkg);
    }
    if (pkg.primaryPackagePurpose === "CONTAINER") requireValid(pkg.name === context.sourceName, RejectionCode.OCI_SOURCE_NAME);
    if (pkg.name === context.sourceName) {
      requireValid(pkg.versionInfo === context.sha, RejectionCode.ROOT_VERSION);
    } else {
      structuredText(pkg.name, 200, /^@?[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/);
      if (pkg.versionInfo !== undefined) packageVersion(pkg.versionInfo);
    }
    downloadLocation(pkg.downloadLocation, pkg);
    requireValid(typeof pkg.filesAnalyzed === "boolean", RejectionCode.FILES_ANALYZED);
    if (pkg.filesAnalyzed) {
      shape(pkg.packageVerificationCode, ["packageVerificationCodeValue"]);
      text(pkg.packageVerificationCode.packageVerificationCodeValue, 40, /^[0-9a-f]{40}$/);
    } else requireValid(pkg.packageVerificationCode === undefined, RejectionCode.VERIFICATION_CODE);
    if (pkg.description !== undefined) syftProse(pkg.description);
    for (const key of ["supplier", "originator"]) {
      if (pkg[key] !== undefined) {
        syftProse(pkg[key], true);
        requireValid(pkg[key] === "NOASSERTION" || /^(?:Person|Organization): [\p{L}\p{M}0-9 ._+@()/-]+$/u.test(pkg[key]), RejectionCode.PACKAGE_ATTRIBUTION);
      }
    }
    if (pkg.primaryPackagePurpose !== undefined) requireValid(["LIBRARY", "APPLICATION", "OPERATING-SYSTEM", "CONTAINER", "FILE"].includes(pkg.primaryPackagePurpose), RejectionCode.PACKAGE_PURPOSE);
    if (pkg.sourceInfo !== undefined) {
      text(pkg.sourceInfo, 600);
      const match = /^acquired package info from (APK DB|installed node module manifest file|go module information|the following paths): (.+)$/.exec(pkg.sourceInfo);
      requireValid(match !== null, RejectionCode.SOURCE_INFO);
      safeText(match[1], 60);
      imagePath(match[2], false, [pkg]);
    }
    optionalMetadata(pkg, licenseIds);
    if (pkg.externalRefs !== undefined) {
      list(pkg.externalRefs, 32);
      for (const ref of pkg.externalRefs) externalRef(ref, context, pkg);
    }
  }
  list(doc.relationships, 20_000, 1);
  {
    const roots = doc.packages.filter(pkg => pkg.name === context.sourceName);
    requireValid(roots.length === 1 && roots[0].primaryPackagePurpose === "CONTAINER", RejectionCode.ROOT_CONTAINER);
    requireValid(roots[0].externalRefs?.some(ref => ref.referenceType === "purl" && ref.referenceLocator.startsWith("pkg:oci/")), RejectionCode.ROOT_PURL);
    requireValid(doc.relationships.some(relation => relation?.spdxElementId === doc.SPDXID &&
      relation.relationshipType === "DESCRIBES" && relation.relatedSpdxElement === roots[0].SPDXID), RejectionCode.ROOT_DESCRIBES);
  }
  if (doc.files !== undefined) {
    list(doc.files, 10_000);
    const tokenPackages = doc.packages.filter(tokenPackage);
    for (const file of doc.files) {
      shape(file, ["SPDXID", "fileName", "checksums"], ["fileTypes", "licenseConcluded", "copyrightText", "comment", "annotations", "licenseInfoInFiles"]);
      register(file.SPDXID, file.fileName);
      imagePath(file.fileName, true, tokenPackages);
      optionalMetadata(file, licenseIds, true);
      if (file.licenseInfoInFiles !== undefined) {
        list(file.licenseInfoInFiles, 64, 1);
        for (const license of file.licenseInfoInFiles) licenseExpression(license, licenseIds);
      }
      if (file.fileTypes !== undefined) {
        list(file.fileTypes, 3, 1);
        requireValid(file.fileTypes.every(type => ["SOURCE", "BINARY", "ARCHIVE", "APPLICATION", "TEXT", "OTHER"].includes(type)), RejectionCode.FILE_TYPES);
      }
    }
  }
  if (doc.documentDescribes !== undefined) {
    list(doc.documentDescribes, doc.packages.length, 1);
    requireValid(doc.documentDescribes.every(id => packageIds.has(id)), RejectionCode.DOCUMENT_DESCRIBES);
  }
  let describes = false;
  for (const relation of doc.relationships) {
    shape(relation, ["spdxElementId", "relatedSpdxElement", "relationshipType"], ["comment"]);
    if (relation.comment !== undefined) {
      requireValid(relation.relationshipType === "OTHER" && relation.comment === "evident-by: indicates the package's existence is evident by the given file", RejectionCode.RELATION_COMMENT);
    }
    requireValid(ids.has(relation.spdxElementId) && ids.has(relation.relatedSpdxElement), RejectionCode.RELATION_REFERENCE);
    requireValid(["DESCRIBES", "CONTAINS", "DEPENDENCY_OF", "DEPENDS_ON", "OTHER"].includes(relation.relationshipType), RejectionCode.RELATION_TYPE);
    if (relation.relationshipType === "DESCRIBES" && relation.spdxElementId === doc.SPDXID && packageIds.has(relation.relatedSpdxElement)) describes = true;
  }
  requireValid(describes, RejectionCode.ROOT_DESCRIBES);
}
export function validateSupplyChain({ command, workspace, temporary, env = process.env }) {
  return rejectionArtifact(command === "kong-digest" ? "digest" : "sbom", () => {
    requireValid(command === "images" || command === "kong-digest" || command === "pr", RejectionCode.SUPPLY_COMMAND);
    requireValid(typeof workspace === "string" && workspace.length > 0, RejectionCode.WORKSPACE_REQUIRED);
    if (command !== "pr") requireValid(typeof temporary === "string" && temporary.length > 0, RejectionCode.TEMPORARY_REQUIRED);
    const kong = command === "kong-digest";
    const context = jobContext(env, kong, command === "pr" ? "pr" : "images");
    // Inspect both independent artifacts before rejecting; CI must upload neither on any failure.
    const failures = [];
    const inspect = (artifact, action) => {
      try { rejectionArtifact(artifact, action); } catch (error) { failures.push(error); }
    };
    if (!kong) inspect("sbom", () => validateSbom(join(directoryPath(workspace), "dist", "sbom"), context));
    if (command !== "pr") inspect("digest", () => validateDigest(join(directoryPath(temporary), kong ? "kong-digests" : "digests"), context, kong));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures);
  });
}
if (import.meta.main) {
  try {
    requireValid(process.argv.length === 3, RejectionCode.CLI_ARGUMENTS);
    validateSupplyChain({ command: process.argv[2], workspace: process.env.GITHUB_WORKSPACE,
      temporary: process.env.RUNNER_TEMP });
  } catch (error) {
    for (const rejection of error instanceof AggregateError ? error.errors : [error]) console.error(rejectionLine(rejection, { artifact: process.argv[2] === "kong-digest" ? "digest" : "sbom", mode: process.argv[2] }));
    process.exitCode = 1;
  }
}
