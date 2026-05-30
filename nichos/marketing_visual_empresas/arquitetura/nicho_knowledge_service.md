# Desenho: Nicho Knowledge Service

Este documento descreve uma possivel implementacao futura. Nao esta implementado.

## Objetivo

Permitir que um pedido localize seu nicho e carregue conhecimento compacto para apoiar a construcao do prompt final.

## Localizacao do nicho

Um pedido poderia resolver o nicho por um campo interno:

```json
{
  "nicho_id": "marketing_visual_empresas"
}
```

Para o produto atual, uma regra futura poderia ser:

```text
product_id = arte_empresa -> nicho_id = marketing_visual_empresas
```

## Carregamento de conhecimento

O servico carregaria preferencialmente:

```text
nichos/marketing_visual_empresas/KNOWLEDGE_SUMMARY.md
```

Somente se necessario, poderia carregar blocos adicionais:

- regras essenciais;
- CTAs;
- campanha especifica;
- erros comuns;
- validacoes.

## Fallback

Se a pasta ou arquivo nao existir, o sistema deve continuar funcionando com o fluxo atual.

Regras de fallback:

- erro de leitura nao pode derrubar pedido;
- conhecimento vazio deve ser aceito;
- prompt atual continua sendo a fonte principal;
- runtime nao deve depender obrigatoriamente da pasta de nicho.

## Evitar prompts grandes

Regras recomendadas:

- carregar primeiro `KNOWLEDGE_SUMMARY.md`;
- limitar caracteres por arquivo;
- selecionar apenas blocos relevantes;
- usar cache em memoria;
- nao carregar toda a pasta;
- resumir campanhas e memoria antes de injetar no prompt.

## Montagem futura do prompt

Ordem sugerida:

1. Prompt principal atual.
2. Dados reais do pedido.
3. Resumo compacto do nicho.
4. Campanha ou objetivo especifico, se houver.
5. Checklist de validacao.

## Flag de seguranca

A ativacao futura deve ser controlada por flag:

```text
ENABLE_NICHO_KNOWLEDGE=true
```

Com a flag desligada, nada muda no sistema atual.
