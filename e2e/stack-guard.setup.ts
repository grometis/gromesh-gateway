import { assertStack } from "../scripts/stack-guard.mjs";

// Before any spec writes, prove disposable container, volume and endpoint ownership.
export default async function globalSetup() {
  await assertStack("acceptance");
}
