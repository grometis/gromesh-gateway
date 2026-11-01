import { assertStack } from "../../../../scripts/stack-guard.mjs";

// Before any spec writes: an isolated run (GROMESH_STACK_ISOLATED=1) must target only its own compose project.
export default async function setup() {
  await assertStack("acceptance");
}
