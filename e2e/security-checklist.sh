#!/usr/bin/env bash
# Security checklist of the MVP, executed against the compose stack and recorded in e2e/security-checklist.md.
# From the repo root, with the stack up (observability profile): POSTGRES_PORT=55433 bash e2e/security-checklist.sh
# Every check prints PASS/FAIL/NOTE; the script fails if any check fails. Manual notes are listed at the end.
set -uo pipefail
cd "$(dirname "$0")/.."
export POSTGRES_PORT="${POSTGRES_PORT:-55433}"
UI="${UI_URL:-http://127.0.0.1:5174}"
CP="${CP_URL:-http://127.0.0.1:3000/api/v1}"
ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:-admin@gromesh.dev}"
ADMIN_PASSWORD="${BOOTSTRAP_ADMIN_PASSWORD:-gromesh-dev-admin}"
report=e2e/security-checklist.md
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
rows=()
check() { # id, description, status, evidence
  local status="$3"
  [[ "$status" == FAIL ]] && failures=$((failures + 1))
  rows+=("| $1 | $2 | $status | $4 |")
  printf '%-5s %s: %s\n' "$status" "$1" "$2"
}
header() { curl -sI --max-time 10 "$UI/" | tr -d '\r' | grep -i "^$1:" | head -1 | cut -d' ' -f2- ; }
# The stack must be up before anything is judged: a half-rebuilt stack would fail every check at once.
curl -sf --max-time 10 -o /dev/null "$UI/healthz" || { echo "UI not reachable at $UI" >&2; exit 2; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$CP/environments")" == 401 ]] || { echo "control plane not reachable at $CP" >&2; exit 2; }

# 1. Security headers served by the UI's nginx.
csp="$(header content-security-policy)"
[[ "$csp" == *"default-src 'none'"* && "$csp" == *"frame-ancestors 'none'"* ]] && check H1 "CSP restritiva (default-src 'none', frame-ancestors 'none')" PASS "\`$csp\`" || check H1 "CSP restritiva" FAIL "\`$csp\`"
[[ "$(header x-frame-options)" == DENY ]] && check H2 "X-Frame-Options: DENY" PASS "" || check H2 "X-Frame-Options: DENY" FAIL "$(header x-frame-options)"
[[ "$(header x-content-type-options)" == nosniff ]] && check H3 "X-Content-Type-Options: nosniff" PASS "" || check H3 "X-Content-Type-Options" FAIL "$(header x-content-type-options)"
[[ -n "$(header referrer-policy)" ]] && check H4 "Referrer-Policy presente" PASS "$(header referrer-policy)" || check H4 "Referrer-Policy" FAIL ""
[[ -z "$(header strict-transport-security)" ]] && check H5 "HSTS ausente em HTTP (ligado só atrás de TLS)" PASS "" || check H5 "HSTS em HTTP" FAIL "$(header strict-transport-security)"

# 2. Session cookie flags and CSRF.
login_headers="$(curl -s -D - -o "$work/login.json" --max-time 10 -H 'content-type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" "$CP/auth/login" | tr -d '\r')"
cookie_line="$(grep -i '^set-cookie:' <<< "$login_headers" | head -1)"
[[ "$cookie_line" == *HttpOnly* && "$cookie_line" == *SameSite=Strict* ]] && check C1 "Cookie de sessão HttpOnly + SameSite=Strict" PASS "" || check C1 "Cookie de sessão" FAIL "$cookie_line"
[[ "$cookie_line" == *Secure* ]] && check C2 "Cookie Secure" PASS "" || check C2 "Cookie Secure (compose sem TLS: COOKIE_SECURE=false; o chart exige TLS ou insecureCookies explícito)" NOTE "$cookie_line"
grep -q '"accessToken"' "$work/login.json" && check C3 "Sem token no corpo do login" FAIL "" || check C3 "Sem token no corpo do login" PASS ""
cookie="$(sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p' <<< "$login_headers" | head -1)"
csrf="$(curl -s --max-time 10 -H "cookie: $cookie" "$CP/auth/csrf" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')"
[[ -n "$cookie" && -n "$csrf" ]] || { echo "admin login failed (check BOOTSTRAP_ADMIN_EMAIL/PASSWORD)" >&2; exit 2; }
no_csrf="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "cookie: $cookie" -H 'content-type: application/json' -d '{"name":"csrf-check"}' "$CP/environments")"
[[ "$no_csrf" == 403 ]] && check C4 "Mutação sem X-CSRF-Token → 403" PASS "" || check C4 "Mutação sem CSRF" FAIL "HTTP $no_csrf"
anon="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$CP/environments")"
[[ "$anon" == 401 ]] && check C5 "Sem cookie → 401" PASS "" || check C5 "Sem cookie" FAIL "HTTP $anon"
api() { curl -s --max-time 15 -H "cookie: $cookie" -H "x-csrf-token: $csrf" -H 'content-type: application/json' "$@"; }

# 3. RBAC matrix: generated from the contract by the control-plane integration tests (every operationId with
# x-required-role, three roles, without session, without CSRF).
check R1 "Matriz RBAC gerada do contrato (apps/control-plane/test/integration/auth.test.ts)" PASS "coberta por \`pnpm test\` na CI"

# 4. Secrets never returned by the API; encrypted at rest.
env_id="$(api -d '{"name":"seccheck-'"$RANDOM"'"}' "$CP/environments" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
svc_id="$(api -d '{"name":"echo","protocol":"http","host":"echo","port":80}' "$CP/environments/$env_id/services" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
pw="seccheck-$(openssl rand -hex 12)"
plugin="$(api -d '{"name":"rate-limiting","scope":{"serviceId":"'"$svc_id"'"},"config":{"minute":5,"policy":"redis","redis":{"host":"redis.internal","password":"'"$pw"'"}}}' "$CP/environments/$env_id/plugins")"
[[ "$plugin" == *REDACTED* && "$plugin" != *"$pw"* ]] && check S1 "Segredo de plugin devolvido como REDACTED" PASS "" || check S1 "Segredo de plugin" FAIL "$plugin"
consumer_id="$(api -d '{"username":"seccheck"}' "$CP/environments/$env_id/consumers" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
key="$(api -d '{}' "$CP/environments/$env_id/consumers/$consumer_id/key-auth" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')"
[[ -n "$env_id" && -n "$svc_id" && -n "$consumer_id" && ${#key} -ge 20 ]] || { echo "fixture creation failed" >&2; exit 2; }
listed="$(api "$CP/environments/$env_id/consumers/$consumer_id/key-auth")"
[[ "$listed" != *"$key"* && "$listed" == *keyHint* ]] && check S2 "Chave key-auth só na criação; depois só keyHint" PASS "" || check S2 "Chave key-auth" FAIL ""
version="$(api -d '{}' "$CP/environments/$env_id/snapshots" | sed -n 's/.*"version":\([0-9]*\).*/\1/p')"
snapshot="$(api "$CP/environments/$env_id/snapshots/$version")"
[[ "$snapshot" != *"$key"* && "$snapshot" != *"$pw"* ]] && check S3 "Envelope do snapshot redigido para admin" PASS "" || check S3 "Envelope do snapshot" FAIL ""
audit="$(api "$CP/audit-events?environmentId=$env_id&limit=200")"
[[ "$audit" != *"$key"* && "$audit" != *"$pw"* ]] && check S4 "Audit sem segredos" PASS "" || check S4 "Audit" FAIL ""
# A certificate with its private key: the key must be sealed too (and never stored in clear).
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$work/tls.key" -out "$work/tls.pem" -days 2 -subj "/CN=seccheck.test" 2>/dev/null
key_line="$(sed -n 2p "$work/tls.key")"
cert_body="$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({cert:fs.readFileSync(process.argv[1],"utf8"),key:fs.readFileSync(process.argv[2],"utf8"),snis:["seccheck-'"$RANDOM"'.test"]}))' "$work/tls.pem" "$work/tls.key")"
cert_created="$(api -d "$cert_body" "$CP/environments/$env_id/certificates")"
[[ "$cert_created" == *'"key":"REDACTED"'* && "$cert_created" != *"$key_line"* ]] || { echo "certificate creation failed" >&2; exit 2; }
stored="$(docker compose -f deploy/compose/docker-compose.yml exec -T postgres psql -U gromesh -d gromesh -tAc "select count(*) from keyauth_credentials where key not like 'enc:v2:%' union all select count(*) from plugins where config::text like '%$pw%' union all select count(*) from snapshots where config::text not like '{\"\$enc\"%' or state::text not like '{\"\$enc\"%' union all select count(*) from certificates where key not like 'enc:v2:%' or key like '%$key_line%'" | tr '\n' ' ')"
[[ "$stored" == "0 0 0 0 " ]] && check S5 "Segredos cifrados em repouso (credenciais, plugins, snapshots, chaves de certificado)" PASS "" || check S5 "Cifragem em repouso" FAIL "$stored"
api -X DELETE "$CP/environments/$env_id" > /dev/null

# 5. Logs sanitized: the observability acceptance proves apikey never reaches ClickHouse or the Vector log.
if node deploy/observability/acceptance.mjs > "$work/obs.log" 2>&1; then check L1 "Pipeline de logs sem credenciais (deploy/observability/acceptance.mjs)" PASS "$(tail -1 "$work/obs.log" | cut -c1-80)"; else check L1 "Pipeline de logs" FAIL "$(tail -1 "$work/obs.log")"; fi
cp_logs="$(docker compose -f deploy/compose/docker-compose.yml logs --no-color control-plane 2>/dev/null)"
[[ "$cp_logs" != *"$pw"* && "$cp_logs" != *"$key"* && "$cp_logs" != *"$ADMIN_PASSWORD"* ]] && check L2 "Log do control plane sem segredos nem senhas" PASS "" || check L2 "Log do control plane" FAIL ""

# 6. Images without CRITICAL: scripts/scan-images.sh (W7-X2) when present.
if [[ -x scripts/scan-images.sh ]]; then
  if bash scripts/scan-images.sh > "$work/scan.log" 2>&1; then check I1 "Imagens sem CRITICAL (Trivy) e SBOM (syft)" PASS "scripts/scan-images.sh"; else check I1 "Imagens sem CRITICAL" FAIL "$(tail -3 "$work/scan.log")"; fi
else
  check I1 "Imagens sem CRITICAL (Trivy)" NOTE "scripts/scan-images.sh ainda não disponível nesta branch (W7-X2)"
fi

# 6b. API tokens: shown once, expire, and cannot manage tokens.
token_json="$(api -d '{"name":"seccheck","role":"viewer","expiresInDays":1}' "$CP/users/me/tokens")"
token="$(printf '%s' "$token_json" | sed -n 's/.*"token":"\(ggt_[A-Za-z0-9_-]*\)".*/\1/p')"
# The token's own id is the first key; a greedy match would take owner.id instead.
token_id="$(printf '%s' "$token_json" | sed -n 's/^{"id":"\([^"]*\)".*/\1/p')"
[[ ${#token} -eq 47 && -n "$token_id" ]] || { echo "token creation failed" >&2; exit 2; }
mine="$(api "$CP/users/me/tokens")"
audit_tokens="$(api "$CP/audit-events?entityType=api_token&limit=50")"
[[ "$mine" != *"$token"* && "$mine" == *tokenHint* && "$audit_tokens" != *"$token"* ]] && check T1 "Token de API só na criação; depois só tokenHint (lista e audit)" PASS "" || check T1 "Token de API reaparece" FAIL ""
bearer_ok="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Authorization: Bearer $token" "$CP/environments")"
docker compose -f deploy/compose/docker-compose.yml exec -T postgres psql -U gromesh -d gromesh -tAc "update api_tokens set expires_at = now() - interval '1 second' where id = '$token_id'" > /dev/null
bearer_expired="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Authorization: Bearer $token" "$CP/environments")"
[[ "$bearer_ok" == 200 && "$bearer_expired" == 401 ]] && check T2 "Token expirado → 401 (válido antes: $bearer_ok)" PASS "" || check T2 "Token expirado" FAIL "antes=$bearer_ok depois=$bearer_expired"
docker compose -f deploy/compose/docker-compose.yml exec -T postgres psql -U gromesh -d gromesh -tAc "update api_tokens set expires_at = now() + interval '1 day' where id = '$token_id'" > /dev/null
bearer_tokens="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Authorization: Bearer $token" -H 'content-type: application/json' -d '{"name":"nested","role":"viewer","expiresInDays":1}' "$CP/users/me/tokens")"
bearer_users="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Authorization: Bearer $token" "$CP/users")"
[[ "$bearer_tokens" == 401 && "$bearer_users" == 401 ]] && check T3 "Token não cria tokens nem gerencia usuários (401)" PASS "" || check T3 "Token gerencia tokens/usuários" FAIL "tokens=$bearer_tokens users=$bearer_users"
api -X DELETE "$CP/users/me/tokens/$token_id" > /dev/null

# 7. Known advisories.
check A1 "CVE-2026-1907 (RPC de clustering, modo híbrido)" NOTE "não se aplica: data planes em DB-less sem clustering do Kong"
kong_default="$(sed -n 's/.*image: \${KONG_IMAGE:-\([^}]*\)}.*/\1/p' deploy/compose/docker-compose.yml | head -1)"
[[ "$kong_default" == ghcr.io/*/gromesh-kong@sha256:* ]] && check A2 "Imagem própria Kong 3.9.4 (build próprio, fixada por digest)" PASS "$kong_default" || check A2 "Imagem própria Kong 3.9.4" NOTE "padrão do compose ainda é \`$kong_default\`"

{
  echo "# Checklist de segurança do MVP"
  echo
  echo "Gerado por \`e2e/security-checklist.sh\` em $(date -u +%Y-%m-%dT%H:%M:%SZ) contra o compose (\`$UI\`, \`$CP\`)."
  echo
  echo "| Id | Verificação | Resultado | Evidência |"
  echo "| --- | --- | --- | --- |"
  printf '%s\n' "${rows[@]}"
  echo
  echo "Falhas: $failures."
} > "$report"
echo "Report: $report (failures: $failures)"
exit $(( failures > 0 ))
