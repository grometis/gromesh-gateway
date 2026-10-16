# Checklist de segurança do MVP

Gerado por `e2e/security-checklist.sh` em 2026-10-16T14:18:10Z contra o compose (`http://127.0.0.1:5174`, `http://127.0.0.1:3000/api/v1`).

| Id | Verificação | Resultado | Evidência |
| --- | --- | --- | --- |
| H1 | CSP restritiva (default-src 'none', frame-ancestors 'none') | PASS | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'` |
| H2 | X-Frame-Options: DENY | PASS |  |
| H3 | X-Content-Type-Options: nosniff | PASS |  |
| H4 | Referrer-Policy presente | PASS | strict-origin-when-cross-origin |
| H5 | HSTS ausente em HTTP (ligado só atrás de TLS) | PASS |  |
| C1 | Cookie de sessão HttpOnly + SameSite=Strict | PASS |  |
| C2 | Cookie Secure (compose sem TLS: COOKIE_SECURE=false; o chart exige TLS ou insecureCookies explícito) | NOTE | Set-Cookie: gromesh_session=tM7MZgbu9rEjzNnv2dEq0t-9rwnLf9jjy9z6Cx4AMRE; Max-Age=28800; Path=/; HttpOnly; SameSite=Strict |
| C3 | Sem token no corpo do login | PASS |  |
| C4 | Mutação sem X-CSRF-Token → 403 | PASS |  |
| C5 | Sem cookie → 401 | PASS |  |
| R1 | Matriz RBAC gerada do contrato (apps/control-plane/test/integration/auth.test.ts) | PASS | coberta por `pnpm test` na CI |
| S1 | Segredo de plugin devolvido como REDACTED | PASS |  |
| S2 | Chave key-auth só na criação; depois só keyHint | PASS |  |
| S3 | Envelope do snapshot redigido para admin | PASS |  |
| S4 | Audit sem segredos | PASS |  |
| S5 | Segredos cifrados em repouso (credenciais, plugins, snapshots) | PASS |  |
| L1 | Pipeline de logs sem credenciais (deploy/observability/acceptance.mjs) | PASS | Acceptance OK: {"kongRows":5,"syntheticRows":3,"elapsedMs":2179,"prometheus":"OK |
| L2 | Log do control plane sem segredos nem senhas | PASS |  |
| I1 | Imagens sem CRITICAL (Trivy) e SBOM (syft) | PASS | scripts/scan-images.sh |
| A1 | CVE-2026-1907 (RPC de clustering, modo híbrido) | NOTE | não se aplica: data planes em DB-less sem clustering do Kong |
| A2 | Imagem própria Kong 3.9.4 (build próprio, fixada por digest) | PASS | ghcr.io/grometis/gromesh-kong@sha256:3293c2e49633c91fa838dbd3eaaa9d534b83d7dbcc7cc84ff341ccee2156fd40 |

Falhas: 0.
