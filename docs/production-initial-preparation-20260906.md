# Preparação inicial de produção — autorização de 06/09/2026

Autorização do proprietário: `11c99ba1-a051-4358-b823-ab9d9c772b45`.
SHA-256 do texto autorizado: `88b23e3672e9593a06513a0403fc7b7a503c578f5849f4448f204f38662b805e`.

## Exceção de retenção, não aprovação de recuperação

O proprietário declarou dispensáveis os logins, imagens, trabalhos e históricos dos seus testes antigos no aplicativo oficial. Aceita sua eventual perda nesta atualização inicial. Isso não manda apagar dados e não autoriza DROP, reset, formatação ou limpeza geral.

A recuperação desse histórico foi **dispensada**, não comprovada. A diferença de ordenação da restauração Windows permanece **não resolvida**. Não usar evidência fictícia, callback de recuperação sempre verdadeiro ou redução das verificações ordinárias de migrations.

A exceção vale exclusivamente para a preparação inicial do banco abaixo e para as migrations canônicas ausentes 0001–0008. Não vale para futuras atualizações, proteção dos novos dados, staging ou outros recursos.

- Banco Render: `ia4tube-social-production`.
- Recurso: `dpg-dae4tmf40ujc73dr2dog-a`.
- Database: `ia4tube_social_production`.
- Servidor PostgreSQL: 18.x, com cadeia TLS e hostname verificados.
- Serviço oficial: `srv-d8708kd7vvec73ap1p6g`.
- Origem: `https://ia4tube-api.onrender.com`.

## Preparação controlada

1. Reinspecionar destino, catálogo, papéis, marker e journal; conferir o manifesto e cada checksum. Em 06/09/2026 às 18:37:54 UTC, a leitura protegida confirmou banco vazio, PostgreSQL 18.6 e as oito migrations pendentes. Essa leitura não é autorização para repetir operações posteriores.
2. Usar o bootstrap canônico de papéis, logins mínimos, marker de ambiente e ledger. Credenciais de migration/admin ficam fora do webservice.
3. Usar a rota inicial explicitamente nomeada, um passo por migration, com catálogo antes/depois e verificação pós-commit. Resultado incerto exige inspeção somente leitura; não repetir automaticamente.
4. Verificar runtime, schema, RLS forçada, grants e isolamento. Identidade/cofre de produção são próprios; não copiar material do staging.
5. Preservar mídia no disco persistente e os fluxos legados. Chaves, assinatura Android, AAB, backups existentes, staging, revisão e provas da Meta não são dispensáveis.

### Diagnóstico transacional do ledger

`previewInitialProductionLedger` usa a mesma autorização inicial, alvo, manifesto, DDL canônico e verificadores da inicialização. Nunca executa COMMIT: desfaz a transação e confere, em nova transação somente leitura, que o ledger continua ausente e o catálogo anterior foi preservado. O resultado é explicitamente `readOnly:false`, `rollbackOnly:true` e `postCommitValidated:false`. Uma recusa não equivale a prévia aprovada; reinspecionar separadamente antes de qualquer tentativa persistente.

A conferência de identidade/TLS deve ser feita com o LOGIN autenticado, antes de assumir novamente o papel restrito de migration. As estatísticas de sessão do PostgreSQL são limitadas pelo papel corrente; trocar para um grupo NOLOGIN pode ocultar a informação TLS da própria conexão. Não contornar isso concedendo leitura global de estatísticas ou aceitando TLS ausente. [Documentação PostgreSQL 18](https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-STATS-VIEWS).

## Promoção e retorno

Registrar o SHA e a configuração funcionais **realmente observados** antes da implantação. A referência histórica `1bd987f1ecbbd3a64f2ad0e905d30649704f4b3c` não é ordem de rollback. Preservar JWT, FCM, DATA_DIR, disco e demais configurações existentes.

Commit/push somente na branch de trabalho. Manter auto-deploy desligado e branch vinculada inalterada. Após testes pertinentes, scanner, diff-check e revisão independente, implantar manualmente o SHA final validado, sem hook ou deploy intermediário ao salvar configurações.

Se houver regressão relevante, recuperar o código/configuração funcionais registrados com configuração compatível, mantendo fechadas as operações externas. Não desfazer migrations nem apagar estruturas. No candidato atual, desligar apenas persistência deixando `DATABASE_URL` configurada impede startup: um retorno ao modo legado exige retirar essa variável do webservice e desabilitar também Instagram, interface real e demais flags sociais habilitadas, preservando os valores no armazenamento protegido para investigação.

## Comprovação e limites

O smoke autorizado cobre saúde/SHA live, login legítimo, vínculo social, acesso autorizado/recusa cruzada, mídia/histórico/estado e contratos legados. Não usar geração paga ou notificações reais de teste.

Conexão externa, publicação externa e janela Meta permanecem `false`. Não executar OAuth, publicação, desconexão ou reconciliação externa. Leituras com gates fechados não provam Instagram de ponta a ponta.

Sem lançamento Google Play, instalação no A55, envio à Meta, novos recursos/custos, alteração de staging ou ampliação da recuperação. O AAB assinado existente e suas provas continuam preservados. A distribuição posterior deve atualizar o mesmo `com.ia4tube.app`; um AAB local não é uma versão disponível na loja.

Os resultados efetivos de execução serão registrados separadamente; este documento não declara migrations aplicadas, deploy realizado ou login live aprovado.
