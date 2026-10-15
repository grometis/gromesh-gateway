# Tarefas — semanas 1 a 3

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

Ordem de merge na semana 3: W2-C2 → W3-X1 → W3-C1 → W3-X2. Quem mergeia depois faz rebase; `src/db/schema.ts` e `drizzle/` são alterados por uma frente por vez.

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

Aceite: e2e — cria cluster → sobe o agente com o token → publica → `GET /clusters/{id}` mostra `converged` com a versão nova em até 10 s → `GET :8000/echo` responde 200. Reiniciar o Kong mantém a rota (subiu do arquivo).

### W3-X2 [Codex] E2E de produto completo
- Pasta `e2e/` com Playwright contra a stack real do compose (postgres, control-plane, ui, kong, agent, echo).
- Cenário: login → service + route + plugin key-auth → consumer + chave → publicar → requisição sem chave 401 e com chave 200 → rollback → rota some (404).
- Job no CI que sobe a stack e roda o cenário; artefatos (trace, vídeo) em falha.

Aceite: o próprio job verde no CI.
