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
| P4-C1 | Claude | — | `apps/ui/` (+ `.github/workflows/` só para anexar screenshots ao job da UI) |
| P4-X0 | Codex | — | `contracts/` (+ `apps/ui/src/api/schema.d.ts` gerado) |
| P4-X1 | Codex | P4-X0 | `packages/compiler/` (conversão Kong → modelo), `apps/control-plane/`, `contracts/` (só remover `x-gromesh-planned`) |
| P4-C2 | Claude | P4-C1, P4-X1 | `contracts/` (PR próprio do `autoPublishPausedReason`), `apps/control-plane/` (o campo), `apps/ui/` (+ `.github/workflows/` só para screenshots) |
| P5-C0 | Claude | — | `contracts/` (+ `apps/ui/src/api/schema.d.ts` gerado) |
| P5-C1 | Claude | P5-C0 | `apps/control-plane/`, `e2e/security-checklist.*`, `contracts/` (só remover `x-gromesh-planned`) |
| P5-C2 | Claude | P5-C1 | `apps/ui/` |
| B-11 | Codex | — | `contracts/` (PR próprio), `packages/compiler/`, `apps/control-plane/`, `deploy/observability/`, `deploy/compose/`, `deploy/helm/data-plane/files/vector/`, `e2e/` |
| B-16 | Codex | — | `contracts/` (PR próprio), `packages/compiler/` (conversão Kong → modelo), `apps/control-plane/` |
| P6-C0 | Claude | — | `contracts/` (+ `apps/ui/src/api/schema.d.ts` gerado), `deploy/helm/*/values.yaml`, `deploy/helm/data-plane/values.schema.json`, `deploy/helm/*/templates/_helpers.tpl` (só a trava "planned"), `deploy/helm/*/ci/check.sh`, `.github/workflows/ci.yml` (só o passo do chart do data plane) |
| P6-X2 | Codex | — | `apps/ui/` |
| P6-X3a | Codex | P6-X2 | `apps/ui/` |
| P6-X3b | Codex | P6-X3a | `apps/ui/` |
| P6-X3c | Codex | P6-X3b | `apps/ui/` |
| P6-X3d | Codex | P6-X3c | `apps/ui/` |
| P6-X3e | Codex | P6-X3d | `apps/ui/` |
| P6-X1 | Codex | P6-C0 | `apps/control-plane/`, `deploy/helm/*/templates/`, `deploy/helm/*/values.yaml` (só os comentários), `deploy/helm/*/ci/check.sh`, `.github/workflows/ci.yml` (só o passo do chart do data plane) |
| P6-C2 | Claude | P6-X1 | `deploy/helm/*/ci/values-homelab.yaml` |
| N0-C0 | Claude | W0 aprovada | `contracts/` (só arquivos v2 e exemplos novos), `apps/control-plane/test/integration/workspaces-v2-contract.test.ts`, `package.json` (só `lint:contracts`) |
| N1-C0 | Claude | N0 mergeada | `contracts/` (PR de contrato: só o que a N1 precisa e o v2 ainda não tem) |
| N1-C1 | Claude | — | `apps/control-plane/src/workspaces/slug.ts` e o teste de unidade dele |
| N1-X1 | Codex | N1-C0 | `apps/control-plane/src/db/schema.ts`, `apps/control-plane/drizzle/`, `apps/control-plane/src/environments/`, `apps/control-plane/src/workspaces/` (exceto `slug.ts`), `apps/control-plane/test/` |
| N1-X2 | Codex | N1-X1 | `apps/control-plane/src/db/schema.ts`, `apps/control-plane/drizzle/`, validação de referência em `src/gateway/`, `src/consumers/`, `src/plugins/`, `src/certificates/`, `src/upstreams/`, `apps/control-plane/test/` |
| N1-X3 | Codex | N1-X2 | os mesmos de N1-X2, mais `src/workspaces/migration-report*` |
| N1-C2 | Claude | N1-X1 | `apps/control-plane/src/gateway/` (routes), `apps/control-plane/src/workspaces/`, `contracts/` (só remover `x-gromesh-planned` de `convertRoutePathCompatibility`), `apps/control-plane/test/` |
| N1-C3 | Claude | N1-X3 | `apps/control-plane/src/auth/`, `apps/control-plane/src/common/`, `apps/control-plane/src/db/schema.ts`, `apps/control-plane/drizzle/`, `apps/control-plane/test/` |
| N1-X4 | Codex | N1-X3, N1-C1, N1-C2, N1-C3 | `apps/control-plane/` (módulos v2), `contracts/` (só remover `x-gromesh-planned`) |
| N1-X5 | Codex | N1-X4 | `apps/control-plane/` (handlers v1 e métrica), `apps/ui/` só se um teste da UI precisar de ajuste sem mudar a tela |
| N1-C4 | Claude | todas da N1 | `e2e/`, `apps/control-plane/test/`, `.github/workflows/` (só o job de regressão da migração) |
| N1-X6 | Claude | N1-X6-C | `apps/control-plane/src/consumers/`, `apps/control-plane/src/config-transfer/`, `apps/control-plane/src/gateway/`, `apps/control-plane/src/db/` + `drizzle/` (status da credencial), `apps/control-plane/test/`, `packages/compiler/` (credencial pendente fora da config), `apps/ui/` (formulários key-auth e JWT, status, rotação) |

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

## P4 — Nova identidade visual; exportar/importar configuração

### P4-C1 [Claude] Nova identidade visual — base + tela de Services
Referência: Direção 3, "Contraste".
- Cores: menu lateral #0B2A2A (texto #CFE0DD, título de grupo #86AAA5, item ativo fundo #FFFFFF texto #0B2A2A); select do menu fundo #133A39 borda #275453; conteúdo fundo #FFFFFF, texto #0B2A2A, secundário #3E5452/#4A5D5B; superfície #F2F5F4, bordas #E4ECEA/#D3DEDC; acento #C93A1E (botão primário, texto branco); rascunho #FFF1EC/#FFE2D8 com texto #8E2A15; sucesso #16A36A com texto #0B5D3A.
- Tipografia: Space Grotesk (texto e títulos; h1 34px/700, letter-spacing -0.03em) e JetBrains Mono (hosts, versões, ids, números), self-hosted via @fontsource em versões exatas (a CSP não permite Google Fonts). Nada de Inter/Roboto.
- Layout: menu lateral de 248px com "gromesh" (21px/700), select de environment, grupos Gateway / Operação / Conta. Faixa de publicação em 3 blocos: "Rascunho · N alterações · Ver diff" (#FFF1EC) → "Publicar vN+1 →" (#C93A1E) → "No ar · vN · x/y nós" (#0B2A2A). Botões com raio 10px e altura ≥ 44px; badges NOVO (#C93A1E) e ALTERADO (#FFE2D8, texto #8E2A15).
- Services: linhas como cartões (#F2F5F4, raio 10, border-spacing 8px), "nome → destino" com destino em mono, filtros "Todos N" / "Com alterações N" como pílulas.
- Responsivo: abaixo de ~900px o menu vira faixa no topo; tabelas largas com rolagem horizontal própria.
- Entregas: tokens em CSS variables num só lugar; componentes Shell/menu, PublishStrip (hasUnpublishedChanges/currentVersion + status agregado dos clusters), Button, Badge, Table, Tabs, Field; `<Brand/>` único (o logo futuro entra só ali); favicon provisório "g" em #0B2A2A. Base aplicada a todas as telas; Services no visual final.

Aceite: Playwright atual verde (seletores por role/label); @axe-core/playwright (versão exata) nas telas existentes contra o Prism, falhando em violações serious/critical; contraste AA; screenshots de Services e da faixa de publicação (1440 e 390) como artefato do job.

### P4-X0 [Codex] Contrato: exportar/importar configuração
- `GET /environments/{envId}/export?format=yaml|json` → configuração declarativa própria, versionada (`gromesh/v1`; não é o formato do Kong). Segredos sempre REDACTED; credenciais só com keyHint.
- `POST /environments/{envId}/import` (editor) com `{document, mode: "merge"|"replace", dryRun}` → `{ added, modified, removed, errors[] }` no formato do diff; dryRun não grava; import grava no rascunho (nunca publica) e gera audit.
- `sourceFormat: "kong-declarative-3.0"` como fonte alternativa; entidades fora do modelo → `errors[]` com `path`, nunca ignoradas em silêncio.
- REDACTED no documento = manter o segredo atual (regra do PUT); credencial nova sem segredo → 422. Operações novas com `x-gromesh-planned: true`.

Aceite: lint válido, diff aprovado antes da implementação.

### P4-X1 [Codex] Exportar/importar configuração
Implementação do contrato do P4-X0 (PR #44). A conversão da config declarativa do Kong para o modelo do Gromesh fica no compilador.

Aceite: (a) export → import em environment vazio → publicar → snapshot equivalente ao original (ids e campos de plugin de plataforma específicos do environment normalizados, já que o import gera ids novos); (b) import do `contracts/examples/snapshot.example.json` (`kong-declarative-3.0`) → rascunho equivalente, com entidades e campos desconhecidos em `errors[]`; (c) import com erro não grava nada (contagem de linhas igual antes e depois); (d) REDACTED mantém o segredo, conferido decifrando no teste; (e) export nunca contém segredo em claro (varredura pelos valores conhecidos).

### P4-C2 [Claude] Pausa do auto-publish visível e telas no novo visual
- Ponto da faixa por estado: verde (todos os nós na versão no ar), âmbar `#B7791F` (convergindo), vermelho `#C93A1E` (degradado), cinza (sem nós).
- Contrato: `Environment.autoPublishPausedReason: "import" | null` (só leitura; o auto-publish volta após a próxima publicação explícita). Implementação: o campo na API e, na faixa, "Publicação automática pausada após importação — publique para retomar".
- Telas, um PR cada, com screenshots desktop/mobile: Visão geral (faixa + 4 indicadores + requisições por hora com sucesso/erro + top rotas com seletor); Revisar e publicar (alterações à esquerda, diff campo a campo v_atual × rascunho à direita, nota de REDACTED, mensagem + Publicar, frase sobre rollback); Clusters (cartões por cluster com barra por nó, tabela de nós, nó com falha na última versão boa com o erro do gateway); Consumer (abas Credenciais / Grupos ACL / Plugins; segredo exibido uma vez com Copiar e "Já copiei"; cartões só com dicas).

Aceite: Playwright e axe verdes; screenshots como artefato; teste dos quatro estados do ponto.

---
## P5 — Papel por environment; retenção por rota; import de hash do basic-auth

### P5-C0 [Claude] Contrato: papel por environment
- Um papel por environment substitui o global ali (`viewer`, `editor`, `admin` ou `none` = sem acesso). Vale para operações com `{envId}` e para recursos de um environment endereçados por id (`/clusters/{clusterId}`). As demais (usuários, tokens, audit, criar environment, `/me`) usam só o global.
- `GET`/`PUT /users/{userId}/environment-roles` (admin global, só sessão, audit before/after); `/me` traz `environmentRoles`; `GET /environments` lista só os visíveis (admin global vê todos).
- Environment invisível → 404, nunca 403; papel insuficiente num visível → 403. Admin global é admin em todos e não recebe papel por environment (422). Um token pode ser criado com papel até o maior papel do dono (o global ou o de qualquer environment). Numa operação com envId, ele age com min(papel do token, papel do dono naquele environment); nas demais, com min(papel do token, papel global). Decisão do Fabrício em 2026-10-18.

Aceite: lint válido e teste do contrato (PR #58).

### P5-C1 [Claude] Papel por environment no control plane
- Tabela `environment_roles(user_id, environment_id, role)`, única por par; apagar o environment ou o usuário remove as linhas; promover a admin global as apaga (com audit).
- Guard resolve o envId (do path ou do cluster) fail-closed: 404 para environment inexistente ou invisível, 403 para papel insuficiente. SSE e agente não mudam.

Aceite: matriz RBAC estendida (viewer global + editor em A; editor global + viewer em A; admin em A sem gerenciar usuários e tokens; `none` → 404 e fora da lista; o mesmo via token) e `e2e/security-checklist.sh` com R1 (eleva só no environment certo) e R2 (environment invisível → 404). PR #62.

### P5-C2 [Claude] Papel por environment na UI
- Usuários: tabela environment × papel com "Usa o global"; só o admin global vê e edita.
- O seletor de environment mostra só os visíveis; os botões seguem o papel efetivo do environment em tela.

Aceite: Playwright contra o Prism, axe e screenshots desktop/mobile. PR #63.

### B-11 [Codex] Retenção por rota no ClickHouse (backlog 11)
- Contrato: `Route.analyticsRetentionDays` 1..7 | null (PR #59).
- A rota leva o valor no http-log via compilador; o Vector grava `retention_days`; a TTL passa a `ts + toIntervalDay(retention_days)`; migração do ClickHouse compatível, com padrão 7.

Aceite: teste com ClickHouse real usando `OPTIMIZE … FINAL` e timestamps antigos (`e2e/route-retention.mjs`). PR #61.

### B-16 [Codex] Import de basic-auth com hash do Kong (backlog 16)
- Contrato: hash aceito só se o consumer tem id preservado; senão 422 no path da senha. O hash é guardado como `enc:v2` (PR #60).

Aceite: hash gerado no teste (`sha1(senha + consumer_id)`) → publicar → login no Kong do compose responde 200 (senha errada 401); consumer sem id preservado → 422. PR #64.

---

## P6 — Telas secundárias na Direção 3; endereço do cliente atrás de CDN

Migração visual: sem mudar comportamento nem contrato de API. Referência: as telas finais (Services, Consumers, Clusters, Revisar e publicar, Visão geral) e os tokens do P4-C1. Vermelho `#C93A1E` só na ação de publicar e em estados de erro; ação destrutiva usa `#8E2A15` com borda, nunca o botão vermelho cheio. Segredos nunca aparecem (REDACTED ou dica); onde se cria um segredo, o fluxo "copie agora, não será exibido de novo" do Consumer. "Kong" não aparece no texto da UI.

Aceite de toda tarefa de tela: Playwright existente verde, mais asserções novas quando um elemento muda de estrutura; axe sem violações serious/critical; a verificação de layout do P6-X2 (sem rolagem horizontal em 390 px, alvos ≥ 40 px, foco visível) aplicada às telas da tarefa; nenhuma ocorrência de "Kong" no texto renderizado; capturas antes/depois em 1440 e 390 no PR.

### P6-C0 [Claude] Contrato: endereço do cliente
- Convenção "Client address" no contrato: hop do `X-Forwarded-For` de proxy confiável ou, com `CLIENT_IP_HEADER`, esse header, honrado só de origem confiável; ausente, inválido ou de origem não confiável, ignorado.
- Charts: `clientIpHeader` no control plane (exige `trustProxy`); `kong.realIpHeader` e `kong.trustedIps` no data plane (juntos, CIDRs explícitos, nunca /0). Qualquer valor é recusado ("planned (P6-X1)") até o P6-X1.

Aceite: lint válido e testes de rejeição dos charts (PR #107).

### P6-X2 [Codex] Componentes comuns das telas
- `PageHeader` (título, descrição, ações) no lugar das `.page-head` repetidas; `EmptyState` (título, texto, ação opcional); tom "no ar" no `Badge` se faltar. Telas finais passam a usá-los sem mudar o visual.
- Verificação de layout reutilizável no Playwright: em 390 px, `scrollWidth` ≤ largura da janela; botões, links de ação e campos visíveis com altura ≥ 40 px; foco visível por teclado. Aplicada às telas finais e, em cada grupo, às telas migradas.

Aceite: Playwright e axe verdes; a verificação de layout passa nas telas finais.

### P6-X3a [Codex] Services (detalhe), Routes, Plugins
### P6-X3b [Codex] Upstreams, Certificados
### P6-X3c [Codex] Publicações (lista e detalhe) e Auditoria
### P6-X3d [Codex] Usuários e Tokens de API
- Criação de token no fluxo "copie agora" do Consumer.
### P6-X3e [Codex] Métricas, Requisições e Login
- Métricas e Requisições mantêm o `Chart` atual: só layout, filtros e tabelas. Login: wordmark "gromesh" (`<Brand/>`), sem ilustração.
- Ao fim, a seção "screens not redesigned yet" do `styles.css` deixa de existir; cada grupo remove as classes que deixou de usar.

Aceite (X3a–X3e): o aceite de toda tarefa de tela, acima.

### P6-X1 [Codex] Endereço do cliente no control plane e no gateway
- `CLIENT_IP_HEADER`: o rate limit de login, o audit, o uso de token de API e o agente usam o endereço da convenção do P6-C0. O chart remove a trava "planned" e passa `clientIpHeader`; o do data plane passa `KONG_REAL_IP_HEADER` e `KONG_TRUSTED_IPS`.

Aceite: testes com header presente vindo de proxy confiável (usado), presente vindo de origem não confiável (ignorado), ausente e inválido (regra anterior); render dos charts com os valores ligados.

### P6-C2 [Claude] values-homelab com CF-Connecting-IP
- Control plane: `clientIpHeader: CF-Connecting-IP`. Data plane: `kong.realIpHeader: CF-Connecting-IP` e `kong.trustedIps` com o CIDR de pods do minikube, explícito.

Aceite: checagens dos charts verdes com os values de homelab.

---

## N0 — Workspaces: contratos (W0 aprovada)

Desenho aprovado pelo Fabrício em 2026-10-24 (W0, `APPROVED_FOR_N0`; desenho e pareceres fora do repositório). A N0 só
publica contratos planejados: nenhum handler, nenhuma migração, nenhum comportamento novo. N1 e N2 não começam sem
autorização.

### N0-C0 [Claude] Contrato v2 (Workspaces, planejado)
- `contracts/control-plane-v2.openapi.yaml`: Workspaces, entidades do gateway por Workspace (`stripPath` padrão
  `false`, path completo com o prefixo ao upstream), bindings e papéis, releases imutáveis, deployments, promoções,
  aprovações, políticas, M2M, pacote assinado e atestados, contenção de isolamento. Tudo `x-gromesh-planned`, com
  `x-required-permission`, `x-scope` e `x-gromesh-requirements`; catálogo de permissões e papéis embutidos no `info`.
  Login, usuários, tokens, `/me` e catálogo de plugins ficam no v1 até a N1 decidir a compatibilidade dos paths (H-9).
- `contracts/agent-protocol-v2.openapi.yaml`: deployment com época e revisão, status, admissão por `podUid` e `bootId`
  com desafio, relatórios assinados e numerados, liberações, formato local da concessão.
- `contracts/snapshot-v2.schema.json` e exemplos (snapshot v2, vetor do pacote assinado).
- Máquinas de estados no contrato (`x-gromesh-transitions`); perfil do núcleo com L1–L10 bloqueados (`x-gromesh-phase`).
- Rollback emergencial: o estado operacional da promoção nunca é sobrescrito; a revisão posterior é
  `EmergencyPostReview`, com identidade, máquina, revisor, resultado e operações próprias.
- O contrato é autossuficiente: as regras normativas da W0 estão escritas nele, e as referências à W0 são só histórico.

- Decisões H-1 (`gromesh-workspace`) e H-5 (consumer único no Workspace, `<slug>~<nome>` no nó) escritas no contrato.

Aceite: `pnpm lint:contracts` sem erros e `workspaces-v2-contract.test.ts` (nenhuma operação v2 com handler;
permissões, escopo e CSRF; decisões só por sessão; corpos fechados, inclusive aninhados, e respostas de erro; 409 e
422 de conflito; papéis e permissões do catálogo; rastreabilidade dos 98 GW-*, com a prova dos requisitos só de
runtime no contrato; máquinas fechadas e estado da promoção coerente com a execução; perfil do núcleo; procedência e
revogação; protocolo do agente; invariantes do exemplo de snapshot v2; vetor C-21 com o digest real do conteúdo).

### N1 — Workspace Foundation no control plane (planejada, não autorizada)
A N1 preserva o comportamento atual: cada environment vira um Workspace com o mesmo UUID, a v1 continua servindo a
UI, e o snapshot de cada environment continua igual byte a byte (mesmo hash antes e depois da migração). Nenhuma
composição por instância, nenhum prefixo no data plane e nenhum segundo Workspace operacional numa instância antes
dos gates da N2.

**Decisões do PO (2026-10-24) e como a N1 as representa:**
- **H-1, isolamento de consumers:** plugin próprio `gromesh-workspace` (global, depois dos autenticadores; consumer
  com tag de outro Workspace ou credencial sem consumer → 401 igual à credencial inválida). Prefixo de route nunca
  conta como isolamento. Na N1 só o lado do control plane: `anonymous` e plugins com escopo de consumer apontam para
  consumer do mesmo Workspace (422), nome `gromesh-*` reservado (422) e FKs compostas que recusam referência cruzada
  no banco. O plugin, as tags e a prova com Kong real são da N2 (GW-WS-06, GW-PLG-06).
- **H-5, identidade dos consumers:** `username` e `customId` únicos no Workspace; `app-sky` em TVRO e em ASSINE são
  consumers independentes. Banco: `unique (workspace_id, username)` e `unique (workspace_id, custom_id)`. API,
  auditoria, export e pacotes: só o nome lógico, 409 só para duplicata no mesmo Workspace. Compilador (N2):
  `<slug>~<username>` e `<slug>~<customId>` no nó, e o `gromesh-workspace` devolve os valores lógicos ao upstream em
  `X-Consumer-Username` e `X-Consumer-Custom-ID`. Credenciais continuam únicas na instância (chave key-auth pelo HMAC,
  `key` JWT, username basic-auth, SNI), com conflito genérico que não nomeia o outro Workspace. Na migração,
  username/`customId` repetidos entre environments deixam de bloquear; credenciais repetidas continuam bloqueando.
- **H-9, migração v1 → v2:** migração controlada, sem duas APIs administrativas equivalentes permanentes. Cada
  handler v1 de `/environments/{envId}/…` passa a chamar o mesmo serviço e o mesmo guard da v2 (Workspace = id do
  environment, papel v1 traduzido para permissões); não existe regra de autorização própria da v1. As regras da v2
  valem também pela v1: a mesma autorização e a unicidade de credenciais e SNI por instância (409). Para preservar o
  comportamento atual, a v1 mantém a semântica dela até o corte: route criada pela v1 é `legacy-preserved`
  (`stripPath: true` padrão, path opcional; sem path entra no relatório da migração e é recusada só pela composição
  da N2) e o service continua apontando o upstream pelo `host`; só a v2 cria routes `workspace-default` e usa
  `upstreamId`. Ficam na v1 sem substituto: login, logout, CSRF, `/me`, usuários, tokens, catálogo de plugins, auditoria e
  registro do agente. Corte das operações administrativas v1 (64 com `{envId}`/`{clusterId}`, mais `GET`/`POST
  /environments`) só quando: (1) a UI não chamar nenhuma delas (e2e); (2) nenhuma chamada v1 por token `ggt_` em 30
  dias (métrica da N1-X5); (3) migração e regressão verdes em integração e e2e, com o roteiro de retorno ensaiado. O
  corte responde 410 e é tarefa própria, com PR de contrato.

Nas tarefas abaixo, `workspace_id` é a coluna `environment_id` das entidades, que a N1-X1 mantém com esse nome (o
valor já é o id do Workspace): `unique (workspace_id, …)` e as FKs `(workspace_id, id)` usam essa coluna.
Tarefas pequenas, um PR cada; `src/db/schema.ts` e `drizzle/` mudam por uma frente por vez, na ordem N1-X1 →
N1-X2 → N1-X3 → N1-C3. Toda migração é testada sobre bancos com os dados de cada versão anterior (0000…0011). Nenhuma
tarefa põe dois Workspaces no mesmo data plane: a criação de Workspace pela v2 (`createWorkspace`, que os põe nos
clusters da instância) fica bloqueada até a N2, e dois Workspaces na mesma instância só existem em fixture de teste. A v1
continua criando environments como hoje (preservação do comportamento atual): cada um vira um Workspace com clusters
próprios (`clusters.environment_id`) e snapshot próprio, sem composição.

| Tarefa | Depende de | Escopo | Aceite |
| --- | --- | --- | --- |
| N1-C0 Contrato complementar | N0 mergeada | o que a N1 precisa e o v2 não tem: relatório de pré-checagem da migração (leitura, `platform-admin`), contador de uso da v1 por token, aviso de depreciação nas operações v1 que serão cortadas; tudo `x-gromesh-planned` | lint + teste de contrato; aprovação do Fabrício antes de qualquer código |
| N1-C1 Slug e identidade lógica | — | função pura de slug (GW-WS-10): minúsculas, sem acento, espaço → hífen, só `[a-z0-9-]`, lista de reservados (B §3.3, `gromesh-*`); colisão → sufixo proposto e listado, nunca aplicado em silêncio; `key` do Workspace (UUID) separado do slug | unidade: tabela de casos (acentos, emoji, reservados, vazio, colisão, limite de tamanho); mesmo nome → mesmo slug |
| N1-X1 Modelo de dados e migração estrutural | N1-C0 | `workspaces` (`id` = `environments.id`, `key`, `slug`, `slug_locked_at`), criada por trigger com cada environment; `environment_id` mantém o nome nas entidades (já é o id do Workspace: nenhum dado reescrito); coluna `path_compatibility` (`legacy-preserved` em toda route existente e nas criadas pela v1); `check (cardinality(paths) > 0)` só nas routes `workspace-default` (criadas pela v2) | migração sobre cada versão anterior; UUIDs, contagens e conteúdo preservados; snapshot de cada environment com o **mesmo hash** antes e depois; v1 e UI sem regressão (integração + e2e); tempo medido num banco sintético grande |
| N1-X2 Propriedade e integridade referencial | N1-X1 | FKs compostas `(workspace_id, id)`: route → service, service → upstream, target → upstream, credencial → consumer, SNI → certificado, plugin → service/route/consumer, `anonymous` → consumer; o serviço recusa antes do banco (422 com `path`) | integração: cada referência cruzada entre dois Workspaces de fixture recusada pelo serviço **e** pelo banco (insert direto); nome `gromesh-*` reservado → 422; dados migrados sem violação |
| N1-X3 Unicidade por Workspace e por instância | N1-X2 | por Workspace: nomes, `username` e `custom_id` de consumer (H-5); por instância: chave key-auth (HMAC), `key` JWT, username basic-auth, SNI; pré-checagem com relatório sobre rascunho, snapshot ativo e candidatos a rollback (C §8.3): credencial repetida entre environments bloqueia a migração, username/`custom_id` repetidos não | integração: `app-sky` em dois Workspaces → ambos aceitos; credencial repetida → 409 genérico que não nomeia o outro Workspace, auditado e limitado; corrida concorrente resolvida pelo índice; relatório lista cada bloqueio sem valores secretos |
| N1-C2 Inventário de routes legadas | N1-X1 | relatório por route (path público e upstream antes/depois, `stripPath`, route sem path); `convertRoutePathCompatibility` por route, explícita e auditada | integração: nenhuma conversão em lote nem implícita; tráfego atual igual (hash do snapshot); route sem path listada e bloqueada só para a futura composição v2 |
| N1-C3 RBAC e escopo por Workspace | N1-X3 | tabela `role_bindings`; guard por `x-required-permission`/`x-scope`; bindings por Workspace e por instância; papéis embutidos do catálogo; migração da matriz efetiva (C §8.6: override do environment, `none` → `deny`, `admin` → `platform-admin`); token = interseção entre escopos do token e permissões atuais do dono; decisões só por sessão com CSRF | matriz usuários × Workspaces × operações antes e depois **sem nenhuma ampliação**; matriz RBAC gerada do contrato; fora do escopo → 404, sem permissão → 403; token tentando decidir → 401/403; nenhum handler sem permissão |
| N1-X4 Endpoints v2 | N1-X3, N1-C1, N1-C2, N1-C3 | Workspaces (leitura; criação recusada além do migrado até a N2), entidades do gateway, variáveis, export/import por Workspace (`gromesh/v1` não transporta variáveis; VarRef → 422 no campo); `x-gromesh-planned` removida operação a operação | integração por operação contra o contrato (corpos fechados, 409/422 de conflito); cobertura contrato ↔ handlers; o teste "marcada sem handler" continua valendo para o resto |
| N1-X5 Compatibilidade temporária com a v1 | N1-X4 | handlers v1 de `/environments/{envId}/…` sobre os serviços e o guard da v2 (Workspace = id do environment, papel v1 traduzido para permissões); contador de chamadas v1 por token `ggt_` | a mesma matriz RBAC passa pelas duas APIs; teste de bypass (permissão v1 sem a v2 → 403/404); e2e da UI atual sem regressão; nenhuma regra de autorização exclusiva da v1 |
| N1-C4 Regressão e ensaio da migração | todas da N1 | job de regressão: banco com dados de cada versão → migração → snapshots com o mesmo hash, matriz RBAC igual, `mvp-e2e` verde; roteiro de retorno (restaurar o backup anterior à migração) ensaiado em cópia | job verde na CI; relatório de tempo da migração; roteiro de retorno executado no ensaio; nada aplicado no homelab |
| N1-X6 Credenciais só geradas pelo servidor (H-14) | N1-X6-C | chave key-auth e segredo HS256 do JWT só gerados pelo servidor (CSPRNG, 32 bytes), na criação ou na rotação (`rotateKeyAuthCredential`, `rotateJwtCredential`), mostrados uma vez: `key`/`secret` informados → 422 no campo (v1 e v2). Import (documento Gromesh ou Kong) nunca grava, gera nem devolve chave ou segredo: credencial casada (key-auth só por id) mantém valor e status; credencial nova entra só com os metadados, `status: pending-reprovision`, fora de toda config publicada, listada em `pendingCredentials` sem valor (`regeneratedCredentials` sempre vazio) até ser rotacionada. Credenciais existentes seguem ativas. RS256/ES256 seguem com a chave pública | integração: 422 no campo nas duas APIs; geração e rotação (valor novo, uma vez, auditado sem valor, 404 entre Workspaces, 409 para RS/ES); import com chave → pendente, listada sem valor, chave do documento nunca chega ao Kong; credencial pendente fora da config compilada; e2e com Kong real: pendente não autentica, rotacionada autentica após publicar e a anterior deixa de autenticar; UI sem campo de chave/segredo, segredo mostrado uma vez |

**Critério de conclusão da N1:** todos os aceites acima verdes, comportamento atual preservado (hash, UI, RBAC) e
nenhum data plane com mais de um Workspace: além dos migrados, só os environments que a v1 continua criando, cada um
com clusters e snapshot próprios; a v2 não cria Workspace. A N1 não ativa nada no data plane: composição, prefixo,
`gromesh-workspace` e tags são da N2.

Riscos: migração longa em tabelas grandes (ensaiar o tempo numa cópia, sem tocar no homelab); credenciais repetidas
entre environments em instalações com vários environments (hoje a unicidade é por environment; a pré-checagem bloqueia
e o relatório orienta a correção); clientes v1 com routes sem path ou que dependem de `stripPath: true`; tokens
`ggt_` usados fora da UI (o corte espera 30 dias sem chamadas); slug derivado de nome de environment que colide ou é
reservado (relatório antes do primeiro release); papéis v1 traduzidos que ampliem acesso (bloqueado pelo aceite da
N1-C3).

### N2 — isolamento no data plane (autorizada em 2026-10-26; nenhum Workspace adicional ativável até os gates)
Incrementos pequenos, um PR cada, sem merge sem aprovação do Fabrício. A composição não é chamada por nenhuma
publicação até a N3 (deployments por instância): nada desta fase muda o data plane de quem usa a v1.

| Tarefa | Depende de | Escopo | Aceite |
| --- | --- | --- | --- |
| N2-C1 Composição de Workspaces | N1 | `packages/compiler`: `composeWorkspaces` (nomes `<slug>~<nome>`, upstream `<nome>.<slug>.gromesh.internal`, paths `/<slug><path>` e `~/<slug>(?:<regex>)` com a regex restrita, `strip_path=false` por padrão, tags `gromesh-ws:`/`gromesh-platform`, guard por route com a política de autenticação, `gromesh-workspace` global, um mecanismo efetivo por route, ldap-auth/session/hmac-auth/acme/oauth2 recusados, nomes e tags `gromesh-*` e obrigatórios da plataforma reservados, `anonymous` só do mesmo Workspace, global do Workspace emulado por route, conflitos da instância antes de compor) | unidade: cada regra, determinismo, alterar A não muda nenhuma entidade de B |
| N2-X1 Plugins `gromesh-workspace` e `gromesh-route-guard` | N2-C1 | `images/kong/plugins`, `e2e` | e2e com o Kong 3.9.4 real: matriz A×B para key-auth, basic-auth e jwt, com e sem `anonymous` (401 igual à credencial inválida / 200 como anônimo), valores lógicos no upstream, path completo, regex, guard 404; controle negativo sem os plugins |
| N2-C2 Capacidades privilegiadas na composição | N2-C1, F-1 (#132/#133) | `packages/compiler` | a classificação `privilegedUses` da F-1 recusada em Workspace na composição |
| N2-D1 Concessão local, guard 503 e supervisor | N2-X1 | `apps/isolation`, `images/kong/plugins`, `e2e` | concessão `CLOCK_BOOTTIME`/`bootId` lida pelo guard, pelo supervisor e pela liveness; inválida → 503 e Kong parado; controles negativos |
| N2-D2 Sonda de isolamento | N2-D1 | `apps/isolation`, `images/kong/plugins`, `packages/compiler` (canário), `e2e` | CAP-1…CAP-7 com alvos de teste, canário do guard, estados de `PodIsolationState` |
| N2-D3 Admissão e relatórios | N2-D2 | `apps/control-plane`, `apps/agent`, contrato v2 (só remoção de `x-gromesh-planned`) | admissão com desafio, relatórios assinados e contínuos, pendências e liberação |
| N2-D4 Chart com sidecars nativos | N2-D2 | `deploy/helm/data-plane`, `apps/agent/Dockerfile`, `apps/isolation` (install), `.github/workflows/ci.yml` | ordem de partida e de encerramento, sondas, volumes sem escrita do `kong` |
| N2-E1 Suíte a–s em Kubernetes | todas | `e2e/kind` e ambiente de referência (decisão humana) | itens a–s de B §3.5 com orçamentos medidos e controle negativo |

**Gates obrigatórios, ainda não comprovados:**
Nenhum Workspace é ativável sem estes testes em Kong real e Kubernetes compatível (≥ 1.33 ou versão validada):
contenção real do tráfego; orçamento de detecção e encerramento (incluindo as folgas K, Ks e Kx medidas);
keepalive e WebSocket; supervisor travado; relógio monotônico e `bootId`; admissão de pods; perda da sonda e da
comunicação; recriação de pod e troca de nó; ordem de encerramento dos sidecars; controles negativos de isolamento.

Gate de acesso (decisão do PO na revisão da N1): um Workspace criado a partir da N2 nasce sem acesso implícito de
editor ou viewer global (menor privilégio): só `platform-admin` e quem for atribuído a ele. Os papéis globais v1 sem
bindings valem só para a N1; o relatório da migração (`accessChanges`) lista quem perde o acesso implícito. As
variáveis (N1-X4b) ficam para a N2, como a escrita v2 de service, route e plugin e o import v2 (estes também
dependem da trilha F-1).

### N3 — recorte mínimo para os aceites da N2 (autorizado em 2026-10-27; nenhum merge sem o Fabrício)
Só o que os aceites n, o, p e CAP-5…CAP-7 com pod servindo exigem. Fora: rollback, reconcile, revogação, promoções,
aprovações DEV → HML → PRD e o restante da N3/N4. Este planejamento não autoriza nenhuma implementação além das
tarefas da tabela. O modo Workspaces segue desabilitado para uso operacional: só laboratórios descartáveis o ligam, de
forma explícita. Sem Workspaces, nada muda (v1 byte a byte).

Decisões do PO (2026-10-27):
- **D1 Identidade da instância.** Antecipa da N4 só a persistência da entidade `instance` (id estável e único, stage
  imutável). Reaproveita as chaves Ed25519 de `instance_signing_keys`: nenhuma segunda identidade nem segundo mecanismo
  de assinatura. Migração aditiva e testada; nenhuma migração em ambiente operacional nesta fase.
- **D2 Quem recebe deployments v2.** Só clusters explicitamente habilitados para o protocolo v2. Um cluster tem um único
  protocolo de entrega ativo; os v1 seguem no fluxo atual; nenhuma conversão automática; a troca de protocolo é
  explícita, validada e auditada, com estados e transições no contrato, e mantém a identidade e a convergência do cluster.
- **D3 Canário ligado à revisão aplicada.** `applied.json` no handoff e `appliedRevision` no relatório da sonda, ligados
  ao estado efetivamente aplicado: instance, cluster, pod, deployment, revisão, hash, identidade do agente e resultado.
  O agente só declara uma revisão aplicada depois de o Kong confirmar a config correspondente; o CP confronta o reporte
  com o deployment e o hash esperados; revisão declarada isoladamente não prova convergência; o canário detecta config
  servindo diferente da revisão autorizada. Exige PR de contrato antes do código.
- **D4 `publishRelease`.** Criar uma release imutável (RBAC) não é implantá-la num cluster. A entrega v2 a um cluster
  exige deployment autorizado, config válida, cluster compatível (D2), admissão válida, isolamento comprovado e
  época/revisão/hash corretos. Sem aprovações DEV → HML → PRD nesta fase.
- **D5 Coexistência v1/v2.** Um fluxo de publicação/aplicação ativo por cluster; o v1 não sobrescreve um deployment v2
  ativo; o v2 não altera o estado legado em silêncio; a troca preserva histórico, config e retorno controlado; um agente
  antigo nunca interpreta um deployment v2 (recusa segura); o suporte v1 não é removido.

| Tarefa | Depende de | Escopo | Aceite |
| --- | --- | --- | --- |
| N3-C1 Envelope do snapshot v2 (#176) | N2-C1 | `packages/compiler` | unidade: valida contra `snapshot-v2.schema.json`; canário e guard em toda route de Workspace; alterar A não muda o `contentDigest` de B; mesmos membros → mesmo hash, qualquer revisão |
| N3-C2 Persistência de releases e deployments (#177) | N1 | `apps/control-plane/src/db`, `apps/control-plane/drizzle` | integração: migração aditiva (colunas v1 intactas); UPDATE/DELETE recusados em `releases`, `deployments`, `content_activations`, `content_revocations`; lease de linha única |
| N3-X1 Agente v2 em modo Workspaces (#178) | N2-X3 | `apps/agent` | `go test` com cpmock v2: época/revisão, 304 confirmado, marca de falha, partida a frio; testes v1 inalterados sem `GROMESH_HANDOFF_DIR`. Merge só depois da N3-C5 comprovada |
| N3-K1 Contrato D2/D3 | D1–D5 | `contracts/` (+ exemplo e teste) | lint + Ajv; protocolo de entrega por cluster com estados e transições; `applied.json`; `ProbeReport.appliedRevision`; regras de convergência e códigos de recusa; controles negativos; rastreabilidade GW-*; aprovação do Fabrício antes do código que dependa dele |
| N3-C3 Configuração v2 | N3-C1, N3-C2, D1 | `apps/control-plane`, `apps/control-plane/drizzle` (instance) | integração: `publishRelease` congela o rascunho em release imutável e compõe a revisão desejada pelo compilador; alterar A não muda o `contentDigest` de B; lease ocupado → 409; desligado fora de laboratório; auditoria na mesma transação |
| N3-C4 Deployment e convergência | N3-C3, N3-K1 | `apps/control-plane` | integração: só cluster v2 recebe a revisão; 304 com revisão; época antiga → 409; revisão menor recusada; convergência só com status do agente e evidência da sonda batendo com o hash esperado; `content_activations` uma vez; prazo → failed |
| N3-C5 Agente e reporte | N3-X1, N3-K1 | `apps/agent`, `apps/isolation` | `go test` + kind: `applied.json` só depois da confirmação do Kong; sonda leva `appliedRevision`; canário com config divergente → pod fora de `ok`; aplicação idempotente; sem regressão de revisão |

**N2, frentes paralelas:** N2-F3K contrato do encerramento de admissão nunca adotada (se o contrato mudar) e N2-F3 a
correção (admissão emitida e não adotada encerrada só com prova assinada de que não houve lease; violação confirmada nunca
apagada por exclusão ou recriação de pod); N2-X4 coletor sidecar no loopback do pod (CAP-7), com autenticação, replay e
dedup preservados. Depois da N3-C5: complemento da N2-E2 (n, o, p, CAP-5…CAP-7 com pod servindo).

## Backlog (pós-MVP, em ordem de prioridade)

1. **Observabilidade resiliente:** feito (B1, PR #5). `dns_not_found_ttl`/`dns_error_ttl` = 1 s no compose e no chart (NXDOMAIN frio do coletor: 80,6 s → 10,3 s nas duas imagens), fila do http-log cobrindo 60 s, alerta `CollectorWithoutEvents` no Prometheus (compose e chart) e aceite automatizado em `e2e/observability.spec.ts` (reinício do coletor e NXDOMAIN frio perdem 0 s de eventos).
2. **Digests nos charts a cada nova imagem:** feito. O workflow `image-digests` abre um PR por grupo (`chore/kong-image-digest` após o `kong-image`, `chore/app-image-digests` após o `images`) com `scripts/bump-image-digests.mjs`; os charts só referenciam imagens por digest (Kong, control-plane, UI, agente, Vector e Postgres do backup). Vector e Postgres são atualizados à mão (`docker buildx imagetools inspect`). Cada merge na `main` gera um PR de digests das aplicações: avaliar agrupar por release (tag) se o ruído incomodar.
3. **kong-image multi-arquitetura:** feito. O `kong-image` constrói `linux/amd64` e `linux/arm64` em runners nativos (smoke e Trivy em cada perna) e publica o manifest list `3.9.4-<sha>`; o `image-digests` fixa o digest da lista. Aceite em 2026-10-16: pull pelo digest da lista num Mac arm64 sem emulação e `pnpm smoke` verde com o padrão do compose.
4. **Cifragem em repouso:** feito (B4). Formato `enc:v2` com tabela, coluna e id da linha no AAD do AES-256-GCM; leitura aceita v1 e v2; a próxima inicialização recifra v1 → v2 pelo mesmo mecanismo da rotação (advisory lock + update condicional). Teste: valor copiado de uma linha para outra não abre; nenhuma linha v1 sobra; publish/rollback/agente continuam funcionando.
5. **Analytics e dado pessoal:** feito (B5). O Vector mascara no path, antes do ClickHouse, CPF e CNPJ (com e sem pontuação), e-mails e sequências de 6+ dígitos (`{cpf}`, `{cnpj}`, `{email}`, `{num}`), inclusive percent-encoded; UUIDs e ids curtos ficam intactos; a query continua descartada. Aceite em `e2e/path-masking.spec.ts` (ClickHouse e log do Vector sem valores brutos).
6. **Analytics:** feito (B6). `GET /environments/{envId}/analytics/top-routes` (`by` = requests | errors | p95, `limit` ≤ 50, 7 dias) agrupando a tabela `requests` por `route_id`, nome vindo do Postgres (rota apagada: id com nome nulo); card "Top rotas" no dashboard com seletor de critério e link para o explorador filtrado pela rota.
7. **Observabilidade:** feito (B7). O compilador injeta no http-log a união dos `key_names` dos key-auth publicados (validados por `^[A-Za-z0-9._-]{1,64}$`, 422 em `config.key_names` na API); o Vector remove esses nomes de header e query por evento; `GROMESH_KEY_NAMES` fica como fallback/união. Aceite em `e2e/key-names.spec.ts`.
8. **Snapshot por cluster:** feito (P1-X1). O agente guarda o node token em `GROMESH_STATE_DIR/node-token` (escrita atômica, modo 0600), num volume próprio no compose e no chart; ao reiniciar usa o token salvo sem novo registro, e um 401 apaga o token e registra de novo com o registration token.
9. **Proteção da `main` no GitHub:** aplicado enquanto o repositório for público (ruleset `main`, id 25344054, em 2026-10-18: sem push direto nem exclusão, alteração só por PR, `ci-ok` obrigatório e atualizado). Se o repositório voltar a ser privado sem GitHub Pro, o ruleset deixa de valer e volta a valer só o hook `pre-push` de `.githooks/` (CLAUDE.md, regra 10). Reaplicar: `gh api -X POST repos/grometis/gromesh-gateway/rulesets --input .github/rulesets/main.json`.
10. **401 antes de 404 para anônimos:** feito (P3-X1). Requisição a `/api/v1/*` sem cookie de sessão nem bearer, fora da lista pública gerada dos dois contratos (`scripts/generate-session-exempt-routes.mjs`, com teste de divergência), recebe 401 antes do roteamento; com credencial presente, rota inexistente segue 404. Risco aceito: anônimo com `Authorization` arbitrário ainda distingue rota existente de inexistente; os paths já são públicos no bundle da UI, então o ganho de fechar não compensa duplicar o guard.
11. **Retenção por rota no ClickHouse:** feito (B-11, PRs #59 e #61). `Route.analyticsRetentionDays` (1..7 ou null) vira uma tag de rota do compilador, lida pelo http-log; o Vector grava `retention_days`; a TTL é `ts + toIntervalDay(retention_days)` (`002-retention.sql`, sem rematerializar). O chart do data-plane recusa install/upgrade enquanto o ClickHouse externo não tiver `001`/`002`, e a mensagem diz qual migração falta e o comando para aplicá-la.
12. **P2: upstreams/targets + certificados/SNIs:** feito (P2-C0..C2, PRs #27, #31, #32). Entidades do Kong ainda não cobertas pelo modelo (balanceamento por upstream/targets, certificados e SNIs); contrato depois do P1-C0.
13. **Flake do `mvp-e2e` em kind:** causa encontrada e corrigida (PR #25). "traffic must reach the analytics API" em 5 execuções em 2026-10-16 (runs 38960971263, 38967623348, 38968335996, 38969548580, 38978312100): o spec usava `/mvp-<8 hex>`, e desde a máscara de dado pessoal (B5) uma sequência de 6+ dígitos vira `{num}` no ClickHouse (~10% das execuções; ex.: `/mvp-629762c6`). O spec passou a usar o UUID inteiro. Fica a lição: paths de teste com sufixo aleatório devem usar UUID completo. Os logs dos pods como artefato do job em falha seguem no P1-X2.
14. **Máscara de path por segmento:** feito (P2-X1). Um segmento com 6+ dígitos seguidos que não é UUID vira `{id}` inteiro (`/mvp-629762c6` → `/{id}`, `/orders/507f1f77bcf86cd799439011` → `/orders/{id}`); CPF/CNPJ completos e segmentos com e-mail mantêm `{cpf}`, `{cnpj}`, `{email}`; UUIDs e ids curtos intactos.
15. **Contador separado para falhas de bearer:** feito (P2-X2). Falhas de token usam a chave própria `bearer-ip:<ip>` (mesmo limiar e janela do login por endereço); um pipeline com token expirado não bloqueia mais o login por senha do mesmo IP, e vice-versa.
16. **Import de basic-auth com hash do Kong:** feito (B-16, PRs #60 e #64). Com `_transform: false`, o hash é aceito só quando o consumer de origem traz um UUID canônico minúsculo que é preservado (o hash usa o id como salt); os erros seguem a tabela de caminhos do contrato; o hash é guardado como `enc:v2` e mostrado como REDACTED fora do agente. Aceite: login no Kong do compose com a senha original.
17. **Teste intermitente "Kong merge resolves existing natural references, supports nested additions and rejects prehashed basic-auth"** (`apps/control-plane/test/integration/export-import.test.ts`): falhou uma vez em 2026-10-17, na suíte completa local (`× … 277ms`; a mensagem de erro não foi capturada). Isolado, passou 30 de 30 vezes em 2026-10-18. Hipótese não comprovada: o teste exige que o export inteiro não contenha a substring `abc` (a chave importada), mas o export traz conteúdo aleatório por execução (6 UUIDs e ~1000 caracteres de PEM base64); simulação dá ~3,9% de chance de `abc` aparecer por acaso. Correção sugerida se voltar a falhar: verificar que nenhum valor de string do documento é igual à chave (ou termina com ela), em vez de procurar a substring no JSON inteiro, e capturar a saída da falha. Em 2026-10-18 a suíte completa rodou pelo menos 6 vezes (P5-C0, P5-C1, B-11, B-16 e duas do Codex) e essa falha não se repetiu. O B-16 altera o teste: o import com hash passa a exigir o id preservado, e o erro esperado fica no path da senha. A busca pela substring `abc` continua. Na mesma noite apareceu outro intermitente, com causa encontrada: `credentials.test.ts` falhou no setup com 429 no login do admin do harness ("Too many login attempts"). O teste "locks a client address after too many failures across accounts" de `auth.test.ts` sobe uma réplica com `loginMaxFailuresPerIp: 3` sem `trustProxy`, então trava `ip:127.0.0.1` no banco que todos os arquivos da execução compartilham. O bloqueio é configurado para 60 s, mas o `finally` do teste o apaga, então a janela dura até essa limpeza. Qualquer harness que fizer login nela recebe 429. A correção usa `trustProxy` e um `X-Forwarded-For` próprio, como os testes vizinhos, e está no PR #65. Esse teste não faz login, então a trava não explica a falha deste item. Ele falhou de novo em 2026-10-18 numa suíte completa (`× … 614ms`) e não repetiu em 4 rodadas seguidas, o que é coerente com a hipótese do `abc` aleatório. O #65 também troca a chave por um valor único e confere a dica contra ela. **Resolvido em 2026-10-18 (PR #65):** a chave do teste é única e não hexadecimal, e o teste de bloqueio por endereço não trava mais 127.0.0.1.
18. **Vector sem interpolação perigosa de ambiente:** remover `--dangerously-allow-env-var-interpolation` do Vector (adotado no upgrade para 0.57, PR #69), tirando as variáveis de ambiente da config ou restringindo a interpolação às necessárias.
19. **Escopo de environment no contrato:** feito (PR #71). Um teste falha se um caminho com parâmetro de id ficar fora de `/environments/{envId}/...` e `/clusters/{clusterId}...` e não estiver na lista de rotas globais (users, tokens, me, auth, environments, plugin-schemas, audit-events). Rota nova: decidir o papel efetivo antes.
20. **Avisos aceitos em dependências só de desenvolvimento (2026-10-18), todos dentro do mock Prism (`@stoplight/prism-cli`, devDependency da UI):** `sprintf-js` 1.0.3 (GHSA-hp3w-g68c-fv3c, sem versão corrigida) vem de `json-schema-faker → json-schema-ref-parser → js-yaml 3 → argparse`, e o argparse só é carregado pelo CLI do js-yaml (`bin/js-yaml.js`), nunca quando o js-yaml é usado como biblioteca: não é alcançável. `@faker-js/faker` 5.5.3 (GHSA-qxc2-j82w-r537, `helpers.fake` com template externo) vem de `@stoplight/http-spec → postman-collection` (o 5.3.1, mais novo, ainda exige faker 5; o override quebra o Prism) e só recebe templates do próprio Prism. `braces` 3.0.3 (GHSA-vfj7-8cjw-p6xm, sem versão corrigida) vem do `chokidar` que observa o arquivo do contrato, com padrões que nós mesmos passamos. Nada disso entra em imagem ou em runtime. Rever quando o Prism ou o postman-collection publicarem versão nova.
21. **Majors planejadas: Node 26 (quando virar LTS), Nest 12.** O Dependabot ignora majors de npm e docker (`.github/dependabot.yml`); cada major entra como tarefa própria. Node 26 remove o `corepack` dos Dockerfiles (PR #82, fechado); Nest 12 quebra o `verify` do body parser em `config-transfer/document.ts` (PR #84, fechado).
22. **Troca de linha de imagem base é planejada: Ubuntu 26.04 LTS e nginx 1.30 estável quando forem adotar.** O Dependabot só propõe patch/digest do `ubuntu` 24.04 (base da imagem do Kong) e do `nginxinc/nginx-unprivileged` 1.28 (UI); o `node` segue com minor/patch dentro da 24.x LTS. O #87 (24.10 e 1.31, fora dessas linhas) foi fechado.
23. **Voltar a acompanhar o nginx 1.28.x assim que existir imagem 1.28.3-alpine sem CRITICAL.** Em 2026-10-18 a base da UI voltou para `nginx-unprivileged:1.28.0-alpine` (fixada por digest), porque a 1.28.2 tem o CVE-2026-42945 (CRITICAL) e ainda não há imagem 1.28.3-alpine. A 1.28.1 também tem o CVE (o `image-scan` barrou o #95, fechado). O Dependabot ignora o intervalo `>=1.28.1, <1.28.3`.
24. **control plane: opção clientIpHeader (ex.: CF-Connecting-IP) para rate limit de login e audit atrás de CDN:** feito (P6-C0, P6-X1 e P6-C2; PRs #107, #111 e #112). Convenção "Client address" no contrato: com `CLIENT_IP_HEADER`, o valor do header é o endereço do cliente só quando o peer TCP imediato está em `TRUST_PROXY` e o valor é um único IP; ausente, inválido ou de origem não confiável, vale a regra do `X-Forwarded-For`. Usam esse endereço o bloqueio de login (inclusive o contador `bearer-ip`), o `ip` do audit, o uso de token de API e o agente (`apps/control-plane/src/common/client-address.ts`). Charts: `clientIpHeader` exige `trustProxy` com CIDRs explícitos (sem alias, booleano ou /0); o data plane passa `kong.realIpHeader` e `kong.trustedIps`. Aceite em `apps/control-plane/test/integration/client-address.test.ts` e nas checagens dos charts. A fronteira de confiança em que essa configuração se apoia no homelab continua aberta no item 28.
25. **homelab: dind do Jenkins sem limite de disco pressiona memória do nó (slab).** No servidor de testes (minikube, driver docker, cgroup de 9,95 GiB), o sidecar `docker:27-dind` do Jenkins guarda `/var/lib/docker` num emptyDir sem limite (73 GB em 2026-10-23). O cache de dentries/inodes dessas camadas ocupa ~5 GiB de slab recuperável no cgroup do nó: as métricas de working set ficam acima de 90% com só ~3,3 GiB não recuperáveis, e o kernel recupera memória continuamente. Avaliar `sizeLimit` no emptyDir ou PVC dedicado, e limpeza periódica (`docker system prune`) no dind.
26. **homelab: cloudflared 2026.3.0 desatualizado.** O túnel do servidor de testes (systemd, `/usr/bin/cloudflared`) roda a 2026.3.0; a atual era a 2026.10.3 em 2026-10-23. O `cloudflared-update.timer` está desabilitado e o serviço usa `--no-autoupdate`: atualizar pelo pacote e decidir a política de atualização.
27. **Apagar o branch `pr-screenshots` antes de voltar o repo a privado.** Branch órfão com as capturas antes/depois anexadas aos PRs da fase P6 (imagens referenciadas pela URL raw nas descrições); não faz parte do código. Com o repo privado, as imagens deixam de abrir nos PRs de qualquer forma.
28. **homelab: trustedIps 10.244.0.0/16 confia em todo tráfego do ingress-nginx; seguro só enquanto o ingress for alcançável apenas pelo cloudflared.** O control plane (`trustProxy`/`clientIpHeader`) e o gateway (`kong.trustedIps`/`realIpHeader`) aceitam o `CF-Connecting-IP` de qualquer requisição que chegue pela rede de pods do minikube, ou seja, de tudo que passa pelo ingress-nginx. Hoje só o cloudflared chega ao ingress (NodePort 30080/30443 no IP do minikube, sem exposição na LAN). Se o ingress passar a ser alcançável por outro caminho, qualquer cliente poderá forjar o header e escolher o próprio IP para o rate limit de login, o audit e o analytics. Alternativas: restringir o ingress ao cloudflared (NetworkPolicy, ou bind só no host) ou validar a origem Cloudflare antes de confiar no header.

Regras de produção já codificadas nos charts e que continuam valendo: `TRUST_PROXY` é o IP/CIDR exato do ingress (nunca `uniquelocal`); o `LISTEN` do control plane usa conexão direta ao Postgres (nunca PgBouncer em modo transação); o ingress na frente do SSE do agente precisa de idle timeout acima de 15 s e buffering desligado; `COOKIE_SECURE` só é falso no compose de desenvolvimento.
