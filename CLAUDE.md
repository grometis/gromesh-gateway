# Gromesh Gateway — instruções para agentes

> `AGENTS.md` é um link para este arquivo. Claude Code e Codex seguem as mesmas regras.

## O produto em 5 linhas

- Gromesh Gateway = UI + control plane próprios; **Kong OSS 3.9.x em modo DB-less** é só o data plane.
- O control plane (Postgres) é a única fonte da verdade. O Kong nunca acessa o banco.
- Edições viram rascunho; **publicar** compila o estado em um snapshot versionado (`packages/compiler`).
- Um agente (sidecar do Kong) baixa o snapshot, grava em volume e aplica via `POST /config` no Kong local.
- Nenhum código, asset ou texto do Kong Enterprise é copiado. A marca "Kong" não aparece na UI.

## Mapa do repositório (e dono de cada área)

| Caminho | O que é | Stack |
| --- | --- | --- |
| `contracts/` | Contratos: API do control plane, protocolo do agente, schema do snapshot | OpenAPI 3.1, JSON Schema |
| `packages/compiler/` | Modelo de domínio → config declarativa do Kong, hash, diff | TypeScript, Vitest |
| `apps/control-plane/` | API REST, auth/RBAC, audit log, snapshots, endpoints do agente | NestJS (ESM), Drizzle ORM, Postgres |
| `apps/ui/` | Interface web | React, Vite, TanStack Query, cliente gerado do OpenAPI |
| `apps/agent/` | Sidecar do Kong | Go (binário estático) |
| `deploy/compose/` | Ambiente local | Docker Compose |
| `deploy/helm/` | Charts de produção (semana 8) | Helm |
| `images/kong/` | Build próprio do Kong 3.9.4 | Bazel/Docker |
| `scripts/` | Smoke e utilitários | Node ≥ 24 sem dependências |

Cada tarefa em `TASKS.md` declara os diretórios que pode alterar. **Não edite fora deles.** Se precisar, pare e registre no PR.

## Comandos

```bash
pnpm install
pnpm typecheck            # todos os pacotes
pnpm test                 # todos os testes
pnpm lint:contracts       # valida os OpenAPI
pnpm dev:up               # Postgres + Kong DB-less + backend echo
pnpm smoke                # aplica contracts/examples/snapshot.example.json no Kong real e testa
pnpm --filter @gromesh/compiler example   # regenera o exemplo do contrato
pnpm --filter @gromesh/control-plane db:generate -- --name <nome>   # nova migração a partir de src/db/schema.ts
pnpm --filter @gromesh/control-plane test:e2e                      # contra a stack do compose
# Aceite: CP/proxy/status/echo/TLS precisam das portas fixas livres; remapeie os demais destinos junto das URLs.
export GROMESH_DISPOSABLE_ID="$(openssl rand -hex 16)"
export COMPOSE_PROJECT_NAME="gromesh-test-$GROMESH_DISPOSABLE_ID" COMPOSE_FILE="$PWD/deploy/compose/docker-compose.yml:$PWD/deploy/compose/disposable.yml"
for key in POSTGRES_PASSWORD BOOTSTRAP_ADMIN_PASSWORD CLICKHOUSE_PASSWORD CLICKHOUSE_READER_PASSWORD CLICKHOUSE_WRITER_PASSWORD GROMESH_COLLECTOR_TOKEN; do export "$key=$(openssl rand -hex 24)"; done
export GROMESH_ENCRYPTION_KEY="test:$(openssl rand -base64 32)" GROMESH_FINGERPRINT_KEY="$(openssl rand -base64 32)"
export BOOTSTRAP_ADMIN_EMAIL=acceptance@example.test POSTGRES_PORT=55443 CLICKHOUSE_PORT=18124 KONG_VALIDATOR_PORT=18012
export UI_URL=http://127.0.0.1:5174 CP_URL=http://127.0.0.1:3000/api/v1 CLICKHOUSE_URL="http://127.0.0.1:$CLICKHOUSE_PORT" KONG_VALIDATOR_URL="http://127.0.0.1:$KONG_VALIDATOR_PORT"
export KONG_PROXY_URL=http://127.0.0.1:8000 KONG_PROXY_TLS_PORT=8443 KONG_STATUS_URL=http://127.0.0.1:8100/status/ready KONG_METRICS_URL=http://127.0.0.1:8100 ECHO_URL=http://127.0.0.1:8080
pnpm dev:up && docker compose --profile observability up -d --wait
pnpm smoke && pnpm --filter @gromesh/control-plane test:e2e && pnpm test:e2e && node deploy/observability/acceptance.mjs
export TEST_DATABASE_URL="postgres://gromesh:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/gromesh" TEST_CLICKHOUSE_URL="$CLICKHOUSE_URL" TEST_CLICKHOUSE_ADMIN_USER=gromesh TEST_CLICKHOUSE_ADMIN_PASSWORD="$CLICKHOUSE_PASSWORD"
unset TEST_CLICKHOUSE_DATABASE TEST_CLICKHOUSE_USER TEST_CLICKHOUSE_PASSWORD GROMESH_PG_TOOLS
pnpm test # Integração cria/apaga bancos próprios; também funciona com dev:up de desenvolvimento + observability, sem override.
docker compose --profile observability down -v # Somente ao encerrar esta execução descartável.
```

Os testes de integração do control plane usam um Postgres real: suba o do compose (`pnpm dev:up`) ou aponte `TEST_DATABASE_URL`.
Cada execução cria e apaga um banco próprio.

Go: `cd apps/agent && go test ./... && go vet ./...`

## Regras invioláveis

1. **Contratos primeiro.** Implementação segue `contracts/`. Mudar um contrato = PR separado, só com o contrato (+ exemplo/teste), aprovado pelo Fabrício antes de qualquer código depender dele.
2. **Só o compilador conhece o formato do Kong.** Control plane, UI e agente não montam JSON do Kong à mão. O agente trata `config` como opaco.
3. **Kong sempre DB-less.** Nada de `KONG_DATABASE=postgres`, nada de escrita em entidades pela Admin API do Kong.
4. **Admin API do Kong nunca exposta fora do pod/host** (exceto no compose da semana 1).
5. **RBAC no servidor.** Toda rota tem `x-required-role` no contrato; o guard aplica. A UI só esconde botões.
6. **Toda mutação gera audit event na mesma transação.** Credenciais e senhas nunca aparecem em log, audit ou diff (use `REDACTED`/`keyHint`).
7. **Teste antes de tela.** Cada tarefa tem um teste de aceite (e2e ou de integração). Tarefa sem teste verde não está pronta.
8. **Dependências:** só a tarefa que precisa adiciona; uma frente por vez mexe no `pnpm-lock.yaml`. Fixe versões exatas.
9. **Sem documentação extra.** Nada de README por pasta, ADR ou guias. Código claro, testes e o contrato bastam. Comente só o "porquê" não óbvio.
10. **`main` só por PR** com a CI verde e aprovação do Fabrício, documentação inclusive. O plano do GitHub não protege a branch, então a trava é local: todo clone novo (e cada worktree) roda `git config core.hooksPath .githooks` logo após o clone; o hook `pre-push` recusa push para `main` (emergência: `GROMESH_ALLOW_MAIN_PUSH=1`). O ruleset em `.github/rulesets/main.json` é aplicado quando houver GitHub Pro.
11. **PR só de contrato marca operações novas com `x-gromesh-planned: true`; o PR de implementação remove a marca.** A matriz RBAC e a cobertura contrato↔handlers pulam as marcadas, e um teste falha se uma operação marcada já tiver handler.
12. **PRs do bot de digests (`image-digests`) podem ser mergeados pelo agente sem perguntar**, desde que a CI completa esteja verde e o PR só altere digests das nossas imagens (as referências fixadas, tag e digest, das imagens `gromesh-*`). Qualquer outra mudança no PR: perguntar ao Fabrício.

## Convenções

- Identificadores, commits e mensagens de erro da API em inglês. Texto da UI em pt-BR.
- TypeScript `strict`, ESM, sem `any` (use `unknown` + validação). Corpos de requisição são validados pelo próprio contrato: `@Body(contractBody("ServiceWrite"))`. Regra que o JSON Schema não expressa vai no service, com erro 422 e `path`.
- Banco: Drizzle, migrações SQL geradas em `apps/control-plane/drizzle/` (nunca editar uma migração já mergeada). Toda mutação roda em `db.transaction` e chama `audit(tx, ctx, …)` e, se mexer no gateway, `markDraftChanged(tx, envId)`.
- Todo handler tem `@RequiredRole(...)` (ou `@Public()`); o guard global recusa handler sem papel.
- API: JSON camelCase, ids UUID gerados pelo control plane, paginação por cursor `{ items, nextCursor }`, erros RFC 9457 (`application/problem+json` com `errors[].path`).
- Commits: Conventional Commits (`feat(compiler): …`, `fix(agent): …`). PRs pequenos, um por tarefa.
- Branch por tarefa: `task/<ID>-<slug>` (ex.: `task/W1-C1-control-plane-skeleton`). Trabalhe em git worktree próprio.

## Definição de pronto

- [ ] `pnpm typecheck && pnpm test` verdes (e `go test ./...` se tocou no agente)
- [ ] Teste de aceite da tarefa existe e passa
- [ ] Contrato respeitado (ou PR de contrato já mergeado)
- [ ] Nenhum arquivo fora dos diretórios da tarefa
- [ ] PR descreve o que mudou e como testar em até 10 linhas
