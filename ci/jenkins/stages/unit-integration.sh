#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/checks-start.sh"
pnpm test:guard
pnpm exec turbo run test --concurrency=1
node --test e2e/kind/n2/components/budgets.test.mjs e2e/kind/n2/components/scrub.test.mjs e2e/kind/n2/components/privileged.test.mjs
