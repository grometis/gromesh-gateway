// What the N2 suites redact from every file they leave, importable without a lab (scrub.test.mjs).
/**
 * Kong prints a fresh request-debug token at start; anyone reaching that proxy could turn on request debugging with it.
 * Any length after the prefix: a text the suites truncated may hold only part of the token.
 */
export const scrubKong = (text) => String(text).replace(/(token for request debugging: ?)[0-9a-fA-F-]+/g, "$1REDACTED");
