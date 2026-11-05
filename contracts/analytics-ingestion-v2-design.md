# Analytics v2 — ingresso verificável e leitura por prefixo aceito

Estado: proposta R18 para aprovação humana. Contrato separado, sem handlers, migrations, ativação ou mudança no legado. Complementa `analytics-v2-design.md`; as quatro operações HTTP permanecem planned. Implementações dependentes devem apontar para este PR e continuar sem merge até aprovação própria.

## Fonte observada e alternativas

Kong `http-log` é configurado exclusivamente por `packages/compiler/src/platform-plugins.ts`. Sua fila POSTa ao Vector com o token de coletor via vault/env; o Agent aplica configuração, não transporta os eventos atuais. Vector autentica token atual/anterior, decodifica lotes, mascara e permite somente campos conhecidos, fixa cluster da configuração e ambiente esperado, deriva ID por cluster/pod/request, deduplica somente ID em cache20000 e grava ClickHouse com acknowledge e buffer em memória. DDL atual é MergeTree/TTL por evento. Não há offset durável da origem ou fence persistida. O contrato de token exclusivity/health possui frentes draft próprias; não presumir implementação nem usar health como prova.

Alternativas: corrigir só o dedupe do legado não fornece origem nem fence e pode alterar os totais antigos. Acrescentar `workspace-v2` ao raw também não autentica nada. A proposta é um caminho v2 isolado: produtor explicitamente autorizado, admissão transacional, cópias preservadas, confirmação concreta de persistência e leitura conservadora. O legado continua com seus arquivos, tabela, API e semântica; sem backfill ou promoção de registros antigos.

## Autoridade e fronteira de confiança

A autoridade proposta é o Control Plane existente, reutilizando a autenticação de node bearer já emitido no registro do Agent. Não criar CA, chave privada, bearer público ou segredo novo por evento. O CP pode autorizar um stream v2 dedicado para um node autenticado, associado ao cluster e à instância locais; podUid canônico é vinculado na abertura. A instância e o cluster vêm do banco e da identidade autenticada, nunca de seleção do cliente. É uma nova autorização explícita de produtor no contrato, não uma capacidade presumida da string enviada.

A abertura e cada envio revalidam bearer, node/cluster, protocolo v2, associação histórica autorizada e sua observação. Credencial inválida/revogada, origem externa, stream de outro node ou binding incompleto recusam admissão. Re-registro usa a identidade técnica que o CP autoriza; não atesta pod físico Kubernetes. Transferência entre instâncias não é suportada. Não registrar token ou hash de autenticação em evento, ledger, audit, erro ou diff.

Somente o pipeline v2 dedicado pode construir o envelope: entrada de http-log com marcador de protocolo v2 emitido pelo compilador, autenticação local de coletor e pinning de I/C/P; saída autenticada pelo produtor autorizado. A aplicação valida o binding e o ID normativo; campos declarados como trusted/provenance/copiesComplete não são aceitos no wire. Marcador ou validade JSON isolados não provam origem. O wiring operacional, entrega protegida da credencial ao coletor e transporte TLS exigem escopo/deploy posterior; testes locais usam origens sintéticas explicitamente identificadas.

Limite de confiança: autenticação prova qual produtor autorizado admitiu os dados e a integridade posterior dessa admissão. Não é prova independente de um pacote físico observado pelo Kong. Um produtor/credencial privilegiado comprometido pode fabricar eventos; detecção de conflito não detecta toda falsificação de IDs inéditos. Se essa autoridade proposta não for aprovada ou a topologia protegida não puder ser comprovada, proveniência permanece unknown. Nunca inferir origem a partir da associação atual ou do horário de entrega de configuração.

## Envelope e validação

Schema canônico: `analytics-ingestion-v2.schemas.json`; exemplo sintético em `examples/analytics-ingestion-v2.example.json`. `OpenStream` recebe somente podUid; nenhum instanceId, clusterId ou workspaceId selecionável. `IngestionCopy` contém schemaVersion1, copyId aleatório técnico da cópia, podUid, requestId de32hex e o evento lógico original. Uma transmissão contém1..100 cópias, no máximo2MiB decodificados; conteúdo adicional é recusado. NDJSON é apenas framing dessas cópias, não fonte de autoridade. Unicidade de copyIds e soma de contagens do recibo (igual ao descritor admitido,1..100) são validações semânticas adicionais, não garantias inferidas da validade do JSON Schema. Copy IDs únicos no lote, schema estrito, path sanitizado até2048caracteres, sem query/fragmento, credenciais/headers/body proibidos.

ID normativo permanece SHA256 UTF-8(clusterId|podUid|requestId), primeiros128bits em UUID; componentes já canônicos, sem normalização reparadora. Recalcular e comparar, não confiar no ID declarado. UUIDs de rota/serviço/consumidor são técnicos; nomes/paths/Workspace atual não atribuem. Tamanhos são strings UInt64 exatas até18446744073709551615. Número JS inseguro é erro, não conversão. ts é UTC com ms; sem futuro ou período admitido maior que7dias. Latências precisam ser Float64 finitos, não negativos; recusar literais JSON com overflow (como1e400), Infinity e NaN após decode. Validadores devem manter strictNumbers:true mesmo quando strict:false for necessário para compatibilidade. Retenção individual1..7dias pelo instante original. O cliente nunca fornece Workspace ou effectiveRevision.

Proveniência interna pode ser legacy, unknown, invalid, conflicting ou verified-v2; os três primeiros não são promovidos. Verified-v2 exige binding autenticado e evidência de admissão/persistência verificável. Dois preimages normativos ou metadados de origem incompatíveis impedem atribuição. Conteúdo alterado após admissão viola seu commitment de integridade. Digest de conteúdo não substitui comparação exata para deduplicar cópias; todas as linhas reais continuam sendo examinadas.

## Preservação, retry e privacidade

Caminho novo usa tabela própria e writer separado. Preservar cópias brutas servíveis antes de filtros e sem dedupe por ID no Vector. Mesmo ID com diferenças em qualquer coluna lógica é conflito. Retried batches mantêm copyIds; uma nova captura/replay pode receber copyId novo sem se tornar nova requisição lógica. Nunca escolher primeira/última cópia como verdade. O armazenamento não promete exactly-once.

Admissão persiste IDs técnicos, quantidade/ordem das cópias e commitments de integridade, sem payload/PII no ledger PG. Escrita CH ocorre fora da transação PG. Repetição compara identidade e conteúdo observado; uma colisão de chave de lookup não autoriza sobrescrita. Todas as cópias encontradas no CH são comparadas exatamente, inclusive fora de instância/janela/status/retention do candidato. Commitments autenticam persistência; não colapsam conteúdo por igualdade de hash.

Conflito comprovado fica em ledger compacto sem representante, IP, path ou outros dados pessoais. Seu horizonte cobre a maior expiração original servível, estendendo com cópias aceitas. Payload individual nunca ganha TTL novo por replay. Se payload anterior já expirou e a equivalência exata não puder ser demonstrada, reter tombstone técnico de incompletude e recusar atribuição; não reconstruir dados apagados. Metadados de comparação têm horizonte explícito limitado à janela/replay de7dias, sujeitos a poda testada que não ressuscite IDs. Eventos expirados podem contribuir para conflito com uma cópia ainda servível sem guardar novamente seu payload pessoal.

## Posições e confirmação

A posição é atribuída pelo próprio CP a um lote admitido, em contador transacional sob serialização. Não é offset nativo do Kong/Vector. Incremento, descritor e audit são atômicos; abort não consome posição nem deixa preparação parcial. Identidade do stream e contador sobrevivem ao reinício do processo. Idempotency key técnica é vinculada ao stream e comparada exatamente; não equivale ao RequestID.

Estados distintos: preparado no PG; cópias enviadas ao CH; persistência observada por leitura limitada/exata; recibo confirmado no PG. ACK ao produtor somente após recibo. Falha entre sistemas deixa preparação sem confirmação, nunca uma atomicidade distribuída fictícia. Falha parcial/retry pode criar cópias adicionais; prova exige todas as posições/índices declarados presentes e coerentes, ou disposição de expiração comprovada, antes de confirmar. Batch conflitante/corrompido não recebe ACK de sucesso. Auditoria acompanha cada mutação do CP na mesma transação.

Restart não fabrica continuidade: recibos duráveis permanecem; posições pendentes continuam lacunas. Se replay exato ou reconciliação puder demonstrar persistência completa, confirmar idempotentemente; caso contrário manter not-ready. Perda antes da admissão, overflow/falha da fila Kong e perda não recuperada de buffer Vector continuam possíveis. Não há garantia de entrega integral de requisições.

## Fence e significado de completude

O fence cobre **todas as cópias admitidas/persistidas até uma posição**, sob uma observação coerente. Não fecha tempo de evento, não promete que não haverá chegada tardia e não prova todos os requests emitidos. Essa separação mantém o contrato existente de leitura do que foi armazenado e paginação viva; upstreamComplete não é certificado. Timestamp recente, heartbeat, container healthy ou ausência de eventos não estabelecem nenhuma prova.

copiesComplete deriva do prefixo transacional sem lacunas relevantes e dos dados efetivamente recuperados; conflictHistoryComplete exige ledger/tombstones suficientes para os IDs; coherentSnapshot exige uma visão real estável. Sem prova, o campo correspondente é false e o adapter retorna analytics-not-ready. Não há configuração que force true.

Estratégia inicial conservadora: escritor serializa preparação/recibo por lock PG; leitor adquire shared lock de sessão ANTES de BEGIN REPEATABLE READ READ ONLY, para não obter snapshot anterior à espera. Só depois fixa asOf, posição e históricos. Snapshot adquirido por SELECT de lock dentro de RR antes de esperar não serve como prova. Escritas CH fora da transação só existem com lote preparado; lote pendente impede prontidão. Leitor limita duração da retenção do lock e libera/destroi conexão corretamente em erro/cancelamento.

Além da coordenação, verificar recurso CH e conjunto de partes imutáveis antes/depois da leitura, sob sessão HTTP única com session_check para recusar mudança de backend. Schema/engine não suportado, parte alterada por merge/TTL/inserção, dado sem recibo/binding ou prova insuficiente tornam leitura incoerente. Não usar um hash do conjunto como comparação exata; limitar quantidade de partes e comparar identidades técnicas. Não presumir transação comum entre Postgres e ClickHouse. Implementação deve demonstrar esses mecanismos em ClickHouse25.8 descartável; até lá false.

## Adapter e limites

Cliente novo, sem alterar v1; UInt64 como strings, SQL parametrizado, identificadores escolhidos pelo servidor. Candidatos em página limitada porI/tempo, depois TODAS as cópias dos IDs em lookup global antes dos filtros de Workspace/status. Estado de conflito e origem são resolvidos antes de chamar route-history-v2. Mapas de rota e cluster vêm de uma única visão PG. Não duplicar a atribuição; effectiveRevision permanece null.

Preservar limites aprovados:7dias,5Mlinhas e256MiB lidos agregando queries,256MiB memória/query,max_threads2,10000grupos,5s banco/8s parede,2MiB resposta, página50/max200. Bytes decodificados não substituem read_bytes do engine. Sem overflow parcial. Aplicar budgets restantes em cada query e medir leitura real. Paginação interna determinística tsDESC,idDESC; cursor público autenticado continua incremento futuro. Sem cache até prova de invalidação; cada página nova reavalia TTL/late conflicts. Cancelar consultas e liberar lock/admissão. Concorrência entre réplicas via PG:2 por principal+Workspace,8 porinstância e fila até1s, sem N+1 global.

Não habilitar endpoint HTTP de Analytics nesta R18. Binding operacional do produtor, provisão de roles/credentials e deployment ficam fora; novo CI/CD permanece com Codex do Mac mini. Nenhuma migration/backfill operacional ou publicação oficial de imagem.

## Aceite e sequência

A: schema, exemplo, negativos e este contrato isolados. B: cópias/TTL/conflitos e pipeline v2 isolado, Vector real, retries/restart/falhas parciais em recursos descartáveis. C: produtor autenticado, descritores/contador/recibos, lacunas, reconciliação e fence com provas de persistência. D: queries limitadas, UInt64, paginação, consistência e histórico, positivos/negativos PostgreSQL+ClickHouse. PRs dependentes explicitam a pilha e permanecem sem merge.

Obrigatórios: origem desconhecida/revogada/externa, flags declaradas sem prova, alteração de evento, replay indevido, identidade/preimage conflitantes; cópias idênticas/conflitantes antes/depois de reinício e compactação, fora de filtros e TTL diferentes; falha antes/durante escrita/confirm, cancelamento, atraso, novo stream e gap; mudança de partes/backend; budget real e retorno sem PII. Dois Workspaces com mesmo path, rota removida/recriada, cluster revogado, rollback e predecessor ausente. Fixture identifica origem sintética e premissas; nenhuma configuração operacional marca completude verdadeira.

Fontes primárias consultadas: [Vector dedupe](https://vector.dev/docs/reference/configuration/transforms/dedupe/), [acknowledgements](https://vector.dev/docs/architecture/end-to-end-acknowledgements/), [HTTP source](https://vector.dev/docs/reference/configuration/sources/http_server/), [ClickHouse HTTP sessions](https://clickhouse.com/docs/concepts/features/interfaces/http), [cliente JS](https://clickhouse.com/docs/integrations/language-clients/js/index). Documentação não substitui runtime no harness.
