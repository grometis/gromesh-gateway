# Analytics v2 por Workspace — contrato R14 (proposto)

Status: somente contrato e desenho; requer aprovação do Fabrício. Operações continuam `x-gromesh-planned: true`, sem handlers novos, migrações, backfill, flags, deploy ou alteração do Agent/coletor/data plane. Tipos gerados são artefatos do contrato. Não habilita Workspaces nem fecha gates N2/N3.

## Problema e evidência atual

Base examinada: main `6f22eb0`, W0 `B-arquitetura.md` §3.5.2, contratos v2 e análise R13. O fluxo fonte é `packages/compiler/src/platform-plugins.ts` → http-log → `deploy/observability/vector/vector.yaml` → `deploy/observability/clickhouse/001-requests.sql` e `002-retention.sql` → `apps/control-plane/src/analytics/analytics.ts`. Na composição v2, `releases/releases.ts` passa o ID da instância como `environmentId`; na publicação v1, snapshots usa o ID do ambiente. São proveniências diferentes, apesar do nome da coluna.

Os eventos contêm IDs de rota/serviço/consumidor, cluster, instante de início, status, tempos, tamanhos e caminho sanitizado. Não contêm revisão efetiva nem Release. `attribution.ts` e `copy-state.ts` têm funções puras úteis, mas o serviço v1 não as integra. O DDL fonte continua MergeTree ordenado por ambiente/tempo; o protocolo v2 exige sobrevivência de cópias divergentes e leitura distinta sem depender de merges. O PR #196 permanece separado; não é suposto mergeado.

Tudo acima é evidência estática de código/contrato, não confirmação do schema ou volume implantado. Nenhuma query no ClickHouse compartilhado foi usada para dimensionar esta proposta.

## Alternativas e decisão proposta

1. Buscar pelo dono atual, nome, slug ou path: rejeitada. Renomear, excluir, recriar ou mover serviços produz atribuição retroativa incorreta.
2. Mapa temporal por revisão e IDs técnicos: escolhido para este contrato. Permite comprovar o dono do evento sem alegar a revisão exata servida. Casos insuficientes permanecem não atribuídos.
3. Emitir revisão efetiva/Release autenticada por evento: melhor precisão futura, mas exige contrato de instrumentação próprio e alteração de compilador/coletor/data plane. Não faz parte da implementação desta rodada nem pode ser simulada por horário de publicação ou heartbeat.

Esta escolha conserva os totais + série do summary v2 já planejado e adiciona uma operação independente para atualizar só o gráfico. Retirar a série do summary criaria quebra desnecessária. A UI escolherá um deles para cada atualização, sem chamadas duplicadas.

## Identidades, tempo e algoritmo `route-history-v2`

- `instanceId`: identidade local persistida; nunca selecionada pelo cliente nem inferida de hostname. Somente eventos da proveniência v2, com ambiente fixado pelo coletor em I e cluster confiável de I, são candidatos.
- `workspaceId`: UUID local do Workspace, diferente de key/slug/nome. O mapa liga I + epoch + revision + routeId a W, Release e serviceId do modelo publicado. A associação de uma identidade de rota a W deve ser imutável; reutilização histórica em outro W torna o ID ambíguo, mesmo quando os dois donos não são revisões adjacentes.
- `routeId`: UUID emitido pelo compilador e preservado na configuração; rota recriada recebe ID novo. Nenhum algoritmo recupera um ID por semelhança de URL.
- `recordedAt`: instante registrado transacionalmente pelo CP para o deployment; vigência lógica `[recordedAt, próximo recordedAt)`, com epoch/revision ordenando empates. Rollback cria revisão nova. Não é timestamp literal do commit nem instante de início de serviço no Kong. O mapa só fica visível depois do commit; o intervalo anterior à sua visibilidade não é retroativamente promovido a evidência de aplicação. Mudanças de epoch requerem continuidade comprovada; lacuna não ganha mapa fabricado.
- Para ts do evento, selecionar a última revisão registrada até ts e a imediatamente anterior, conforme a regra base do protocolo v2. Se o mapa estiver incompleto para essas revisões (inclusive a âncora anterior ao período), não atribuir. Se ts precede o primeiro registro, `before-first-revision`.
- A rota precisa aparecer em pelo menos um dos dois candidatos e ter um único dono comprovado no histórico de identidade preservado. Se está ausente, `route-not-deployed`; se mais de um dono, `ambiguous-route`. Não unir uma revisão futura por horário de ingestão nem usar o dono atual do banco. Essa verificação histórica adicional é o endurecimento de `route-history-v2`; as funções puras N3 atuais não devem ser tratadas como sua implementação completa.
- A confiança no cluster considera sua associação histórica à instância no instante do evento, não apenas a lista atual. Sem evidência histórica suficiente: `unknown-cluster`. Evidência incompleta/corrompida de atribuição vira `attribution-evidence-missing`, nunca fallback para v1.
- Deduplicar o ID normativo (SHA-256 cluster|pod|request, 128 bits) e resolver todas as cópias observadas antes de filtros. Diferença em qualquer coluna lógica original, inclusive instância, ts, status e retention, é conflito. Metadados de ingestão/atribuição não integram conteúdo lógico. Nenhum representante de conflito entra em um Workspace; manter evidência enquanto qualquer cópia puder ser servida.
- Motivos base preservados: conflicting-copies, foreign-instance, unknown-cluster, no-route, before-first-revision, route-not-deployed, ambiguous-route. O motivo novo de evidência incompleta exige extensão planejada dos totais administrativos antes da ativação desta política; até lá, retornar 502 analytics-not-ready para a janela que dependa dessa capacidade. Não mudar silenciosamente o enum administrativo existente.
- `effectiveRevision` do evento é sempre null neste slice. `candidateRevisions` informa apenas as revisões usadas para provar o dono; nunca será apresentada como revisão efetivamente servida. Convergência de configuração, collector saudável e tráfego completo são três observações diferentes.

Uma rota removida pode continuar nos candidatos durante rollout/rollback, com ID e dono históricos; depois, eventos de nós muito atrasados ficam não atribuídos quando sua revisão estiver fora dos dois candidatos. Serviço trocado não muda o dono W: filtros usam o serviceId original do evento validado pelo histórico. Nomes atuais só enriquecem IDs já autorizados; exclusão devolve nome null. Nenhum evento anterior ao modelo recebe atribuição sem histórico suficiente.

## Quatro operações e isolamento

Contrato canônico planejado em `control-plane-v2.openapi.yaml`; respostas próprias em `analytics-v2.schemas.json`. Reutilizam `workspace.read`, escopo workspace e segurança sessão/bearer atuais. Não adicionam permissão, papel ou mudança de RBAC.

| Operação GET relativa a `/api/v2/workspaces/{workspaceId}` | Entradas além de from/to | Saída/ordem | Custo máximo estrutural |
| --- | --- | --- | --- |
| analytics/summary | routeId?, serviceId?, interval? | Totais e série crescente, até 2000 buckets; sem cursor | 2 agregações |
| analytics/timeseries | routeId?, serviceId?, interval? | Mesmos buckets, sem totais ou cursor | 1 agregação |
| analytics/top-routes | routeId?, serviceId?, by?, limit? | requests/errors/p95 DESC, nulos por último, empate requests DESC e routeId ASC; até 50 rotas | 1 agregação + 1 lookup em lote |
| requests | routeId?, serviceId?, consumerId?, status? OU statusClass?, limit?, cursor? | ts DESC,id DESC; default 50/máximo 200, `{items,nextCursor}` sem COUNT total | 1 seleção + resolução compartilhada de identidade/mapa |

Mapa e identidade são carregados em lote e têm orçamento próprio dentro da mesma operação. Os números não autorizam scans adicionais ilimitados de preparação. O ranking agrega uma linha por routeId; serviceId é null se os eventos filtrados envolveram vários serviços. Percentis são exatos; não somar/médiar p95. UInt64 de bytes é string decimal sem perda. Contagens acima de Number.MAX_SAFE_INTEGER falham 502, sem arredondamento.

Antes de cache ou tráfego: resolver Workspace, autenticação, permissões atuais, deny e interseção bearer/dono. Workspace inacessível/inexistente e filtro externo têm 404 indistinguível. Workspace arquivado continua legível. Cache inclui I/W/principal/permissões/política/parâmetros/geração dos dados; reautoriza em cada request. Não persistir caches de tráfego no browser nem compartilhar respostas por W apenas.

Filtros se combinam com AND. Rota/serviço/consumidor excluído é elegível se o pertencimento histórico for comprovado no período. Combinação pertencente mas incompatível é 422 com path; IDs externos são 404 sem nome/contagem. Instância, W e identidade estão no predicado do servidor antes de agregar/paginar; nunca filtrar dados de outros W no navegador.

IP mantém a regra existente de papel admin efetivo; demais IPv4 /24, IPv6 /48. Nenhum header/query/body/credencial é retornado. Path já sanitizado não vira filtro livre. Não incluir dados ou contagens não atribuídas nas quatro operações. O endpoint administrativo já planejado continua separado com platform.admin; sua extensão de motivos requer contrato antes de ativar route-history-v2.

## Períodos, paginação, vazios e erros

- Datas RFC3339 com offset explícito, no máximo ms e normalizadas UTC; `[from,to)`, from < to, duração <=7 dias; na primeira página now-7d <= from e to <= now. Um relógio por operação. Nenhum ajuste silencioso. Retenção lógica de cada linha: ts + retention_days > generatedAt, mesmo antes da remoção física por TTL.
- Intervalos 1m/5m/15m/1h/1d, default5m; ceil((to-from)/interval) <=2000. Buckets ancorados em from, último parcial. Vazio: counts/errorRate zero, quantis null; séries com buckets vazios, ranking [], requests []/null. Retenção menor pode deixar lacunas; zero não comprova saúde/entrega.
- Cursor autenticado, opaco, <=4096 caracteres, TTL15min, liga I/W/principal, parâmetros normalizados, from/to fixos, versão de atribuição, posição (ts,id) e expiração. Os parâmetros são reenviados idênticos; adulteração, escopo diferente ou expiração dá 422 em cursor depois da autorização do W. Chave de assinatura é credencial de servidor nunca logada; distribuição/rotação usam mecanismo existente de segredos, com domínio criptográfico próprio. Não reutilizar token de sessão como segredo público.
- Cada página é uma leitura nova, com autorização e expiração atuais. Validade do cursor não congela retenção. From/to da página inicial não mudam na continuação e a checagem de recência não os desliza. Não há snapshot imutável: chegadas tardias podem ficar antes da posição já vista; conflitos/TTL podem retirar itens. Reiniciar a consulta é necessário para reconciliar o intervalo. Não prometer exportação exaustiva nessa API.
- Desconhecidos, repetidos, arrays, datas impossíveis, SQL, regex, path livre, seleção de instância, filtros incompatíveis e limites inválidos: 422 `errors[].path`.
- 401 ausente/expirado; 403 permissão negada quando o escopo é revelável, senão 404; 429 admissão cheia com Retry-After:1 sem iniciar outra query; 502 indisponibilidade, deadline, overflow, budget ou evidência inconsistente. Códigos: analytics-unavailable, analytics-timeout, analytics-budget-exceeded, analytics-not-ready. Mensagens em inglês e RFC9457; não expor SQL/stack/conteúdo oculto. Falha não se converte em 200 vazio.

## Budgets iniciais (proposta, sem benchmark)

Por operação HTTP: <=5 milhões de linhas lidas e <=256MiB lidos agregando todas as queries internas, <=256MiB memória/query, max_threads2, <=10000 grupos, <=5s execução total em banco, <=8s parede (inclui Postgres, fila e serialização), <=2MiB resposta. Overflow sempre throw, nunca break/any. Cancelar consultas ao atingir deadline/desconexão e liberar admissão. Duas simultâneas por principal+W, oito por instância, fila <=1s, depois429. Múltiplas réplicas exigem coordenação; limite só por processo não atende ao contrato. Não implementar global por N chamadas contextuais.

Cache opcional <=15s só com geração consistente e invalidação de conflito/TTL/atribuição; sem esse mecanismo, desabilitar cache de dados. Mapa de autorização nunca ganha TTL maior que sua revogação permite. Nenhum agregado materializado com soma sobre inserts brutos: retries e conflitos tardios exigem retração ou recálculo, não resolvidos por merge eventual. Inicialmente preferir consultas exatas limitadas.

## Persistência futura e migração (nenhuma executada)

1. Postgres: ledger imutável do mapa de deployment `(instance_id,epoch,revision,route_id)` → workspace_id/service_id/release_id, recorded_at, snapshot/config hash e versão/proveniência do mapa. Capturar com o deployment na mesma transação de publicação/rollback, sem mudar sua semântica. Índices por I/epoch/revision e I/routeId/tempo; diretório histórico de identidade da rota preserva dono e evita reutilização entre W. Ausência de service/consumer histórico suficiente deve bloquear esses filtros, não confiar em cadastros atuais.
2. Manter histórico de cluster/instância e continuidade dos epochs. Reter mapas pelo horizonte de consulta + atraso/replay aceito e pelo menos a revisão âncora anterior; tombstones de identidade não podem autorizar reutilização depois da poda. Quantificar crescimento por número de revisões/rotas antes de escolher compressão/deltas.
3. ClickHouse: tabela nova preservando todos os campos lógicos, TTL1..7 e digest de conteúdo completo; ordenação normativa que não colapse cópias divergentes. Candidatos a colunas adicionais derivadas: instance_id, workspace_id nullable, attribution_version/reason, candidate_epoch/revision (nullable, nunca effectiveRevision inventada), received_at e versão/proveniência. Metadados não alteram comparação lógica de cópias.
4. Acesso por id precisa encontrar cópias em qualquer instância/janela/status/retention, inclusive divergências fora do filtro candidato. Avaliar projeção/índice por id + raw lookup e estado exato min/max de conteúdo canônico; não usar apenas countDistinct nem presumir ausência de colisão de digest para descartar conteúdo. Preservar a evidência de conflito até a maior expiração lógica de qualquer cópia servível; chegada aceita estende o horizonte. Poda nunca reatribui um ID restante. Dados já apagados não podem ser reconstruídos; não se promete detectar cópias que não estão mais armazenadas além do horizonte de evidência declarado.
5. Visão contextual candidata `(I,W,ts,id)` é derivada. Leitura precisa provar que raw/copy-state/mapa pertencem à mesma observação; preparação atrasada não serve antigo como correto. Começar com resolução exata no read e budgets, ou introduzir watermark/fence verificável antes de usar projeções assíncronas. Ainda não há watermark confiável na instrumentação atual; adapter fica 502 not-ready até a prova. Conflito tardio invalida materializações/caches antes de próxima resposta elegível; nenhuma soma incremental não retratável.
6. Migração separada e aprovada: nova tabela, cópia por partições com limites, comparação de IDs/cópias/TTL e leituras sombra, corte por configuração controlada. DDL/Helm/Agent são frentes futuras próprias. Não rematerializar TTL nem aumentar retenção de PII implicitamente. Duplicatas idênticas/restart devem produzir mesma leitura antes/depois de merges.
7. Backfill apenas do que ainda existe e tem proveniência v2 + mapa completo. Sem mapa: não atribuído/indisponível explicitamente. Não converter E=W para I nem recuperar por path/slug. V1 continua servindo sua fonte/API/PII como hoje; telas identificam legado, sem juntar séries silenciosamente. Rollback de serving volta ao v1 explicitamente rotulado, nunca substitui resposta v2 por v1.

## Custo estimado, com premissas

Sem amostra de compressão ou capacidade medida. Fórmula de raw: R ×86400×7×b×(1+d), b=200..500 bytes comprimidos/evento e d=10% cópias por retry. São cenários, não previsão do DEV:

| Tráfego constante | Eventos lógicos/7d | Raw com 10% cópias |
| --- | --- | --- |
| 10/s | 6.048.000 | 1,33..3,33 GB decimais |
| 100/s | 60.480.000 | 13,31..33,26 GB |
| 1000/s | 604.800.000 | 133,06..332,64 GB |

Quatro UUIDs + dois UInt64 + dois DateTime64 novos custam nominalmente até96 bytes/linha antes de compressão (campos finais dependem do adapter); 100/s×7d corresponde a5,81GB nominais extras sem retries. Reservar inicialmente 2..3 vezes raw para cópia coexistente, serving/copy-state/índices, depois medir; não é teto comprovado. Mapas full snapshot: 10000 rotas×100 revisões/dia×7d×100bytes ≈700MB nominais, mais índices/âncora; histórico de identidade é adicional. Deltas podem reduzir armazenamento, com custo maior de reconstrução.

5M linhas em 200..500bytes representam1..2,5GB: budget256MiB limitará antes do teto de linhas se os bytes lidos tiverem essa ordem. Uma janela completa de alto volume pode responder budget-exceeded; não se promete sete dias a1000/s sem rollups contratados/índices medidos. Quantis exatos e verificação de todas as cópias podem dominar memória/IO. Retenção de estado de conflitos exige medição separada e não pode ser escondida dentro do custo raw.

Estimativa de esforço do executor, sem compromisso de calendário: política/fixtures e mapa histórico 3..5 dias; adapter/migração/consistência/dedupe 5..8; quatro queries, autorização/cursor/budgets 4..6; UI contextual e testes integrados 3..5; total15..24 dias de engenharia, com revisão. Instrumentação de revisão efetiva e implantação/certificação N2 ficam fora. Nenhuma infraestrutura paga está autorizada; custo monetário depende de volume real, benchmark e decisão humana de capacidade.

## Matriz de testes e incrementos

| Área | Evidência requerida antes de servir |
| --- | --- |
| Contrato (este PR) | lint, schemas/exemplos válidos e negativos, generated diff, quatro operações planned sem handlers |
| Identidade/atribuição | dois W com paths iguais, UUIDs distintos; rota removida/recriada; reutilização ambígua não adjacente; mudança serviço; rollback/epoch; ts de fronteira; mapa ausente/âncora; cluster histórico; effectiveRevision null |
| Cópias reais | retries/restart antes/depois de merge; conflito fora de I/janela/status/retention; TTL divergente; chegada tardia; estado pendente; sem ressurreição após poda; nenhuma representante conflitante |
| Isolamento | bearer/dono/deny/revogação; cache; W externo/arquivado; filtro externo; consumer/serviço histórico; nenhum conteúdo não atribuído no W |
| Consultas | [from,to), recência, 7dias, 2000 buckets, vazios/zero/null, rank e empate, mudança histórica serviço, UInt64 máximo, overflow contagem, cursor adulterado/repetido/expirado/outroW, páginas novas após TTL/conflito |
| Custo/UX | budgets reais, cancelamento e admissão entre réplicas, 429/502; contagem constante de queries, nenhum fan-out; 390/768/1440 e axe; legado/v2 explicitamente distintos |

Primeiro PR após aprovação: `feat(analytics): validate workspace attribution history` — tipos/política `route-history-v2`, fixtures normativas e testes determinísticos reais; sem endpoints habilitados ou migração operacional. Depois: persistência transacional do mapa/identidades (migração em PR próprio), adapter ClickHouse e prova de cópias/retention/fence, queries/cursor/budgets com guards existentes, testes de integração em banco isolado, UI workspace e aceite autorizado. Remover planned de cada operação somente quando seu handler/aceite existir. Não bloquear tudo atrás de um PR de instrumentação efetiva: esta fica como capacidade futura com contrato próprio.

## Decisões para aprovação humana

Aprovar política conservadora com effectiveRevision null; aceitar paginação viva e ausência de exportação exaustiva; aprovar budgets iniciais sujeitos a benchmark; selecionar estratégia de prova de consistência do adapter antes de implantação; aprovar extensão futura de motivos administrativos; reservar escopos próprios de migrations/instrumentação. Aprovação deste contrato não autoriza merge de implementação, operação no ClickHouse, deploy ou mudança de RBAC.
