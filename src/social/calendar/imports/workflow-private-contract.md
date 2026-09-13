# iA4tube — candidato de execução e transferência privada por Workflow

13/09/2026. Implementação candidata, desativada por padrão. Provas locais não equivalem a funcionamento no Render. Nenhuma tarefa paga foi executada.

## Contrato oficial utilizado

Dependência direta exata `@renderinc/sdk@1.1.0`, npm oficial, integridade `sha512-8KQs5YRkY7zPMfGEJINra7NiAsNr8dbD0da3zNnNuxkxVlTsiStXE1oqlWPHcFjnAl8ofUftexZ6J0XaAebTqA==`. Instalada com scripts desabilitados; as duas dependências AWS anteriores foram preservadas, não ativadas. Nenhuma atualização ampla das dependências existentes foi solicitada.

O cliente usa `new Render({token})`, `workflows.startTask(slug,[{executionId}],signal)`, `getTaskRun`, `listTaskRuns` e `cancelTaskRun`. Não inventa endpoint, cabeçalho de idempotência, propriedade de contexto ou identificação de execução fornecida pelo TaskContext. O objeto oficial TaskContext só documenta `run()` para encadeamento.

`workflows/calendar-media.mjs` é o ponto de entrada efetivo: `node workflows/calendar-media.mjs`. Registra `prepareCalendarMedia`, plano `flex`, `timeoutSeconds:180`, `retry:{maxRetries:0}`. A API não chama `runTask`, não aguarda indefinidamente e não dispara outra execução após erro de criação. O limite de espera do cliente é 15 segundos: o argumento AbortSignal documentado é usado no start; métodos de consulta sem esse parâmetro têm espera local limitada. Isso NÃO cancela a tarefa remota nem libera uma reserva. Cancelar exige método próprio e sua resposta ainda não comprova encerramento do subprocesso.

Fontes primárias consultadas: [SDK TypeScript](https://render.com/docs/workflows-sdk-typescript), [disparo](https://render.com/docs/workflows-running), [definição de tarefas](https://render.com/docs/workflows-defining), [repositório oficial](https://github.com/render-oss/sdk), [registro npm 1.1.0](https://registry.npmjs.org/@renderinc%2Fsdk/1.1.0). Estes links identificam contratos, não evidência de conta/recurso contratado.

## Composição completa, sem ativação implícita

`createWorkflowOperationalComponents` retorna indisponível quando `enabled` não é true. Quando configurado explicitamente, verifica a store existente e cria journal, ponte privada, worker remoto, runners de inspeção/preparo, provider de upload, result store e fila. `resultStore`, `preparation`, `provider` e `upload` alimentam a factory operacional do calendário já existente. O retorno `handlePrivateRequest(req,res)` deve ser montado antes do parser JSON global e do roteamento público; não monta nada sozinho.

O retorno `tick()` é a entrada finita de progresso para o start assíncrono real do SDK. Não instala timer e não é chamado pelo GET de status. Um chamador operacional futuro deve invocá-lo em cadência explícita e sem sobreposição; chamadas simultâneas nessa instância compartilham a mesma Promise. Cada passagem observa no máximo um upload em verificação e uma preparação; só então pode retomar até uma intenção já persistida de cada espécie e despachar uma seleção pendente. A política owner é reconferida antes de cada operação, os journals duráveis impedem lançamentos duplicados entre processos e nenhum trabalho novo é despachado enquanto uma execução não tiver entrega E capacidade liquidadas. Prazo cooperativo de 60 s impede iniciar a próxima operação; a observação SDK em curso tem sua própria espera limitada. Nenhuma reserva é liberada por timeout de espera. A composição e este tick são exercitados pela mesma factory real na fixture, não por uma segunda implementação.

O bloqueio examina também os journals predecessores claimed/não liquidados, mesmo se uma falha acontecer antes do registro Workflow. Intenções nunca claimed continuam resumíveis. Depois de revogar a elegibilidade, este tick não progride nem despacha: a via de observação/liquidação explícita dos runners (`getByKey`) continua disponível ao coordenador confiável, sem reativar o owner. Não se afirma que revogar a conta drena automaticamente todas as reservas.

Parâmetros: store PostgreSQL genuína e owner permitido; capacidade global; admissão de fonte/preparo; política de acesso; evidência de espaço; `privateRoot`, `preparationRoot`, `publicApiOrigin`; catálogo/trilha e `musicRoot` opcional; `bridgeKey` Buffer de exatamente 32 bytes; adaptador SDK; `clock`. Para provas controladas, `allowControlledForTests:true` aceita somente o adaptador com marca de teste. Cópias de objetos não satisfazem as marcas. Para uma futura prova autorizada no Render, `validationOnly:true` é explícito. **Nenhum booleano `remoteRuntimeVerified` torna o candidato pronto**: `remoteWorkflowVerified:false` e `readyForProduction:false` permanecem no worker. A liberação operacional depende da evidência física/configuração do host exato, ainda não produzida nesta missão.

Não existe `getAPIserverConfig` vazio, endpoint presumido ou dispatch automático de inicialização. A composição requer os recursos conhecidos do projeto como argumentos, não varre variáveis ou credenciais. Não aplica migrations. Usa a extensão `workflowExecutions` no JSON da tabela `import_upload_state` já protegida por RLS/role restrita; o guard da store valida o namespace em toda atualização.

## Identidade e persistência

O journal existente primeiro comprova autorização, reserva global e claim; só então o journal da ponte registra a execução. Preserva empresa, usuário, asset, upload, revisão, digest, deadline, resultRef e intenção. `attempt` é persistido ANTES de chamar o SDK. Uma resposta de start perdida deixa `runId=null`, mas `dispatchAttempted=true` proíbe repetir o start. Observação procura no máximo quatro páginas de 100, com orçamento total de espera; somente um input exatamente correspondente pode recuperar o runId. Ausência/duplicação de resultados deixa estado incerto.

Somente `{executionId}` — UUID opaco sem outros campos — acompanha a chamada armazenada no Workflow. Resultado retornado ao SDK é `{executionId,state}`, com estados fechados. Mídia, tarefa detalhada, seleção, música, dados de empresa, nomes/caminhos, tokens e URLs não aparecem nos argumentos/resultados do Workflow. Diagnósticos próprios contêm apenas códigos fechados. É necessário confirmar no Render que proxy/instrumentação também não registram cabeçalhos/corpos privados.

O primeiro coordenador autenticado recebe um `agentId` aleatório e único. Claim concorrente com outro agentId é rejeitado, mesmo após timeout. A mesma instância pode repetir leituras/retorno exato. Nova tarefa ou processo após perda de disco efêmero NÃO rouba o claim. O coordenador não recebe conexão de banco nem credencial Instagram.

## Transporte, confiança e disco

O disco da API e o do Workflow NÃO são compartilhados. Caminho de API fixo: `/internal/calendar-media/workflow/<executionId>/<ação>`, com ações fechadas `claim`, `source`, `music`, `manifest`, `part/<sha256>`, `complete`, `status`. URL não contém token ou grant bearer. Não existe listagem de tarefas, GET genérico, caminho de arquivo fornecido pelo cliente ou comando livre.

Origem HTTPS fixa, sem usuário/senha, caminho, query ou fragmento. Validação TLS fica ativada e redirecionamentos não são seguidos. HTTP somente em loopback explicitamente marcado para testes. **O DNS privado HTTP normal de um serviço Render não é automaticamente aceito**: a rota TLS privada, certificados confiáveis e comportamento da rede devem ser confirmados no destino. Não se afirma tráfego privado sem custo usando uma rota pública como se fosse rede interna.

"Privada" também descreve o conteúdo autenticado, não garante topologia de rede interna. Uma origem HTTPS pública da API, com estas rotas autenticadas e controles de logs, pode ser candidata futura mediante autorização e avaliação de tráfego/custo; isso não a transforma em rede privada Render nem comprova ausência de cobrança de saída. Não foi escolhida ou ativada nenhuma rota nova nesta missão.

Autenticação HMAC vincula execução, método, ação, agentId, timestamp, tamanho e SHA-256. API resolve empresa/fonte/revisão exclusivamente do journal; não aceita o dono enviado no URL. Janela de timestamp: 90 segundos. A chave de serviço é segregada e compartilhada apenas entre coordenadores API/Workflow; dela derivam MACs por execução. **A credencial raiz de bootstrap é do serviço, não uma credencial irreversivelmente limitada a uma única tarefa**. Conhecimento de outra identidade válida mais comprometimento do coordenador é risco de confiança residual. Não há endpoint de enumeração. O processo de conversão recebe só entrada projetada e ambiente mínimo, não a chave de ponte, token Render, banco ou Instagram. Isso não equivale a um sandbox completo contra exploração hostil do SO.

Fonte original e música são transferidas com tamanho/hash conferidos. Música é lida exclusivamente do diretório de catálogo configurado, sem symlink, com arquivo MP3/WAV e hash conhecido; trilha sintética somente quando autorizado pelo modo de teste. O Flow definitivo continua pendente de arquivo/direitos, sem integração automática.

Retorno usa manifesto imutável por execução. Cada parte deve corresponder a um SHA/nome/tamanho previsto; soma não excede a reserva de saída. Transferência em blocos de até 64 KiB, arquivo até 100 MiB, dois transfers simultâneos, prazo total de até 60 segundos e não superior ao deadline da tarefa. Remetente que envia continuamente não reinicia esse prazo. Fechar o cliente cancela espera de backpressure/leitura e libera somente o slot de transferência, não a reserva de execução. Metadados têm teto de 64 KiB.

Escrita usa arquivo temporário exclusivo; confere tamanho/hash, fsync do arquivo, link exclusivo, proteção readonly e fsync do diretório em Linux antes de confirmar. Um arquivo já íntegro é reutilizado somente se seu hash/tamanho forem idênticos. Em interrupção desta requisição, só seu próprio temporário fechado é removido. Não apaga origem, derivado final ou tentativa desconhecida.

## Validação e retorno ao calendário

O coordenador Workflow chama o supervisor real para `inspect`, `prepare` e `inspect_output`, em diretórios próprios. Final decode também está na árvore supervisionada, fora da API de 512 MiB. Hash é conferido antes e depois. A prova agregada exige que conversão e todas as inspeções-filhas terminaram, com zero descendentes.

API recebe arquivos e certificado autenticado de decode; o inspector remoto genuíno é aceito pelo mesmo result store. Antes de validar o certificado, compara caminho final completo empresa/asset/dispatch, campos canônicos, tamanho/hash dos bytes copiados e descriptor. Não executa Sharp/FFmpeg na API para essa verificação. O result store mantém a validação canônica anterior e os mesmos objetos/ref/grants do calendário/publicador.

Somente entrega durável na API + prova nativa de término + run Render terminal permitem observação terminal do runner e liquidação da capacidade de execução. Prova de cancelamento/timeout da chamada SDK sozinha nunca basta. O contador de armazenamento continua separado e só retenção referenciada pode liberá-lo.

Resultado novo atrasado é recusado. Confirmação exata de resultado já persistido pode ser observada novamente. `recover()` reutiliza manifesto/arquivos/resultRef recebidos; não recodifica nem repete publicação. Se só parte do retorno chegou e o disco efêmero já desapareceu, ou se o tempo de encerramento ultrapassar o orçamento contratual, continua pendente de reconciliação — não há promessa de recuperar qualquer crash sem intervenção. O término/resultado não é fabricado para fechar uma reserva. Workflow pode terminar a instância aos 180 s incluindo transferência/inicialização; orçamento da aplicação não é orçamento de fatura.

## Configuração futura do Workflow

| Campo | Valor/condição |
|---|---|
| Fonte | Branch/SHA revisados, nunca main por rotina |
| Start | `node workflows/calendar-media.mjs` |
| Task slug | ID real a confirmar, sufixo `/prepareCalendarMedia` |
| Plano/retentativa/prazo | Flex; zero retries; 180 segundos |
| `IA4TUBE_WORKFLOW_ROOT` | Diretório privado efêmero próprio, absoluto, 0700 |
| `IA4TUBE_WORKFLOW_FFMPEG_PATH` | Executável do build fixado e validado, absoluto |
| `IA4TUBE_WORKFLOW_CGROUP_ROOT` | Subárvore cgroupv2 realmente delegada, controles/probe exigidos |
| `IA4TUBE_WORKFLOW_PRIVATE_ORIGIN` | Origem HTTPS privada real e certificada da API |
| `IA4TUBE_WORKFLOW_BRIDGE_KEY_BASE64` | Material protegido 32 bytes; não imprimir/copiar a arguments/results |
| Render API token | Só coordenador API; não copiar ao Workflow/codec |
| Banco/Instagram | Ausentes do ambiente do Workflow e do codec |

O entrypoint registra sem instalar/contratar nada; inicializa e prova o runtime somente ao receber tarefa. Não usa sudo em produção: se cgroup, montagem/isolamento ou permissões exigidos não estiverem disponíveis no Render Flex, falha fechado. GitHub Actions sudo não prova que Render delega a mesma capacidade. Imagem/build FFmpeg, delegação do host, rede TLS e logs são condições de piloto, não itens presumidos concluídos por teste local.

Há uma pré-condição adicional de empacotamento/launcher: o supervisor compilado pelo Node não privilegiado não ganha privilégios ao usar `launchMode:direct`. Executar o próprio Node como root também não é uma solução aceita pelo guard. O host deve disponibilizar um launcher privilegiado seguro/delegação compatível, e o empacotamento precisará ser ajustado e validado para esse mecanismo real. A existência desse mecanismo no Render Flex não foi confirmada. Portanto, o entrypoint é código candidato de contrato, não uma execução Render já comprovada ou promessa de que bastam variáveis de configuração.

## Evidências pertinentes

`WORKFLOW_PRIVATE_SEPARATE_PROCESS_FINAL_2026-09-13.tap`: 12/12, zero falhas/ignorados, 74,043 s; oito casos de contrato SDK e quatro físicos com PostgreSQL e HTTP reais, coordenador Workflow em processo Node separado da API, subprocessos nativos e provedor Instagram controlado. Percursos: foto completa ao calendário/publicador; resposta start perdida observada sem duplicação; slow body/disconnect/imutabilidade; foto musical e vídeo original. O host separado recebeu ambiente mínimo sem banco/Instagram e sua saída foi aguardada na limpeza. SDK simulado somente na coordenação Render. Nenhuma requisição Instagram real ou tarefa Render foi executada. Linux recebe prova própria, não se presume a partir do Windows.

`WORKFLOW_ASYNC_TICK_PHYSICAL_V2_2026-09-13.tap`: 1/1 em 11,942 s, start retornando running antes de a mídia ser convertida. Upload e preparação só avançam em chamada explícita do tick; chamadas sobrepostas não duplicam start; resultado já recebido com status SDK ainda running mantém capacidade reservada; confirmação terminal conclui a mesma revisão. O mapa de controle SDK desta fixture vive em memória: esse caso não é prova de reinício do serviço API/Render nem de durabilidade do controle Render. As provas PG/retorno privado existentes não são substituídas por essa simulação.

Rodada posterior com a factory real e os ajustes finais: `WORKFLOW_REAL_FACTORY_FINAL_V2_2026-09-13.tap`, 12/14 em 68,574 s. Os nove casos SDK/configuração e o novo teste assíncrono/gap/overlap passaram; dois casos físicos tiveram `not_started_spawn` na primeira inspeção Windows. A prova disponível indica ausência de evento spawn/PID, não a causa do erro de sistema; portanto a suíte Windows atual não é declarada integralmente aprovada. A rodada anterior pela factory (`WORKFLOW_REAL_FACTORY_FINAL_2026-09-13.tap`) teve 12/13 e um episódio semelhante. Os registros são preservados para diagnóstico focal, sem retry automático do runtime, sem relaxar limites e sem substituir falhas atuais pela prova histórica 12/12. Limpeza de host/PG/HTTP foi registrada em todos os casos. A prova Linux é independente.

Triagens anteriores preservadas: nome de arquivo não compatível com contrato fechado do executor; caminhos Windows profundos para supervisor; campo de seleção musical da fixture; verificador remoto inicialmente vinculado à pasta de staging em vez da cópia final imutável; teste aguardando sucesso imediato em vez de reconciliação após resposta perdida. Foram corrigidos caminhos/contratos/fixture sem enfraquecer checks. Revisão independente acrescentou prazo total, backpressure de desconexão, fsync de diretório, limite agregado de saída, SDK bounded-wait, igualdade do runId, vínculo resultRef e remoção de `remoteRuntimeVerified` como prova por booleano.

O funcionamento efetivo no Render, teto absoluto adicional de US$5 e piloto externo continuam não comprovados/não ativados. Nenhum deploy, migration remota, AAB, Play, OAuth, publicação ou envio Meta decorre destes módulos.
