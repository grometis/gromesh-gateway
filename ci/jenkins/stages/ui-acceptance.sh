#!/usr/bin/env bash
set -euo pipefail
pnpm --filter @gromesh/ui exec playwright install chromium
pnpm --filter @gromesh/ui test:e2e
