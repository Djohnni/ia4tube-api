import json
import os
import re
import requests
import shutil
import sys
from pathlib import Path
from datetime import datetime

from openai import OpenAI

from resultado_pipeline_ia4tube import (
    BASE_DIR,
    OUT_DIR,
    MODEL,
    SIZE,
    QUALITY,
    OUTPUT_FORMAT,
    load_api_key,
    load_json,
    normalize_text,
    safe_dict,
    render_via_chatgpt_api,
    gerar_preview_protegida,
    limpar_descricao_instagram,
)


MAX_REFERENCIAS_PLANEJAMENTO = 8
API_BASE = os.environ.get("IA4TUBE_API_BASE", "https://ia4tube-api.onrender.com").rstrip("/")
BOT_TOKEN_FILE = BASE_DIR / "bot_token.txt"
ALL_IMAGES_DIR = BASE_DIR / "dados" / "pedidos" / "todas imagens"
TEXTOS_INTERNOS_PROIBIDOS = [
    "reforco",
    "reforco 2",
    "reforco 3",
    "reforco 4",
    "reforco 5",
    "tema interno",
    "objetivo interno",
]

BRIEFING_LABEL_MARKERS = [
    "INSTRUCAO VISUAL OBRIGATORIA",
    "TEXTO QUE DEVE APARECER NA IMAGEM",
    "ORIENTACAO SOMENTE PARA LEGENDA",
    "TEXTO/ASSUNTO PROIBIDO",
    "ORIENTACAO DO CLIENTE PARA ESTA FOTO",
    "Tema e objetivo do Planejamento Mensal",
    "Tema interno",
    "Objetivo interno",
    "O texto visivel",
    "Nunca escrever",
    "Foto com pessoa detectada",
    "Data sugerida",
    "Horario sugerido",
]


def log(msg):
    try:
        print(str(msg), flush=True)
    except UnicodeEncodeError:
        print(str(msg).encode("ascii", errors="replace").decode("ascii"), flush=True)


def safe_archive_segment(value, fallback="item"):
    text = str(value or "").strip() or fallback
    text = re.sub(r"[^0-9A-Za-z_.@+-]+", "_", text).strip("_")
    return text[:120] or fallback


def unique_archive_path(directory: Path, filename: str) -> Path:
    candidate = directory / filename
    if not candidate.exists():
        return candidate

    suffix = candidate.suffix or ".png"
    stem = candidate.stem
    for index in range(2, 1000):
        numbered = directory / f"{stem}_{index}{suffix}"
        if not numbered.exists():
            return numbered

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return directory / f"{stem}_{timestamp}{suffix}"


def copy_final_image_to_all_images(pedido: dict, pedido_dir: Path, pedido_id: str, final_path: Path):
    try:
        if not final_path.exists():
            log(f"Aviso: resultado final nao encontrado para copia extra: {final_path}")
            return

        whatsapp = safe_archive_segment(
            pedido.get("whatsapp") or pedido_dir.parent.parent.name,
            "sem_whatsapp",
        )
        safe_pedido_id = safe_archive_segment(pedido_id or pedido.get("id") or pedido_dir.name, "pedido")
        ALL_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        archive_path = unique_archive_path(
            ALL_IMAGES_DIR,
            f"{whatsapp}_{safe_pedido_id}_resultado_final.png",
        )
        shutil.copy2(final_path, archive_path)
        log(f"Copia extra salva em: {archive_path}")
    except Exception as exc:
        log(f"Aviso: falha ao copiar resultado para todas imagens: {exc}")


def _sources(pedido):
    fields = safe_dict(pedido.get("fields"))
    legacy = safe_dict(pedido.get("legacy"))
    legacy_fields = safe_dict(legacy.get("fields"))

    return [
        pedido,
        safe_dict(pedido.get("planejamento_mensal")),
        fields,
        safe_dict(fields.get("campos_dinamicos")),
        legacy,
        safe_dict(legacy.get("planejamento_mensal")),
        legacy_fields,
        safe_dict(legacy_fields.get("campos_dinamicos")),
    ]


def first_value(pedido, *keys):
    for source in _sources(pedido):
        for key in keys:
            if key not in source:
                continue
            value = source.get(key)
            if isinstance(value, (list, dict)):
                if value:
                    return value
                continue
            text = normalize_text(value).strip()
            if text:
                return text
    return ""


def text_value(pedido, *keys):
    value = first_value(pedido, *keys)
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    return normalize_text(value).strip()


def normalize_text_items(value):
    if value is None:
        return []
    if isinstance(value, list):
        result = []
        for item in value:
            result.extend(normalize_text_items(item))
        return result
    if isinstance(value, dict):
        result = []
        for item in value.values():
            result.extend(normalize_text_items(item))
        return result

    text = normalize_text(value).strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
        if parsed is not value:
            parsed_items = normalize_text_items(parsed)
            if parsed_items:
                return parsed_items
    except Exception:
        pass

    return [item.strip() for item in re.split(r"\r?\n|[,;]", text) if item.strip()]


def company_characteristics(pedido):
    keys = (
        "caracteristicas_empresa",
        "caracteristicasEmpresa",
        "company_characteristics",
        "companyCharacteristics",
    )
    for source in _sources(pedido):
        for key in keys:
            if key not in source:
                continue
            items = normalize_text_items(source.get(key))
            if items:
                return list(dict.fromkeys(items))
    return []


def company_important_info(pedido):
    return text_value(
        pedido,
        "informacoes_empresa",
        "informacoes_importantes_empresa",
        "regras_empresa",
        "dados_importantes_empresa",
    )


def company_reality_prompt_block(pedido):
    characteristics = company_characteristics(pedido)
    info = company_important_info(pedido)
    characteristics_text = "\n".join(f"- {item}" for item in characteristics) if characteristics else "Nenhuma caracteristica marcada."
    info_text = info or "Nenhuma informacao adicional."

    return f"""
CARACTERISTICAS E REGRAS REAIS DA EMPRESA:
Caracteristicas marcadas pelo cliente:
{characteristics_text}

Outras informacoes do cliente:
{info_text}

REGRAS DE USO:
- As caracteristicas marcadas e as outras informacoes representam regras reais da empresa.
- Pode mencionar uma caracteristica somente se ela estiver marcada ou descrita nas outras informacoes.
- Quando houver caracteristicas marcadas, use-as como diferenciais reais da empresa para orientar composicao, textos, chamadas e elementos visuais quando forem coerentes com o objetivo da arte.
- Escolha no maximo 1 ou 2 caracteristicas por imagem para evitar poluicao visual. Nao tente mostrar todas.
- Em venda ou promocao, Pix pode virar facilidade de pagamento, delivery pode virar destaque de entrega, estacionamento pode virar beneficio e drive-thru pode virar conveniencia, somente quando essas caracteristicas estiverem marcadas.
- Em artes institucionais, use as caracteristicas marcadas como provas ou diferenciais da empresa quando fizer sentido.
- Se a caracteristica marcada nao combinar com o objetivo da arte, nao force.
- Nunca contradiga essas informacoes.
- Nunca invente caracteristicas permanentes que nao foram informadas.
- So mencione delivery, entrega, receber em casa, app ou termos equivalentes se houver caracteristica marcada ligada a delivery/entrega ou se isso estiver escrito nas outras informacoes.
- Se "Aceitamos Pix" nao estiver marcado nem escrito nas outras informacoes, nao mencione Pix.
- Se "Estacionamento" nao estiver marcado nem escrito nas outras informacoes, nao mencione estacionamento.
- Se "Drive-thru" nao estiver marcado nem escrito nas outras informacoes, nao mencione drive-thru.
- Se "Parcelamos no cartao" nao estiver marcado nem escrito nas outras informacoes, nao mencione parcelamento.
- Essas regras tem prioridade sobre criatividade, nicho, objetivo, briefing, CTA generico e conhecimento do segmento.
""".strip()


def company_important_info_prompt_block(pedido):
    return company_reality_prompt_block(pedido)


def normalize_instruction_list(value):
    if value is None:
        return []

    if isinstance(value, list):
        result = []
        for item in value:
            result.extend(normalize_instruction_list(item))
        return result

    if isinstance(value, dict):
        result = []
        for key in ("texto", "text", "valor", "value", "item", "descricao", "description"):
            if key in value:
                result.extend(normalize_instruction_list(value.get(key)))
        if result:
            return result
        return [normalize_text(json.dumps(value, ensure_ascii=False)).strip()]

    text = normalize_text(value).strip()
    if not text:
        return []

    parts = re.split(r"[\n;,]+", text)
    return [part.strip(" -•\t") for part in parts if part.strip(" -•\t")]


def list_value(pedido, *keys):
    for key in keys:
        value = first_value(pedido, key)
        items = normalize_instruction_list(value)
        if items:
            return items
    return []


def extract_labeled_text(text, label):
    text = str(text or "")
    if not text:
        return ""

    label_pattern = re.compile(rf"{re.escape(label)}\s*:", re.IGNORECASE)
    match = label_pattern.search(text)
    if not match:
        return ""

    start = match.end()
    end = len(text)
    lower_text = text.lower()

    for marker in BRIEFING_LABEL_MARKERS:
        if marker.lower() == label.lower():
            continue
        marker_index = lower_text.find(marker.lower(), start)
        if marker_index != -1:
            end = min(end, marker_index)

    newline_marker = re.search(r"\n[A-Z0-9 /_-]{4,}\s*:", text[start:end])
    if newline_marker:
        end = min(end, start + newline_marker.start())

    return normalize_text(text[start:end]).strip().strip(". ")


def planning_instructions(pedido):
    briefing = text_value(pedido, "briefing_arte", "observacoes")
    visual = text_value(pedido, "orientacao_visual")
    required = text_value(pedido, "texto_obrigatorio_imagem")
    legend = text_value(pedido, "orientacao_legenda")
    forbidden = list_value(pedido, "texto_proibido")

    if not required:
        required = extract_labeled_text(briefing, "TEXTO QUE DEVE APARECER NA IMAGEM")
    if not visual:
        visual = extract_labeled_text(briefing, "INSTRUCAO VISUAL OBRIGATORIA")
    if not legend:
        legend = extract_labeled_text(briefing, "ORIENTACAO SOMENTE PARA LEGENDA")
    if not forbidden:
        forbidden = normalize_instruction_list(
            extract_labeled_text(briefing, "TEXTO/ASSUNTO PROIBIDO")
        )

    for item in TEXTOS_INTERNOS_PROIBIDOS:
        if item not in forbidden:
            forbidden.append(item)

    return {
        "orientacao_visual": visual,
        "texto_obrigatorio_imagem": required,
        "orientacao_legenda": legend,
        "texto_proibido": forbidden,
    }


def planning_style(pedido):
    style = text_value(pedido, "estilo_visual_cliente", "estilo_planejamento_mensal").lower()
    if style in {"foto_detalhes", "leve", "normal"}:
        return style
    return "normal"


def style_block(style):
    if style == "foto_detalhes":
        return "\n".join([
            "Estilo escolhido: So embelezar a foto.",
            "A foto enviada e a FOTO BASE obrigatoria.",
            "Edite essa foto base; nao gere uma cena nova.",
            "Nao invente slogan, CTA, promocao, preco, beneficio, chamada comercial, frase de impacto ou texto extra.",
            "Nao recrie uma arte do zero e nao transforme em flyer generico.",
            "Nao mude completamente a composicao da foto enviada.",
            "Apenas melhore iluminacao, acabamento, nitidez, contraste, composicao leve, pequenos detalhes profissionais e moldura discreta.",
            "Use texto curto somente se esse texto existir explicitamente no pedido.",
        ])

    if style == "leve":
        return "\n".join([
            "Estilo escolhido: Visual leve.",
            "Crie uma arte limpa, elegante e com bastante respiro visual.",
            "Pode adicionar poucas informacoes visuais, sempre usando somente o que o cliente enviou.",
            "Use poucos elementos, pouco texto, pouca poluicao visual e hierarquia simples.",
            "Deixe o logo visivel, mas discreto e bem integrado.",
            "Respeite fortemente fotos, referencias e dados enviados pelo cliente.",
            "Evite poluicao visual, excesso de efeitos, selos grandes e contrastes agressivos.",
        ])

    return "\n".join([
        "Estilo escolhido: Normal IA4Tube.",
        "Crie uma arte comercial equilibrada, profissional e clara.",
        "Organize CTA, oferta e informacoes principais com boa hierarquia.",
        "Usar presenca visual maior que o modo leve, mas sem exagero.",
        "Destacar produto, servico, oferta, CTA ou beneficio quando existirem.",
        "Mantenha leitura rapida em celular e identidade alinhada ao logo.",
    ])


def visual_mode_contract(style, has_photo):
    common = [
        "O modo visual controla apenas o nivel de transformacao permitido para este pedido.",
        "O nicho/produto continua decidindo linguagem, estetica, estilo e repertorio do segmento.",
        "O objetivo interno nunca pode aparecer literalmente na imagem em nenhum modo.",
        "Nao use o campo objetivo interno como fonte de texto publico.",
    ]

    rules = {
        "foto_detalhes": [
            "Modo: Embelezar Foto / foto_detalhes.",
            "Fazer minima intervencao.",
            "Manter a foto enviada como protagonista.",
            "Nao criar anuncio completo.",
            "Nao criar conceito visual novo.",
            "Nao transformar objetivo interno em chamada publica grande.",
            "Usar somente moldura, logo, pequenos detalhes, contatos e acabamento leve quando forem coerentes com o pedido.",
            "Se usar objetivo interno, usar apenas para orientar tom discreto e acabamento.",
        ],
        "leve": [
            "Modo: Leve.",
            "Fazer transformacao leve.",
            "Organizar melhor a foto e adicionar poucos elementos.",
            "Nao virar campanha, mosaico, vitrine ou anuncio completo.",
            "Nao criar composicao complexa ou layout muito publicitario.",
            "Nao parecer Normal IA4Tube.",
            "Se usar objetivo interno, usar apenas para orientar atmosfera discreta.",
        ],
        "normal": [
            "Modo: Normal IA4Tube.",
            "Pode transformar a foto em peca publicitaria completa.",
            "Pode criar conceito visual.",
            "Pode criar mensagem publica derivada do objetivo do cliente, sem copiar texto interno.",
            "Pode reduzir moderadamente a dominancia da foto.",
            "Pode organizar produto, servico, oferta, beneficio e CTA com mais forca.",
            "Deve parecer anuncio pronto para Instagram.",
        ],
    }

    selected = rules.get(style, rules["normal"])
    if has_photo and style == "leve":
        selected = [
            "Modo: Leve com foto do cliente.",
            "Fazer transformacao leve a partir da foto enviada.",
            "Organizar melhor a foto e adicionar poucos elementos.",
            "A foto enviada deve continuar sendo a base visual principal.",
            "Nao substituir a foto por cena, pessoa, ambiente, fachada ou produto inventado.",
            "Nao virar campanha, mosaico, vitrine ou anuncio completo.",
            "Nao criar composicao complexa ou layout muito publicitario.",
            "Se usar objetivo interno, usar apenas para orientar atmosfera discreta sem trocar a cena da foto.",
        ]
    elif has_photo and style == "normal":
        selected = [
            "Modo: Normal IA4Tube com foto do cliente.",
            "Pode transformar a foto enviada em peca publicitaria completa.",
            "Pode criar layout, hierarquia, textos e elementos graficos ao redor da foto enviada.",
            "A foto enviada deve continuar sendo a base visual principal.",
            "Nao criar conceito visual que substitua a cena da foto.",
            "Nao reduzir a dominancia da foto a ponto de trocar o ambiente, fachada, pessoa, produto ou cena principal.",
            "Nao recriar ambiente diferente, fachada diferente, pessoa diferente ou produto principal diferente.",
            "Pode organizar produto, servico, oferta, beneficio e CTA com mais forca quando esses dados existirem.",
            "Deve parecer anuncio pronto para Instagram sem abandonar a foto enviada.",
        ]

    return "\n".join(common + selected)


def asset_names_from_value(value):
    names = []

    if isinstance(value, str):
        value = value.strip()
        if value:
            names.append(value)
        return names

    if isinstance(value, list):
        for item in value:
            names.extend(asset_names_from_value(item))
        return names

    if isinstance(value, dict):
        file_value = str(value.get("file") or value.get("name") or "").strip()
        if file_value:
            names.append(file_value)
        files = value.get("files")
        if isinstance(files, list):
            for item in files:
                names.extend(asset_names_from_value(item))

    return names


def clean_file_name(name):
    value = str(name or "").strip().replace("\\", "/").split("/")[-1]
    return value if value else ""


def collect_declared_asset_names(pedido, key):
    names = []
    for group_name in ("assets", "company_assets"):
        group = safe_dict(pedido.get(group_name))
        names.extend(asset_names_from_value(group.get(key)))

    seen = set()
    result = []
    for name in names:
        clean = clean_file_name(name)
        if clean and clean not in seen:
            result.append(clean)
            seen.add(clean)
    return result


def collect_monthly_reference_images(pedido_dir, pedido):
    refs = []
    seen = set()

    def add(path):
        if not path or not path.exists() or not path.is_file():
            return
        resolved = path.resolve()
        if resolved in seen:
            return
        refs.append(path)
        seen.add(resolved)

    for name in collect_declared_asset_names(pedido, "fotos"):
        add(pedido_dir / name)

    for name in collect_declared_asset_names(pedido, "logo"):
        add(pedido_dir / name)

    for name in collect_declared_asset_names(pedido, "referencias"):
        add(pedido_dir / name)

    if not refs:
        for path in sorted(pedido_dir.iterdir()):
            if not path.is_file() or path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
                continue
            name = path.name.lower()
            if name.startswith("resultado_") or name in {"resultado_final.png", "preview_ia4tube.jpg"}:
                continue
            add(path)

    return refs[:MAX_REFERENCIAS_PLANEJAMENTO]


def pessoa_block(pedido):
    preserve = first_value(pedido, "preservar_pessoa")
    rules = list_value(pedido, "regras_preservacao_pessoa")

    if not preserve and not rules:
        return ""

    if not rules:
        rules = [
            "nao alterar rosto",
            "nao trocar rosto",
            "nao alterar corpo",
            "nao emagrecer ou engordar",
            "nao mudar idade aparente",
            "nao mudar cor de pele",
            "nao transformar em outra pessoa",
            "manter a identidade visual da pessoa",
            "usar a foto como referencia principal",
        ]

    return "\n".join([
        "REGRA OBRIGATORIA PARA FOTO COM PESSOA:",
        *[f"- {item}" for item in rules],
    ])


def build_prompt(pedido, referencias):
    instructions = planning_instructions(pedido)
    style = planning_style(pedido)
    has_photo = bool(collect_declared_asset_names(pedido, "fotos")) or any(
        ref.name.lower().startswith("foto") for ref in referencias
    )
    foto_info = "Foram enviadas imagens de referencia para este pedido."
    if has_photo and len(referencias) == 1:
        foto_info = "Ha uma foto principal neste pedido. Use essa foto como referencia visual principal."
    elif has_photo and len(referencias) > 1:
        foto_info = "Ha uma foto principal neste pedido. Use a foto principal como base e as demais imagens, incluindo logo, apenas como apoio de identidade visual."
    elif len(referencias) > 1:
        foto_info = "Ha mais de uma referencia neste pedido. Use as imagens apenas como apoio visual e de identidade."

    forbidden = ", ".join(instructions["texto_proibido"]) or "nenhum"
    required = instructions["texto_obrigatorio_imagem"] or "nenhum"
    visual = instructions["orientacao_visual"] or "nenhuma"
    legend = instructions["orientacao_legenda"] or "nenhuma"
    customer_goal = text_value(pedido, "objetivo_foto_cliente") or text_value(pedido, "objetivo")

    return f"""
Crie uma arte vertical profissional para Instagram, pronta para postar.

Este pedido e um PEDIDO FILHO DO PLANEJAMENTO MENSAL.
Use somente os dados deste pedido filho.
Nao usar regras de futebol, placar, escalacao, patrocinador, escudo, mascote, uniforme ou produto esportivo.
Nao tratar tema interno ou objetivo interno como texto obrigatorio da imagem.

DADOS DA EMPRESA:
- Nome: {text_value(pedido, "nome_empresa", "empresa") or "nao informado"}
- Ramo: {text_value(pedido, "ramo", "nicho") or "nao informado"}
- WhatsApp: {text_value(pedido, "whatsapp_contato", "whatsapp") or "nao informado"}
- Instagram: {text_value(pedido, "instagram") or "nao informado"}

{company_important_info_prompt_block(pedido)}

DADOS DO PEDIDO:
- Objetivo principal: {customer_goal or "nao informado"}
- Texto que deve aparecer na imagem: {required}

CONTEXTO INTERNO DO PLANEJAMENTO:
- Tema interno: {text_value(pedido, "tema_interno", "tema") or "nao informado"}
- Objetivo interno: {text_value(pedido, "objetivo_interno", "objetivo_postagem", "objetivo") or "nao informado"}
- Data sugerida: {text_value(pedido, "data_sugerida") or "nao informado"}
- Horario sugerido: {text_value(pedido, "horario_sugerido") or "nao informado"}

REGRA SOBRE TEMA E OBJETIVO:
- Tema interno e objetivo interno servem apenas para orientar a estrategia.
- Nunca copie literalmente tema interno ou objetivo interno como titulo da imagem.
- Nunca escreva "reforco", "reforco 2", "tema interno" ou "objetivo interno" na imagem.

FOTOS E REFERENCIAS:
{foto_info}
- A imagem enviada manda na composicao visual.
- Preserve produto, ambiente, pessoa, cor e contexto da foto.
- Nao misture fotos de outros posts.

{pessoa_block(pedido)}

ESTILO VISUAL:
{style_block(style)}

CONTRATO TECNICO DO MODO VISUAL:
{visual_mode_contract(style, has_photo)}

INSTRUCAO VISUAL OBRIGATORIA:
{visual}
Use como direcao forte da composicao, destaque, hierarquia e mensagem visual.
Nao copie literalmente esta frase se ela for apenas direcao estrategica.

TEXTO QUE DEVE APARECER NA IMAGEM:
{required}
Se houver texto acima, ele deve aparecer na arte com legibilidade.
Nao trocar produto, preco, data, telefone, CTA ou palavras.

ORIENTACAO SOMENTE PARA LEGENDA:
{legend}
Nao usar esta orientacao como texto obrigatorio da imagem.

TEXTO/ASSUNTO PROIBIDO:
{forbidden}
Nao escreva, sugira ou invente nenhum termo proibido na imagem.

BRIEFING CRIATIVO DO PEDIDO:
{text_value(pedido, "briefing_arte", "observacoes") or "sem briefing adicional"}

REGRAS FINAIS:
- A arte deve parecer feita para a empresa real do pedido.
- Usar cores, contraste e hierarquia profissionais.
- Priorizar a foto principal e a orientacao do cliente.
- Nao inventar preco, promocao, telefone, endereco ou informacao ausente.
- Se houver texto obrigatorio, ele tem prioridade sobre qualquer texto generico.
- Se houver texto proibido, ele vence qualquer outro pedido.
- Entregar imagem vertical completa, sem bordas cortadas, pronta para postagem.
""".strip()


def remove_forbidden_lines(text, forbidden):
    lines = []
    forbidden_norm = [item.lower() for item in forbidden if item]
    for line in str(text or "").splitlines():
        line_norm = line.lower()
        if forbidden_norm and any(item in line_norm for item in forbidden_norm):
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def gerar_descricao_planejamento(pedido):
    instructions = planning_instructions(pedido)
    forbidden = instructions["texto_proibido"]

    try:
        client = OpenAI(api_key=load_api_key())
        prompt = f"""
Escreva somente a legenda final para Instagram em portugues do Brasil.
Nao inclua titulo, rotulo, explicacao ou cabecalho.

DADOS:
- Empresa: {text_value(pedido, "nome_empresa", "empresa")}
- Ramo: {text_value(pedido, "ramo", "nicho")}
- Objetivo da postagem: {text_value(pedido, "objetivo_postagem", "objetivo")}
- Texto que aparece na imagem: {instructions["texto_obrigatorio_imagem"] or "nenhum"}
- Orientacao visual da arte: {instructions["orientacao_visual"] or "nenhuma"}
- Orientacao especifica para legenda: {instructions["orientacao_legenda"] or "nenhuma"}
- Texto/assunto proibido: {", ".join(forbidden) or "nenhum"}
- Caracteristicas marcadas da empresa: {", ".join(company_characteristics(pedido)) or "nenhuma"}
- WhatsApp: {text_value(pedido, "whatsapp_contato", "whatsapp")}
- Instagram: {text_value(pedido, "instagram")}
- Informacoes importantes da empresa: {company_important_info(pedido) or "nenhuma"}

REGRAS:
- Se houver orientacao especifica para legenda, obedeca.
- Use texto obrigatorio e orientacao visual apenas como contexto.
- As caracteristicas marcadas e as informacoes importantes da empresa representam regras reais e tem prioridade sobre criatividade.
- Pode mencionar uma caracteristica somente se ela estiver marcada ou escrita nas informacoes importantes.
- Nunca contradiga as regras reais da empresa.
- Nunca invente caracteristicas permanentes nao informadas, como delivery, estacionamento, Pix, cartao, parcelamento, drive-thru, horario especial ou atendimento 24 horas.
- Nunca mencione texto/assunto proibido.
- Nao invente informacoes.
- Maximo 6 linhas.
- Incluir hashtags no final.
- Incluir #ia4tube na ultima linha.
""".strip()
        response = client.responses.create(model="gpt-5-mini", input=prompt)
        return limpar_descricao_instagram(response.output_text, pedido)
    except Exception:
        base = instructions["texto_obrigatorio_imagem"] or instructions["orientacao_visual"]
        if not base:
            base = text_value(pedido, "objetivo_postagem", "objetivo") or "Arte pronta para divulgar sua empresa."
        nome = text_value(pedido, "nome_empresa", "empresa")
        ramo = text_value(pedido, "ramo", "nicho")
        fallback = "\n".join([
            base,
            f"{nome} prepara esse conteudo para aproximar sua empresa dos clientes.".strip(),
            f"#{ramo.replace(' ', '').lower()}" if ramo else "#negocios",
            "#ia4tube",
        ])
        return remove_forbidden_lines(limpar_descricao_instagram(fallback, pedido), forbidden)


def save_description(pedido_dir, pedido, descricao):
    pedido["descricao_instagram"] = descricao
    if isinstance(pedido.get("legacy"), dict):
        pedido["legacy"]["descricao_instagram"] = descricao
    (pedido_dir / "pedido.json").write_text(
        json.dumps(pedido, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_bot_token():
    token = os.environ.get("IA4TUBE_BOT_TOKEN", "").strip()
    if token:
        return token

    try:
        if BOT_TOKEN_FILE.exists():
            return BOT_TOKEN_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        return ""

    return ""


def upload_resultado_planejamento(pedido_dir, pedido_id, imagem_path, preview_path=None):
    token = load_bot_token()
    if not token:
        raise RuntimeError("IA4TUBE_BOT_TOKEN/bot_token.txt nao configurado para upload da arte do Planejamento Mensal.")

    endpoint = os.environ.get("IA4TUBE_PLANNING_ART_UPLOAD_ENDPOINT", "").strip()
    if not endpoint:
        endpoint = f"{API_BASE}/bot/empresa/planejamento-mensal/artes/{pedido_id}/upload-resultado"

    pedido = load_json(pedido_dir / "pedido.json")
    api_info_path = pedido_dir / "resultado_api_info.json"
    api_info = ""
    if api_info_path.exists():
        try:
            api_info = api_info_path.read_text(encoding="utf-8")
        except Exception:
            api_info = ""

    files_upload = {}
    with open(imagem_path, "rb") as f_resultado:
        files_upload["resultado"] = ("resultado_final.png", f_resultado, "image/png")
        f_preview = None
        try:
            if preview_path and preview_path.exists():
                f_preview = open(preview_path, "rb")
                files_upload["preview"] = ("preview_ia4tube.jpg", f_preview, "image/jpeg")

            response = requests.post(
                endpoint,
                headers={"Authorization": f"Bearer {token}"},
                files=files_upload,
                data={
                    "descricao_instagram": pedido.get("descricao_instagram", ""),
                    "api_info": api_info,
                },
                timeout=180,
            )
        finally:
            if f_preview:
                f_preview.close()

    if response.status_code < 200 or response.status_code >= 300:
        raise RuntimeError(
            f"Falha no upload da arte do Planejamento Mensal: "
            f"{response.status_code} | {response.text[:500]}"
        )

    log("Upload da arte do Planejamento Mensal concluido.")


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Uso: python resultado_pipeline_planejamento_mensal.py <PASTA_DO_PEDIDO>")

    pedido_dir = Path(sys.argv[1]).resolve()
    pedido_json = pedido_dir / "pedido.json"
    if not pedido_json.exists():
        raise SystemExit("pedido.json nao encontrado.")

    pedido = load_json(pedido_json)
    pedido_id = text_value(pedido, "id") or pedido_dir.name

    log("Pipeline Planejamento Mensal iniciado")
    log(f"Pedido: {pedido_id}")

    referencias = collect_monthly_reference_images(pedido_dir, pedido)
    log(f"Referencias do pedido filho: {len(referencias)}")
    for idx, ref in enumerate(referencias, start=1):
        log(f"   {idx:02d}. {ref.name}")

    prompt = build_prompt(pedido, referencias)

    out_final_pedido = pedido_dir / "resultado_final.png"
    out_preview_pedido = pedido_dir / "preview_ia4tube.jpg"
    out_final_geral = OUT_DIR / f"resultado_{pedido_id}.png"

    render_via_chatgpt_api(
        out_final_pedido,
        prompt,
        referencias,
        allow_prompt_only=True,
    )

    try:
        gerar_preview_protegida(out_final_pedido, out_preview_pedido)
        log(f"Preview protegida salva em: {out_preview_pedido}")
    except Exception as exc:
        log(f"Nao consegui gerar preview protegida: {exc}")

    shutil.copy2(out_final_pedido, out_final_geral)
    log(f"Copia salva em: {out_final_geral}")
    copy_final_image_to_all_images(pedido, pedido_dir, pedido_id, out_final_pedido)

    info = {
        "pedido_id": pedido_id,
        "pipeline": "resultado_pipeline_planejamento_mensal.py",
        "modelo": MODEL,
        "size": SIZE,
        "quality": QUALITY,
        "output_format_api": OUTPUT_FORMAT,
        "estilo_visual_cliente": planning_style(pedido),
        "resultado_final": str(out_final_pedido),
        "resultado_copia": str(out_final_geral),
        "referencias": [str(path) for path in referencias],
        "caracteristicas_empresa": company_characteristics(pedido),
        "informacoes_empresa": company_important_info(pedido),
        "instrucoes_planejamento": planning_instructions(pedido),
        "gerado_em": datetime.now().isoformat(timespec="seconds"),
    }
    (pedido_dir / "resultado_api_info.json").write_text(
        json.dumps(info, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    descricao = gerar_descricao_planejamento(pedido)
    save_description(pedido_dir, pedido, descricao)

    upload_resultado_planejamento(pedido_dir, pedido_id, out_final_pedido, out_preview_pedido)

    (pedido_dir / "status.txt").write_text("pronto", encoding="utf-8")
    (pedido_dir / "processado_handoff.txt").write_text("OK", encoding="utf-8")


if __name__ == "__main__":
    main()
