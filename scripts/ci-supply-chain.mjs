import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { directoryPath, readRegularFile, requireValid } from "./ci-evidence.mjs";

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

function exactDigest(value) {
  requireValid(typeof value === "string" && value.length === 71 && digestPattern.test(value));
}
function shape(value, required, optional = []) {
  requireValid(value !== null && typeof value === "object" && !Array.isArray(value));
  // Every object is closed, so sensitive names (even with innocuous values) cannot add a channel.
  requireValid(Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
  requireValid(required.every(key => Object.hasOwn(value, key)));
}
function list(value, maximum, minimum = 0) {
  requireValid(Array.isArray(value) && value.length >= minimum && value.length <= maximum);
}
function text(value, maximum, pattern, unicode = false) {
  requireValid(typeof value === "string" && value.length > 0 && value.length <= maximum);
  requireValid((unicode ? /^[\x20-\x7e\p{L}\p{M}]+$/u : /^[\x20-\x7e]+$/).test(value) && !credentialPattern.test(value));
  if (pattern) requireValid(pattern.test(value));
}
function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  return [...counts.values()].reduce((sum, n) => sum - (n / value.length) * Math.log2(n / value.length), 0);
}
function safeText(value, maximum = 160) {
  text(value, maximum, /^[A-Za-z0-9 .,():/+_@=*~-]+$/);
  requireValid(!sensitiveTextPattern.test(value));
  requireValid(!value.includes("://") && !value.includes(".."));
  // Free text is never exempt just because it resembles a hash/base64 string.
  for (const word of value.match(/[A-Za-z0-9_+/=-]+/g) ?? []) {
    requireValid(word.length < 32 && (word.length < 20 || entropy(word) < 3.5));
  }
  requireValid(value.length < 32 || entropy(value) < 4.5);
}
function syftProse(value, unicode = false) {
  text(value, 160, /^[\p{L}\p{M}0-9 .,():/+_@=*~`'"!?&;[\]-]+$/u, unicode);
  requireValid(!value.includes("://") && !value.includes(".."));
  // Project descriptions legitimately mention cookie parsing and tokenizers. Reject
  // credential words/phrases, and short encoded credential markers regardless of entropy.
  requireValid(!/\b(?:password|passwd|authorization|credentials?|api[ _-]?key|private[ _-]?key|access[ _-]?key|bearer|secret)\b/i.test(value));
  const terminology = value.replace(/\btoken types\b/ig, "types")
    .replace(/\bdefinition for [a-z0-9-]+ token$/ig, "definition")
    .replace(/\bcookie parsing\b/ig, "parsing");
  requireValid(!/\b(?:token|cookie)\b/i.test(terminology));
  for (const encoded of value.match(/[A-Za-z0-9+/_-]{8,}={0,2}/g) ?? []) {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    requireValid(!sensitiveTextPattern.test(decoded) && !credentialPattern.test(decoded));
  }
  for (const word of value.match(/[\p{L}\p{M}0-9_+/=-]+/gu) ?? []) {
    // Descriptions contain camelCase API identifiers; comments keep the stricter 3.5 budget.
    requireValid(word.length < 32 && (word.length < 20 || entropy(word) < 4));
  }
  // Author names plus email addresses naturally have high whole-string entropy;
  // their individual words and credential patterns remain bounded above.
}
function structuredText(value, maximum, pattern, unicode = false) {
  text(value, maximum, pattern, unicode);
  requireValid(!value.includes(".."));
  // Package/path separators carry structure. Apply token budgets to their components,
  // while comments/annotations keep the stricter whole-value budget in safeText.
  for (const word of value.split(/[/.@+_:=~-]+/).filter(Boolean)) {
    requireValid(word.length < 32 && (word.length < 20 || entropy(word) < 3.5));
  }
}
function packageVersion(value, maximum = 100) {
  if (value === "(devel)") return;
  structuredText(value, maximum, /^[A-Za-z0-9._+~-]+$/);
}
function downloadRef(value) {
  text(value, 100, /^[A-Za-z0-9._+-]+$/);
  requireValid(!sensitiveTextPattern.test(value) && !value.includes(".."));
  if (/^[0-9a-f]{7,40}$/.test(value)) return;
  // Numeric release tags include v1.2.3, release-1.2.3 and upstream's libidn2.
  // Unstructured words and opaque high-entropy fragments are not refs.
  requireValid(semver.test(value.replace(/^v/, "")) || /^(?:[A-Za-z][A-Za-z_-]{0,39})?[0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(value));
  structuredText(value, 100);
}
function githubRepository(value) {
  structuredText(value, 141, /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\/[A-Za-z0-9._-]+$/);
  const [owner, repo] = value.split("/");
  requireValid(owner.length <= 39 && repo.length <= 100 && repo !== "." && repo !== "..");
}
function downloadHost(value) {
  text(value, 253, /^[a-z0-9.-]+$/);
  const labels = value.split(".");
  requireValid(labels.length >= 2 && isIP(value) === 0 && /[a-z]/.test(labels.at(-1)));
  for (const label of labels) {
    requireValid(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) && !label.startsWith("xn--"));
    requireValid(!/(?:^|-)(?:password|passwd|authorization|cookie|credentials?|secrets?|api-?key|private-?key|access-?key|token|bearer|synthetic)(?:-|$)/i.test(label));
    requireValid(label.length < 20 || entropy(label) < 3.5);
  }
}
function downloadLocation(value) {
  if (["NOASSERTION", "NONE"].includes(value)) return;
  text(value, 512);
  if (!value.includes("://")) {
    const shorthand = /^(?:github:)?([^#]+)(?:#([^#]+))?$/.exec(value);
    requireValid(shorthand !== null);
    githubRepository(shorthand[1]);
    if (shorthand[2] !== undefined) downloadRef(shorthand[2]);
    return;
  }
  // Parse the raw spelling first: URL normalizes traversal, empty queries,
  // default ports and hostname case, which must not hide rejected input.
  const match = /^(https|http|git|git\+https|git\+ssh):\/\/([a-z0-9.-]+)(?::([0-9]+))?(\/[A-Za-z0-9._!@+/-]*)?(?:#([^#]+))?$/.exec(value);
  requireValid(match !== null);
  downloadHost(match[2]);
  const defaults = { https: "443", http: "80", git: "9418", "git+https": "443", "git+ssh": "22" };
  requireValid(match[3] === undefined || match[3] === defaults[match[1]]);
  const url = new URL(value);
  requireValid(!url.username && !url.password && !url.search && url.hostname === match[2]);
  const path = match[4] ?? "";
  structuredText(path || "/", 400, /^\/[A-Za-z0-9._!@+/-]*$/);
  const parts = path.replace(/^\//, "").replace(/\/$/, "").split("/");
  requireValid(path === "" || path === "/" || parts.every(part => part.length > 0 && part !== "."));
  for (const part of parts) {
    requireValid(!/^(?:password|passwd|authorization|cookie|credential|secret|api[_-]?key|private[_-]?key|access[_-]?key|token|bearer)$/i.test(part));
  }
  if (match[5] !== undefined) downloadRef(match[5]);
}
function homepageLocation(value) {
  text(value, 512, /^https?:\/\//);
  // npm's repository landing-page anchor is metadata, not a download ref.
  downloadLocation(value.endsWith("#readme") ? value.slice(0, -7) : value);
}
function identifier(value, fileName) {
  // Syft appends a 16-hex ID hash to the file path. Validate these separately only
  // when that prefix matches the actual fileName: Irkutsk-<hash> is not an sk- key.
  // Credentials in the filename or in an unrelated ID still hit the original detector.
  const prefix = typeof fileName === "string" ? `SPDXRef-File-${fileName.replaceAll("/", "-")}-` : undefined;
  if (prefix && typeof value === "string" && value.startsWith(prefix) && /^[0-9a-f]{16}$/.test(value.slice(prefix.length))) {
    requireValid(value.length <= 200);
    text(value.slice(0, -17), 183, /^SPDXRef-[A-Za-z0-9.-]+$/);
    text(value.slice(-16), 16, /^[0-9a-f]{16}$/);
  } else text(value, 200, /^SPDXRef-[A-Za-z0-9.-]+$/);
}
function timestamp(value) {
  text(value, 20, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
  const parsed = Date.parse(value);
  requireValid(Number.isFinite(parsed) && new Date(parsed).toISOString() === value.replace("Z", ".000Z"));
}
function imagePath(value, inventory = false) {
  text(value, 512, /^\/?[\p{L}\p{M}0-9@+_.,/=-]+$/u, true);
  const parts = value.replace(/^\//, "").split("/");
  requireValid(parts.every(part => part !== ".." && part !== "." && part.length > 0));
  // Only image filesystem roots, never runner mounts, home directories, credentials or host paths.
  requireValid(["app", "usr", "bin", "sbin", "lib", "lib64", "etc", "opt", "var", "gromesh", "gromesh-agent"].includes(parts[0]));
  // The public image inventory includes the standard account database path, never its contents.
  // This exception is only for file metadata, not sourceInfo or arbitrary shadow paths.
  requireValid((inventory && ["etc/shadow", "/etc/shadow"].includes(value)) || !/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.aws|\.ssh|\.docker|credentials|secrets?|shadow|gshadow|kubeconfig)(?:\/|$)/i.test(value));
  requireValid(!/(?:^|\/)(?:home|Users|runner|github|host|proc|sys|dev|mnt)(?:\/|$)/.test(value));
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
  requireValid(length !== undefined);
  text(value.checksumValue, length, /^[0-9a-f]+$/);
  requireValid(value.checksumValue.length === length);
}
function checksums(value) {
  list(value, 4, 1);
  value.forEach(checksum);
  requireValid(new Set(value.map(item => item.algorithm)).size === value.length);
}
function externalRef(value, context, pkg) {
  shape(value, ["referenceCategory", "referenceType", "referenceLocator"]);
  text(value.referenceLocator, 512);
  if (value.referenceType === "purl") {
    requireValid(value.referenceCategory === "PACKAGE-MANAGER");
    // Syft reports the platform manifest with containerd, the config with classic Docker.
    if (value.referenceLocator.startsWith("pkg:oci/")) {
      requireValid(pkg.name === context.sourceName && pkg.primaryPackagePurpose === "CONTAINER");
      const imageChecksum = pkg.checksums?.find(item => item.algorithm === "SHA256")?.checksumValue;
      requireValid(typeof imageChecksum === "string" && /^[0-9a-f]{64}$/.test(imageChecksum));
      requireValid(imageChecksum === context.sbomDigest.slice(7));
      requireValid(value.referenceLocator === `pkg:oci/${context.sourceName}@sha256:${imageChecksum}?arch=${context.arch}&tag=${context.digest.slice(7)}`);
      return;
    }
    // Parse delimiters before decoding components: %2f and %26 cannot create
    // a namespace or a second qualifier that was absent from the original purl.
    function component(raw) {
      const decoded = decodeURIComponent(raw);
      requireValid(!/[\/%?#&=]/.test(decoded) && !decoded.includes(".."));
      return decoded;
    }
    const match = /^pkg:(apk|npm|golang|generic)\/([^?#]+)(?:\?([^#]+))?(?:#([^?#]+))?$/.exec(value.referenceLocator);
    requireValid(match !== null);
    const coordinate = match[2];
    const separator = coordinate.lastIndexOf("@");
    const versioned = separator > 0;
    requireValid(!versioned || separator < coordinate.length - 1);
    const name = (versioned ? coordinate.slice(0, separator) : coordinate).split("/").map(component).join("/");
    const version = versioned ? component(coordinate.slice(separator + 1)) : undefined;
    requireValid(name.split("/").every(part => part.length > 0 && part !== "." && part !== ".."));
    structuredText(name, 200, /^@?[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/);
    if (version !== undefined) packageVersion(version);
    if (match[1] === "generic") {
      requireValid(embeddedRuntimes.has(name) && typeof version === "string" && semver.test(version));
      requireValid(pkg.name === name && pkg.versionInfo === version);
    }
    if (match[1] === "apk") requireValid(/^alpine\/[A-Za-z0-9._+-]+$/.test(name));
    if (match[1] === "npm") requireValid(/^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(name));
    if (match[4] !== undefined) {
      requireValid(match[1] === "golang");
      structuredText(match[4].split("/").map(component).join("/"), 200, /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/);
    }
    if (match[3] !== undefined) {
      const seen = new Set();
      for (const qualifier of match[3].split("&")) {
        const pair = /^([a-z_]+)=([^=]+)$/.exec(qualifier);
        requireValid(pair !== null && !seen.has(pair[1]));
        seen.add(pair[1]);
        const key = pair[1];
        const entry = component(pair[2]);
        requireValid(/^[A-Za-z0-9._+-]+$/.test(entry));
        requireValid(match[1] === "apk" && ["arch", "distro", "epoch", "upstream"].includes(key));
        safeText(entry, 100);
        if (key === "arch") requireValid([context.arch, context.arch === "amd64" ? "x86_64" : "aarch64", "all", "noarch"].includes(entry));
        if (key === "distro") requireValid(/^alpine-[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(entry));
        if (key === "epoch") requireValid(/^[0-9]{1,6}$/.test(entry));
      }
    }
  } else {
    requireValid(value.referenceCategory === "SECURITY");
    requireValid(["cpe22Type", "cpe23Type"].includes(value.referenceType));
    const locator = value.referenceLocator;
    const parts = locator.match(/(?:\\.|[^:\\])+/g) ?? [];
    requireValid(parts.join(":") === locator);
    if (value.referenceType === "cpe23Type") {
      requireValid(parts.length === 13 && parts[0] === "cpe" && parts[1] === "2.3");
    } else {
      requireValid(parts.length >= 4 && parts.length <= 8 && parts[0] === "cpe" && /^\/[aho]$/.test(parts[1]));
    }
    const offset = value.referenceType === "cpe23Type" ? 3 : 2;
    if (offset === 3) requireValid(["a", "h", "o"].includes(parts[2]));
    for (const part of parts.slice(offset)) {
      // CPE formatted strings escape punctuation, including Go subpaths and (devel).
      text(part, 200, /^(?:\*|-|(?:[A-Za-z0-9._-]|\\[\\!"#$%&'()+,/:;<=>?@[\]^`{|}~*-])+)$/);
      structuredText(part.replace(/\\(.)/g, "$1"), 200);
      // cookie, tokenizer and similar words are real npm products, not credentials.
      // Reject credential labels without rejecting every product containing them.
      requireValid(!/^(?:password|passwd|authorization|credential|secret|api[_-]?key|private[_-]?key|access[_-]?key)$/i.test(part));
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
  requireValid(!sensitiveTextPattern.test(value));
}
function licenseExpression(value, licenseIds) {
  text(value, 160, /^[A-Za-z0-9.()+ -]+$/);
  const tokens = value.match(/[A-Za-z0-9.-]+\+?|[()]/g) ?? [];
  requireValid(tokens.join("") === value.replaceAll(" ", ""));
  requireValid(tokens.length > 0 && tokens.length <= 128);
  requireValid(tokens.length === 1 || !tokens.some(token => ["NONE", "NOASSERTION"].includes(token)));
  let position = 0;
  function term() {
    const id = tokens[position++];
    licenseId(id);
    requireValid(!["AND", "OR", "WITH"].includes(id));
    if (id.startsWith("LicenseRef-")) requireValid(licenseIds.has(id));
  }
  function atom() {
    if (tokens[position] === "(") {
      position++;
      expression();
      requireValid(tokens[position++] === ")");
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
  requireValid(position === tokens.length);
}
function extractedLicenses(value) {
  const ids = new Set();
  if (value === undefined) return ids;
  list(value, 256);
  for (const item of value) {
    shape(item, ["licenseId", "extractedText"]);
    licenseId(item.licenseId);
    requireValid(/^LicenseRef-[A-Za-z0-9.-]+$/.test(item.licenseId) && !ids.has(item.licenseId));
    // Syft emits unrecognized license tokens here, not arbitrary license bodies.
    requireValid(item.extractedText === item.licenseId.slice("LicenseRef-".length));
    ids.add(item.licenseId);
  }
  return ids;
}
function optionalMetadata(value, licenseIds, inventory = false) {
  if (value.comment !== undefined) {
    if (inventory && value.comment.startsWith("layerID:")) {
      text(value.comment, 80, /^layerID: sha256:[0-9a-f]{64}$/);
    } else requireValid(false);
  }
  if (value.copyrightText !== undefined) requireValid(["NOASSERTION", "NONE"].includes(value.copyrightText));
  for (const key of ["licenseConcluded", "licenseDeclared"]) {
    if (value[key] !== undefined) licenseExpression(value[key], licenseIds);
  }
  if (value.annotations !== undefined) annotations(value.annotations);
  if (value.checksums !== undefined) checksums(value.checksums);
}

function localIdentity(env) {
  exactDigest(env.LOCAL_IMAGE_ID);
  exactDigest(env.LOCAL_SBOM_DIGEST);
  requireValid(["classic-config", "containerd-manifest"].includes(env.LOCAL_IDENTITY_KIND));
  if (env.LOCAL_IDENTITY_KIND === "classic-config") requireValid(env.LOCAL_SBOM_DIGEST === env.LOCAL_IMAGE_ID);
  return env.LOCAL_SBOM_DIGEST;
}

export function jobContext(env = process.env, kong = false, mode = "images") {
  const name = env.IMAGE_NAME;
  const arch = env.TARGET_ARCH;
  const sha = env.GITHUB_SHA;
  requireValid((kong ? ["kong"] : applicationNames).includes(name) && architectures.includes(arch));
  requireValid({ X64: "amd64", ARM64: "arm64" }[env.RUNNER_ARCH] === arch);
  text(sha, 40, /^[0-9a-f]{40}$/);
  if (mode === "pr") {
    requireValid(!kong);
    const sbomDigest = localIdentity(env);
    return { name, arch, sha, mode, sbomDigest, digest: env.LOCAL_IMAGE_ID,
      sourceName: `gromesh-${name}-${arch}-${sha}-${env.LOCAL_IMAGE_ID.slice(7)}` };
  }
  requireValid(mode === "images");
  requireValid(env.PUBLISHED_SHA === sha && env.PUBLISHED_ARCH === arch);
  exactDigest(env.EXPECTED_DIGEST);
  text(env.GITHUB_REPOSITORY_OWNER, 39, /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/);
  const image = `ghcr.io/${env.GITHUB_REPOSITORY_OWNER.toLowerCase()}/gromesh-${name}:${kong ? "3.9.4-" : ""}${sha}-${arch}`;
  requireValid(env.PUBLISHED_IMAGE === image);
  const sbomDigest = kong ? undefined : localIdentity(env);
  if (!kong) requireValid(env.PUBLISHED_CONFIG_ID === env.LOCAL_IMAGE_ID);
  return { name, arch, sha, mode, sbomDigest, digest: env.EXPECTED_DIGEST,
    sourceName: `gromesh-${name}-${arch}-${sha}-${env.EXPECTED_DIGEST.slice(7)}` };
}
function exactFile(directory, name, maximum) {
  const root = directoryPath(directory);
  const entries = readdirSync(root);
  requireValid(entries.length === 1 && entries[0] === name);
  return readRegularFile(join(root, name), maximum);
}
export function validateDigest(directory, context, kong = false) {
  exactDigest(context.digest);
  const name = kong ? `${context.arch}.txt` : `${context.name}-${context.arch}.txt`;
  const bytes = exactFile(directory, name, 72);
  const value = bytes.toString("utf8");
  requireValid(value === context.digest || value === `${context.digest}\n`);
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
  const doc = JSON.parse(source);
  requireValid(JSON.stringify(doc) === compact);
  return doc;
}
export function validateSbom(directory, context) {
  const bytes = exactFile(directory, `gromesh-${context.name}-${context.arch}.spdx.json`, maximumSbomBytes);
  const doc = parseSpdx(bytes);
  shape(doc, ["spdxVersion", "dataLicense", "SPDXID", "name", "documentNamespace", "creationInfo", "packages", "relationships"],
    ["files", "documentDescribes", "comment", "annotations", "hasExtractedLicensingInfos"]);
  requireValid(doc.spdxVersion === "SPDX-2.3" && doc.dataLicense === "CC0-1.0" && doc.SPDXID === "SPDXRef-DOCUMENT");
  // --source-name is set explicitly by the Syft step. Its image namespace adds a UUID-v4 suffix.
  requireValid(doc.name === context.sourceName);
  const prefix = `https://anchore.com/syft/image/${context.sourceName}-`;
  requireValid(typeof doc.documentNamespace === "string" && doc.documentNamespace.startsWith(prefix));
  text(doc.documentNamespace.slice(prefix.length), 36, new RegExp(`^${uuid}$`));
  shape(doc.creationInfo, ["created", "creators"], ["licenseListVersion"]);
  timestamp(doc.creationInfo.created);
  list(doc.creationInfo.creators, 2, 2);
  requireValid(creators.every(creator => doc.creationInfo.creators.includes(creator)));
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
    requireValid(!ids.has(id));
    ids.add(id);
  }
  for (const pkg of doc.packages) {
    shape(pkg, ["SPDXID", "name", "downloadLocation", "filesAnalyzed"], ["versionInfo", "sourceInfo", "licenseConcluded", "licenseDeclared", "copyrightText", "externalRefs", "checksums", "primaryPackagePurpose", "comment", "annotations", "description", "supplier", "originator", "packageVerificationCode", "homepage"]);
    register(pkg.SPDXID);
    packageIds.add(pkg.SPDXID);
    if (pkg.homepage !== undefined) {
      requireValid(pkg.externalRefs?.some(ref => ref.referenceType === "purl" && ref.referenceLocator.startsWith("pkg:npm/")));
      homepageLocation(pkg.homepage);
    }
    if (pkg.name === context.sourceName) {
      requireValid(pkg.versionInfo === context.sha);
    } else {
      structuredText(pkg.name, 200, /^@?[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/);
      if (pkg.versionInfo !== undefined) packageVersion(pkg.versionInfo);
    }
    downloadLocation(pkg.downloadLocation);
    requireValid(typeof pkg.filesAnalyzed === "boolean");
    if (pkg.filesAnalyzed) {
      shape(pkg.packageVerificationCode, ["packageVerificationCodeValue"]);
      text(pkg.packageVerificationCode.packageVerificationCodeValue, 40, /^[0-9a-f]{40}$/);
    } else requireValid(pkg.packageVerificationCode === undefined);
    if (pkg.description !== undefined) syftProse(pkg.description);
    for (const key of ["supplier", "originator"]) {
      if (pkg[key] !== undefined) {
        syftProse(pkg[key], true);
        requireValid(pkg[key] === "NOASSERTION" || /^(?:Person|Organization): [\p{L}\p{M}0-9 ._+@()/-]+$/u.test(pkg[key]));
      }
    }
    if (pkg.primaryPackagePurpose !== undefined) requireValid(["LIBRARY", "APPLICATION", "OPERATING-SYSTEM", "CONTAINER", "FILE"].includes(pkg.primaryPackagePurpose));
    if (pkg.sourceInfo !== undefined) {
      text(pkg.sourceInfo, 600);
      const match = /^acquired package info from (APK DB|installed node module manifest file|go module information|the following paths): (.+)$/.exec(pkg.sourceInfo);
      requireValid(match !== null);
      safeText(match[1], 60);
      imagePath(match[2]);
    }
    optionalMetadata(pkg, licenseIds);
    if (pkg.externalRefs !== undefined) {
      list(pkg.externalRefs, 32);
      for (const ref of pkg.externalRefs) externalRef(ref, context, pkg);
    }
  }
  {
    const roots = doc.packages.filter(pkg => pkg.name === context.sourceName);
    requireValid(roots.length === 1 && roots[0].primaryPackagePurpose === "CONTAINER");
    requireValid(roots[0].externalRefs?.some(ref => ref.referenceType === "purl" && ref.referenceLocator.startsWith("pkg:oci/")));
    requireValid(doc.relationships.some(relation => relation.spdxElementId === doc.SPDXID &&
      relation.relationshipType === "DESCRIBES" && relation.relatedSpdxElement === roots[0].SPDXID));
  }
  if (doc.files !== undefined) {
    list(doc.files, 10_000);
    for (const file of doc.files) {
      shape(file, ["SPDXID", "fileName", "checksums"], ["fileTypes", "licenseConcluded", "copyrightText", "comment", "annotations", "licenseInfoInFiles"]);
      register(file.SPDXID, file.fileName);
      imagePath(file.fileName, true);
      optionalMetadata(file, licenseIds, true);
      if (file.licenseInfoInFiles !== undefined) {
        list(file.licenseInfoInFiles, 64, 1);
        for (const license of file.licenseInfoInFiles) licenseExpression(license, licenseIds);
      }
      if (file.fileTypes !== undefined) {
        list(file.fileTypes, 3, 1);
        requireValid(file.fileTypes.every(type => ["SOURCE", "BINARY", "ARCHIVE", "APPLICATION", "TEXT", "OTHER"].includes(type)));
      }
    }
  }
  if (doc.documentDescribes !== undefined) {
    list(doc.documentDescribes, doc.packages.length, 1);
    requireValid(doc.documentDescribes.every(id => packageIds.has(id)));
  }
  list(doc.relationships, 20_000, 1);
  let describes = false;
  for (const relation of doc.relationships) {
    shape(relation, ["spdxElementId", "relatedSpdxElement", "relationshipType"], ["comment"]);
    if (relation.comment !== undefined) {
      requireValid(relation.relationshipType === "OTHER" && relation.comment === "evident-by: indicates the package's existence is evident by the given file");
    }
    requireValid(ids.has(relation.spdxElementId) && ids.has(relation.relatedSpdxElement));
    requireValid(["DESCRIBES", "CONTAINS", "DEPENDENCY_OF", "DEPENDS_ON", "OTHER"].includes(relation.relationshipType));
    if (relation.relationshipType === "DESCRIBES" && relation.spdxElementId === doc.SPDXID && packageIds.has(relation.relatedSpdxElement)) describes = true;
  }
  requireValid(describes);
}
export function validateSupplyChain({ command, workspace, temporary, env = process.env }) {
  requireValid(command === "images" || command === "kong-digest" || command === "pr");
  requireValid(typeof workspace === "string" && workspace.length > 0);
  if (command !== "pr") requireValid(typeof temporary === "string" && temporary.length > 0);
  const kong = command === "kong-digest";
  const context = jobContext(env, kong, command === "pr" ? "pr" : "images");
  // Publication checks both artifacts; PRs check only the local inventory, with the same content rules.
  if (!kong) validateSbom(join(directoryPath(workspace), "dist", "sbom"), context);
  if (command !== "pr") validateDigest(join(directoryPath(temporary), kong ? "kong-digests" : "digests"), context, kong);
}
if (import.meta.main) {
  try {
    requireValid(process.argv.length === 3);
    validateSupplyChain({ command: process.argv[2], workspace: process.env.GITHUB_WORKSPACE,
      temporary: process.env.RUNNER_TEMP });
  } catch {
    console.error("CI supply chain rejected.");
    process.exitCode = 1;
  }
}
