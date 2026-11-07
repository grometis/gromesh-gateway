#!/usr/bin/env bash
set -euo pipefail
require_disposable_worker() {
  [[ "${JENKINS_URL:-}" == 'https://jenkins.grometis.com/' ]] || return 78
  [[ "${GROMESH_CI_RUN:-}" =~ ^[a-f0-9]{32}$ ]] || return 78
  [[ "${DOCKER_HOST:-}" =~ ^unix:///run/user/[1-9][0-9]*/docker.sock$ ]] || return 78
  [[ "${GROMESH_CI_STATE:-}" == "/tmp/gromesh-jenkins-${GROMESH_CI_RUN}" ]] || return 78
  [[ "${KUBECONFIG:-}" != *gromesh-n2* ]] || return 78
}
compose_environment() {
  require_disposable_worker || exit 78
  umask 077
  mkdir -p "$GROMESH_CI_STATE"
  export GROMESH_DISPOSABLE_ID="$GROMESH_CI_RUN"
  export COMPOSE_PROJECT_NAME="gromesh-test-${GROMESH_CI_RUN}"
  export COMPOSE_FILE="$PWD/deploy/compose/docker-compose.yml:$PWD/deploy/compose/disposable.yml"
  for key in POSTGRES_PASSWORD BOOTSTRAP_ADMIN_PASSWORD CLICKHOUSE_PASSWORD CLICKHOUSE_READER_PASSWORD CLICKHOUSE_WRITER_PASSWORD GROMESH_COLLECTOR_TOKEN; do
    export "$key=$(openssl rand -hex 24)"
  done
  export GROMESH_ENCRYPTION_KEY="ci:$(openssl rand -base64 32)" GROMESH_FINGERPRINT_KEY="$(openssl rand -base64 32)"
  export BOOTSTRAP_ADMIN_EMAIL=jenkins-ci@example.test POSTGRES_PORT=55442 CLICKHOUSE_PORT=18124 KONG_VALIDATOR_PORT=18012
  export UI_URL=http://127.0.0.1:5174 CP_URL=http://127.0.0.1:3000/api/v1 CLICKHOUSE_URL=http://127.0.0.1:18124
  export KONG_PROXY_URL=http://127.0.0.1:8000 KONG_STATUS_URL=http://127.0.0.1:8100/status/ready KONG_METRICS_URL=http://127.0.0.1:8100
  export ECHO_URL=http://127.0.0.1:8080 KONG_VALIDATOR_URL=http://127.0.0.1:18012 KONG_PROXY_TLS_PORT=8443
}
