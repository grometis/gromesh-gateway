#!/usr/bin/env bash
set -euo pipefail
pnpm --filter @gromesh/ui gen:api
git diff --exit-code -- apps/ui/src/api/schema.d.ts apps/ui/src/api/schema-v2.d.ts
