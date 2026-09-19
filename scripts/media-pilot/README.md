# Piloto operacional Google — iA4tube

Este adaptador é separado da prova sintética encerrada. Não chama `runSequence`, os cinco casos, revalidação ou lançamentos sintéticos. O módulo não executa ação ao ser importado.

## Contrato operacional

`google-plan.js` vincula usuário/empresa, worker, pacote, revisão, autorização, IPv4 atual, imagem exata e previsão de custo. A estimativa considera duas horas de máquina, disco de 50 GiB e IPv4, margem de tráfego e outros componentes explicitamente informados. Soma o consumo anterior do piloto. Recusa referência diferente de US$5, build adicional ou soma estimada acima da referência. Não promete teto de fatura. As tarifas devem vir de conferência externa recente, não dos números dos testes.

A infraestrutura reaproveita o contrato imutável da prova Google: e2-medium, Ubuntu 24.04/ID exato, us-central1-a, disco exclusivo, rede/sub-rede/firewall exclusivos, SSH /32, sem service account, DELETE automático. Por compatibilidade de identidade, os nomes/descrições internos ainda usam `ia4proof`; isso não dispara a prova anterior. O plano operacional externo identifica e vincula a missão verdadeira; não executar o controlador sintético com esse plano.

`google-controller.js` persiste intenções antes de criar, instalar e iniciar. Cria uma única vez, reconcilia a mesma operação incerta sem repetição e retoma um diário existente somente para encerramento. O prazo começa antes da primeira criação: admissão até 90 minutos, encerramento do worker aos 110, exclusão até 120. Uma janela mais curta de admissão pode ser escolhida no plano. A parada antecipada ocorre quando o observador informa que o aceite terminou. Recursos anteriores são inventariados e reconferidos; nomes e IDs próprios são vinculados antes da exclusão. Falta de confirmação de ausência é `cleanup_required`, nunca “encerrado”.

`google-guest.js` reutiliza a identidade SSH e instalação revisadas, uma vez. Executa a verificação nativa dos controles no host instalado antes do worker. O comando de instalação legado `--synthetic-proof` apenas instala o runtime desligado e não roda casos; o adaptador não muda esse contrato. O worker recebe somente chave HMAC restrita e configuração fixa, por stdin do SSH com host key verificada. Não recebe Google administrativo, banco ou Instagram. Um registro exclusivo impede segundo start e `RuntimeMaxSec`/`Restart=no` limita a execução sem depender do telefone/assistente. O executor nativo conserva seus próprios limites e isolamento.

## Composição pelo operador

`createOperationalSession` em `google-session.js` requer plano revisado, pacote hash-idêntico, diretório externo protegido, Google CLI privado já autenticado e três callbacks:

- `getBridgeKey()`: devolver **cópia própria** Buffer de 32 bytes da chave restrita já vinculada à API; a cópia será zerada.
- `prepareApi(context)`: concluir automaticamente o vínculo com `hostEvidence` e devolver somente recibo seguro. Deve honrar `signal`, não aguardar intervenção humana e não repetir deploy/secret de resultado incerto. Contexto inclui `createdAt`, `admitUntil`, `finishBy`/`destroyBy` (120 minutos) e `stopAt` (110). Recibo deve conter `ready`, ownerCompanyId, ownerUserId, workerId, runtimeRevision, connectionEnabled=false, publicationEnabled=false, metaWindowEnabled=false, admitUntil, finishBy e receiptSha256.
- `observeApi(context)`: somente observar o mesmo piloto e devolver `finished`, `gatesClosed=true`, `receiptSha256`. A própria API deve recusar novas admissões após admitUntil; o observador não substitui isso.

O diretório de diário/chaves deve estar fora do Git, outputs e pacote. O canal protegido da API, migrações/roles, músicas e readiness devem estar preparados **antes** de criar a VM. O hostEvidence só existe depois do host: se a ligação final falhar, o controlador encerra a VM em vez de deixá-la cobrando por uma resposta do usuário. Callbacks não estão implementados neste módulo; pertencem à composição remota protegida da missão principal.

## Evidência e limites

Os testes `calendar-google-operational-pilot.test.js` usam provider/SSH simulados com o provider e validadores reais. Cobrem duplicação, falhas, recibos e exclusão; não comprovam uma VM, instalação Linux, custo real nem API remota. Os programas remotos são analisados sintaticamente, sem executá-los neste teste. A verificação real ocorrerá no host da única janela operacional autorizada, depois da revisão/conferências remotas. Nenhum recurso foi criado para desenvolver este adaptador.
