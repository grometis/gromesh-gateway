# Tarefas — semanas 1 a 8

Duas frentes em paralelo: **[Claude]** = Claude Code, **[Codex]** = Codex. Cada tarefa = 1 branch + 1 PR + 1 worktree.
Pronto = teste de aceite verde no CI + checklist de `CLAUDE.md`. Revisão cruzada: o PR do Claude é revisado pelo Codex e vice-versa.

Já entregue (base): contratos em `contracts/`, `packages/compiler` (compile, hash, diff, snapshot, 12 testes), compose com Kong 3.9 DB-less, `scripts/smoke.mjs`, CI.

**MVP fechado (W8-C2):** o aceite final roda em kind (`e2e/kind/run.sh`, job `mvp-e2e`): instalar via Helm → login do admin → service + route + key-auth + rate-limiting → publicar → cluster converge → tráfego no dashboard → rollback → audit. O checklist de segurança executado está em `e2e/security-checklist.md` (`e2e/security-checklist.sh`). Pendências atreladas ao repositório no GitHub: imagem própria Kong 3.9.4, catálogo regenerado, compose com a imagem própria e digests nos charts (parte remota da W7-X2).

```bash
# uma worktree por frente, a partir da main
git worktree add ../gg-claude -b task/W1-C1-control-plane-skeleton
git worktree add ../gg-codex  -b task/W1-X1-kong-image
```

| ID | Frente | Depende de | Diretórios permitidos |
| --- | --- | --- | --- |
| W1-C1 | Claude | — | `apps/control-plane/`, `deploy/compose/` |
| W1-X1 | Codex | — | `images/kong/`, `.github/workflows/` |
| W2-C1 | Claude | W1-C1 | `apps/control-plane/` |
| W2-C2 | Claude | W2-C1 | `apps/control-plane/` |
| W2-X1 | Codex | — | `apps/agent/` |
| W3-C1 | Claude | — (usa mock do contrato) | `apps/ui/` |
| W3-X1 | Codex | W2-C1, W2-X1 | `apps/control-plane/src/agent-gateway/`, `apps/control-plane/src/clusters/`, `apps/control-plane/drizzle/`, `apps/control-plane/src/db/schema.ts`, `deploy/compose/` |
| W3-X2 | Codex | W3-C1, W3-X1 | `e2e/`, `.github/workflows/` |
| W4-C1 | Claude | — | `apps/ui/` (exceto `pages/Snapshots*`, `pages/Clusters*`) |
| W4-X1 | Codex | — | `apps/ui/src/pages/Snapshots*`, `apps/ui/src/pages/Clusters*`, `apps/ui/src/components/Diff*`, `apps/ui/e2e/`, entradas dessas páginas em `router.tsx` |
| W4-C2 | Claude | W4-C1 | `apps/control-plane/src/plugins/`, `apps/control-plane/src/plugin-catalog/`, `apps/ui/src/schema-form/`, testes |
| W5-C0 | Claude | — | `contracts/` (PR de contrato, antes de W5-C1/W5-X1) |
| W5-C1 | Claude | W5-C0 | `apps/control-plane/` (exceto `src/audit/`) |
| W5-X1 | Codex | W5-C0 | `apps/control-plane/src/audit/`, `apps/ui/`, `apps/ui/nginx.conf` |
| W6-X1 | Codex | — | `packages/compiler/` (só opções de plugins de plataforma), `deploy/compose/`, `deploy/observability/` |
| W6-C0 | Claude | W6-X1 (schema da tabela) | `contracts/` |
| W6-C1 | Claude | W6-C0 | `apps/control-plane/src/analytics/`, `apps/ui/` |
| W6-C2 | Claude | W6-X1, W6-C1 | `packages/compiler/`, `apps/control-plane/src/snapshots/`, `apps/control-plane/src/config.ts`, `deploy/compose/`, `deploy/observability/`, `deploy/helm/data-plane/` (só collector), `e2e/` |
| W7-X1 | Codex | — | `deploy/helm/data-plane/`, `.github/workflows/` (job helm-dp) |
| W7-C1 | Codex | W7-X1 | `deploy/helm/control-plane/`, `.github/workflows/` (jobs helm-cp e helm-e2e) |
| W7-X2 | Codex | repositório no GitHub | `apps/*/Dockerfile`, `images/`, `.github/workflows/` (jobs de imagem) |
| W8-C1 | Claude | — | `apps/control-plane/` (crypto, migração), `packages/compiler/` só se precisar |
| W8-X1 | Codex | W7-X1, W7-C1 | `tests/load/`, `deploy/helm/*/templates/backup*`, `scripts/` |
| W8-C2 | Claude | todas | `e2e/`, `.github/workflows/`, `TASKS.md` |
| B1 | Codex | W8-C2 | `deploy/compose/`, `deploy/observability/`, `deploy/helm/data-plane/`, `packages/compiler/` (só opções do `platformPlugins`), `e2e/` (spec novo) |
| P1-C0 | Claude | — | `contracts/` (+ `apps/ui/src/api/schema.d.ts` gerado) |
| P1-C1 | Claude | P1-C0 | `apps/control-plane/`, `apps/ui/`, `e2e/security-checklist.*`, `contracts/` (só remover `x-gromesh-planned`) |
| P1-X1 | Codex | — | `apps/agent/`, `deploy/helm/data-plane/`, `deploy/compose/`, `e2e/kind/` |
| P1-X2 | Codex | P1-X1 | `.github/workflows/`, `e2e/kind/`, `deploy/helm/`, `deploy/compose/` |
| P2-C0 | Claude | — | `contracts/` (+ `apps/ui/src/api/schema.d.ts` gerado e rótulos de tipo da UI) |
| P2-C1 | Claude | P2-C0 | `apps/control-plane/`, `packages/compiler/`, `e2e/security-checklist.*`, `contracts/` (só remover `x-gromesh-planned`) |
| P2-C2 | Claude | P2-C1 | `apps/ui/` |
| P2-X1 | Codex | — | `deploy/observability/`, `deploy/helm/data-plane/files/vector/`, `e2e/` |
| P2-X2 | Codex | P2-X1 | `apps/control-plane/src/tokens/`, `apps/control-plane/src/auth/` (só o limitador), testes correspondentes |
| P3-C0 | Claude | — | `contracts/` (+ `apps/ui/src/api/schema.d.ts` gerado e rótulos de tipo da UI) |
| P3-C1 | Claude | P3-C0 | `apps/control-plane/`, `packages/compiler/`, `apps/ui/`, `e2e/security-checklist.*`, `contracts/` (só remover `x-gromesh-planned`) |
| P3-X1 | Codex | — | `apps/control-plane/src/auth/`, `apps/control-plane/test/`, `scripts/` (só o gerador, se precisar) |

Ordem de merge na semana 3: W2-C2 → W3-X1 → W3-C1 → W3-X2. Quem mergeia depois faz rebase; `src/db/schema.ts` e `drizzle/` são alterados por uma frente por vez.

Ordem de merge: semana 4 → W4-C1 antes de W4-X1 (W4-X1 faz rebase em `router.tsx`); W4-C2 mergeia antes de começar a semana 5. Semana 5 → W5-C0 → W5-C1 → W5-X1, todos na branch `integration/w5-auth` (criada da `main`), que entra na `main` num único merge quando a CI inteira estiver verde; a `main` é mergeada nela, nunca o contrário. Semana 6 → W6-X1 → W6-C0 → W6-C1 → W6-C2 (antes da W8-C2). Semanas 7 e 8 → W7-X1 e W7-C1 em paralelo (charts diferentes), depois o job conjunto em kind; W7-X2 assim que o repositório estiver no GitHub; W8-C1 em paralelo; W8-X1 depois dos charts; W8-C2 por último.

**Pré-requisito (decisão do Fabrício):** repositório privado no GitHub com a `main` publicada. Sem isso, o build da imagem Kong 3.9.4, o CI e o job em kind não rodam de verdade.

---

## Semana 1

### W1-C1 [Claude] Esqueleto do control plane ponta a ponta — FEITO (branch `task/W1-C1-control-plane-skeleton`)
Objetivo: uma rota criada pela API chega ao Kong e uma requisição atravessa até o backend `echo`.

- NestJS em `apps/control-plane` (pacote `@gromesh/control-plane`), Drizzle + Postgres do compose, porta 3000, prefixo `/api/v1`.
- Tabelas: `environments`, `services`, `routes`, `snapshots` (version, hash, config jsonb, createdAt, createdBy), `audit_events`.
- Endpoints do contrato: environments, services, routes e `POST /environments/{envId}/snapshots` (publicar).
- Publicar = ler o estado → `buildSnapshot()` do `@gromesh/compiler` → gravar → **temporário**: `POST {KONG_ADMIN_URL}/config` direto (removido em W3-X1).
- Auth ainda não existe: um guard "dev user" (role admin) já plugado onde o RBAC real vai entrar. Toda mutação grava audit event.
- Erros RFC 9457; `CompileError.issues` vira `errors[]` com status 422.
- Adicionar `control-plane` ao compose (migrações na subida, depende de `postgres` e `kong` saudáveis).

Aceite: `apps/control-plane/test/e2e/walking-skeleton.e2e-spec.ts` — cria environment → service `echo` (host `echo`, porta 80) → route `/echo` → publica → `GET http://127.0.0.1:8000/echo` responde 200 com `Hostname` no corpo. Rodar no CI (job novo após `smoke`).

### W1-X1 [Codex] Imagem própria do Kong 3.9.4
Objetivo: não depender da imagem oficial (parada na 3.9.3, sem a correção da CVE-2026-1907).

- `images/kong/Dockerfile` multi-stage: build da tag `3.9.4` do `github.com/Kong/kong` com o sistema de build oficial (Bazel, `make build-release` / pacote deb) e runtime Ubuntu 24.04 mínimo, usuário não-root, `kong` no PATH.
- Plugins próprios futuros entram por `images/kong/plugins/` (copiados para o LUA_PATH); por enquanto vazio.
- Workflow `.github/workflows/kong-image.yml`: `workflow_dispatch` + tag `kong-v*`; cache do Bazel; push para GHCR `gromesh-kong:3.9.4-<sha>`; scan Trivy que falha em CRITICAL.

Aceite: no workflow, `docker run <img> kong version` imprime `3.9.4` e `KONG_IMAGE=<img> docker compose up -d --wait kong echo && node scripts/smoke.mjs` passa.

---

## Semana 2

### W2-C1 [Claude] Publicação completa
- Versão monotônica por environment; publicar com hash igual ao atual → 409 "nothing to publish".
- `expectedCurrentVersion` (409 se desatualizado), `message`, `createdBy`.
- `GET /publish-preview` (rascunho compilado × atual com `diffConfigs`), `GET /snapshots`, `GET /snapshots/{v}`, `GET /snapshots/{v}/diff?against=`.
- `POST /snapshots/{v}/rollback`: restaura o rascunho ao estado da versão e publica como versão nova (`rollbackOf`). Para isso, o snapshot guarda também o `GatewayState` de origem (coluna `state jsonb`).
- `publishMode: auto`: publica sozinho 3 s após a última edição (debounce por environment, seguro com várias réplicas: lock no Postgres).
- `hasUnpublishedChanges` e `currentVersion` no environment.

Aceite: testes de integração com Postgres real cobrindo publicar, 409 sem mudança, diff, rollback criando versão nova e auto-publish.

### W2-C2 [Claude] Consumers, credenciais e plugins
- CRUD de consumers; key-auth com chave gerada (32 bytes base64url) mostrada só na criação, `keyHint` nas leituras, nunca em logs/audit.
- CRUD de plugins com escopo (global, service, route, consumer) e unicidade (nome + escopo) → 409.
- Catálogo: `GET /plugin-schemas` e `/plugin-schemas/{name}` servidos de arquivos JSON versionados em `apps/control-plane/src/plugin-catalog/kong-3.9/`, gerados por um script que lê `GET /schemas/plugins/{name}` de um Kong de referência (o do compose). Marcar `supportedInDbless: false` para `oauth2`.
- Validação de `config` delegada ao próprio Kong: `POST {KONG_VALIDATOR_URL}/schemas/plugins/validate` (o Kong do compose em dev; em produção, um Kong DB-less sem tráfego junto do control plane). Erros do Kong viram `errors[]` 422.

Aceite: testes de integração: plugin `rate-limiting` válido é criado; `config.minute = "abc"` → 422 com path; segundo `key-auth` na mesma rota → 409; a chave completa aparece só no 201.

### W2-X1 [Codex] Agente em Go
Implementa `contracts/agent-protocol.openapi.yaml` do lado do cliente.
- Config por env: `GROMESH_CP_URL`, `GROMESH_REGISTRATION_TOKEN`, `GROMESH_NODE_ID` (default: hostname), `KONG_ADMIN_URL` (default `http://127.0.0.1:8001`), `KONG_STATUS_URL`, `SNAPSHOT_PATH` (default `/kong/declarative/kong.json`).
- Fluxo: register → SSE com reconexão (backoff exponencial com jitter, `Last-Event-ID`) → polling de reserva com `If-None-Match` → grava o snapshot de forma atômica (tmp + rename) → `POST /config` → status/heartbeat.
- Na subida, se `SNAPSHOT_PATH` existir, reporta a versão dele (o Kong já subiu com esse arquivo).
- Falha ao aplicar: mantém o último snapshot bom em disco, reporta `failed` com o erro do Kong (truncado em 8 KiB) e não tenta de novo o mesmo hash até chegar outro.
- Logs JSON (`log/slog`), métricas mínimas em `:9100/metrics` (versão aplicada, falhas, último sucesso).
- `internal/cpmock`: control plane falso implementando o contrato, usado nos testes.

Aceite: `go test ./...` cobre registro, aplicação via SSE, aplicação via polling quando o SSE cai, 304 sem reaplicar, falha do Kong reportada e persistência atômica; teste com build tag `integration` aplica o snapshot de exemplo no Kong do compose.

---

## Semana 3

### W3-C1 [Claude] UI — base e primeiras telas
- Vite + React + TypeScript em `apps/ui`; cliente gerado do contrato (`openapi-typescript` + `openapi-fetch`); TanStack Query; roteamento com TanStack Router ou React Router.
- `pnpm --filter @gromesh/ui mock`: Prism servindo `contracts/control-plane.openapi.yaml` (a UI não espera o backend).
- Layout: seletor de environment; menu Services, Routes, Consumers, Plugins, Publicações, Clusters; barra "N alterações não publicadas" + botão Publicar.
- Telas: login; Services (lista, busca, criar, editar, excluir com confirmação); Routes (idem, filtro por service); modal de publicação com o diff do `publish-preview`.
- Erros 422 mapeados para os campos pelo `errors[].path`.

Aceite: Playwright contra o mock: login → criar service → criar route → abrir publicação e ver 2 itens "added".

### W3-X1 [Codex] Endpoints do agente e clusters no control plane
- Módulos `agent-gateway` (register, snapshots/current com ETag/304/204, SSE `snapshot.published` + `ping` 15 s, status) e `clusters` (CRUD, rotate-token, status agregado `converged/converging/degraded/no-nodes`).
- Tokens guardados só como hash; node token por nó; revogação ao apagar cluster.
- Publicar (W2-C1) emite evento para os agentes do environment via `LISTEN/NOTIFY` do Postgres (funciona com várias réplicas).
- Remover o push direto ao Kong da W1-C1. No compose: serviço `agent` com `network_mode: "service:kong"`, volume compartilhado `kong-config` montado em `/kong/declarative`, `KONG_DECLARATIVE_CONFIG=/kong/declarative/kong.json` e Admin API do Kong de volta para `127.0.0.1:8001`.
- O campo `error` do status recebido do agente pode ecoar valores da config (ex.: chaves key-auth): o control plane redige antes de gravar.
- Com a Admin API do Kong de volta ao `127.0.0.1`, `KONG_VALIDATOR_URL` (W2-C2) não pode mais apontar para `http://kong:8001`: no compose, um Kong DB-less só para validação (sem tráfego), com a Admin API na rede do compose.

Aceite: e2e — cria cluster → sobe o agente com o token → publica → `GET /clusters/{id}` mostra `converged` com a versão nova em até 10 s → `GET :8000/echo` responde 200. Reiniciar o Kong mantém a rota (subiu do arquivo).

### W3-X2 [Codex] E2E de produto completo
- Pasta `e2e/` com Playwright contra a stack real do compose (postgres, control-plane, ui, kong, agent, echo).
- Cenário: login → service + route + plugin key-auth → consumer + chave → publicar → requisição sem chave 401 e com chave 200 → rollback → rota some (404).
- Job no CI que sobe a stack e roda o cenário; artefatos (trace, vídeo) em falha.
- O CI também (a) roda o aceite Playwright da UI contra o Prism (`pnpm --filter @gromesh/ui test:e2e`) e (b) regera `apps/ui/src/api/schema.d.ts` a partir do contrato e falha com `git diff --exit-code` se mudar.
- Mover o `kong-validator` do compose para `127.0.0.1:8011` no host (`8001` não deve parecer o Kong de dados) e ajustar `KONG_VALIDATOR_URL` onde for preciso (CI, harness dos testes, script do catálogo).

Aceite: o próprio job verde no CI.

---

## Semana 4 — UI completa do gateway

### W4-C1 [Claude] Consumers e Plugins com formulário gerado pelo schema
- Consumers: lista, busca, criar, editar, excluir; credenciais key-auth com a chave mostrada **uma única vez** num modal com "copiar" e aviso; depois só `keyHint`.
- Plugins: catálogo por categoria (`/plugin-schemas`), plugins com `supportedInDbless: false` aparecem desabilitados com motivo; escolha de escopo (global, service, route, consumer); lista de plugins por escopo também dentro das telas de Service, Route e Consumer.
- Gerador de formulário a partir do schema do Kong (`fields`): string, number, integer, boolean, array/set de string, map, record aninhado, `one_of` → select, `default`, `required`, `between`/`len_min` como validação local, campos `encrypted` como input de senha (nunca pré-preenchidos com `REDACTED` no envio). Modo "JSON avançado" para o que o gerador não cobrir.
- Erros 422 do validador (`config.minute`, `scope.consumerId`) no campo certo.

Aceite: (1) teste unitário que renderiza o formulário de **todos os 45** schemas de `apps/control-plane/src/plugin-catalog/kong-3.9/` sem erro e envia os defaults; (2) Playwright contra o Prism: criar consumer → chave aparece uma vez e some ao fechar; criar `rate-limiting` em uma route pelo formulário; 422 em `config.minute` aparece no campo.

### W4-X1 [Codex] Publicações e Clusters na UI
- Publicações: histórico (cursor), detalhe da versão, diff entre duas versões quaisquer (added/removed/modified, before/after lado a lado, chaves sempre `REDACTED`), rollback com confirmação mostrando o diff que será aplicado; 409 "mesma configuração" tratado.
- Clusters: criar cluster → modal com o `registrationToken` mostrado uma vez + comandos prontos (`docker run` do agente e `--set agent.token=…` do Helm futuro); tabela de nós (versão aplicada, estado, `kongHealthy`, `lastSeenAt`, online), status agregado com cor, rotate-token, excluir com confirmação.
- Atualização periódica da lista de clusters (10 s) só com a aba visível.

Aceite: Playwright contra o Prism: abrir histórico → diff entre v1 e v2 → rollback confirma; criar cluster → token aparece uma vez; nó `failed` mostra o erro.

### W4-C2 [Claude] Segredos de plugin são somente escrita
- `GET /plugins`, `GET /plugins/{id}` e qualquer outra resposta da API devolvem os campos `encrypted` do schema como `"REDACTED"` para **todos** os papéis, inclusive admin. Só o snapshot enviado ao agente leva o valor real.
- `PUT`/`POST` de plugin: campo `encrypted` com valor `"REDACTED"` = manter o valor atual gravado; campo ausente = remover (comportamento normal do `PUT`). Em `POST` (plugin novo), `"REDACTED"` é 422.
- O validador do Kong recebe o valor real mesclado, nunca `"REDACTED"`.
- UI (`schema-form`): campo `encrypted` não alterado é enviado como `"REDACTED"` (hoje é omitido, o que apagaria o segredo no `PUT`). Dica do campo: "Valor atual mantido; digite para trocar."

Aceite: (a) `GET` nunca contém o segredo; (b) editar outro campo do plugin sem redigitar o segredo o mantém, conferido no snapshot publicado; (c) trocar o segredo funciona; (d) `POST` com `"REDACTED"` → 422; (e) teste da UI cobre o envio do sentinel.

---

## Semana 5 — Autenticação real e RBAC

### W5-C0 [Claude] PR de contrato: sessão por cookie
- `POST /auth/login` → 200 com `user` e cookie de sessão `httpOnly; Secure; SameSite=Strict`; sem `accessToken` no corpo.
- `POST /auth/logout`; `GET /auth/csrf` (ou cookie legível) + header `X-CSRF-Token` obrigatório em toda mutação; 429 no login por excesso de tentativas.
- `securitySchemes`: `cookieAuth` substitui `bearerAuth` para a UI (agentes continuam com bearer próprio).
- `GET /environments/{envId}/snapshots/{version}`: credenciais key-auth e campos `encrypted` de plugins sempre `"REDACTED"`, para todos os papéis (coerente com a W4-C2). Só o endpoint do agente (`/agent/v1/snapshots/current`) entrega o snapshot completo.

### W5-C1 [Claude] Autenticação e usuários no control plane
- Tabela `users`; senha com argon2id; primeiro admin criado na subida a partir de `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` só se não existir nenhum usuário.
- Sessões no Postgres (id aleatório, expiração deslizante de 8 h, revogação no logout e ao desativar o usuário); CSRF double-submit; limite de tentativas de login por IP + e-mail.
- CRUD de usuários (admin) conforme contrato; não permitir remover/rebaixar o último admin.
- **Remover `AUTH_MODE=dev` por completo** (código, compose e CI passam a usar o bootstrap admin).
- Audit: `auth.login` (sucesso e falha, sem senha), `auth.logout`, `user.*`.
- Novo id de sessão a cada login (anti-fixation); a sessão anterior é invalidada.
- Login não revela se o e-mail existe: mesma resposta 401 e tempo equivalente (rodar argon2 contra um hash fictício quando o usuário não existir).
- Atributo `Secure` do cookie controlado por `COOKIE_SECURE` (default `true`); só o compose de desenvolvimento usa `false`.
- Desativar usuário ou mudar o papel revoga as sessões dele imediatamente.

Aceite: teste de matriz RBAC gerado do contrato — para **cada** `operationId` com `x-required-role`, os três papéis recebem 2xx/403 conforme esperado; sem cookie → 401; mutação sem CSRF → 403; último admin protegido; 6ª tentativa de login errada → 429.

### W5-X1 [Codex] Audit log, telas de usuários e endurecimento da UI
- Control plane: `GET /audit-events` (filtros do contrato, cursor, só admin).
- UI: login por cookie + CSRF (remover `sessionStorage`), tela de Usuários (admin), tela de Audit log com filtros e before/after, menu e botões conforme papel (a API continua sendo quem decide).
- `apps/ui/nginx.conf`: CSP restritiva, `X-Frame-Options: DENY`, `Referrer-Policy`, `X-Content-Type-Options`, HSTS quando atrás de TLS.
- Apagar `apps/ui/src/pages/Placeholder.tsx`, sem uso desde a W4-X1.

Aceite: e2e completo da W3-X2 adaptado ao login real; viewer não vê botões de edição e recebe 403 se forçar; audit mostra a publicação com autor.

---

## Semana 6 — Observabilidade

### W6-X1 [Codex] Pipeline de logs e métricas
- Compilador: `platformPlugins` vindos da configuração do control plane — `prometheus` global e `http-log` global apontando para o coletor do cluster (batch via `queue`).
- `deploy/observability/`: Vector (versão fixa) recebendo o http-log, **removendo headers e query params de credencial** (`apikey` e os `key_names` configurados, `authorization`, `cookie`) e gravando no ClickHouse (versão fixa).
- Tabela `requests` com TTL de 7 dias: ts, environment_id, cluster_id, service_id, route_id, consumer_id, method, path, status, latency_kong_ms, latency_upstream_ms, latency_total_ms, client_ip, request_size, response_size.
- Compose: perfis `observability` com Vector, ClickHouse e Prometheus.

Aceite: requisição via Kong aparece no ClickHouse em até 10 s; teste prova que a chave `apikey` enviada no header e na query **não** aparece em nenhuma coluna nem no log do Vector.

### W6-C0 [Claude] PR de contrato: analytics
- `GET /environments/{envId}/analytics/summary?from&to&routeId&serviceId` → séries por intervalo: requisições, taxa de erro (4xx, 5xx), p50/p95/p99.
- `GET /environments/{envId}/requests` → explorador com filtros (status, route, service, consumer, período) e cursor.

### W6-C1 [Claude] Analytics no control plane e dashboards na UI
- Módulo `analytics` lendo do ClickHouse (`@clickhouse/client`), consultas parametrizadas, limite de período (30 dias) e de linhas.
- UI: dashboard do environment (requisições, erros e latência p95 ao longo do tempo, top rotas por volume e por erro) e explorador de requisições com filtros e detalhe.
- ClickHouse com usuários separados: o control plane usa um usuário só `SELECT` na tabela `requests`; o Vector usa um usuário só `INSERT`. Nenhum dos dois usa o `default`. Senhas por variável de ambiente.
- A máscara de IP de `clientIp` para viewer/editor (contrato da W6-C0) é aplicada no servidor, não na UI.

Aceite: testes de integração com ClickHouse real e dados de fixture conhecidos (números conferidos); Playwright contra o Prism: dashboard renderiza séries e o explorador filtra por status.

### W6-C2 [Claude] Plugins de plataforma na publicação
- `platformPlugins()` deixa de exigir `clusterId`: injeta só `environment_id` (`custom_fields_by_lua`, mantendo a validação de UUID). O snapshot continua idêntico (mesmo hash) para todos os clusters do environment: **nunca** compilar por cluster no endpoint do agente.
- Aplicado em publish, rollback e auto-publish quando a plataforma tiver observabilidade configurada (`PLATFORM_HTTP_LOG_ENDPOINT` no control plane; vazio = não injeta). O endpoint do http-log é um nome fixo resolvido localmente em cada cluster (ex.: `http://gromesh-collector:8686`).
- Vector: acrescenta `cluster_id` a partir da própria variável `GROMESH_CLUSTER_ID` (valida UUID na subida e recusa iniciar sem ela); continua descartando eventos sem `environment_id` válido.
- Compose: serviço/alias `gromesh-collector` apontando para o Vector. Chart do data plane: opção `collector.enabled` com o Vector como Deployment/Service `gromesh-collector` no namespace do cluster (ou endpoint externo).

Aceite: e2e de produto publica uma rota pela UI, envia tráfego pelo Kong e vê as requisições no dashboard (via API de analytics) com `environment_id` e `cluster_id` corretos; o hash do snapshot muda quando os plugins entram, mas o teste confere que é igual para dois clusters do mesmo environment.

---

## Semana 7 — Kubernetes e imagens de produção

### W7-X1 [Codex] Helm chart do data plane
- Pod = Kong (imagem própria) + agente (sidecar), volume `emptyDir` compartilhado para o snapshot; Admin API só em 127.0.0.1; Service do proxy (LoadBalancer/ClusterIP configurável) expõe só 8000/8443.
- Token de registro vindo de Secret (`agent.existingSecret` ou `agent.token`); nunca em ConfigMap.
- Readiness do Kong por `/status/ready` (só fica pronto depois de carregar um snapshot); liveness separada.
- HPA (CPU), PodDisruptionBudget, `securityContext` não-root, `readOnlyRootFilesystem` onde der, `resources` com padrões sensatos, NetworkPolicy que bloqueia tudo exceto proxy de entrada e saída para o control plane, upstreams e coletor.
- Valores para o coletor de logs (endpoint do http-log) e para as métricas.

Aceite: `helm lint` e `helm template` sem erro; no job conjunto em kind (W7-C1), um pod sem snapshot fica NotReady e passa a Ready depois da primeira publicação.

### W7-C1 [Codex] Helm chart do control plane
- Deployments: control plane (2 réplicas), UI (nginx não-root), kong-validator; Job de migração como hook `pre-install,pre-upgrade`.
- Postgres externo obrigatório (`database.existingSecret`); URL separada para o LISTEN com conexão direta (documentada no `values.yaml`, nunca via PgBouncer em modo transação).
- Ingress com anotações para o SSE do agente (idle timeout > 15 s, buffering desligado), `TRUST_PROXY` = CIDR do ingress (nunca `uniquelocal`), `COOKIE_SECURE=true`.
- Secrets: bootstrap admin, ClickHouse (usuário só leitura), chave de cifragem (W8-C1).
- Job do CI `helm-e2e` em kind: instala Postgres de teste + os dois charts, cria cluster pela API, sobe o data plane com o token, publica uma rota, verifica `converged` e 200 no proxy.

Aceite: o job `helm-e2e` verde.

### W7-X2 [Codex] Imagens de produção
- Control plane: multi-stage com `pnpm deploy --prod`, sem devDependencies, usuário não-root.
- UI: nginx não-root (porta 8080) com os headers da W5-X1.
- Rodar de verdade o workflow `kong-image` (imagem própria 3.9.4); se o tempo estourar, aplicar a troca de `--jobs=2` por `--jobs=4`.
- Todas as imagens: Trivy (falha em CRITICAL), SBOM com syft anexado, tags por SHA, digest fixado nos charts.
- Regerar o catálogo de plugins a partir da imagem 3.9.4 (`catalog:generate`) e trocar o padrão do compose para a imagem própria.

Aceite: os quatro workflows de imagem verdes no GitHub; `docker run <cp> node -e "require('vitest')"` falha (prova que devDependencies saíram).

---

## Semana 8 — Segurança de dados, carga, backup e aceite final

### W8-C1 [Claude] Cifragem em repouso dos segredos
- AES-256-GCM com chave de `GROMESH_ENCRYPTION_KEY` (32 bytes, base64), com `keyId` gravado junto para permitir rotação (várias chaves de leitura, uma de escrita).
- Cifrar: chaves key-auth, campos `encrypted` de plugins **e** as colunas `state` e `config` da tabela `snapshots` (elas também carregam segredos).
- Migração que cifra os dados existentes; comando de rotação de chave que recifra tudo.
- O endpoint do agente decifra só no momento de servir; nada decifrado em log ou audit.

Aceite: depois da migração, `select` direto no Postgres não encontra nenhuma chave nem segredo em claro (teste varre as tabelas); publicar e rollback continuam funcionando; rotação de chave sem downtime.

### W8-X1 [Codex] Carga e backup
- k6 em `tests/load/`: 1.000 req/s via Kong com key-auth + rate-limiting; publicar 5 vezes durante a carga.
- Teste de reconexão: 200 agentes simulados (cpmock invertido ou cliente leve em Go) conectando no SSE do control plane ao mesmo tempo.
- Backup: CronJob de `pg_dump` no chart do control plane + `scripts/restore-drill.sh` que restaura num banco novo e confere que snapshots e usuários batem.

Aceite: p95 do overhead do Kong registrado como baseline; **zero 5xx** durante as publicações sob carga; 200 agentes convergem em até 30 s; o restore drill passa.

### W8-C2 [Claude] Aceite final do MVP
- E2E em kind cobrindo o critério de pronto: instalar via Helm → login do admin → service + route + key-auth + rate-limiting → publicar → cluster converge → requisições aparecem no dashboard → rollback → audit mostra tudo.
- Checklist de segurança executado e registrado: headers, cookie, matriz RBAC, segredos nunca devolvidos, logs sanitizados, imagens sem CRITICAL, segredos cifrados.
- Atualizar `TASKS.md`: MVP fechado e backlog priorizado para o pós-MVP.

Aceite: o job do e2e final verde no CI e o checklist sem pendências.

---

### B1 [Codex] Observabilidade resiliente
- Investigar e medir no compose qual configuração do Kong 3.9.4 reduz a janela após NXDOMAIN do `gromesh-collector` (`dns_not_found_ttl`, `dns_error_ttl`, `dns_stale_ttl` e, se existir nessa versão, o novo cliente DNS). Registrar a medição antes/depois.
- Aplicar a configuração escolhida no compose e no chart do data plane (valores com padrão sensato).
- `platformPlugins`: fila do http-log configurável (`max_retry_time`, `max_entries`) para segurar eventos durante uma queda curta do coletor; padrão que cubra pelo menos 30 s.
- Métrica/alerta: regra do Prometheus (arquivo de rules no chart/compose) para "coletor sem eventos há mais de 2 min com tráfego no Kong".
- Aceite automatizado: tráfego contínuo pelo Kong, reiniciar o coletor, contar eventos no ClickHouse. Roda no compose e no job e2e.

Aceite: reiniciar o coletor com tráfego contínuo perde no máximo 10 s de eventos.

---

## P1 — Tokens de API, agente resiliente e limpezas

### P1-C0 [Claude] Contrato: tokens de API
- `POST /users/me/tokens {name, role, expiresInDays}` → 201 com o token completo (única vez) + metadados; `GET /users/me/tokens`; `DELETE /users/me/tokens/{id}`.
- Admin: `GET /tokens` (todos os usuários, cursor) e `DELETE /tokens/{id}`.
- `ApiToken`: id, name, role, tokenHint (últimos 4), createdAt, expiresAt, lastUsedAt, revokedAt, owner {id, name}.
- `securitySchemes.bearerApiToken`, aceito em toda operação que hoje aceita `cookieAuth`, exceto as de `/users/me/tokens` e `/tokens` (só por sessão). Operações novas com `x-gromesh-planned: true`.

Aceite: lint do contrato válido, matriz RBAC verde com as operações planejadas puladas, diff aprovado antes do P1-C1.

### P1-C1 [Claude] Tokens de API
- Formato `ggt_` + 32 bytes aleatórios em base64url; guardado só o HMAC-SHA256 com `GROMESH_FINGERPRINT_KEY` + tokenHint; comparação por hash.
- `role` ≤ papel do dono na criação; `expiresInDays` obrigatório, 1..365, padrão 90 na UI. Papel efetivo = min(role do token, role atual do dono); dono desativado ou rebaixado reflete na hora.
- `Authorization: Bearer` usa só o token (ignora cookie), sem CSRF; bearer inválido → 401 e entra no limitador por IP do login. Token não cria nem revoga tokens e não mexe em usuários.
- `lastUsedAt` no máximo 1×/min por token. Audit `token.create`/`token.revoke`; mutações por token levam actor `{userId, name, via: "token", tokenId, tokenName}`. O token nunca aparece em log, audit ou resposta depois do 201.
- Matriz RBAC estendida por bearer nos três papéis; testes de rebaixamento do dono, expiração e CSRF dispensado só com bearer.
- UI: página "Tokens de API" no menu do usuário (criar com modal de exibição única + copiar, lista, revogar); admin vê todos. Remover `x-gromesh-planned`.
- `e2e/security-checklist.sh`: linhas T1 (token não reaparece), T2 (expirado → 401), T3 (token não gerencia tokens).

Aceite: testes acima verdes, checklist com T1–T3 PASS, CI verde.

### P1-X1 [Codex] Persistir o node token do agente (backlog 8)
- Token em `GROMESH_STATE_DIR/node-token` (padrão `/var/lib/gromesh`), escrita atômica, modo 0600. Na subida usa o salvo; 401 → apaga e registra de novo com o registration token.
- Helm e compose: volume próprio montado só no container do agente (não reaproveitar o volume do snapshot).

Aceite: `go test` com o cpmock prova reinício sem novo register, token revogado → re-register e permissões 0600; e2e em kind: kill do agente → mesmo nodeId e nenhum nó duplicado.

### P1-X2 [Codex] Limpezas
- Jobs em kind: em falha, salvar `kubectl get pods -A -o wide`, `kubectl get events -A --sort-by=.lastTimestamp` e os logs dos pods como artefato.
- `GROMESH_KEY_NAMES`/`collector.keyNames` deixa de ser Secret e vira valor opcional comum (só fallback); remover o que ficou sem uso.

Aceite: artefato presente num job forçado a falhar (ou verificação por renderização do workflow) e charts/compose sem o Secret.

---

## P2 — Upstreams, targets, certificados e SNIs

### P2-C0 [Claude] Contrato
- Upstreams por environment (editor): `name` hostname único (um service com `host` igual balanceia por ele), `algorithm` (round-robin | least-connections | consistent-hashing | latency), `hashOn`/`hashFallback` (none | consumer | ip | header | cookie, com `hashOnHeader`/`hashOnCookie`), `healthchecks.active` e `healthchecks.passive` opcionais, desligados por padrão.
- Targets (sub-recurso): `target` "host:port", `weight` 0..65535 (0 = fora), único por upstream.
- Certificates (editor): `cert` PEM, `key` PEM write-only (`REDACTED` na leitura; `REDACTED` no PUT mantém), `snis[]` únicos no environment (curinga só como prefixo `*.`), e só leitura `subject`, `issuer`, `notBefore`, `notAfter`, `fingerprintSha256`.
- 422 com `path`: PEM inválido, chave que não corresponde, certificado expirado, SNI duplicado, target fora do formato; service apontando para upstream inexistente é válido (DNS). Operações novas com `x-gromesh-planned: true`.

Aceite: lint válido, diff aprovado antes do P2-C1.

### P2-C1 [Claude] Control plane + compilador
- Tabelas, CRUD, audit e `markDraftChanged` como os demais recursos. Chave privada cifrada em repouso (`enc:v2`, contexto `certificates.key` + id), redigida em audit, diff, preview e envelope do snapshot para todos os papéis; o agente recebe em claro.
- Validação com `node:crypto` (`X509Certificate` + `checkPrivateKey`), sem dependência nova.
- Compilador: upstreams/targets/certificates/snis no formato do Kong, determinístico, tag `managed-by:gromesh`; diff do compilador redige `key`.

Aceite (integração com o Kong do compose): upstream com 2 targets echo alterna o `Hostname`, peso 0 manda tudo ao outro; certificado autoassinado + SNI → `curl --resolve` no 8443 recebe o certificado certo (fingerprint confere); select direto no Postgres não acha a chave em claro (no S5 do checklist).

### P2-C2 [Claude] UI
- Telas Upstreams (com targets e saúde configurável) e Certificados (upload de PEM, chave nunca reexibida, aviso quando `notAfter` < 30 dias). No formulário de Service, sugestão de upstreams no campo `host`.

Aceite: Playwright contra o Prism.

### P2-X1 [Codex] Máscara de path por segmento (backlog 14)
Aceite: vector tests com `/mvp-629762c6` → `/{id}`, `/orders/507f1f77bcf86cd799439011` → `/orders/{id}`, `/v1/pedidos/123` intacto, casos do B5 mantidos; e2e de mascaramento verde.

### P2-X2 [Codex] Contador próprio para falhas de bearer (backlog 15)
- Chave `bearer-ip:<ip>` separada da do login, mesmo limiar e janela.

Aceite: N falhas de bearer bloqueiam só o bearer daquele IP (429) e o login por senha continua; e vice-versa.

---

## P3 — Credenciais JWT, basic-auth e grupos ACL; 401 antes de 404

### P3-C0 [Claude] Contrato
- Sub-recursos do consumer, no mesmo padrão do key-auth:
  - `jwt`: `key` (issuer/kid), `algorithm` (HS256 | RS256 | ES256), `secret` (HS256; write-only, gerado se ausente, exibido só no 201) ou `rsaPublicKey` (PEM; RS256/ES256).
  - `basic-auth`: `username` (único no environment), `password` (write-only, nunca devolvida).
  - `acl`: `groups[]` (nomes `^[a-z0-9_-]{1,64}$`).
- Plugins `jwt`, `basic-auth` e `acl` no catálogo com `supportedInDbless` conferido.
- 409 para `key` de jwt e `username` duplicados no environment. Operações novas com `x-gromesh-planned: true`.

Aceite: lint válido, diff aprovado antes do P3-C1.

### P3-C1 [Claude] Control plane + compilador + UI
- Segredos (`secret` do jwt, `password` do basic-auth) cifrados em repouso (`enc:v2` com contexto), redigidos em audit, diff e envelope.
- Compilador: `jwt_secrets`, `basicauth_credentials` e `acls` no formato do Kong 3.9, determinístico. A senha do basic-auth nunca fica em claro no snapshot persistido no Postgres.
- UI: abas JWT, Basic-auth e Grupos na tela do consumer; segredos exibidos uma única vez.

Aceite (Kong real do compose): JWT HS256 assinado no teste → 200, assinatura errada → 401; RS256 com par gerado no teste → 200; basic-auth certo → 200, errado → 401; `acl` com `allow: [grupo]` → consumer do grupo 200, fora do grupo 403. S5 do checklist cobre as novas colunas.

### P3-X1 [Codex] 401 antes de 404 para anônimos (backlog 10)
- Lista de rotas públicas gerada do contrato em build/teste (operações sem `security` ou com `security` vazio, mais os endpoints do agente do `agent-protocol`).
- Middleware antes do roteamento: requisição a `/api/v1/*` sem sessão nem bearer, fora dessa lista → 401; o resto segue como hoje.

Aceite: anônimo em rota inexistente → 401 (não 404); anônimo em rota pública → comportamento atual; agente com node token continua funcionando (e2e do compose e kind); teste que falha se a lista divergir do contrato.

---

## Backlog (pós-MVP, em ordem de prioridade)

1. **Observabilidade resiliente:** feito (B1, PR #5). `dns_not_found_ttl`/`dns_error_ttl` = 1 s no compose e no chart (NXDOMAIN frio do coletor: 80,6 s → 10,3 s nas duas imagens), fila do http-log cobrindo 60 s, alerta `CollectorWithoutEvents` no Prometheus (compose e chart) e aceite automatizado em `e2e/observability.spec.ts` (reinício do coletor e NXDOMAIN frio perdem 0 s de eventos).
2. **Digests nos charts a cada nova imagem:** feito. O workflow `image-digests` abre um PR por grupo (`chore/kong-image-digest` após o `kong-image`, `chore/app-image-digests` após o `images`) com `scripts/bump-image-digests.mjs`; os charts só referenciam imagens por digest (Kong, control-plane, UI, agente, Vector e Postgres do backup). Vector e Postgres são atualizados à mão (`docker buildx imagetools inspect`). Cada merge na `main` gera um PR de digests das aplicações: avaliar agrupar por release (tag) se o ruído incomodar.
3. **kong-image multi-arquitetura:** feito. O `kong-image` constrói `linux/amd64` e `linux/arm64` em runners nativos (smoke e Trivy em cada perna) e publica o manifest list `3.9.4-<sha>`; o `image-digests` fixa o digest da lista. Aceite em 2026-10-16: pull pelo digest da lista num Mac arm64 sem emulação e `pnpm smoke` verde com o padrão do compose.
4. **Cifragem em repouso:** feito (B4). Formato `enc:v2` com tabela, coluna e id da linha no AAD do AES-256-GCM; leitura aceita v1 e v2; a próxima inicialização recifra v1 → v2 pelo mesmo mecanismo da rotação (advisory lock + update condicional). Teste: valor copiado de uma linha para outra não abre; nenhuma linha v1 sobra; publish/rollback/agente continuam funcionando.
5. **Analytics e dado pessoal:** feito (B5). O Vector mascara no path, antes do ClickHouse, CPF e CNPJ (com e sem pontuação), e-mails e sequências de 6+ dígitos (`{cpf}`, `{cnpj}`, `{email}`, `{num}`), inclusive percent-encoded; UUIDs e ids curtos ficam intactos; a query continua descartada. Aceite em `e2e/path-masking.spec.ts` (ClickHouse e log do Vector sem valores brutos).
6. **Analytics:** feito (B6). `GET /environments/{envId}/analytics/top-routes` (`by` = requests | errors | p95, `limit` ≤ 50, 7 dias) agrupando a tabela `requests` por `route_id`, nome vindo do Postgres (rota apagada: id com nome nulo); card "Top rotas" no dashboard com seletor de critério e link para o explorador filtrado pela rota.
7. **Observabilidade:** feito (B7). O compilador injeta no http-log a união dos `key_names` dos key-auth publicados (validados por `^[A-Za-z0-9._-]{1,64}$`, 422 em `config.key_names` na API); o Vector remove esses nomes de header e query por evento; `GROMESH_KEY_NAMES` fica como fallback/união. Aceite em `e2e/key-names.spec.ts`.
8. **Snapshot por cluster:** em andamento como P1-X1 (persistir o node token do agente).
9. **Proteção da `main` no GitHub:** aplicar `.github/rulesets/main.json` (`gh api -X POST repos/grometis/gromesh-gateway/rulesets --input .github/rulesets/main.json`) quando a conta tiver GitHub Pro; até lá vale o hook `pre-push` de `.githooks/` (CLAUDE.md, regra 10).
10. **401 antes de 404 para anônimos:** feito (P3-X1). Requisição a `/api/v1/*` sem cookie de sessão nem bearer, fora da lista pública gerada dos dois contratos (`scripts/generate-session-exempt-routes.mjs`, com teste de divergência), recebe 401 antes do roteamento; com credencial presente, rota inexistente segue 404. Risco aceito: anônimo com `Authorization` arbitrário ainda distingue rota existente de inexistente; os paths já são públicos no bundle da UI, então o ganho de fechar não compensa duplicar o guard.
11. **Retenção por rota no ClickHouse:** o `path` pode ser sensível mesmo mascarado; permitir retenção menor (TTL) para rotas marcadas, em vez dos 7 dias globais da tabela `requests`.
12. **P2: upstreams/targets + certificados/SNIs:** feito (P2-C0..C2, PRs #27, #31, #32). Entidades do Kong ainda não cobertas pelo modelo (balanceamento por upstream/targets, certificados e SNIs); contrato depois do P1-C0.
13. **Flake do `mvp-e2e` em kind:** causa encontrada e corrigida (PR #25). "traffic must reach the analytics API" em 5 execuções em 2026-10-16 (runs 38960971263, 38967623348, 38968335996, 38969548580, 38978312100): o spec usava `/mvp-<8 hex>`, e desde a máscara de dado pessoal (B5) uma sequência de 6+ dígitos vira `{num}` no ClickHouse (~10% das execuções; ex.: `/mvp-629762c6`). O spec passou a usar o UUID inteiro. Fica a lição: paths de teste com sufixo aleatório devem usar UUID completo. Os logs dos pods como artefato do job em falha seguem no P1-X2.
14. **Máscara de path por segmento:** feito (P2-X1). Um segmento com 6+ dígitos seguidos que não é UUID vira `{id}` inteiro (`/mvp-629762c6` → `/{id}`, `/orders/507f1f77bcf86cd799439011` → `/orders/{id}`); CPF/CNPJ completos e segmentos com e-mail mantêm `{cpf}`, `{cnpj}`, `{email}`; UUIDs e ids curtos intactos.
15. **Contador separado para falhas de bearer:** feito (P2-X2). Falhas de token usam a chave própria `bearer-ip:<ip>` (mesmo limiar e janela do login por endereço); um pipeline com token expirado não bloqueia mais o login por senha do mesmo IP, e vice-versa.

Regras de produção já codificadas nos charts e que continuam valendo: `TRUST_PROXY` é o IP/CIDR exato do ingress (nunca `uniquelocal`); o `LISTEN` do control plane usa conexão direta ao Postgres (nunca PgBouncer em modo transação); o ingress na frente do SSE do agente precisa de idle timeout acima de 15 s e buffering desligado; `COOKIE_SECURE` só é falso no compose de desenvolvimento.
