import { expect, it } from "vitest";
import { validateTrustedCopyStorageSettings } from "./trusted-copy-storage.js";
const fixture = () => ({ url: "http://127.0.0.1:8123", databaseName: "trusted_copies",
  writer: { user: "writer", password: "1".repeat(48) }, reader: { user: "reader", password: "2".repeat(48) }, auditor: { user: "auditor", password: "3".repeat(48) } });
it("accepts only distinct dedicated credentials", () => { expect(() => validateTrustedCopyStorageSettings(fixture())).not.toThrow(); });
it.each(["reader", "auditor"] as const)("rejects a %s secret shared with the writer", kind => {
  const value = fixture(); value[kind].password = value.writer.password;
  expect(() => validateTrustedCopyStorageSettings(value)).toThrow();
});
it("does not allow URL credentials, remote plaintext or adoption of the legacy database", () => {
  for (const value of [{ ...fixture(), url: "http://user:secret@127.0.0.1:8123" }, { ...fixture(), url: "http://remote.invalid:8123" }, { ...fixture(), databaseName: "gromesh" }])
    expect(() => validateTrustedCopyStorageSettings(value)).toThrow();
});
