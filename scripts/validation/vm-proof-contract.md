# Prova temporária da VM de mídia — iA4tube

Este pacote é uma preparação local, desligada por padrão. Não cria VM, não aceita pagamento e não executa teste pago ao ser importado, instalado ou preparado. A execução futura exige confirmação específica do plano/hash e pré-condições de conta. A API, o banco e o publicador continuam no Render; não há migration, deploy da API, gates, OAuth, Android, Play ou Meta nesta prova.

## Operação única candidata

1. No computador do operador, verificar material externo protegido, pacote e plano exatos; inventariar recursos existentes e verificar a chave SSH já cadastrada na conta por ID e fingerprint.
2. Gravar intenção durável antes de criar uma única VM Ubuntu 24.04 x64, SFO3, 1 vCPU/2 GiB, sem backup/monitoramento/IP extra. O ID devolvido precisa corresponder à intenção e não pode estar no inventário inicial.
3. Verificar a identidade SSH com a chave de host única pré-provisionada e conhecida. A admissão pode esperar o SSH ficar acessível com comando inerte; não aceita uma chave desconhecida nem repete instalação ou conversão.
4. Copiar somente fontes sanitizadas, conferir SHA-256 e executar preflight somente leitura. Sem controles obrigatórios, encerrar antes de qualquer conversão.
5. Preparar dependências públicas, Node 24.15.0 com checksum fixo e lockfile; instalar o candidato com identidades separadas. O coordenador e o conversor não são root. O supervisor privilegiado é mínimo e fixo. Worker permanece desabilitado.
6. Gravar intenção única da sequência de cinco casos/oito tentativas supervisionadas e executá-la uma única vez.
7. Recolher apenas recibos fechados: casos, contagens, término e medidas numéricas. Nenhuma mídia, chave, caminho de dados, ambiente ou log bruto acompanha a evidência exportada.
8. Pelo controle do provedor no computador, conferir e destruir somente o ID criado; verificar que o mesmo ID não existe mais. Desligar o Linux não é confirmação de encerramento de cobrança.

## Cinco casos, oito tentativas — sem repetição

| Caso | Tentativas supervisionadas | Critério |
|---|---|---|
| Identidade/preflight instalado | `native-preflight` | Usuários separados, launcher imutável, cgroup v2/pidfd e quota agregada; sem mídia real. |
| Leitura/isolamento | `read-isolation` | Conversor não lê segredo sintético do coordenador, estado e outra empresa; replay da identidade não lança outra execução. |
| Espaço agregado | `aggregate-quota` | Vários arquivos atingem a quota real total de 3 GiB; recusa fechada e limpeza só dos próprios arquivos. |
| Prazo/descendentes | `aggregate-deadline` | Prazo agregado encerra a árvore; marcador para de avançar. |
| Fonte de 100 MiB/60 s | `generate-source`, `inspect-source`, `prepare-media`, `inspect-derivative` | Gerar fonte sintética, inspecionar, preparar Story/Reel e verificar independentemente o derivado. |

O máximo autorizado candidato é dez tentativas; o roteiro usa oito. Uma tentativa supervisionada pode conter processos/threads finitos sob o mesmo limite, não equivale a um único processo do sistema operacional. Não iniciar um processo Node separado por caso: isso repetiria o probe. Cada tentativa tem até 180 segundos agregados; os casos têm orçamento finito incluindo limpeza, e a sequência única tem 900 segundos. Falha impede os casos seguintes, não ganha novas tentativas.

Medições recolhidas: tempo total da sequência, tempo e CPU da preparação, pico de memória/tarefas da preparação, tamanho da fonte e duração do vídeo conferido. Ausência de recibo é desconhecimento, nunca zero conversões ou término comprovado.

## Relógio, perda de resposta e encerramento

- Duas horas desde `created_at` confirmado pelo provedor. Antes de conhecer o ID, reconciliação usa relógio conservador da intenção de criação.
- Reservas: dez minutos para coleta e dez para destruição. Instalação até quarenta minutos; não iniciar uma fase que invada as reservas. Falha de coleta não impede tentativa de destruição.
- Create incerto: consultar somente a tag única até o prazo conservador, sem segundo POST. Uma consulta posterior ainda pode localizar o mesmo ID para encerramento; múltiplos resultados ou identidade divergente não autorizam apagar nada.
- Intenções de preflight, instalação ou sequência encontradas na retomada não são repetidas. A retomada prioriza coleta/encerramento do mesmo ID.
- Journal externo append-only, sincronizado, encadeado por hashes, com marcador de sessão independente; cauda parcial, perda de marcador ou journal não viram sessão nova. Exclusão entre controladores é mantida pelo sistema operacional, sem confiar em PID reutilizado.
- Falha de persistência após o ID conhecido não impede o controlador em memória de tentar encerrá-lo. Sem confirmação do provedor, o resultado continua `cleanup_required` e `billingMayContinue=true`.
- Matar o cliente SSH não comprova término do trabalho remoto. Resultado permanece incerto até recibo físico válido ou destruição do ID. O controlador externo deve permanecer disponível durante a prova.
- Não há promessa de teto de cobrança infalível: falha prolongada do computador, Internet ou provedor pode impedir destruição no prazo. Nesse caso, retomar o mesmo estado/ID e finalizar pelo provedor, sem criar nova VM. Não existe automação mensal ou piloto de 24 horas.

## Preparação offline do pacote e plano

Na worktree, a forma abaixo só gera fontes/manifesto; os dois destinos devem ser novos:

```powershell
node scripts/validation/vm-proof-cli.js --mode prepare --package <pacote-novo.tar> --plan <plano-novo.json>
```

O plano sem chave SSH da conta é intencionalmente pendente e não executável. Depois de o operador identificar uma chave pública existente, é possível gerar outro plano offline incluindo `--provider-ssh-key-id <ID_EXISTENTE>` e `--provider-ssh-key-fingerprint <FINGERPRINT_EXISTENTE>`. O hash resultante requer a confirmação futura correspondente. Não se cadastra chave, inventa ID ou usa credencial por esta preparação.

Fontes textuais são normalizadas para LF e indexadas por caminho/tamanho/SHA-256. O bundle inclui migrations como arquivos somente para o banco sintético da prova; não as aplica em um banco remoto. Não contém a CLI administrativa, adaptador DigitalOcean, credenciais, repositório Git, dados reais, outputs ou nichos. Compilação/instalação real na DigitalOcean ainda depende da prova futura; o nome Ubuntu, isoladamente, não comprova capacidades.

## CLI futura, nunca automática

Somente após autorização paga específica e pré-condições de conta, a execução usa `--mode execute`, pacote/plano, `--approval-sha256`, `--external-state-dir`, `--credential-file` e a confirmação literal `CREATE_ONE_SYNTHETIC_VM_MAX_2_HOURS_AND_DESTROY_ONLY_ITS_ID`.

O diretório protegido deve estar fora do repositório, Git e outputs. No Windows, ACL explícita e proprietário permitido; em Linux, proprietário atual e permissões restritas. A credencial administrativa do provedor é lida somente de arquivo protegido nesse diretório, nunca argumento, variável publicada, log, VM ou bundle. As chaves efêmeras de host/admin são geradas só na operação futura, protegidas externamente; apenas o material específico da própria VM entra no bootstrap HTTPS. A VM não recebe a credencial DigitalOcean, segredo Instagram ou acesso amplo ao PostgreSQL.

Conta aceita e meio de pagamento ainda precisam ser confirmados pelo operador; esta CLI não cadastra cartão/PayPal, não aceita cobrança e não registra chave pública no provedor. Sem chave pública existente verificada e confirmação de hash, Create é bloqueado.

## Referência financeira, não autorização

Compute candidato: US$0,01786/h × 2 = US$0,03572. Referência operacional da prova: US$0,10, não um limite garantido pelo provedor. Franquias de tráfego e eventuais tributos/câmbio não se confundem com teto contratual. O mês de US$12 e um piloto de 24 horas não estão autorizados. O teste só usa mídia sintética local da VM; nenhum arquivo real sai do Render nesta prova.
