#!/usr/bin/env bash
# Local schema/mock plans only. This command has no apply, SDK provisioning or cloud credential input.
set -euo pipefail
cd -- "$(dirname -- "$0")"
export TF_IN_AUTOMATION=1 TF_INPUT=0 CHECKPOINT_DISABLE=1
unset SCW_SECRET_KEY SCW_ACCESS_KEY SCW_DEFAULT_PROJECT_ID SCW_DEFAULT_ORGANIZATION_ID SCW_PROFILE
terraform init -backend=false -input=false -lockfile=readonly
terraform fmt -check -recursive
terraform validate
terraform test -no-color
