# Gate 5A — alterações pendentes no Meta Dashboard

Data do inventário: 30/08/2026. Estado: **PLANO SOMENTE LEITURA**.

Nenhuma alteração no painel Meta, App Review, Advanced Access, Business Verification ou Access Verification foi executada nesta etapa.

## 1. Estado observado e preservado

| Item | Estado observado | Ação futura, somente após autorização |
|---|---|---|
| App | `ia4tube`, modo desenvolvimento/não publicado | Preservar até conclusão da revisão |
| Negócio exibido | `Ia4tube empresas` | Reconciliar identidade antes de verificação |
| Instagram Login | Presente | Preservar o tipo de login; não adicionar Facebook Login ao mesmo app |
| Callback OAuth de staging | `https://ia4tube-api-staging-checkpoint-a.onrender.com/v1/social/oauth/callback` | Preservar exatamente; validar novamente antes de qualquer edição |
| App Review | Não solicitado | Preparar evidências antes de enviar |
| Advanced Access | Não solicitado | Solicitar apenas para as duas permissões mínimas aprovadas |
| Business Verification | Não iniciada | Resolver identidade e obter autorização humana antes de iniciar |
| Access Verification / Tech Provider | Não iniciada | Preparar após Business Verification, sem iniciar agora |
| Ícone | Ausente | Proprietário deve aprovar candidato; dimensões e SHA-256 ainda não existem |
| Categoria | Ausente | Confirmar opções reais apresentadas pelo painel e obter decisão do proprietário |
| Privacy Policy | Ausente | Substituir futuramente pela URL final aprovada |
| Terms URL | Aponta incorretamente para `facebook.com` | Substituir futuramente pela URL final aprovada da IA4Tube |
| Data Deletion URL | Aponta incorretamente para `facebook.com` | Substituir futuramente pela instrução ou callback aprovado da IA4Tube |
| Deauthorization callback | Vazio no Meta Dashboard | A rota e a validação de `signed_request` estão montadas no servidor candidato; não preencher o painel enquanto o repository PostgreSQL real estiver bloqueado pela migration |

## 2. URLs candidatas de staging

Estas URLs são candidatas técnicas e só podem ser inseridas no painel depois de deploy e verificação HTTPS/HTTP 200, conteúdo final aprovado e autorização explícita:

- Privacidade: `https://ia4tube-api-staging-checkpoint-a.onrender.com/politica-de-privacidade`
- Termos: `https://ia4tube-api-staging-checkpoint-a.onrender.com/termos-de-uso`
- Instruções de exclusão: `https://ia4tube-api-staging-checkpoint-a.onrender.com/exclusao-de-dados`
- Callback de desautorização: `https://ia4tube-api-staging-checkpoint-a.onrender.com/v1/social/compliance/meta/deauthorization`
- Callback de solicitação de exclusão: `https://ia4tube-api-staging-checkpoint-a.onrender.com/v1/social/compliance/meta/data-deletion`
- Status de exclusão: `https://ia4tube-api-staging-checkpoint-a.onrender.com/v1/social/compliance/meta/data-deletion/status/:confirmationCode` — não é campo do painel.

A página de instruções não deve ser confundida com um callback que recebe `signed_request`.
As rotas e o verificador de `signed_request` já estão montados no servidor candidato. Isso não torna a exclusão real operacional: o repository PostgreSQL durável, o ledger/status, a resolução pré-tenant e o privilégio `DELETE` continuam bloqueados pela migration descrita em `DATA_DELETION_MIGRATION_REQUIRED.md`. Até esse bloqueio ser resolvido, as URLs são candidatas para preparo e não devem ser inseridas no painel nem receber dados reais.

## 3. Permissões a preservar

O código OAuth ativo contém exatamente:

1. `instagram_business_basic`
2. `instagram_business_content_publish`

Não renomear `instagram_business_content_publish` para `instagram_business_content_publishing`. A página específica de App Review apresenta nomenclatura divergente, enquanto as superfícies oficiais de Login, Access Verification e referência de permissões usam o nome preservado pelo código. A escolha no painel deve ser confirmada visualmente antes do envio.

## 4. Três permissões extras observadas

| EXTRA_PERMISSION_NAME | SOURCE | REQUESTED_BY_ACTIVE_OAUTH_FLOW | NEEDED_BY_CURRENT_PRODUCT | SAFE_TO_REMOVE_LATER |
|---|---|---|---|---|
| `instagram_business_manage_messages` | Meta Dashboard | NAO | NAO | Candidata; confirmar dependências/concessões antes da remoção |
| `instagram_business_manage_comments` | Meta Dashboard | NAO | NAO | Candidata; confirmar dependências/concessões antes da remoção |
| `instagram_business_manage_insights` | Meta Dashboard | NAO | NAO | Candidata; confirmar dependências/concessões antes da remoção |

As três permissões não aparecem no conjunto exato solicitado pelo fluxo OAuth ativo. Nenhuma foi removida do painel nesta etapa.

## 5. Gates oficiais antes de contas externas

Para o IA4Tube atender empresas que não têm papel no app, preparar separadamente:

1. app do tipo Business e App Purpose `Clients`;
2. plataforma Web/mobile Web para Instagram API with Instagram Login;
3. Business Verification;
4. Access Verification como Tech Provider;
5. App Review e Advanced Access por permissão;
6. uma chamada API bem-sucedida por permissão nos 30 dias anteriores ao envio;
7. descrição individual e screencast por permissão;
8. instruções passo a passo e credencial de teste da IA4Tube, sem compartilhar credencial pessoal Meta/Instagram;
9. app/site acessível ao revisor, embora o onboarding geral permaneça bloqueado;
10. mudança para Live somente após aprovação;
11. preparação para o Data Use Checkup anual após publicação/Advanced Access.

## 6. Evidência exigida para a futura submissão

Para `instagram_business_basic`, o screencast deve mostrar logout, login completo do Instagram, concessão e exibição de username/ID. Para `instagram_business_content_publish`, deve mostrar o mesmo login e consentimento, criação da foto orgânica, legenda/hashtags/metadados, publicação e resultado no feed.

As gravações devem ser legíveis, preferencialmente em inglês ou com legendas/anotações, 1080p ou superior e sem depender de áudio. Cada permissão precisa de descrição própria.

## 7. Itens que continuam bloqueados

- alterar App ID, App Secret, callback ou permissões;
- iniciar qualquer verificação;
- solicitar Advanced Access ou App Review;
- publicar o app ou realizar novo OAuth/publicação real;
- inserir URL jurídica enquanto o conteúdo estiver rotulado como não aprovado;
- escolher ícone, categoria, identidade ou contato por suposição.

`META_DASHBOARD_CHANGED=NAO`.

## 8. Referências oficiais usadas no preparo

- Instagram API with Instagram Login: `https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login` — visão geral marcada pela Meta como atualizada em 21/01/2025.
- Business Login: `https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login`.
- App Review do Instagram: `https://developers.facebook.com/documentation/instagram-platform/app-review`.
- Referência de permissões: `https://developers.facebook.com/docs/permissions#instagram_business_basic`.
- Access Levels: `https://developers.facebook.com/docs/graph-api/overview/access-levels`.
- Business Verification: `https://developers.facebook.com/documentation/development/release/business-verification`.
- Access Verification: `https://developers.facebook.com/documentation/development/release/access-verification`.
- Submission Guide: `https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/submission-guide`.
- Screen Recordings: `https://developers.facebook.com/docs/app-review/submission-guide/screen-recordings`.
- Basic Settings: `https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/basic-settings`.
- Data Deletion Callback: `https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/data-deletion-callback`.
- Platform Terms: `https://developers.facebook.com/terms/` — página marcada como atualizada em 03/02/2026.
- Data Use Checkup: `https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/data-use-checkup` — página marcada como atualizada em 16/09/2024.

As URLs acima são referências documentais. Nenhuma chamada, login ou alteração foi executada pelo pacote Gate 5A.
