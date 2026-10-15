# Tarefas — semanas 1 a 6

Duas frentes em paralelo: **[Claude]** = Claude Code, **[Codex]** = Codex. Cada tarefa = 1 branch + 1 PR + 1 worktree.
Pronto = teste de aceite verde no CI + checklist de `CLAUDE.md`. Revisão cruzada: o PR do Claude é revisado pelo Codex e vice-versa.

Já entregue (base): contratos em `contracts/`, `packages/compiler` (compile, hash, diff, snapshot, 12 testes), compose com Kong 3.9 DB-less, `scripts/smoke.mjs`, CI.

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

Ordem de merge na semana 3: W2-C2 → W3-X1 → W3-C1 → W3-X2. Quem mergeia depois faz rebase; `src/db/schema.ts` e `drizzle/` são alterados por uma frente por vez.

Ordem de merge: semana 4 → W4-C1 antes de W4-X1 (W4-X1 faz rebase em `router.tsx`); W4-C2 mergeia antes de começar a semana 5. Semana 5 → W5-C0 → W5-C1 → W5-X1, todos na branch `integration/w5-auth` (criada da `main`), que entra na `main` num único merge quando a CI inteira estiver verde; a `main` é mergeada nela, nunca o contrário. Semana 6 → W6-X1 → W6-C0 → W6-C1.

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

Aceite: testes de integração com ClickHouse real e dados de fixture conhecidos (números conferidos); Playwright contra o Prism: dashboard renderiza séries e o explorador filtra por status.

---

## Backlog

- Cifrar em repouso, no Postgres, as chaves key-auth e os campos `encrypted` da config de plugins.
- Semana 5 (auth): token em cookie httpOnly + SameSite + proteção CSRF, no lugar do `sessionStorage` da UI.
- Semana 8 (Helm/produção): `TRUST_PROXY` em produção é o IP/CIDR exato do ingress, nunca `uniquelocal` (só o compose de desenvolvimento usa isso).
- Semana 8 (Helm/produção): o `LISTEN` do control plane usa conexão direta ao Postgres, nunca via PgBouncer em modo transação; o LB/ingress na frente do SSE do agente precisa de idle timeout acima de 15 s e buffering desligado.
