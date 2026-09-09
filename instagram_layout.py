"""One Feed composition, intact in both placements; no legacy artwork conversion."""
LAYOUT = "safe_master_v1"
MASTER_SIZE = "1152x1440"


def layout_for(pedido):
    return (pedido.get("planejamento_mensal") or {}).get("instagram_layout") == LAYOUT


def composition_instructions(pedido):
    if not layout_for(pedido):
        return ""
    return """
COMPOSICAO RESPONSIVA PARA INSTAGRAM — PRIORIDADE GEOMETRICA:
Crie uma unica arte vertical de 1152 x 1440 pixels (4:5), sem moldura, sem barras,
sem margens brancas adicionadas. O fundo visual deve preencher a tela inteira.
O Feed mostrara a arte inteira. O Story preservara esta mesma arte inteira,
centralizada, com preenchimento de fundo acima e abaixo; NAO havera recorte.
TODOS os textos, logotipo, produto principal e informacoes essenciais devem
ficar inteiros e legiveis, com margem interna de pelo menos 92 pixels.
Nao coloque texto nem marca tocando as bordas. Nao desenhe o preenchimento
do Story: gere somente a composicao final 4:5 para Feed.
Nao desenhe guias, limites, medidas ou dois quadros. Nao duplique a arte.
Distribua o conteudo com equilibrio e fundo continuo
ate as bordas. A legenda do Feed e separada; Story nao tem essa legenda.
""".strip()
