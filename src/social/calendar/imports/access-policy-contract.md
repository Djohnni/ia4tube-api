# iA4tube — acesso de importação por empresa

Implementação local, sem liberação de conta, runner remoto ou chamada paga.

## Composição confiável

`createImportAccessPolicy({mode,allowedOwners,isEligible})` cria uma política marcada internamente. Objetos recebidos de HTTP, snapshots, tokens do cliente ou uma cópia JSON não substituem essa política.

- O modo omitido é `owner_pilot`: aceita somente um par `companyId/userId` e audiência `owner_pilot`; lista vazia não libera ninguém.
- `multi_company` é explícito e exige audiência `owner_pilot` ou `customers` em cada par. Uma empresa não pode ter audiências contraditórias. IDs são normalizados, entradas copiadas e duplicatas rejeitadas.
- `isEligible({companyId,userId,audience})` é uma leitura **síncrona, confiável e atual** de configuração do servidor. Só `true` admite a ação. Falha, Promise ou outro valor negam acesso. Seu estado pode refletir revogação sem reconstruir o consumidor. Não consultar banco/HTTP dentro da transação por essa função: o coordenador futuro deverá entregar uma configuração atualizada de forma confiável e definir sua propagação entre processos.
- A audiência não é parâmetro editável pelo aplicativo. Ela serve também à conferência dos direitos musicais: `customers` exige `endUserSublicensing=true`, além das provas e da lista de empresas já exigidas pelo catálogo.

## Consumidores existentes

Preparação e inspeção aceitam `accessPolicy` nas opções. Para compatibilidade, `allowedOwners:[par]` continua construindo a política do piloto. Não fornecer ambos: configuração ambígua é rejeitada. As duas fábricas preservam `enabled=false` por padrão e todos os requisitos de persistência/isolamento/idempotência existentes.

`schedulePreparedImport(...,{accessPolicy,...})` exige a política explicitamente. Não a deduz da empresa da sessão ou de uma prévia anteriormente autorizada. A elegibilidade é conferida novamente antes de todo agendamento, inclusive repetição idempotente. Um novo agendamento com música reconfere a licença para a data programada e a audiência atual. `import.accessAudience` registra a audiência desse agendamento; não é autorização irrevogável para o publicador.

A preparação reconfere elegibilidade e plano musical depois da transação de lease e imediatamente antes do dispatch. A inspeção reconfere elegibilidade depois da reserva e antes de iniciar o runner. Se ocorrer revogação nesse intervalo, não há chamada externa e o consumo de processamento é liquidado em zero; o registro fica em atenção/falha. Reservas e dados existentes não são apagados automaticamente.

Callbacks confiáveis de preparação podem concluir/liquidar execução já iniciada mesmo após revogação. Isso não abre novas tarefas, prévias, acesso do cliente ou agendamento. Não se afirma que revogar elegibilidade mata um processo remoto já iniciado: cancelamento e confirmação de encerramento pertencem ao runner/coordenador.

## Expansão permanece bloqueada

`multi_company` resolve elegibilidade e permite testar localmente os contratos de agenda/licença, mas `executionAvailable=false` mantém **inspeção e preparação indisponíveis**, mesmo com um único cliente configurado. Não há exceção por `globalAdmission.capabilities` nem por sinalização inventada.

Para ativar execução de clientes, ainda falta compor o coordenador global durável real em ambos os caminhos: reserva idempotente, aquisição justa de vaga, rechecagem de elegibilidade antes do início, recibos de término, liberação comprovada de espaço, reconciliação de falhas e retomada após reinício. A fila deve usar os mesmos proprietários e digests; uma declaração de capacidade não equivale à execução dessas operações. Só depois da composição e dos testes será removido o bloqueio explícito desse modo.

Também permanecem pendentes a entrada/upload protegida pela mesma política na composição HTTP, o publicador tipado com nova conferência de elegibilidade/licença/gates na hora efetiva e a integração Render/Android. Este módulo não altera essas partes nem amplia autorização real.

## Provas focais

50 testes aprovados nos quatro arquivos afetados: política (4), entrada do calendário (10), inspeção (17) e preparação/queue (19). Incluem falsificação de política/audiência, uma empresa cliente, múltiplas empresas, revogação antes/durante reserva, sub-licença musical e execução multiempresa fechada sem coordenação real. Não constituem prova em nuvem ou publicação externa.
