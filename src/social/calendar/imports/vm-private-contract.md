# Executor privado candidato em VM — iA4tube

Implementação local de transporte pull. Não ativa serviço, cria máquina, altera banco remoto, contrata recursos ou publica no Instagram. `enabled` só aceita o booleano `true`; o padrão fica desligado. `readyForProduction` continua `false`. A prova de um host instalado não equivale a prova de desempenho, pagamento ou segurança da futura VM real.

## Composição existente preservada

`createWorkflowOperationalComponents` recebe as mesmas instâncias duráveis de store, capacidade, admission, policy, diretórios privados, catálogo e chave. Para VM acrescenta `executionTransport: {kind: 'vm', workerId: UUID, runtimeRevision: SHA256}` e `validationOnly: true`; NÃO recebe adapter Render. A factory monta o publicador/queue existentes, worker, journal, resultados e handler privado. É necessário montar `handlePrivateRequest` no servidor HTTP já autenticado pelo protocolo e invocar `tick()` de forma explícita e limitada para observar inspeções/preparos. Construir componentes não cria timer nem trabalho.

As duas rotas novas são POST `/internal/calendar-media/vm/poll` e `/internal/calendar-media/vm/done`. Só transportam UUIDs, revisão e estados fechados. A autenticação HMAC usa finalidade `calendar-vm-control-v1`, binding de worker, ação, timestamp, tamanho e SHA-256; corpo máximo 4096 bytes, prazo total 15 segundos e duas solicitações simultâneas. Não há comando livre, URL de mídia, SQL, endereço de banco ou payload de cliente. Fora dos testes locais explícitos, o cliente aceita exclusivamente HTTPS com validação TLS e sem redirecionamentos. HTTPS autenticado pode usar uma API publicamente roteável: não constitui promessa de rede privada do provedor nem de transferência gratuita.

Os bytes continuam no protocolo de tarefa existente: origem privada → download de hash/tamanho conhecidos → executor nativo → decodificação final dentro do executor → upload privado verificado → persistência por empresa/revisão. A VM não acessa o banco nem Instagram; só o processo coordenador lê a chave da ponte, nunca o codec. O gateway HMAC é segredo do coordenador, não uma credencial de banco nem token DigitalOcean.

## Identidade e recuperação

O journal do PostgreSQL conserva o schema documental 1 e lê registros antigos sem `transport` como Render, sem reescrevê-los. `runId=trn-*` permanece exclusivo do Render; VM exige `runId=null`, worker/revisão próprios, oferta com request/agent/boot e terminal ligado ao recibo já persistido. Não há ID Render inventado nem migração SQL adicional.

A VM persiste e sincroniza request/agent antes do poll. O servidor persiste a oferta antes de responder. Resposta perdida retorna a mesma oferta; outra identidade não toma o trabalho. A VM persiste a oferta antes de iniciar o agente, que persiste intenção antes do executor nativo. Repetição concorrente encontra a intenção exclusiva e não inicia nova conversão. Mais de um pedido local inacabado fecha o coordenador, em vez de selecionar arbitrariamente um deles.

Reiniciar o processo conserva request/agent e consulta o mesmo executionId. Um boot diferente só pode reconciliar oferta anterior. Intenção existente sem `return.json` consulta a identidade nativa, sem nova execução: ausência/ambiguidade do recibo conserva disco e reserva para decisão operacional. Um retorno durável já completo pode ser retransmitido, com o mesmo ID e hash; não se recompila ou recodifica o arquivo. `done` não aceita um booleano genérico como prova: exige a entrega com término nativo, zero descendentes e proofId vinculados à oferta. Resultado antigo fica restrito à sua revisão; não substitui a revisão nova. Prazo original continua obrigatório para uma primeira entrega. ACK perdido de entrega já persistida é idempotente.

Nenhuma falta de processo/PID, timeout de HTTP, reinício ou status remoto sozinho libera capacidade. O encerramento bloqueia novos polls, espera trabalho ativo e consulta recibos nativos agregados; se forem desconhecidos, informa fechamento não comprovado e preserva os arquivos. A retenção continua conservadora; este daemon não apaga fontes ou derivados da API nem promete liberar armazenamento ao terminar um processo. A quota rígida do volume limita o scratch acumulado; esgotamento deve fechar a admissão, nunca ampliar disco automaticamente.

## Instalação candidata, ainda desligada

Entrada `workflows/calendar-media-vm.cjs`, sem argumentos livres. Usuário coordenador não-root. Arquivos root-owned: `/etc/ia4tube-media/worker.json`, chave binária de 32 bytes em `/etc/ia4tube-media/bridge.key`; este segredo é legível pelo grupo coordenador e fica fora do jail. O runtimeRevision deve coincidir com `/opt/ia4tube-media/installation.json` protegido.

Configuração fechada: schema 1, enabled false inicialmente, workerId UUID, runtimeRevision SHA256, apiOrigin HTTPS aprovado, stateRoot `/var/lib/ia4tube-media/state`, workRoot `/var/lib/ia4tube-media/work/data`, executorRoot `/var/lib/ia4tube-media/work/executions`, ffmpegPath `/opt/ia4tube-media/runtime/usr/bin/ffmpeg`, pollIntervalMs 5000, linuxRuntime `{cgroupRoot:'/sys/fs/cgroup/ia4tube-media-vm',launchMode:'installed',validationOnly:true}`. Boot ID é lido do kernel, não escolhido pelo request. O daemon exige prova nativa branded com readIsolatedRoot, distinctCodecUid, installedLauncher e aggregateScratchQuotaBytes=3221225472, além de término forte.

Não basta instalar Node ou configurar uma variável. O launcher fixo privilegiado, runtime root-owned, jail legível apenas da própria execução, UID de codec distinto, cgroups e volume rígido são fornecidos pelo pacote nativo separado. Sem essa prova o daemon não inicia polling. Não habilitar genericamente sudo para um executável gravável pelo coordenador.

## Provas focais e limites

`calendar-vm-transport.test.js`: padrão desligado, rejeição de booleanos falsos como host certificado, TLS, histórico Render e terminal/transport inválidos. `calendar-vm-private-physical.test.js`: PostgreSQL real, coordenador Node em processo separado sem credenciais DB/Instagram/admin no ambiente, bytes reais por HTTP loopback somente sintéticos, perda de resposta, reinício real do PG/coordenador, boot ID simulado, reserva incerta, alteração de bytes e preservação de nova revisão. Instagram é um publicador controlado, não chamada externa.

Modo instalado usa `CALENDAR_VM_INSTALLED_TEST=1`, usuário `ia4tube-coordinator`, FFmpeg fixo, dados sob `/work/data/test-*`, estado sob `/state/test-*` e executor instalado fixo. Requer `CALENDAR_OPERATIONAL_MEDIA_TEST_PG_BIN` apontando para binários PostgreSQL locais e acesso aos módulos/dependências/migrations do pacote de prova. O modo de CI `sudo` é separado e não deve ser relatado como prova de instalação.

Primeira execução local Windows dos dois cenários iniciais: 2/2 em 34,85 s. A rodada seguinte teve `not_started_spawn/UNKNOWN` em duas inspeções antes das novas asserções; término e limpeza foram comprovados. Isso não é aprovação dos novos casos de integridade nem evidência contra o protocolo. Uma regressão física Render passou; os 9 contratos Render e os 2 VM passaram. A prova Linux instalada e as asserções finais devem ser registradas a partir do resultado real da CI, não inferidas deste documento.

Ainda não executados: provisão DigitalOcean, prova paga na VM, reboot físico dessa VM, ativação da API/daemon em ambiente real, alteração de gates, processamento de dados reais ou publicação. Essas operações continuam fora desta implementação local.
