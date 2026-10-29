// node --test e2e/kind/n2/components/scrub.test.mjs — the evidence redaction of the N2 suites, without a lab.
import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubKong } from "./scrub.mjs";

const TOKEN = "07c59ec0-184e-4a73-9987-1a60e07d2d49";
const LINE = `2026/10/28 03:30:36 [notice] 508#0: [lua] init.lua:794: init(): [request-debug] token for request debugging: ${TOKEN}`;

test("the request-debug token Kong prints is redacted, the rest of the line kept for diagnosis", () => {
  const out = scrubKong(LINE);
  assert.ok(!out.includes(TOKEN));
  assert.ok(out.endsWith("token for request debugging: REDACTED"));
  assert.ok(out.startsWith("2026/10/28 03:30:36 [notice] 508#0: [lua] init.lua:794"));
});

test("a token cut by a truncation is redacted too (truncation may come before the redaction)", () => {
  for (const cut of [8, 20, 35]) {
    const truncated = LINE.slice(0, LINE.length - (36 - cut));
    const out = scrubKong(truncated);
    assert.ok(!out.includes(TOKEN.slice(0, cut)), `${cut} characters of the token left`);
    assert.ok(out.endsWith("REDACTED"));
  }
});

test("inside JSON (results.json): every occurrence redacted and the document still parses", () => {
  const doc = JSON.stringify({ logs: [LINE, LINE.slice(0, -10)], other: "uuid 11111111-1111-4111-8111-111111111111 stays" }, null, 2);
  const out = scrubKong(doc);
  assert.ok(!out.includes(TOKEN.slice(0, 8)));
  const parsed = JSON.parse(out);
  assert.equal(parsed.logs.filter((l) => l.endsWith("REDACTED")).length, 2);
  assert.equal(parsed.other, "uuid 11111111-1111-4111-8111-111111111111 stays");
});

test("negative control: the former 36-character pattern let a truncated token through", () => {
  const former = (text) => String(text).replace(/(token for request debugging: )[0-9a-f-]{36}/g, "$1REDACTED");
  const truncated = LINE.slice(0, -10);
  assert.ok(former(truncated).includes(TOKEN.slice(0, 20)));
  assert.ok(!scrubKong(truncated).includes(TOKEN.slice(0, 20)));
});
