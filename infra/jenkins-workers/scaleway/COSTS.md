# J8 — comparação oficial, consultada em 05/11/2026

Proposta, sem conta criada, contratação, recurso pago ou autorização financeira. Não há duração de build, benchmark, latência Brasil↔cloud nem quota de conta medidos. As moedas abaixo são as de cada catálogo; **não são conversões EUR/USD/BRL nem preço final brasileiro**. Impostos, IOF, câmbio, suporte e descontos dependem da futura conta. 730h é apenas a premissa mensal comparável.

## Recomendação principal: Scaleway, Paris fr-par-2

Dois workers nativos8vCPU/32GiB, BASIC3-X8C-32G AMD64 (€0,236797/h) e BASIC2-A8C-32G ARM64 (€0,137800/h), mais DEV1-S2vCPU/2GiB coordenador/relay (€0,008976/h). **Compute total €0,383573/h**. A API pública retornou os três tipos disponíveis na zona; não é reserva, quota de conta ou promessa de capacidade futura. Região europeia aumenta a distância ao Mac/Jenkins; não alegamos desempenho medido. Escolha baseada em par nativo com estoque público consultável, preço integral verificável e módulo reproduzível já validado. OCI abaixo é mais barata no catálogo, mas sem prova de estoque A1. AWS oferece regiões brasileiras/americanas com custo de compute maior no catálogo.

572GB decimais SBS5K: boot35GB×3, work216GB×2+35GB coordenador. €0,000129999/GB/h = **€54,2824/mês**. Três IPv4 retidos: €0,005/IP/h = **€10,95/mês**, mesmo sem compute. Piloto de100GiB object MultiAZ (107,374GB decimais): €0,000022/GB/h = **€1,7244/mês**, opcional/inativo. Compute, discos, IPs, objeto e snapshots são cobranças distintas.

| Cenário | Compute | Discos+IPs mês | Piloto objeto | Total estimado sem impostos/backup/excesso de tráfego |
|---|---:|---:|---:|---:|
| Econômico recomendado: cada máquina100h, parada no restante | €38,3573 | €65,2324 | €1,7244 | **€105,31/mês** |
| Contínuo: as três730h | €280,0083 | €65,2324 | €1,7244 | **€346,97/mês** |
| Híbrido: coordenador730h, workers100h cada | €44,0122 | €65,2324 | €1,7244 | **€110,97/mês** |
| Recursos próprios existem somente100h, depois exclusão/liberação autorizada; objeto fica mês | €38,3573 | €8,9360 por100h | €1,7244 | **€49,02** |

A última linha exige exclusão de discos/IPs e reprovisionamento posterior; **não** é o comportamento automático deste módulo, cujos guards impedem destruição. Recomendo começar com a primeira: agrupar execuções em sessões, parar **as três** máquinas ao terminar e preservar discos inicialmente para qualificar o processo. Se persistência mensal ficar desproporcional ao uso, autorizar separadamente o ciclo efêmero após provar archive/restore/reset; ele reduz custos sem reusar discos PR como Main.

Scaleway: cobrança mínima60min por recurso/período; parada `stopped` suspende compute, `standby` não. Disco/IP alocado continua cobrado. Custo por build só poderá ser medido após CI real: somar por máquina sua duração faturável, respeitando mínimos, mais bytes/retensão/tráfego. Não tratamos1h hipotética como build medido. Um novo acionamento curto das três pode custar pelo menos€0,383573 em compute.

Object storage regional: requisições e entrada incluídas, tráfego regional gratuito;75GB/mês de saída internet incluídos, depois€0,01/GB segundo catálogo. A franquia pode ser compartilhada com consumo da conta; não assumida garantida ao projeto. Snapshot block: €0,000049/GB/h; snapshot completo hipotético de572GB por730h = **€20,46 adicionais**, não ativado e não substitui restore testado/backup independente.

Fontes oficiais: [tipos/preços API](https://api.scaleway.com/instance/v1/zones/fr-par-2/products/servers), [estoque](https://api.scaleway.com/instance/v1/zones/fr-par-2/products/servers/availability), [catálogo de storage/rede](https://api.scaleway.com/product-catalog/v2alpha1/public-catalog/products), [storage](https://www.scaleway.com/en/pricing/storage/), [rede](https://www.scaleway.com/en/pricing/network/), [estados e cobrança](https://www.scaleway.com/en/docs/instances/reference-content/instance-states/), [mínimo de faturamento](https://www.scaleway.com/en/docs/billing/faq/). JSONs brutos e cálculo reproduzível preservados em evidence/j8/public-catalogs e cost-calculation.json.

## Alternativa econômica: OCI, São Paulo, sujeita à capacidade A1

Mesmo objetivo de capacidade: AMD64 **VM.Standard.E5.Flex4OCPU/32GB** (8vCPU), ARM64 **VM.Standard.A1.Flex8OCPU/32GB** (8cores nativos) e coordenador E5.Flex1OCPU/2GB. Um OCPU x86 equivale a2vCPU; A1 tem1core porOCPU. Não confundir A1 com A2, em que4OCPU já fornecem8cores.

Catálogo oficial: E5CPUUS$0,03/OCPU/h + RAMUS$0,002/GB/h; A1CPUUS$0,01/OCPU/h + RAMUS$0,0015/GB/h. Resultado **US$0,184 +0,128 +0,034 = US$0,346/h**; **US$34,60/100h**, **US$252,58/730h** em compute bruto. Não descontamos créditos/free-tier/A1 allowances sem comprovar elegibilidade/consumo da tenancy. Preço regional uniforme de catálogo, não confirmação de quota/estoque em São Paulo, EUA ou Europa. A própria documentação alerta sobre capacidade limitada A1; alternativa exige confirmação em availability domain antes da escolha final.

Discos OCI mínimos: boot50GB×3, work216GB×2+35GB coordenador = **617GB**, Balanced10VPU/GB. BaseUS$0,0255+10×US$0,0017 = **US$0,0425/GB/mês**, total **US$26,2225**. Object100GiB, admitindo unidade oficial GB binária conforme medidor OCI: estimativa bruta **US$2,55/mês** aUS$0,0255/GB/mês, sem benefício gratuito. Confirmar unidade no orçamento da tenancy antes de aprovação. Estimativa subtotal100h+discos+objeto **US$63,37/mês**, **exclui IP/requisições/saída/backup/impostos não cotados nesta sessão**; não é all-in comparável aos€105,31. OCI usa mínimo1min; Standard stopped pausa compute, discos persistem. Nenhum SLA de provisioning/capacidade foi comprovado.

Essa alternativa exige adaptar o módulo ao provider/boot metadata/volumes OCI e repetir dry-run/revisão antes de apply; a IaC entregue e testada é a da recomendação principal. Não assumimos que o serial SCW e o cloud-init de enrollment sirvam no OCI. Se A1 estiver disponível, é a melhor candidata a reduzir o custo em moeda do catálogo; escolha comercial final depende do orçamento em moeda de cobrança/impostos e desempenho real.

Fontes: [lista oficial](https://www.oracle.com/cloud/price-list/), [shapes/arquiteturas](https://docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm), [block volumes](https://www.oracle.com/cloud/storage/block-volumes/faq/), [parada/faturamento](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/resource-billing-stopped-instances.htm), [contrato de créditos vigente08/10/2026](https://www.oracle.com/tr/contracts/docs/paas_iaas_universal_credits_3940775.pdf). Catálogo salvo atualizado02/11/2026 contém preços USD e BRL próprios; não fizemos conversão.

## Terceira opção: AWS, Brasil/EUA/Europa

M7i.2xlarge AMD64 + M7g.2xlarge ARM64 (8vCPU/32GiB cada), t3.small coordenador2vCPU/2GiB. Apenas compute Linux sob demanda, sem Savings Plan/Spot/compromisso:

| Região | AMD64/h | ARM64/h | Coord/h | Total/h |100h |730h |
|---|---:|---:|---:|---:|---:|---:|
| EUA N.Virginia us-east-1 | US$0,4032 | US$0,3264 | US$0,0208 | **US$0,7504** | US$75,04 | US$547,79 |
| Brasil São Paulo sa-east-1 | US$0,6426 | US$0,5202 | US$0,0336 | **US$1,1964** | US$119,64 | US$873,37 |
| Europa Paris eu-west-3 | US$0,4704 | US$0,3808 | US$0,0236 | **US$0,8748** | US$87,48 | US$638,60 |

Três IPv4 aUS$0,005/IP/h somamUS$10,95/mês. EBS gp3/S3/requests/egress/backup/impostos **não estão incluídos**; não foi confirmada nesta sessão uma cotação regional completa de gp3, portanto não inventamos total mensal all-in. T3 tem créditos CPU: coord deve ser medido para evitar cobrança adicional em Unlimited ou esgotamento no Standard. Linux cobra por segundo, mínimo60s; stopped mantém EBS e IPs reservados. EC2 catálogo regional não prova quota/capacidade da conta. Traz operação madura e região Brasil, mas preço inicial não favorece nosso piloto esporádico.

Fontes oficiais: [M7i](https://aws.amazon.com/ec2/instance-types/m7i/), [M7g](https://aws.amazon.com/ec2/instance-types/m7g/), [preços/billing](https://aws.amazon.com/ec2/pricing/on-demand/), [IPv4](https://aws.amazon.com/vpc/pricing/). Feeds oficiais regionais b0.p.awsstatic.com salvos como aws-{virginia,saopaulo,paris}-small.json em public-catalogs; taxas acima extraídas das três shapes exatas, não de agregador.

Hetzner foi considerado, mas CX/CAX relevantes constavam indisponíveis; não foi promovido a plano contratável. Não há benchmark equivalente entre vCPU compartilhada, core ARM físico e x86 SMT. A primeira qualificação medirá tempos, CPU/RAM/disco/rede antes de assumir equivalência operacional.

## Storage progressivo e autorização mínima

Object S3 privado/versionado na mesma região, opcional, sem backend conectado: piloto100GiB€1,72; habitual250GiB€4,31; ampliado500GiB€8,62 por730h, mais versões/multipart/tráfego/backup. Limite é orçamento de admissão, não hard quota nativa; precisa reserva atômica/contagem real antes de habilitar. Não apagar evidência para caber. Ultrapassar orçamento falha explicitamente e solicita expansão autorizada. Backup/restore/retention/ACL e artefatos parciais precisam prova real. Não comprar2,4TiB por teto hipotético de fixtures.

Menor proposta preparada para começar **qualificação e CI PR nativa**: autorizar três hosts/Paris acima por sessões e572GBdiscos+3IPs. PilotoS3 pode ser autorizado separadamente após qualificação, sem impedir diagnóstico inicial. Isso **não basta para declarar toda matriz/Kong/publisher/CD qualificados**. Main exige geração nova; image coordinator/publisher precisam discos maiores e seus próprios gates. Prazo comercial não verificável sem conta/quota. Intervenções: conta/pagamento/MFA, orçamento e apply exato, chaves dedicadas/console, rota privada do Mac/Docker, evidências de isolamento e aprovação das identidades/ACLs antes de registrar agentes. Automação futura: cloud-init, instalação com identidade/volume/hash, configuração inativa, testes de diagnóstico; nenhuma dessas ações foi executada no host atual.
