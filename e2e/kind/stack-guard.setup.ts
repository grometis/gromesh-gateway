import { assertKindStack } from '../../scripts/kind-stack-guard.mjs';
export default async function setup() { await assertKindStack('acceptance'); }
