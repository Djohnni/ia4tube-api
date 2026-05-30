# Uso Futuro Pelo Motor de Nichos

O Motor de Nichos podera localizar esta pasta quando um pedido for resolvido para `dentista`.

Fluxo futuro:

1. Resolver nicho do pedido.
2. Carregar `KNOWLEDGE_SUMMARY.md`.
3. Selecionar arquivos extras apenas quando necessario.
4. Montar contexto compacto.
5. Injetar como apoio secundario no prompt final.

Fallback obrigatorio:

- Se a pasta nao existir, seguir sem contexto.
- Se o resumo estiver vazio, seguir sem contexto.
- Se houver erro de leitura, seguir sem quebrar o pedido.
