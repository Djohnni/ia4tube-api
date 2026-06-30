import json
import base64
import shutil
import os
import re
from io import BytesIO
from pathlib import Path
from datetime import datetime

import requests
from openai import OpenAI
from PIL import Image, ImageDraw, ImageFont
from nicho_knowledge_local import build_local_niche_knowledge_for_order, resolve_local_nicho_id

API_BASE = os.environ.get("IA4TUBE_API_BASE", "https://api.ia4tube.com.br").rstrip("/")
DESCRIPTION_TIMEOUT_SECONDS = float(os.environ.get("IA4TUBE_DESCRIPTION_TIMEOUT_SECONDS", "30"))

# =========================================================
# PIPELINE 100% CHATGPT API
# =========================================================
# Fluxo:
# site -> pasta do pedido -> ChatGPT API -> resultado_final.png -> site
#
# Este arquivo NÃO usa FFmpeg.
# Este arquivo NÃO monta a arte no computador.
# Ele apenas:
# 1) lê pedido.json
# 2) encontra imagens do pedido/template
# 3) escolhe o prompt .txt da categoria
# 4) envia referências + prompt para a API de imagem do ChatGPT
# 5) salva resultado_final.png
# 6) envia para o site
# =========================================================

BASE_DIR = Path(__file__).resolve().parent

TEMPLATE_DIR = BASE_DIR / "template_resultado"
TEMPLATE_ESCALACAO_DIR = BASE_DIR / "template_escalacao"
TEMPLATE_PROXIMO_JOGO_DIR = BASE_DIR / "template_proximo_jogo"
TEMPLATE_TREINO_DIR = BASE_DIR / "template_treino"
TEMPLATE_PATROCINADOR_DIR = BASE_DIR / "template_patrocinador"
TEMPLATE_PROXIMO_JOGO_JOGADOR_DIR = BASE_DIR / "template_proximo_jogo_jogador"
TEMPLATE_RESULTADO_JOGADOR_DIR = BASE_DIR / "template_resultado_jogador"
TEMPLATE_JOGADOR_ESCUDO_DIR = BASE_DIR / "template_jogador_escudo"
TEMPLATE_MASCOTE_UNIFORME_DIR = BASE_DIR / "template_mascote_uniforme"

OUT_DIR = BASE_DIR / "resultados_prontos"
OUT_DIR.mkdir(exist_ok=True)
ALL_IMAGES_DIR = BASE_DIR / "dados" / "pedidos" / "todas imagens"

OPENAI_KEY_FILE = BASE_DIR / "openai_key.txt"
CREDENTIALS_FILE = BASE_DIR / "credenciais.txt"
PROMPT_IMAGEM_FILE = BASE_DIR / "prompt_imagem.txt"  # fallback antigo
FOOTBALL_NICHE_PROMPT_DIR = BASE_DIR / "nichos" / "futebol"
NICHOS_DIR = BASE_DIR / "nichos"
NICHOS_BASE_DIR = NICHOS_DIR / "_base"
BASE_CREATIVE_RULE_FILES = [
    NICHOS_BASE_DIR / "regras_criativas_base.md",
    NICHOS_BASE_DIR / "regras_comerciais_base.md",
    NICHOS_BASE_DIR / "regras_campos_dinamicos.md",
    NICHOS_BASE_DIR / "regras_modos_visuais.md",
    NICHOS_BASE_DIR / "regras_de_fidelidade.md",
    NICHOS_BASE_DIR / "uso_de_referencias.md",
    NICHOS_BASE_DIR / "qualidade_minima.md",
]
NICHE_RULE_RELATIVE_FILES = [
    Path("regras") / "regras_criativas.md",
    Path("regras") / "regras_comerciais.md",
    Path("regras") / "regras_de_produto.md",
    Path("regras") / "regras_do_nicho.md",
    Path("regras") / "validacoes.md",
    Path("prompts") / "prompt_principal.md",
    Path("KNOWLEDGE_SUMMARY.md"),
    Path("NICHO.md"),
]
PROMPT_FILES = {
    "resultado": BASE_DIR / "prompt_resultado.txt",
    "resultado_jogo": BASE_DIR / "prompt_resultado.txt",
    "resultado_do_jogo": BASE_DIR / "prompt_resultado.txt",
    "escalacao": BASE_DIR / "prompt_escalacao.txt",
    "proximo_jogo": BASE_DIR / "prompt_proximo_jogo.txt",
    "pronto_para_proximo_jogo": BASE_DIR / "prompt_proximo_jogo.txt",
    "treino": BASE_DIR / "prompt_treino.txt",
    "artilheiro": BASE_DIR / "prompt_artilheiro.txt",
    "destaque": BASE_DIR / "prompt_destaque.txt",
    "destaque_do_jogo": BASE_DIR / "prompt_destaque.txt",
    "contratacao": BASE_DIR / "prompt_contratacao.txt",
    "patrocinador": BASE_DIR / "prompt_patrocinador.txt",
    "escudo3d": BASE_DIR / "prompt_escudo3d.txt",
    "proximo_jogo_jogador": BASE_DIR / "prompt_proximo_jogo_jogador.txt",
    "resultado_jogo_jogador": BASE_DIR / "prompt_resultado_jogador.txt",
    "jogador_escudo": BASE_DIR / "prompt_jogador_escudo.txt",
    "mascote_uniforme": BASE_DIR / "prompt_mascote_uniforme.txt",
    "arte_empresa": BASE_DIR / "prompt_arte_empresa.txt",
}
FOOTBALL_PROMPT_PRODUCTS = {
    "resultado",
    "resultado_jogo",
    "resultado_do_jogo",
    "escalacao",
    "proximo_jogo",
    "pronto_para_proximo_jogo",
    "treino",
    "contratacao",
    "patrocinador",
    "escudo3d",
    "proximo_jogo_jogador",
    "resultado_jogo_jogador",
    "jogador_escudo",
    "mascote_uniforme",
}

MODEL = "gpt-image-2"
SIZE = "1024x1536"
QUALITY = "medium"
INPUT_FIDELITY = "high"
OUTPUT_FORMAT = "jpeg"
N = 1
MODO = "normal"  # normal | barato | premium

if MODO == "barato":
    QUALITY = "low"
    SIZE = "1024x1536"
elif MODO == "premium":
    QUALITY = "high"
    SIZE = "1024x1536"

W_REF = 1024
H_REF = 1536
MAX_REFERENCIAS = 16

FONT_DIR = BASE_DIR / "fonts"


# =========================================================
# LOG / ARQUIVOS
# =========================================================

def log(msg: str):
    msg = str(msg)
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        safe = msg.encode("ascii", errors="replace").decode("ascii")
        print(safe, flush=True)


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


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def safe_dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def safe_int(value, default: int = 1) -> int:
    try:
        number = int(value)
        return number if number > 0 else default
    except Exception:
        return default


def build_legacy_from_top_level(pedido: dict) -> dict:
    legacy = dict(pedido or {})
    legacy.pop("fields", None)
    legacy.pop("assets", None)
    legacy.pop("legacy", None)
    return legacy


def build_fields_from_legacy(legacy: dict) -> dict:
    return {
        "rodada": legacy.get("rodada", ""),
        "data": legacy.get("data", ""),
        "hora": legacy.get("hora", ""),
        "arena": legacy.get("arena", ""),
        "time_principal": legacy.get("time_principal", ""),
        "gols_time_principal": legacy.get("gols_time_principal", ""),
        "gols_adversario": legacy.get("gols_adversario", ""),
        "time_adversario": legacy.get("time_adversario", ""),
        "artilheiros": legacy.get("artilheiros", []),
        "jogadores": legacy.get("jogadores", []),
        "jogadores_texto": legacy.get("jogadores_texto", ""),
    }


def build_assets_from_legacy(legacy: dict) -> dict:
    assets = {}

    if legacy.get("escudo_principal"):
        assets["escudo_principal"] = {"file": legacy.get("escudo_principal")}

    if legacy.get("escudo_adversario"):
        assets["escudo_adversario"] = {"file": legacy.get("escudo_adversario")}

    if legacy.get("foto_jogo"):
        assets["foto_jogo"] = {"file": legacy.get("foto_jogo")}

    patrocinadores_qtd = safe_int(legacy.get("patrocinadores_qtd", 0), 0)
    if patrocinadores_qtd:
        assets["patrocinadores"] = {
            "files": [f"pat{i:02d}.png" for i in range(1, patrocinadores_qtd + 1)]
        }

    return assets


def normalize_pedido_for_pipeline(pedido: dict) -> dict:
    raw = safe_dict(pedido)
    schema_version = safe_int(raw.get("schema_version", 1), 1)
    top_level_legacy = build_legacy_from_top_level(raw)

    if schema_version >= 2:
        embedded_legacy = safe_dict(raw.get("legacy"))
        legacy = {
            **top_level_legacy,
            **embedded_legacy,
        }

        product_id = normalize_text(raw.get("product_id") or legacy.get("categoria", ""))
        if product_id:
            legacy["categoria"] = product_id

        return {
            "schema_version": schema_version,
            "product_id": product_id or normalize_text(legacy.get("categoria", "")),
            "fields": safe_dict(raw.get("fields")),
            "assets": safe_dict(raw.get("assets")),
            "legacy": legacy,
            "raw": raw,
        }

    legacy = top_level_legacy
    product_id = normalize_text(legacy.get("categoria", ""))

    return {
        "schema_version": 1,
        "product_id": product_id,
        "fields": build_fields_from_legacy(legacy),
        "assets": build_assets_from_legacy(legacy),
        "legacy": legacy,
        "raw": raw,
    }


CLEAN_SIMPLE_PRODUCTS = {
    "jogador_escudo": {
        "text_fields": ["player_name"],
        "team_crest_asset": "team_crest",
        "photo_asset": "player_photo",
        "photo_legacy_names": ["foto_jogo"],
        "photo_fallback_files": ["mascote.png", "mascote.jpg", "mascote.jpeg", "mascote.webp"],
    },
    "mascote_uniforme": {
        "text_fields": ["mascot_name", "mascot_animal"],
        "team_crest_asset": "team_crest",
        "photo_asset": "uniform_image",
        "photo_legacy_names": ["foto_jogo"],
        "photo_fallback_files": ["mascote.png", "mascote.jpg", "mascote.jpeg", "mascote.webp"],
    },
    "contratacao": {
        "text_fields": ["headline", "player_name"],
        "team_crest_asset": "team_crest",
        "photo_asset": "player_photo",
        "photo_legacy_names": ["foto_jogo", "escudo_adversario"],
        "photo_fallback_files": [
            "escudo2.png", "escudo2.jpg", "escudo2.jpeg", "escudo2.webp",
            "mascote.png", "mascote.jpg", "mascote.jpeg", "mascote.webp",
        ],
    },
    "proximo_jogo_jogador": {
        "text_fields": ["match_title", "headline"],
        "team_crest_asset": "team_crest",
        "photo_asset": "player_photo",
        "photo_legacy_names": ["foto_jogo"],
        "photo_fallback_files": ["mascote.png", "mascote.jpg", "mascote.jpeg", "mascote.webp"],
    },
}

CLEAN_RESULT_PRODUCTS = {
    "resultado": {
        "photo_asset": "match_photo",
        "include_scorers": True,
    },
    "resultado_jogo_jogador": {
        "photo_asset": "player_photo",
        "include_scorers": False,
    },
}

CLEAN_STRUCTURED_PRODUCTS = {
    "escalacao": {
        "team_crest_asset": "team_crest",
        "opponent_crest_asset": "opponent_crest",
        "photo_asset": "team_photo",
    },
    "patrocinador": {
        "team_crest_asset": "team_crest",
        "sponsor_asset": "sponsor_logos",
    },
    "proximo_jogo": {
        "home_crest_asset": "home_crest",
        "away_crest_asset": "away_crest",
    },
    "treino": {
        "team_crest_asset": "team_crest",
        "photo_asset": "training_photo",
    },
}


def get_clean_product_id(order_model: dict) -> str:
    return normalize_text(order_model.get("product_id", "")).lower()


def is_clean_product_enabled(order_model: dict) -> bool:
    return (
        safe_int(order_model.get("schema_version", 1), 1) >= 2
        and get_clean_product_id(order_model) in CLEAN_SIMPLE_PRODUCTS
    )


def is_clean_result_product(order_model: dict) -> bool:
    return (
        safe_int(order_model.get("schema_version", 1), 1) >= 2
        and get_clean_product_id(order_model) in CLEAN_RESULT_PRODUCTS
    )


def is_clean_structured_product(order_model: dict) -> bool:
    return (
        safe_int(order_model.get("schema_version", 1), 1) >= 2
        and get_clean_product_id(order_model) in CLEAN_STRUCTURED_PRODUCTS
    )


def is_company_product(order_model: dict) -> bool:
    return get_clean_product_id(order_model) == "arte_empresa"


def get_clean_asset_names(order_model: dict, key: str) -> list[str]:
    assets = safe_dict(order_model.get("assets"))
    raw_asset = assets.get(key)

    if isinstance(raw_asset, str):
        name = normalize_text(raw_asset)
        return [name] if name else []

    if isinstance(raw_asset, list):
        names: list[str] = []
        for value in raw_asset:
            if isinstance(value, dict):
                name = normalize_text(value.get("file", "") or value.get("name", ""))
            else:
                name = normalize_text(value)
            if name:
                names.append(name)
        return names

    asset = safe_dict(raw_asset)
    names: list[str] = []

    file_value = normalize_text(asset.get("file", ""))
    if file_value:
        names.append(file_value)

    files_value = asset.get("files", [])
    if isinstance(files_value, list):
        for value in files_value:
            if isinstance(value, dict):
                name = normalize_text(value.get("file", "") or value.get("name", ""))
            else:
                name = normalize_text(value)

            if name:
                names.append(name)

    return names


def get_company_client_photo_candidate_names(order_model: dict) -> list[str]:
    names = get_clean_asset_names(order_model, "fotos")
    for i in range(1, 21):
        names.extend([
            f"foto{i:02d}.png", f"foto{i:02d}.jpg", f"foto{i:02d}.jpeg", f"foto{i:02d}.webp"
        ])
    return names


def find_company_client_photo_paths(pedido_dir: Path, order_model: dict) -> list[Path]:
    return find_existing_many(pedido_dir, get_company_client_photo_candidate_names(order_model))


def set_company_client_photo_context(order_model: dict, pedido_dir: Path) -> list[Path]:
    photo_paths = find_company_client_photo_paths(pedido_dir, order_model)
    order_model["_tem_foto_cliente"] = bool(photo_paths)
    order_model["_foto_base_obrigatoria"] = bool(photo_paths)
    order_model["_quantidade_fotos_cliente"] = len(photo_paths)
    return photo_paths


def has_company_client_photos(order_model: dict) -> bool:
    return bool(order_model.get("_tem_foto_cliente"))


def get_company_value(order_model: dict, key: str, *aliases: str) -> str:
    raw = safe_dict(order_model.get("raw"))
    legacy = safe_dict(order_model.get("legacy"))
    fields = safe_dict(order_model.get("fields"))

    for source in (fields, raw, legacy):
        for name in (key, *aliases):
            value = normalize_text(source.get(name, ""))
            if value:
                return value

    return ""


def get_company_whatsapp_value(order_model: dict) -> str:
    raw = safe_dict(order_model.get("raw"))
    legacy = safe_dict(order_model.get("legacy"))
    fields = safe_dict(order_model.get("fields"))

    allowed_sources = (
        (fields, ("whatsapp", "whatsapp_contato", "whatsapp_empresa")),
        ({
            "whatsapp_contato": raw.get("whatsapp_contato"),
            "whatsapp_empresa": raw.get("whatsapp_empresa"),
        }, ("whatsapp_contato", "whatsapp_empresa")),
        (legacy, ("whatsapp_contato", "whatsapp_empresa")),
    )

    for source, names in allowed_sources:
        for name in names:
            value = normalize_text(source.get(name, ""))
            if value:
                return value

    return ""


def normalize_company_text_items(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        result: list[str] = []
        for item in value:
            result.extend(normalize_company_text_items(item))
        return result
    if isinstance(value, dict):
        result: list[str] = []
        for item in value.values():
            result.extend(normalize_company_text_items(item))
        return result

    text = normalize_text(value).strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
        parsed_items = normalize_company_text_items(parsed)
        if parsed_items:
            return parsed_items
    except Exception:
        pass

    return [item.strip() for item in re.split(r"\r?\n|[,;]", text) if item.strip()]


def get_company_characteristics(order_model: dict) -> list[str]:
    raw = safe_dict(order_model.get("raw"))
    legacy = safe_dict(order_model.get("legacy"))
    fields = safe_dict(order_model.get("fields"))
    legacy_fields = safe_dict(legacy.get("fields"))
    sources = (
        fields,
        safe_dict(fields.get("campos_dinamicos")),
        raw,
        legacy,
        legacy_fields,
        safe_dict(legacy_fields.get("campos_dinamicos")),
    )
    keys = (
        "caracteristicas_empresa",
        "caracteristicasEmpresa",
        "company_characteristics",
        "companyCharacteristics",
    )

    for source in sources:
        for key in keys:
            if key not in source:
                continue
            items = normalize_company_text_items(source.get(key))
            if items:
                return list(dict.fromkeys(items))

    return []


def get_company_important_info(order_model: dict) -> str:
    raw = safe_dict(order_model.get("raw"))
    legacy = safe_dict(order_model.get("legacy"))
    fields = safe_dict(order_model.get("fields"))
    legacy_fields = safe_dict(legacy.get("fields"))
    sources = (
        fields,
        safe_dict(fields.get("campos_dinamicos")),
        raw,
        legacy,
        legacy_fields,
        safe_dict(legacy_fields.get("campos_dinamicos")),
    )
    keys = (
        "informacoes_empresa",
        "informacoes_importantes_empresa",
        "regras_empresa",
        "dados_importantes_empresa",
    )

    for source in sources:
        for key in keys:
            value = normalize_text(source.get(key, "")).strip()
            if value:
                return value

    return ""


def build_company_important_info_rules(info: str, characteristics=None) -> str:
    info = normalize_text(info)
    characteristics = [normalize_text(item) for item in (characteristics or []) if normalize_text(item)]
    characteristics_text = "\n".join(f"- {item}" for item in characteristics) if characteristics else "Nenhuma caracteristica marcada."
    info_text = info or "Nenhuma informacao adicional."

    return "\n".join([
        "Caracteristicas marcadas pelo cliente:",
        characteristics_text,
        "",
        "Outras informacoes do cliente:",
        info_text,
        "",
        "Regras de uso:",
        "- As caracteristicas marcadas e as outras informacoes representam regras reais da empresa.",
        "- Pode mencionar uma caracteristica somente se ela estiver marcada ou descrita nas outras informacoes.",
        "- Quando houver caracteristicas marcadas, use-as como diferenciais reais da empresa para orientar composicao, textos, chamadas e elementos visuais quando forem coerentes com o objetivo da arte.",
        "- Escolha no maximo 1 ou 2 caracteristicas por imagem para evitar poluicao visual. Nao tente mostrar todas.",
        "- Em venda ou promocao, Pix pode virar facilidade de pagamento, delivery pode virar destaque de entrega, estacionamento pode virar beneficio e drive-thru pode virar conveniencia, somente quando essas caracteristicas estiverem marcadas.",
        "- Em artes institucionais, use as caracteristicas marcadas como provas ou diferenciais da empresa quando fizer sentido.",
        "- Se a caracteristica marcada nao combinar com o objetivo da arte, nao force.",
        "- Nunca contradiga essas informacoes.",
        "- Nunca invente caracteristicas permanentes que nao foram informadas.",
        "- So mencione delivery, entrega, receber em casa, app ou termos equivalentes se houver caracteristica marcada ligada a delivery/entrega ou se isso estiver escrito nas outras informacoes.",
        "- Se \"Aceitamos Pix\" nao estiver marcado nem escrito nas outras informacoes, nao mencione Pix.",
        "- Se \"Estacionamento\" nao estiver marcado nem escrito nas outras informacoes, nao mencione estacionamento.",
        "- Se \"Drive-thru\" nao estiver marcado nem escrito nas outras informacoes, nao mencione drive-thru.",
        "- Se \"Parcelamos no cartao\" nao estiver marcado nem escrito nas outras informacoes, nao mencione parcelamento.",
        "- Essas regras tem prioridade sobre criatividade, nicho, objetivo, briefing, CTA generico e conhecimento do segmento.",
    ])


def build_company_important_info_block(order_model: dict) -> str:
    return build_prompt_section(
        "CARACTERISTICAS E REGRAS REAIS DA EMPRESA",
        build_company_important_info_rules(
            get_company_important_info(order_model),
            get_company_characteristics(order_model),
        ),
    )


def get_company_visual_style(order_model: dict) -> str:
    style = get_company_value(order_model, "estilo_visual_cliente").lower()
    if style in {"foto_detalhes", "leve", "normal", "agressivo"}:
        return style
    return "normal"


def build_company_visual_style_lines(order_model: dict) -> list[str]:
    style = get_company_visual_style(order_model)
    tem_foto_cliente = has_company_client_photos(order_model)
    instructions = {
        "foto_detalhes": [
            "Estilo escolhido: So embelezar a foto.",
            "A primeira imagem de referencia enviada e a FOTO BASE obrigatoria.",
            "Edite essa foto base; nao gere uma cena nova.",
            "REGRA MAIS IMPORTANTE: use somente informacoes enviadas pelo cliente.",
            "Nao invente slogan, CTA, promocao, preco, beneficio, chamada comercial, frase de impacto ou texto extra.",
            "Se houver foto do cliente, use essa foto como base principal da arte.",
            "Nao recrie uma arte do zero e nao transforme em flyer generico.",
            "Nao mude completamente a composicao da foto enviada.",
            "Mantenha o ambiente, produto ou servico da foto como foco principal.",
            "A foto enviada deve continuar sendo claramente a arte principal.",
            "Apenas melhore iluminacao, acabamento, nitidez, contraste, composicao leve, pequenos detalhes profissionais e moldura discreta.",
            "Adicione o logo de forma discreta e coerente com a identidade visual.",
            "Use texto curto somente se esse texto existir explicitamente no pedido.",
            "Nao use layout agressivo, excesso de elementos, fundo inventado ou composicao totalmente nova.",
        ],
        "leve": [
            "Estilo escolhido: Visual leve.",
            "Crie uma arte limpa, elegante e com bastante respiro visual.",
            "Pode adicionar poucas informacoes visuais, sempre usando somente o que o cliente enviou.",
            "Use poucos elementos, pouco texto, pouca poluicao visual e hierarquia simples.",
            "Deixe o logo visivel, mas discreto e bem integrado.",
            "Respeite fortemente fotos, referencias e dados enviados pelo cliente.",
            "Evite poluicao visual, excesso de efeitos, selos grandes e contrastes agressivos.",
        ],
        "normal": [
            "Estilo escolhido: Normal IA4Tube.",
            "Crie uma arte comercial equilibrada, profissional e clara.",
            "Organize CTA, oferta e informacoes principais com boa hierarquia.",
            "Use mais presenca visual que o modo leve, mas sem exagero.",
            "Mantenha leitura rapida em celular e identidade alinhada ao logo.",
        ],
        "agressivo": [
            "Estilo escolhido: Visual agressivo.",
            "Crie uma arte promocional forte, chamativa e de alto contraste.",
            "Destaque CTA, oferta, preco ou beneficio principal quando existirem.",
            "Use elementos de impacto, escala maior e contraste forte sem perder legibilidade.",
            "Mesmo no visual agressivo, respeite as cores, energia e identidade visual do logo.",
        ],
    }

    style_lines = list(instructions[style])
    if tem_foto_cliente and style in {"leve", "normal"}:
        style_lines.extend([
            "Como ha foto enviada pelo cliente, a foto do cliente e a base obrigatoria da arte final.",
            "Nao substitua a foto por outra imagem inventada.",
            "Nao crie outra pessoa, outro ambiente, outra fachada, outro produto principal ou outra cena.",
            "Pode melhorar qualidade, luz, enquadramento, composicao, layout, textos e identidade visual sem trocar a cena da foto.",
            "A composicao publicitaria deve ser construida a partir da foto enviada, nao no lugar dela.",
        ])

    return style_lines


def format_dna_value(value) -> str:
    if isinstance(value, list):
        return ", ".join(normalize_text(item) for item in value if normalize_text(item))
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return normalize_text(value)


COMPANY_DYNAMIC_FIELD_LABELS = {
    "nome_lanche": "Nome do lanche",
    "nome_produto": "Nome do produto",
    "nome_servico": "Nome do servico",
    "produto": "Produto",
    "servico": "Servico",
    "preco": "Preco",
    "ingredientes": "Ingredientes",
    "descricao": "Descricao",
    "delivery": "Delivery",
    "tipo_vidro": "Tipo do vidro",
    "acabamento": "Acabamento",
    "descricao_projeto": "Descricao do projeto",
    "publico_alvo": "Publico-alvo",
    "beneficio_principal": "Beneficio principal",
    "frase_impacto": "Frase de impacto",
    "chamada_whatsapp": "Chamada para WhatsApp",
    "prova_resultado": "Prova/resultado/exemplo",
    "observacao_arte": "Observacao da arte",
}


PUBLIC_COMPANY_DYNAMIC_FIELD_KEYS = {
    "preco",
    "valor",
    "oferta",
    "promocao",
    "cta",
    "frase_impacto",
    "chamada_whatsapp",
    "beneficio_principal",
    "delivery",
}


def humanize_company_dynamic_label(key: str) -> str:
    key = normalize_text(key)
    if key in COMPANY_DYNAMIC_FIELD_LABELS:
        return COMPANY_DYNAMIC_FIELD_LABELS[key]
    return key.replace("_", " ").strip().capitalize()


def build_company_dynamic_content_lines(order_model: dict) -> list[str]:
    fields = safe_dict(order_model.get("fields"))
    dynamic_fields = safe_dict(fields.get("campos_dinamicos"))
    lines: list[str] = []

    for key, value in dynamic_fields.items():
        key_norm = normalize_text(key)
        if key_norm not in PUBLIC_COMPANY_DYNAMIC_FIELD_KEYS:
            continue
        label = humanize_company_dynamic_label(key_norm)
        text = format_dna_value(value)
        if label and text:
            add_line(lines, f"{label}: {text}")

    return lines


def build_company_dynamic_context_lines(order_model: dict) -> list[str]:
    fields = safe_dict(order_model.get("fields"))
    dynamic_fields = safe_dict(fields.get("campos_dinamicos"))
    lines: list[str] = []

    for key, value in dynamic_fields.items():
        key_norm = normalize_text(key)
        text = format_dna_value(value)
        if key_norm and text:
            add_line(lines, f'- campo interno "{key_norm}": valor "{text}"')

    return lines


def build_company_dna_lines(order_model: dict) -> list[str]:
    raw = safe_dict(order_model.get("raw"))
    legacy = safe_dict(order_model.get("legacy"))
    dna = safe_dict(raw.get("niche_dna") or legacy.get("niche_dna"))

    labels = [
        ("estilo_visual", "Estilo visual"),
        ("publico_alvo", "Publico-alvo"),
        ("cores_sugeridas", "Cores sugeridas"),
        ("tipo_layout", "Tipo de layout"),
        ("ofertas_comuns", "Ofertas comuns"),
        ("chamadas", "Chamadas de venda"),
        ("ctas", "CTAs"),
        ("elementos_visuais", "Elementos visuais"),
        ("tipos_de_post", "Tipos de post"),
    ]

    lines: list[str] = []
    for key, label in labels:
        value = format_dna_value(dna.get(key))
        if value:
            lines.append(f"{label}: {value}")

    status = normalize_text(raw.get("niche_dna_status") or legacy.get("niche_dna_status"))
    if not lines and status:
        lines.append(f"Status do DNA: {status}")

    return lines


def get_company_model_reference(order_model: dict) -> dict:
    raw = safe_dict(order_model.get("raw"))
    legacy = safe_dict(order_model.get("legacy"))
    return safe_dict(raw.get("modelo_referencia") or legacy.get("modelo_referencia"))


def build_company_model_lines(order_model: dict) -> list[str]:
    raw = safe_dict(order_model.get("raw"))
    legacy = safe_dict(order_model.get("legacy"))
    modelo = get_company_model_reference(order_model)
    status = normalize_text(raw.get("modelo_status") or legacy.get("modelo_status"))
    erro = normalize_text(raw.get("modelo_erro") or legacy.get("modelo_erro"))
    score = normalize_text(raw.get("modelo_score") or legacy.get("modelo_score"))

    if not modelo:
        if status:
            lines = [f"Status do modelo: {status}"]
            if erro:
                lines.append(f"Motivo: {erro}")
            return lines
        return []

    lines: list[str] = []

    def add_labeled(label: str, value):
        value = format_dna_value(value)
        if value:
            lines.append(f"{label}: {value}")

    add_labeled("ID", modelo.get("id"))
    add_labeled("Ramo do modelo", modelo.get("ramo"))
    add_labeled("Objetivo do modelo", modelo.get("objetivo"))
    add_labeled("Tipo de post", modelo.get("tipo_post"))
    add_labeled("Estilo visual", modelo.get("estilo"))
    add_labeled("Cores", modelo.get("cores"))
    add_labeled("Layout", modelo.get("layout"))
    add_labeled("Texto principal exemplo", modelo.get("texto_principal"))
    add_labeled("CTA exemplo", modelo.get("cta"))
    add_labeled("Elementos", modelo.get("elementos"))
    if score:
        add_labeled("Score de escolha", score)

    return lines


def resolve_company_model_image(order_model: dict) -> Path | None:
    modelo = get_company_model_reference(order_model)
    if not modelo:
        return None

    image_path = normalize_text(modelo.get("imagem_exemplo_path"))
    if image_path:
        candidate = Path(image_path)
        if not candidate.is_absolute():
            candidate = BASE_DIR / image_path
        if candidate.exists():
            return candidate

    image_name = normalize_text(modelo.get("imagem_exemplo"))
    ramo_slug = normalize_text(modelo.get("ramo_slug"))
    if image_name and ramo_slug:
        candidate = BASE_DIR / "banco_modelos" / ramo_slug / image_name
        if candidate.exists():
            return candidate

    return None


def log_company_reference_counts(refs: list[Path], foto_paths: list[Path], logo_path: Path | None):
    photo_set = set(foto_paths or [])
    fotos_enviadas = sum(1 for ref in refs if ref in photo_set)
    logos_enviados = 1 if logo_path and logo_path in refs else 0
    outras_referencias = max(0, len(refs) - fotos_enviadas - logos_enviados)
    log(
        "contagem_referencias_arte_empresa: "
        f"fotos_cliente={fotos_enviadas} | "
        f"logos={logos_enviados} | "
        f"outras={outras_referencias} | "
        f"total={len(refs)}"
    )


def create_neutral_logo_canvas_reference(logo_path: Path, temp_dir: Path) -> Path:
    canvas_size = 1024
    max_logo_width = 520
    max_logo_height = 680
    temp_dir.mkdir(parents=True, exist_ok=True)
    temp_path = temp_dir / f"{logo_path.stem}_canvas_neutro.png"

    with Image.open(logo_path) as img:
        img.load()
        logo = img.convert("RGBA")
        scale = min(max_logo_width / logo.width, max_logo_height / logo.height)
        new_size = (
            max(1, int(round(logo.width * scale))),
            max(1, int(round(logo.height * scale))),
        )
        logo = logo.resize(new_size, Image.LANCZOS)

        canvas = Image.new("RGBA", (canvas_size, canvas_size), (255, 255, 255, 255))
        x = (canvas_size - logo.width) // 2
        y = (canvas_size - logo.height) // 2
        canvas.alpha_composite(logo, (x, y))
        canvas.convert("RGB").save(temp_path, "PNG")

    log("logo_canvas_neutro=true")
    log(f"logo_canvas_neutro_path: {temp_path}")
    log(f"logo_canvas_neutro_dimensoes: {canvas_size}x{canvas_size} | logo={new_size[0]}x{new_size[1]}")
    return temp_path


def build_company_text_lines_from_model(order_model: dict) -> list[str]:
    lines: list[str] = []

    def add_labeled(label: str, value: str):
        value = normalize_text(value)
        if value:
            add_line(lines, f"{label}: {value}")

    add_labeled("Nome da empresa", get_company_value(order_model, "nome_empresa", "company_name"))
    add_labeled("Oferta/promocao", get_company_value(order_model, "oferta", "offer"))
    add_labeled("CTA", get_company_value(order_model, "cta"))
    add_labeled("WhatsApp", get_company_whatsapp_value(order_model))
    add_labeled("Instagram", get_company_value(order_model, "instagram"))
    for line in build_company_dynamic_content_lines(order_model):
        add_line(lines, line)

    return lines


COMPANY_OBJECTIVE_LABEL = "Objetivo da arte:"


def is_company_objective_line(line: str) -> bool:
    return normalize_text(line).lower().startswith(COMPANY_OBJECTIVE_LABEL.lower())


def without_company_objective_lines(lines: list[str]) -> list[str]:
    return [line for line in lines if not is_company_objective_line(line)]


def build_internal_objective_direction(objective: str) -> str:
    objective_norm = normalize_text(objective)
    objective_lower = objective_norm.lower()
    if not objective_norm:
        return ""

    directions = []
    if "confi" in objective_lower or "credibilidade" in objective_lower:
        directions.append("confianca, credibilidade, acolhimento e seguranca")
    if "atrair" in objective_lower or "cliente" in objective_lower:
        directions.append("atracao de novos clientes e clareza da oferta")
    if "divulgar" in objective_lower or "empresa" in objective_lower:
        directions.append("divulgacao da empresa e valorizacao da marca")
    if "vender" in objective_lower or "venda" in objective_lower:
        directions.append("conversao comercial e destaque da oferta")

    if directions:
        return "; ".join(dict.fromkeys(directions))

    return "direcao interna de comunicacao, atmosfera e hierarquia comercial informada pelo cliente"


def without_internal_objective_value_lines(lines: list[str], objective: str) -> list[str]:
    objective_norm = normalize_text(objective).lower()
    if not objective_norm:
        return lines

    filtered = []
    for line in lines:
        line_norm = normalize_text(line)
        line_lower = line_norm.lower()
        value_lower = line_lower.split(":", 1)[1].strip() if ":" in line_lower else line_lower
        if value_lower == objective_norm:
            continue
        filtered.append(line)
    return filtered


def without_company_internal_objective_public_lines(order_model: dict, lines: list[str]) -> list[str]:
    objective = get_company_value(order_model, "objetivo", "objective")
    return without_internal_objective_value_lines(without_company_objective_lines(lines), objective)


def build_company_internal_objective_block(order_model: dict) -> str:
    objective = normalize_text(get_company_value(order_model, "objetivo", "objective"))
    if not objective:
        return ""
    objective_direction = build_internal_objective_direction(objective)

    return build_prompt_section(
        "OBJETIVO INTERNO DO PEDIDO",
        "\n".join([
            f"Direcao interna normalizada: {objective_direction}",
            "Este campo descreve a intencao da arte.",
            "Use-o para entender o que a imagem deve comunicar.",
            "O objetivo NAO e texto obrigatorio da arte.",
            "O objetivo NAO deve ser usado como headline.",
            "O objetivo NAO deve ser reproduzido literalmente.",
            "Use o objetivo apenas para decidir:",
            "- o foco principal da imagem;",
            "- o que deve receber mais destaque;",
            "- quais elementos devem aparecer;",
            "- qual mensagem a arte deve transmitir.",
            "O objetivo orienta a ideia da arte, nao o texto da arte.",
        ]),
    )


def build_company_context(order_model: dict) -> str:
    info_lines = without_company_internal_objective_public_lines(order_model, build_company_text_lines_from_model(order_model))
    dynamic_lines = build_company_dynamic_context_lines(order_model)
    style_lines = build_company_visual_style_lines(order_model)
    dna_lines = build_company_dna_lines(order_model)
    model_lines = build_company_model_lines(order_model)
    internal_objective = build_company_internal_objective_block(order_model)
    important_info = build_company_important_info_block(order_model)

    return "\n".join([
        "DADOS DA EMPRESA:",
        "\n".join(info_lines) if info_lines else "Sem dados empresariais adicionais.",
        "",
        important_info,
        "",
        internal_objective,
        "",
        "CAMPOS DINAMICOS COMO CONTEXTO INTERNO:",
        "\n".join(dynamic_lines) if dynamic_lines else "Nenhum campo dinamico preenchido.",
        "REGRA: os nomes dos campos internos ajudam a entender a funcao do valor, mas nao sao texto da arte.",
        "REGRA: nao escreva literalmente nomes de campos internos como tipo_projeto, publico_alvo, observacao_arte ou descricao_projeto.",
        "REGRA: use os valores dos campos para decidir produto, servico, contexto, beneficio, destaque e mensagem visual.",
        "REGRA: quando o valor for publicavel, transforme-o em linguagem natural adequada ao nicho.",
        "",
        "ESTILO VISUAL ESCOLHIDO PELO CLIENTE:",
        "\n".join(style_lines),
        "",
        "DNA VISUAL/COMERCIAL DO NICHO:",
        "\n".join(dna_lines) if dna_lines else "DNA ainda pendente. Use somente os dados do pedido e as imagens enviadas.",
        "",
        "MODELO INTERNO DE REFERENCIA:",
        "\n".join(model_lines) if model_lines else "Nenhum modelo interno encontrado. Use o DNA do nicho e as referencias do cliente.",
    ]).strip()


def build_company_prompt(prompt_base: str, texto_formatado: str, contexto_empresa: str, bloco_ajuste: str = "", conteudo_obrigatorio: str = "", knowledge_context: str = "") -> str:
    knowledge_context = str(knowledge_context or "").strip()
    bloco_conhecimento_nicho = ""
    if knowledge_context:
        bloco_conhecimento_nicho = f"""

CONHECIMENTO DO NICHO:
Use esta direcao do especialista para orientar linguagem, hierarquia comercial, atmosfera visual, CTA, termos do mercado e escolha da mensagem principal, sempre sem contradizer os dados reais do cliente.
Quando houver dados reais do cliente, combine-os com o especialista em vez de usar texto generico.
Nunca invente preco, contato, endereco, desconto, promessa ou informacao ausente.
{knowledge_context}
"""

    return f"""{prompt_base}

{bloco_ajuste}

BRIEFING EMPRESARIAL:
Use as informacoes abaixo como a fonte principal do pedido.
Organize a arte para marketing comercial, com leitura rapida e foco em conversao.
Nao transforme todos os dados em texto grande; escolha uma hierarquia visual clara.
Se houver CONTEUDO OBRIGATORIO ENVIADO PELO CLIENTE, use esse bloco como conteudo principal da arte.
O DNA do nicho e apenas inspiracao secundaria de estilo, nunca fonte principal de texto.

INFORMACOES DO CLIENTE:
{texto_formatado}

{conteudo_obrigatorio}

{contexto_empresa}
{bloco_conhecimento_nicho}

DIRECAO VISUAL E COMERCIAL:
- A logo da empresa e a referencia visual principal da marca.
- Extraia da logo a paleta de cores, contraste, sensacao, energia, estilo grafico e identidade visual.
- Nao use cores aleatorias se a logo tiver cores fortes ou identidade clara.
- Fotos do cliente podem orientar produto, servico, ambiente e composicao, mas a identidade visual vem primeiro da logo.
- Use o DNA do nicho para orientar linguagem, cores, elementos e tipo de layout.
- Use o modelo interno como referencia de composicao, ritmo visual, hierarquia e estilo.
- O modelo interno e apenas uma referencia artistica de composicao, hierarquia, ritmo visual e estilo.
- Nao copie texto, logo, marca, nome, telefone, identidade visual ou qualquer dado do modelo interno.
- Se houver modelo existente enviado pelo cliente, use apenas como guia de composicao, cores, ritmo visual e layout.
- Nao copie textos, telefone, Instagram, preco, data, endereco, marca antiga ou informacoes antigas do modelo existente.
- Substitua o conteudo do modelo existente pelos textos e dados atuais do pedido.
- Substitua toda informacao visual/textual do modelo pelos dados reais do cliente.
- Adapte a composicao para os dados reais do cliente.
- Se houver fotos do cliente, use para representar produto, servico, ambiente ou equipe.
- Se houver referencias do cliente, use apenas como direcao visual.
- Se faltar dado do cliente, omita esse elemento em vez de inventar.
- Nao invente texto quando houver campos dinamicos preenchidos.
- Nao invente preco, promocao, desconto, slogan, CTA, telefone, endereco, beneficio ou nome de produto.
- Use oferta e CTA somente se estiverem preenchidos no pedido.
- Priorize a mensagem principal enviada pelo cliente; use beneficio e CTA somente quando informados.
- Garanta legibilidade em celular, contraste e respiro visual.

REGRAS CRITICAS:
- Nao invente informacao ausente.
- Nao invente telefone, Instagram, endereco, preco, desconto, promocao, slogan, CTA, beneficio, nome de produto ou promessa.
- Se algum campo estiver vazio, omita.
- Nao use texto generico para preencher espaco.
- Nao copie marcas de terceiros.
- Entregue uma arte profissional, comercial e pronta para postagem.
"""


def find_existing_many(folder: Path, names: list[str]) -> list[Path]:
    found: list[Path] = []
    seen: set[Path] = set()

    for name in names:
        path = find_existing(folder, [name])
        if not path:
            continue
        resolved = path.resolve()
        if resolved in seen:
            continue
        found.append(path)
        seen.add(resolved)

    return found


def build_company_reference_images(pedido_dir: Path, order_model: dict, text_ref_path: Path) -> list[Path]:
    refs: list[Path] = []
    seen: set[Path] = set()

    logo_names = get_clean_asset_names(order_model, "logo") + [
        "logo.png", "logo.jpg", "logo.jpeg", "logo.webp"
    ]
    logo_path = find_existing(pedido_dir, logo_names)
    foto_paths = find_company_client_photo_paths(pedido_dir, order_model)
    tem_foto_cliente = bool(foto_paths)
    modelo_existente_names = get_clean_asset_names(order_model, "modelo_existente") + [
        "modelo_existente.png", "modelo_existente.jpg", "modelo_existente.jpeg", "modelo_existente.webp"
    ]
    referencia_names = get_clean_asset_names(order_model, "referencias")
    for i in range(1, 21):
        referencia_names.extend([
            f"referencia{i:02d}.png", f"referencia{i:02d}.jpg", f"referencia{i:02d}.jpeg", f"referencia{i:02d}.webp"
        ])
    referencia_paths = find_existing_many(pedido_dir, referencia_names)
    modelo_existente_path = find_existing(pedido_dir, modelo_existente_names)
    modelo_interno_path = resolve_company_model_image(order_model)
    pedido_layout_path = pedido_dir / "pedido.png"

    log(f"tem_foto_cliente: {str(tem_foto_cliente).lower()}")
    log(f"foto_base_obrigatoria: {str(tem_foto_cliente).lower()}")
    logo_count_path = logo_path
    logo_only_reference = False

    if get_company_visual_style(order_model) == "foto_detalhes":
        # Embelezar foto: a primeira imagem enviada precisa ser a foto base.
        # Modelos internos e referencias extras podem induzir a IA a inventar outra cena.
        if not foto_paths:
            raise RuntimeError("Embelezar foto precisa de uma foto base enviada pelo cliente.")
        for path in foto_paths:
            unique_append(refs, path, seen)
        unique_append(refs, logo_path, seen)
        unique_append(refs, find_existing(pedido_dir, modelo_existente_names), seen)
        unique_append(refs, text_ref_path, seen)

        if len(refs) > MAX_REFERENCIAS:
            log(f"Aviso: Foram encontradas {len(refs)} imagens. Enviarei somente as primeiras {MAX_REFERENCIAS}.")
            refs = refs[:MAX_REFERENCIAS]

        log_company_reference_counts(refs, foto_paths, logo_path)
        log("Referencias arte_empresa foto_detalhes:")
        for idx, ref in enumerate(refs, start=1):
            log(f"   {idx:02d}. {ref}")

        return refs

    if tem_foto_cliente:
        # Quando ha foto do cliente, ela deve ter prioridade e ir antes de logo/modelos.
        for path in foto_paths:
            unique_append(refs, path, seen)
        unique_append(refs, logo_path, seen)
    else:
        # Sem foto do cliente e sem outras referencias do pedido, envia a logo em canvas neutro.
        logo_ref_path = logo_path
        logo_only_reference = (
            logo_path
            and not referencia_paths
            and not modelo_existente_path
            and not modelo_interno_path
            and not text_ref_path.exists()
            and not pedido_layout_path.exists()
        )
        if logo_only_reference:
            try:
                logo_ref_path = create_neutral_logo_canvas_reference(logo_path, text_ref_path.parent)
                logo_count_path = logo_ref_path
            except Exception as exc:
                log(f"Aviso: nao consegui criar canvas neutro da logo ({exc}). Usando logo original.")
        unique_append(refs, logo_ref_path, seen)
        if logo_ref_path != logo_path and logo_path:
            seen.add(logo_path.resolve())

    for path in referencia_paths:
        unique_append(refs, path, seen)

    unique_append(refs, modelo_existente_path, seen)

    unique_append(refs, modelo_interno_path, seen)

    unique_append(refs, text_ref_path, seen)
    unique_append(refs, pedido_layout_path, seen)

    if not logo_only_reference:
        for p in collect_extra_images(pedido_dir, seen):
            unique_append(refs, p, seen)

    if len(refs) > MAX_REFERENCIAS:
        log(f"Aviso: Foram encontradas {len(refs)} imagens. Enviarei somente as primeiras {MAX_REFERENCIAS}.")
        refs = refs[:MAX_REFERENCIAS]

    log_company_reference_counts(refs, foto_paths, logo_count_path)
    log("Referencias arte_empresa:")
    for idx, ref in enumerate(refs, start=1):
        log(f"   {idx:02d}. {ref}")

    return refs


def build_clean_product_text_lines(order_model: dict) -> list[str]:
    product_id = get_clean_product_id(order_model)
    config = CLEAN_SIMPLE_PRODUCTS.get(product_id)
    if not config:
        return build_text_lines(safe_dict(order_model.get("legacy")))

    fields = safe_dict(order_model.get("fields"))
    lines: list[str] = []

    for key in config.get("text_fields", []):
        add_line(lines, fields.get(key, ""))

    if lines:
        return lines

    return build_text_lines(safe_dict(order_model.get("legacy")))


def find_clean_product_assets(pedido_dir: Path, order_model: dict) -> dict:
    product_id = get_clean_product_id(order_model)
    config = CLEAN_SIMPLE_PRODUCTS.get(product_id, {})
    legacy = safe_dict(order_model.get("legacy"))

    team_crest_names = get_clean_asset_names(order_model, config.get("team_crest_asset", "team_crest")) + [
        normalize_text(legacy.get("escudo_principal", "")),
        "escudo1.png",
        "escudo1.jpg",
        "escudo1.jpeg",
        "escudo1.webp",
    ]

    player_photo_names = get_clean_asset_names(order_model, config.get("photo_asset", "player_photo"))
    for legacy_name in config.get("photo_legacy_names", ["foto_jogo"]):
        player_photo_names.append(normalize_text(legacy.get(legacy_name, "")))
    player_photo_names.extend(config.get("photo_fallback_files", []))

    return {
        "escudo": find_existing(pedido_dir, team_crest_names),
        "foto": find_existing(pedido_dir, player_photo_names),
        "escudo2": None,
    }


def build_clean_product_reference_images(pedido_dir: Path, order_model: dict, text_ref_path: Path) -> list[Path]:
    product_id = get_clean_product_id(order_model)
    template_dir = template_dir_for_categoria(product_id)
    assets = find_clean_product_assets(pedido_dir, order_model)

    refs: list[Path] = []
    seen: set[Path] = set()

    pedido_layout_img = pedido_dir / "pedido.png"
    unique_append(refs, pedido_layout_img, seen)
    unique_append(refs, assets.get("escudo"), seen)
    unique_append(refs, assets.get("foto"), seen)

    for p in collect_template_refs(template_dir):
        unique_append(refs, p, seen)

    for p in collect_extra_images(pedido_dir, seen):
        unique_append(refs, p, seen)

    if len(refs) > MAX_REFERENCIAS:
        log(f"Aviso: Foram encontradas {len(refs)} imagens. Enviarei somente as primeiras {MAX_REFERENCIAS}.")
        refs = refs[:MAX_REFERENCIAS]

    return refs


def get_clean_result_field(order_model: dict, key: str) -> str:
    fields = safe_dict(order_model.get("fields"))
    score = safe_dict(fields.get("score"))
    return normalize_text(fields.get(key, "") or score.get(key, ""))


def build_clean_result_score_text(order_model: dict) -> str:
    home_team = get_clean_result_field(order_model, "home_team")
    away_team = get_clean_result_field(order_model, "away_team")
    home_score = get_clean_result_field(order_model, "home_score")
    away_score = get_clean_result_field(order_model, "away_score")

    has_any_score_data = bool(home_team or away_team or home_score or away_score)
    if not has_any_score_data:
        return ""

    if not home_score:
        home_score = "0"
    if not away_score:
        away_score = "0"

    if home_team and away_team:
        return f"{home_team} {home_score} x {away_score} {away_team}"

    if home_team:
        return f"{home_team} {home_score} x {away_score}"

    return f"{home_score} x {away_score} {away_team}".strip()


def build_clean_result_scorer_lines(order_model: dict) -> list[str]:
    product_id = get_clean_product_id(order_model)
    config = CLEAN_RESULT_PRODUCTS.get(product_id, {})
    if not config.get("include_scorers"):
        return []

    fields = safe_dict(order_model.get("fields"))
    scorers = fields.get("scorers", [])
    if not isinstance(scorers, list):
        return []

    lines = []
    for item in scorers:
        if not isinstance(item, dict):
            continue

        nome = normalize_text(item.get("nome", "") or item.get("name", ""))
        gols = normalize_text(item.get("gols", "") or item.get("goals", ""))

        if not nome:
            continue

        if gols:
            lines.append(f"{nome} ({gols})")
        else:
            lines.append(nome)

    return lines


def build_clean_result_text_lines(order_model: dict) -> list[str]:
    lines: list[str] = []

    add_line(lines, build_clean_result_score_text(order_model))
    add_line(lines, get_clean_result_field(order_model, "headline"))
    add_line(lines, get_clean_result_field(order_model, "competition"))

    scorers = build_clean_result_scorer_lines(order_model)
    if scorers:
        add_line(lines, "Artilheiros:")
        for scorer in scorers:
            add_line(lines, scorer)

    if lines:
        return limpar_linhas_visuais(lines)

    return build_text_lines(safe_dict(order_model.get("legacy")))


def find_clean_result_assets(pedido_dir: Path, order_model: dict) -> dict:
    product_id = get_clean_product_id(order_model)
    config = CLEAN_RESULT_PRODUCTS.get(product_id, {})
    legacy = safe_dict(order_model.get("legacy"))

    home_crest_names = get_clean_asset_names(order_model, "home_crest") + [
        normalize_text(legacy.get("escudo_principal", "")),
        "escudo1.png", "escudo1.jpg", "escudo1.jpeg", "escudo1.webp",
    ]

    away_crest_names = get_clean_asset_names(order_model, "away_crest") + [
        normalize_text(legacy.get("escudo_adversario", "")),
        "escudo2.png", "escudo2.jpg", "escudo2.jpeg", "escudo2.webp",
    ]

    photo_asset = config.get("photo_asset", "match_photo")
    photo_names = get_clean_asset_names(order_model, photo_asset) + [
        normalize_text(legacy.get("foto_jogo", "")),
        "mascote.png", "mascote.jpg", "mascote.jpeg", "mascote.webp",
    ]

    return {
        "escudo": find_existing(pedido_dir, home_crest_names),
        "escudo2": find_existing(pedido_dir, away_crest_names),
        "foto": find_existing(pedido_dir, photo_names),
    }


def build_clean_result_reference_images(pedido_dir: Path, order_model: dict, text_ref_path: Path) -> list[Path]:
    product_id = get_clean_product_id(order_model)
    template_dir = template_dir_for_categoria(product_id)
    assets = find_clean_result_assets(pedido_dir, order_model)

    refs: list[Path] = []
    seen: set[Path] = set()

    pedido_layout_img = pedido_dir / "pedido.png"
    unique_append(refs, pedido_layout_img, seen)
    unique_append(refs, assets.get("escudo"), seen)
    unique_append(refs, assets.get("escudo2"), seen)
    unique_append(refs, assets.get("foto"), seen)

    for p in collect_template_refs(template_dir):
        unique_append(refs, p, seen)

    for p in collect_extra_images(pedido_dir, seen):
        unique_append(refs, p, seen)

    if len(refs) > MAX_REFERENCIAS:
        log(f"Aviso: Foram encontradas {len(refs)} imagens. Enviarei somente as primeiras {MAX_REFERENCIAS}.")
        refs = refs[:MAX_REFERENCIAS]

    return refs


def get_first_clean_field(fields: dict, keys: list[str]) -> str:
    for key in keys:
        value = normalize_text(fields.get(key, ""))
        if value:
            return value
    return ""


def get_clean_matchup_text(order_model: dict) -> str:
    fields = safe_dict(order_model.get("fields"))
    matchup = fields.get("matchup")

    if isinstance(matchup, dict):
        home = normalize_text(matchup.get("home_team", "") or matchup.get("time_principal", ""))
        away = normalize_text(matchup.get("away_team", "") or matchup.get("time_adversario", ""))
        title = normalize_text(matchup.get("title", "") or matchup.get("text", ""))
    else:
        home = ""
        away = ""
        title = normalize_text(matchup)

    home = home or get_first_clean_field(fields, ["home_team", "time_principal", "team_home"])
    away = away or get_first_clean_field(fields, ["away_team", "time_adversario", "team_away"])

    if home and away:
        return f"{home} x {away}"

    return title


def build_clean_players_lines(order_model: dict) -> list[str]:
    fields = safe_dict(order_model.get("fields"))
    players = fields.get("players", [])
    if not isinstance(players, list):
        return []

    lines = []
    for item in players:
        if not isinstance(item, dict):
            continue

        nome = normalize_text(item.get("nome", "") or item.get("name", ""))
        posicao = normalize_text(item.get("posicao", "") or item.get("position", ""))

        if nome and posicao:
            lines.append(f"{nome} - {posicao}")
        elif nome:
            lines.append(nome)
        elif posicao:
            lines.append(posicao)

    return lines


def build_clean_structured_text_lines(order_model: dict) -> list[str]:
    product_id = get_clean_product_id(order_model)
    fields = safe_dict(order_model.get("fields"))
    lines: list[str] = []

    if product_id == "escalacao":
        add_line(lines, get_clean_matchup_text(order_model))
        add_line(lines, get_first_clean_field(fields, ["match_datetime", "date_time", "data"]))
        add_line(lines, get_first_clean_field(fields, ["competition", "campeonato", "hora"]))
        add_line(lines, get_first_clean_field(fields, ["venue", "arena", "local"]))

        for player in build_clean_players_lines(order_model):
            add_line(lines, player)

    elif product_id == "patrocinador":
        add_line(lines, get_first_clean_field(fields, ["title", "titulo", "rodada"]))
        add_line(lines, get_first_clean_field(fields, ["headline", "texto", "data"]))

    elif product_id == "proximo_jogo":
        add_line(lines, get_clean_matchup_text(order_model))
        add_line(lines, get_first_clean_field(fields, ["match_datetime", "date_time", "data"]))
        add_line(lines, get_first_clean_field(fields, ["competition", "campeonato", "hora"]))
        add_line(lines, get_first_clean_field(fields, ["venue", "arena", "local"]))

    elif product_id == "treino":
        add_line(lines, get_first_clean_field(fields, ["title", "titulo", "rodada"]))
        add_line(lines, get_first_clean_field(fields, ["headline", "chamada", "data"]))
        add_line(lines, get_first_clean_field(fields, ["context", "competition", "campeonato", "hora"]))
        add_line(lines, get_first_clean_field(fields, ["venue", "arena", "local"]))

    if lines:
        return limpar_linhas_visuais(lines)

    return build_text_lines(safe_dict(order_model.get("legacy")))


def find_clean_structured_assets(pedido_dir: Path, order_model: dict) -> dict:
    product_id = get_clean_product_id(order_model)
    config = CLEAN_STRUCTURED_PRODUCTS.get(product_id, {})
    legacy = safe_dict(order_model.get("legacy"))

    escudo_names = get_clean_asset_names(
        order_model,
        config.get("team_crest_asset") or config.get("home_crest_asset", "team_crest")
    ) + [
        normalize_text(legacy.get("escudo_principal", "")),
        "escudo1.png", "escudo1.jpg", "escudo1.jpeg", "escudo1.webp",
    ]

    escudo2_names = get_clean_asset_names(
        order_model,
        config.get("opponent_crest_asset") or config.get("away_crest_asset", "away_crest")
    ) + [
        normalize_text(legacy.get("escudo_adversario", "")),
        "escudo2.png", "escudo2.jpg", "escudo2.jpeg", "escudo2.webp",
    ]

    photo_names = get_clean_asset_names(order_model, config.get("photo_asset", "team_photo")) + [
        normalize_text(legacy.get("foto_jogo", "")),
        "mascote.png", "mascote.jpg", "mascote.jpeg", "mascote.webp",
    ]

    return {
        "escudo": find_existing(pedido_dir, escudo_names),
        "escudo2": find_existing(pedido_dir, escudo2_names),
        "foto": find_existing(pedido_dir, photo_names),
    }


def find_clean_sponsor_files(pedido_dir: Path, order_model: dict) -> list[Path]:
    config = CLEAN_STRUCTURED_PRODUCTS.get("patrocinador", {})
    sponsor_names = get_clean_asset_names(order_model, config.get("sponsor_asset", "sponsor_logos"))
    sponsors: list[Path] = []
    seen: set[Path] = set()

    for name in sponsor_names:
        path = find_existing(pedido_dir, [name])
        if path:
            unique_append(sponsors, path, seen)

    for path in find_patrocinadores(pedido_dir):
        unique_append(sponsors, path, seen)

    return sponsors


def build_clean_structured_reference_images(pedido_dir: Path, order_model: dict, text_ref_path: Path) -> list[Path]:
    product_id = get_clean_product_id(order_model)
    template_dir = template_dir_for_categoria(product_id)
    assets = find_clean_structured_assets(pedido_dir, order_model)

    refs: list[Path] = []
    seen: set[Path] = set()

    pedido_layout_img = pedido_dir / "pedido.png"
    unique_append(refs, pedido_layout_img, seen)
    unique_append(refs, assets.get("escudo"), seen)

    if product_id in {"escalacao", "proximo_jogo"}:
        unique_append(refs, assets.get("escudo2"), seen)

    if product_id in {"escalacao", "treino"}:
        unique_append(refs, assets.get("foto"), seen)

    for p in collect_template_refs(template_dir):
        unique_append(refs, p, seen)

    if product_id == "patrocinador":
        for p in find_clean_sponsor_files(pedido_dir, order_model):
            unique_append(refs, p, seen)

    for p in collect_extra_images(pedido_dir, seen):
        unique_append(refs, p, seen)

    if len(refs) > MAX_REFERENCIAS:
        log(f"Aviso: Foram encontradas {len(refs)} imagens. Enviarei somente as primeiras {MAX_REFERENCIAS}.")
        refs = refs[:MAX_REFERENCIAS]

    return refs


def load_api_key() -> str:
    if not OPENAI_KEY_FILE.exists():
        raise FileNotFoundError(f"Não achei {OPENAI_KEY_FILE.name} na mesma pasta do script.")

    key = OPENAI_KEY_FILE.read_text(encoding="utf-8", errors="ignore").strip()
    if not key:
        raise ValueError(f"{OPENAI_KEY_FILE.name} está vazio.")

    return key


def load_credentials() -> tuple[str, str]:
    if not CREDENTIALS_FILE.exists():
        raise FileNotFoundError("credenciais.txt não encontrado na mesma pasta do script.")

    linhas = CREDENTIALS_FILE.read_text(encoding="utf-8", errors="ignore").splitlines()
    if len(linhas) < 2:
        raise ValueError("credenciais.txt inválido. Use linha 1 = whatsapp, linha 2 = senha.")

    whatsapp = linhas[0].strip()
    senha = linhas[1].strip()

    if not whatsapp or not senha:
        raise ValueError("credenciais.txt inválido. WhatsApp ou senha vazios.")

    return whatsapp, senha


def find_existing(folder: Path, names: list[str]) -> Path | None:
    for name in names:
        if not name:
            continue
        p = folder / str(name).strip()
        if p.exists() and p.is_file():
            return p
    return None


def optional_template_file(folder: Path, names: list[str]) -> Path | None:
    if not folder.exists():
        return None

    for name in names:
        p = folder / name
        if p.exists() and p.is_file():
            return p

    return None


def safe_json_list(value) -> list:
    if isinstance(value, list):
        return value

    if isinstance(value, str):
        value = value.strip()
        if not value:
            return []
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except Exception:
            return []

    return []


import unicodedata

def normalize_text(value) -> str:
    texto = " ".join(str(value or "").replace("\r", "\n").split()).strip()
    return unicodedata.normalize("NFC", texto)


def is_image_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}


# =========================================================
# PEDIDO / TEXTO
# =========================================================

def get_categoria(pedido: dict) -> str:
    return str(pedido.get("categoria", "")).strip().lower()


def build_score_text(pedido: dict) -> str:
    time_principal = normalize_text(pedido.get("time_principal", ""))
    time_adversario = normalize_text(pedido.get("time_adversario", ""))

    gols_time = str(pedido.get("gols_time_principal", "")).strip()
    gols_adv = str(pedido.get("gols_adversario", "")).strip()

    tem_placar = bool(time_principal or time_adversario or gols_time or gols_adv)

    if not tem_placar:
        return normalize_text(pedido.get("rodada", ""))

    if not gols_time:
        gols_time = "0"
    if not gols_adv:
        gols_adv = "0"

    if time_principal and time_adversario:
        return f"{time_principal} {gols_time} x {gols_adv} {time_adversario}"

    if time_principal:
        return f"{time_principal} {gols_time} x {gols_adv}"

    return f"{gols_time} x {gols_adv}"


def build_artilheiros_text(pedido: dict) -> list[str]:
    artilheiros = safe_json_list(pedido.get("artilheiros", []))
    linhas = []

    for item in artilheiros:
        if not isinstance(item, dict):
            continue

        nome = normalize_text(item.get("nome", ""))
        gols = normalize_text(item.get("gols", ""))

        if not nome:
            continue

        if gols:
            linhas.append(f"{nome} ({gols})")
        else:
            linhas.append(nome)

    return linhas


def build_jogadores_text(pedido: dict) -> list[str]:
    jogadores = safe_json_list(pedido.get("jogadores", []))
    linhas = []

    for item in jogadores:
        if not isinstance(item, dict):
            continue

        nome = normalize_text(item.get("nome", ""))
        posicao = normalize_text(item.get("posicao", ""))

        if nome and posicao:
            linhas.append(f"{nome} - {posicao}")
        elif nome:
            linhas.append(nome)
        elif posicao:
            linhas.append(posicao)

    return linhas


def corrigir_linhas_texto(linhas: list[str]) -> list[str]:
    linhas_originais = [normalize_text(l) for l in linhas if normalize_text(l)]

    if not linhas_originais:
        return linhas_originais

    try:
        client = OpenAI(api_key=load_api_key(), timeout=DESCRIPTION_TIMEOUT_SECONDS)

        prompt = f"""
Corrija apenas ortografia, acentuação e concordância básica das linhas abaixo.

REGRAS:
- NÃO invente informação nova.
- NÃO mude nomes próprios.
- NÃO mude nomes de times.
- NÃO resuma.
- NÃO traduza.
- NÃO coloque aspas.
- Mantenha a MESMA quantidade de linhas.
- Responda APENAS em JSON válido no formato:
{{"linhas":["linha 1","linha 2"]}}

LINHAS:
{json.dumps(linhas_originais, ensure_ascii=False)}
"""

        response = client.responses.create(
            model="gpt-5-mini",
            input=prompt
        )

        data = json.loads(response.output_text.strip())
        corrigidas = data.get("linhas", [])

        if not isinstance(corrigidas, list):
            return linhas_originais

        corrigidas = [normalize_text(l) for l in corrigidas]

        if len(corrigidas) != len(linhas_originais):
            return linhas_originais

        for original, corrigida in zip(linhas_originais, corrigidas):
            if not corrigida:
                return linhas_originais
            if len(corrigida) > len(original) * 1.8:
                return linhas_originais

        return corrigidas

    except Exception:
        return linhas_originais


def add_line(lines: list[str], text: str):
    text = normalize_text(text)
    if text and text not in lines:
        lines.append(text)


def build_required_client_content_block(linhas: list[str]) -> str:
    linhas_limpas = without_company_objective_lines([normalize_text(linha) for linha in linhas if normalize_text(linha)])
    conteudo = "\n".join(f"- {linha}" for linha in linhas_limpas) if linhas_limpas else "- Nenhum campo preenchido."

    return f"""CONTEUDO OBRIGATORIO ENVIADO PELO CLIENTE:
{conteudo}

REGRA GLOBAL DO IA4TUBE:
- Use essas informacoes com prioridade maxima no flyer.
- Nao ignore nenhum campo preenchido pelo cliente.
- Nao substitua o que o cliente escreveu por texto generico.
- Nao invente dados conflitantes.
- Nao troque nome, preco, placar, data, hora, local, jogador, time, patrocinador, produto, servico, CTA ou oferta enviados pelo cliente.
- Se for texto curto, mantenha fiel.
- Se precisar ajustar, corrija apenas ortografia, acentuacao e formatacao, sem mudar o sentido.
- Campos vazios podem ser omitidos.
- Textos automaticos so podem complementar quando o campo estiver vazio ou quando o produto exigir atmosfera/narrativa.
- Em caso de conflito, a prioridade e: CLIENTE > produto > modelo interno > DNA/prompt generico."""


def texto_tem_horario(texto: str) -> bool:
    texto = normalize_text(texto).lower()
    if not texto:
        return False

    padroes = [
        "h da manhã",
        "h da manha",
        "hrs",
        "horas",
        "às ",
        "as ",
        ":"
    ]

    if any(p in texto for p in padroes):
        return any(ch.isdigit() for ch in texto)

    return False


def texto_parece_tipo_jogo(texto: str) -> bool:
    texto = normalize_text(texto).lower()
    if not texto:
        return False

    tipos = [
        "amistoso",
        "campeonato",
        "torneio",
        "copa",
        "final",
        "semifinal",
        "quartas",
        "rodada",
        "jogo treino",
        "jogo-treino"
    ]

    return any(tipo in texto for tipo in tipos)


def limpar_linhas_visuais(linhas: list[str]) -> list[str]:
    limpas = []
    tem_horario_em_linha_anterior = False

    for linha in linhas:
        linha = normalize_text(linha)
        if not linha:
            continue

        if texto_tem_horario(linha):
            if tem_horario_em_linha_anterior:
                continue
            tem_horario_em_linha_anterior = True

        if linha not in limpas:
            limpas.append(linha)

    return limpas


def build_text_lines(pedido: dict) -> list[str]:
    categoria = get_categoria(pedido)

    titulo_pedido = normalize_text(pedido.get("titulo", ""))
    rodada = normalize_text(pedido.get("rodada", ""))
    data = normalize_text(pedido.get("data", ""))
    hora = normalize_text(pedido.get("hora", ""))
    arena = normalize_text(pedido.get("arena", ""))
    frase = normalize_text(pedido.get("frase", ""))

    lines: list[str] = []

    if categoria == "resultado":
        add_line(lines, build_score_text(pedido))
        add_line(lines, rodada)
        add_line(lines, data)
        add_line(lines, hora)

        artilheiros = build_artilheiros_text(pedido)
        if artilheiros:
            add_line(lines, "Artilheiros:")
            for linha in artilheiros:
                add_line(lines, linha)

    elif categoria == "escalacao":
        add_line(lines, rodada)
        add_line(lines, data)
        add_line(lines, hora)
        add_line(lines, arena)

        jogadores = build_jogadores_text(pedido)
        for jogador in jogadores:
            add_line(lines, jogador)

    elif categoria == "contratacao":
        add_line(lines, rodada)
        add_line(lines, data)
        add_line(lines, hora)

    elif categoria == "proximo_jogo":

        time_principal = normalize_text(pedido.get("time_principal", ""))
        time_adversario = normalize_text(pedido.get("time_adversario", ""))

        if time_principal and time_adversario:
            add_line(lines, f"{time_principal} x {time_adversario}")
        else:
            add_line(lines, rodada)
            add_line(lines, time_principal)
            add_line(lines, time_adversario)

        add_line(lines, data)
        if not texto_tem_horario(data) or texto_parece_tipo_jogo(hora):
            add_line(lines, hora)
        add_line(lines, arena)

    elif categoria == "treino":
        add_line(lines, rodada)
        add_line(lines, data)
        add_line(lines, hora)
        add_line(lines, arena)

    elif categoria == "proximo_jogo_jogador":
        time_principal = normalize_text(pedido.get("time_principal", ""))
        time_adversario = normalize_text(pedido.get("time_adversario", ""))

        if time_principal and time_adversario:
            add_line(lines, f"{time_principal} x {time_adversario}")
        else:
            add_line(lines, rodada)
            add_line(lines, time_principal)
            add_line(lines, time_adversario)

        add_line(lines, data)
        if not texto_tem_horario(data) or texto_parece_tipo_jogo(hora):
            add_line(lines, hora)
        add_line(lines, arena)

    elif categoria == "resultado_jogo_jogador":
        add_line(lines, build_score_text(pedido))
        add_line(lines, rodada)
        add_line(lines, data)
        add_line(lines, hora)

    elif categoria == "jogador_escudo":
        add_line(lines, data)
        add_line(lines, rodada)

        jogadores = build_jogadores_text(pedido)
        for jogador in jogadores:
            add_line(lines, jogador)

    elif categoria == "mascote_uniforme":
        add_line(lines, data)
        add_line(lines, rodada)

        jogadores = build_jogadores_text(pedido)
        for jogador in jogadores:
            add_line(lines, jogador)

    elif categoria == "patrocinador":
        add_line(lines, rodada)
        add_line(lines, data)

    elif categoria == "arte_empresa":
        for label, value in [
            ("Nome da empresa", pedido.get("nome_empresa", "")),
            ("Oferta/promocao", pedido.get("oferta", "")),
            ("CTA", pedido.get("cta", "")),
            ("WhatsApp", pedido.get("whatsapp_contato", "") or pedido.get("whatsapp", "")),
            ("Instagram", pedido.get("instagram", "")),
        ]:
            value = normalize_text(value)
            if value:
                add_line(lines, f"{label}: {value}")

    elif categoria == "escudo3d":
        pass

    else:
        add_line(lines, rodada)
        add_line(lines, data)
        add_line(lines, frase)

    return limpar_linhas_visuais(lines)


def load_font(size: int, bold: bool = False):
    candidates = []

    if bold:
        candidates.extend([
            FONT_DIR / "Anton-Regular.ttf",
            FONT_DIR / "Montserrat-Bold.ttf",
            FONT_DIR / "Montserrat[wght].ttf",
        ])

    candidates.extend([
        FONT_DIR / "Montserrat.ttf",
        FONT_DIR / "Montserrat-Regular.ttf",
        FONT_DIR / "BebasNeue-Regular.ttf",
        Path("C:/Windows/Fonts/arialbd.ttf") if bold else Path("C:/Windows/Fonts/arial.ttf"),
    ])

    for path in candidates:
        try:
            if path.exists():
                return ImageFont.truetype(str(path), size=size)
        except Exception:
            pass

    return ImageFont.load_default()


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> list[str]:
    words = str(text or "").split()
    if not words:
        return []

    lines = []
    current = ""

    for word in words:
        candidate = word if not current else f"{current} {word}"
        bbox = draw.textbbox((0, 0), candidate, font=font)
        w = bbox[2] - bbox[0]

        if w <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word

    if current:
        lines.append(current)

    return lines


def render_text_reference_image(lines: list[str], output_path: Path):
    img = Image.new("RGB", (W_REF, H_REF), (0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin_x = 70
    y = 70
    max_width = W_REF - (margin_x * 2)

    title_font = load_font(58, bold=True)
    body_font = load_font(34, bold=True)
    small_font = load_font(28, bold=False)

    for idx, line in enumerate(lines):
        if y > H_REF - 90:
            break

        font = title_font if idx == 0 else body_font
        line_spacing = 12 if idx == 0 else 8

        wrapped = wrap_text(draw, line, font, max_width)

        for subline in wrapped:
            bbox = draw.textbbox((0, 0), subline, font=font)
            w = bbox[2] - bbox[0]
            h = bbox[3] - bbox[1]

            x = int((W_REF - w) / 2)
            draw.text((x, y), subline, font=font, fill=(255, 255, 255))

            y += h + line_spacing

        if idx == 0:
            y += 28
        else:
            y += 10

    if y > H_REF - 120:
        aviso = "Texto extra cortado por limite visual."
        draw.text((margin_x, H_REF - 70), aviso, font=small_font, fill=(255, 255, 255))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(output_path)


# =========================================================
# PROMPT
# =========================================================

DEFAULT_PROMPT_IMAGEM = ""


def prompt_file_for_categoria(categoria: str) -> Path:
    categoria = normalize_text(categoria).lower().replace("-", "_").replace(" ", "_")
    prompt_file = PROMPT_FILES.get(categoria, PROMPT_IMAGEM_FILE)

    if categoria in FOOTBALL_PROMPT_PRODUCTS:
        football_prompt_file = FOOTBALL_NICHE_PROMPT_DIR / prompt_file.name
        if football_prompt_file.exists():
            return football_prompt_file

    return prompt_file


def display_path_for_log(path: Path) -> str:
    try:
        return path.relative_to(BASE_DIR).as_posix()
    except ValueError:
        return path.name


def read_text_file_if_exists(path: Path) -> str:
    try:
        if path.exists() and path.is_file():
            return path.read_text(encoding="utf-8", errors="ignore").strip()
    except Exception as exc:
        log(f"Aviso: nao consegui carregar {display_path_for_log(path)} ({exc})")
    return ""


def build_prompt_section(title: str, body: str) -> str:
    body = str(body or "").strip()
    if not body:
        return ""
    return f"{title}:\n{body}"


def load_base_creative_rules() -> str:
    sections = []
    for path in BASE_CREATIVE_RULE_FILES:
        content = read_text_file_if_exists(path)
        if content:
            sections.append(build_prompt_section(display_path_for_log(path), content))
    return "\n\n".join(sections).strip()


def resolve_niche_dir_for_prompt(order_model: dict, prompt_file: Path) -> Path | None:
    try:
        relative = prompt_file.relative_to(NICHOS_DIR)
        parts = relative.parts
        if parts and parts[0] != "_base":
            niche_dir = NICHOS_DIR / parts[0]
            if niche_dir.exists():
                return niche_dir
    except ValueError:
        pass

    if is_company_product(order_model):
        ramo = get_company_value(order_model, "ramo")
        nicho_id = resolve_local_nicho_id(ramo)
        if nicho_id:
            niche_dir = NICHOS_DIR / nicho_id
            if niche_dir.exists():
                return niche_dir

    return None


def load_niche_specific_rules(niche_dir: Path | None) -> str:
    if not niche_dir:
        return ""

    sections = []
    for rel_path in NICHE_RULE_RELATIVE_FILES:
        path = niche_dir / rel_path
        content = read_text_file_if_exists(path)
        if content:
            sections.append(build_prompt_section(display_path_for_log(path), content))

    return "\n\n".join(sections).strip()


def build_company_client_photo_base_block(order_model: dict) -> str:
    if not has_company_client_photos(order_model):
        return ""

    count = safe_int(order_model.get("_quantidade_fotos_cliente", 0), 0)
    return build_prompt_section(
        "REGRA PRINCIPAL OBRIGATORIA PARA FOTO DO CLIENTE",
        "\n".join([
            f"Este pedido tem {count} foto(s) enviada(s) pelo cliente.",
            "A arte final deve obrigatoriamente utilizar a(s) foto(s) enviada(s) pelo cliente.",
            "A foto enviada pelo cliente deve permanecer sendo a base visual da arte final.",
            "Nao substitua a foto por outra foto inventada.",
            "Nao crie outra pessoa.",
            "Nao crie outro ambiente.",
            "Nao crie outra fachada.",
            "Nao crie outro produto principal.",
            "Nao crie outra cena completamente diferente.",
            "Pode melhorar qualidade, iluminacao, enquadramento, composicao, layout publicitario, textos, identidade visual e acabamento.",
            "Todas as melhorias devem preservar a foto enviada como cena/base principal.",
            "Se houver conflito entre criar um conceito novo e preservar a foto, preserve a foto.",
        ])
    )


def build_company_data_block(order_model: dict) -> str:
    lines = []
    info_lines = without_company_internal_objective_public_lines(order_model, build_company_text_lines_from_model(order_model))
    dynamic_lines = build_company_dynamic_context_lines(order_model)
    style_lines = build_company_visual_style_lines(order_model)
    dna_lines = build_company_dna_lines(order_model)
    model_lines = build_company_model_lines(order_model)
    internal_objective = build_company_internal_objective_block(order_model)
    important_info = build_company_important_info_block(order_model)

    if info_lines:
        lines.append(build_prompt_section("DADOS DA EMPRESA", "\n".join(info_lines)))
    if important_info:
        lines.append(important_info)
    photo_base_block = build_company_client_photo_base_block(order_model)
    if photo_base_block:
        lines.append(photo_base_block)
    if internal_objective:
        lines.append(internal_objective)
    if dynamic_lines:
        lines.append(build_prompt_section(
            "CAMPOS DINAMICOS COMO CONTEXTO INTERNO",
            "\n".join([
                "Os nomes dos campos internos servem apenas para entender a funcao do valor.",
                "Nao copie nomes ou rotulos de campos internos como texto da arte.",
                "Use os valores para decidir produto, servico, contexto, beneficio, destaque e mensagem visual.",
                "Quando o valor for publicavel, transforme-o em linguagem natural adequada ao nicho.",
                *dynamic_lines,
            ])
        ))
    if style_lines:
        lines.append(build_prompt_section("ESTILO ESCOLHIDO PELO CLIENTE", "\n".join(style_lines)))
    if dna_lines:
        lines.append(build_prompt_section("DNA DO NICHO DISPONIVEL NO PEDIDO", "\n".join(dna_lines)))
    if model_lines:
        lines.append(build_prompt_section("MODELO INTERNO DE REFERENCIA DISPONIVEL", "\n".join(model_lines)))

    return "\n\n".join(lines).strip()


def build_client_data_block(order_model: dict, linhas_texto: list[str]) -> str:
    linhas_limpas = [normalize_text(linha) for linha in linhas_texto if normalize_text(linha)]
    if is_company_product(order_model):
        linhas_limpas = without_company_internal_objective_public_lines(order_model, linhas_limpas)
    content = "\n".join(f"- {linha}" for linha in linhas_limpas) if linhas_limpas else "- Nenhum campo preenchido."

    sections = [build_prompt_section("DADOS REAIS DO CLIENTE", content)]
    if is_company_product(order_model):
        company_data = build_company_data_block(order_model)
        if company_data:
            sections.append(company_data)

    return "\n\n".join(sections).strip()


def build_visual_mode_contract(order_model: dict) -> str:
    style = get_company_visual_style(order_model)
    tem_foto_cliente = has_company_client_photos(order_model)
    common_rules = [
        "O modo visual controla apenas o nivel de transformacao permitido para este pedido.",
        "O nicho/produto continua decidindo linguagem, estetica, estilo e repertorio do segmento.",
        "O objetivo interno nunca pode aparecer literalmente na imagem em nenhum modo.",
        "Nao use o campo objetivo como fonte de texto publico.",
    ]

    mode_rules = {
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
            "Pode criar mensagem publica derivada do objetivo interno, sem copiar o texto original.",
            "Pode reduzir a dominancia da foto.",
            "Pode organizar produto, servico, oferta, beneficio e CTA com mais forca.",
            "Deve parecer anuncio pronto para Instagram.",
        ],
    }

    selected_rules = mode_rules.get(style, [
        f"Modo: {style or 'normal'}.",
        "Aplicar somente limites tecnicos do modo visual informado.",
        "Na duvida, preservar os dados reais e nao inventar informacoes.",
    ])
    if tem_foto_cliente and style == "leve":
        selected_rules = [
            "Modo: Leve com foto do cliente.",
            "Fazer transformacao leve a partir da foto enviada.",
            "Organizar melhor a foto e adicionar poucos elementos.",
            "A foto enviada deve continuar sendo a base visual principal.",
            "Nao substituir a foto por cena, pessoa, ambiente, fachada ou produto inventado.",
            "Nao virar campanha, mosaico, vitrine ou anuncio completo.",
            "Nao criar composicao complexa ou layout muito publicitario.",
            "Se usar objetivo interno, usar apenas para orientar atmosfera discreta sem trocar a cena da foto.",
        ]
    elif tem_foto_cliente and style == "normal":
        selected_rules = [
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

    return build_prompt_section(
        "CONTRATO TECNICO DO MODO VISUAL",
        "\n".join(f"- {rule}" for rule in [*common_rules, *selected_rules]),
    )


def build_universal_technical_rules() -> str:
    return """REGRAS TECNICAS UNIVERSAIS:
- Use somente informacoes realmente presentes no pedido.
- Nao invente informacoes ausentes.
- Nao troque nome, preco, placar, data, hora, local, cidade, jogador, time, patrocinador, produto, servico, CTA, telefone, Instagram, endereco ou oferta enviados pelo cliente.
- Nao preencher automaticamente campos vazios.
- Se algum campo estiver vazio, omita.
- Nao criar texto substituto para compensar campo vazio.
- Use as imagens e referencias enviadas como referencias do pedido.
- Nao copie textos, telefone, Instagram, preco, data, endereco, marca antiga ou informacoes antigas de modelos de referencia.
- Substitua qualquer dado antigo de modelo pelos dados reais do pedido atual.
- Em ajustes, corrija somente o problema apontado pelo cliente e preserve o restante quando possivel."""


def build_neutral_prompt(
    prompt_base: str,
    order_model: dict,
    linhas_texto: list[str],
    bloco_ajuste: str,
    prompt_file: Path,
) -> tuple[str, str]:
    base_rules = load_base_creative_rules()
    niche_dir = resolve_niche_dir_for_prompt(order_model, prompt_file)
    niche_rules = load_niche_specific_rules(niche_dir)
    local_niche_context = ""

    if is_company_product(order_model):
        local_niche = build_local_niche_knowledge_for_order(safe_dict(order_model.get("legacy")))
        local_niche_context = str(local_niche.get("context", "") or "").strip()
        if local_niche_context:
            log(f"Especialista local usado: {local_niche.get('nicho_id') or 'pedido_json'}")

    sections = [
        build_prompt_section("PROMPT DO NICHO/PRODUTO", prompt_base),
        build_prompt_section("REGRAS CRIATIVAS HERDADAS DA BASE", base_rules),
        build_prompt_section("REGRAS E CONHECIMENTO ESPECIFICOS DO NICHO", niche_rules),
        build_prompt_section("CONHECIMENTO LOCAL DO NICHO", local_niche_context),
        build_client_data_block(order_model, linhas_texto),
        build_prompt_section("AJUSTE SOLICITADO PELO CLIENTE", bloco_ajuste),
        build_visual_mode_contract(order_model),
        build_universal_technical_rules(),
    ]

    prompt = "\n\n".join(section for section in sections if str(section or "").strip()).strip()
    niche_label = display_path_for_log(niche_dir) if niche_dir else "_base"
    return prompt, niche_label


def load_prompt_imagem(pedido: dict, linhas_texto: list[str]) -> tuple[str, Path]:
    categoria = get_categoria(pedido)
    prompt_file = prompt_file_for_categoria(categoria)

    # Compatibilidade: se ainda não existir o txt específico, usa o prompt_imagem.txt antigo.
    if not prompt_file.exists() and PROMPT_IMAGEM_FILE.exists():
        prompt_file = PROMPT_IMAGEM_FILE

    if not prompt_file.exists():
        raise FileNotFoundError(
            f"Não achei o prompt da categoria '{categoria}'. Crie {display_path_for_log(prompt_file)}."
        )

    prompt = prompt_file.read_text(encoding="utf-8", errors="ignore").strip()
    if not prompt:
        raise ValueError(f"{prompt_file.name} está vazio.")

    return prompt, prompt_file


# =========================================================
# REFERÊNCIAS DE IMAGEM
# =========================================================

TEMPLATE_CONTRATACAO_DIR = BASE_DIR / "template_contratacao"

def template_dir_for_categoria(categoria: str) -> Path:
    if categoria == "escalacao":
        return TEMPLATE_ESCALACAO_DIR
    if categoria == "proximo_jogo":
        return TEMPLATE_PROXIMO_JOGO_DIR
    if categoria == "treino":
        return TEMPLATE_TREINO_DIR if TEMPLATE_TREINO_DIR.exists() else TEMPLATE_DIR
    if categoria == "proximo_jogo_jogador":
        return TEMPLATE_PROXIMO_JOGO_JOGADOR_DIR if TEMPLATE_PROXIMO_JOGO_JOGADOR_DIR.exists() else TEMPLATE_PROXIMO_JOGO_DIR
    if categoria == "resultado_jogo_jogador":
        return TEMPLATE_RESULTADO_JOGADOR_DIR if TEMPLATE_RESULTADO_JOGADOR_DIR.exists() else TEMPLATE_DIR
    if categoria == "jogador_escudo":
        return TEMPLATE_JOGADOR_ESCUDO_DIR if TEMPLATE_JOGADOR_ESCUDO_DIR.exists() else TEMPLATE_DIR
    if categoria == "mascote_uniforme":
        return TEMPLATE_MASCOTE_UNIFORME_DIR if TEMPLATE_MASCOTE_UNIFORME_DIR.exists() else TEMPLATE_JOGADOR_ESCUDO_DIR
    if categoria == "patrocinador":
        return TEMPLATE_PATROCINADOR_DIR
    if categoria == "contratacao":
        return TEMPLATE_CONTRATACAO_DIR
    return TEMPLATE_DIR


def find_core_assets(pedido_dir: Path, pedido: dict) -> dict:
    foto = None
    escudo = None
    escudo2 = None

    foto_nome = normalize_text(pedido.get("foto_jogo", "")) or normalize_text(pedido.get("foto", ""))
    escudo_nome = normalize_text(pedido.get("escudo_principal", ""))
    escudo2_nome = normalize_text(pedido.get("escudo2", "")) or normalize_text(pedido.get("escudo_adversario", ""))

    if foto_nome:
        foto = find_existing(pedido_dir, [foto_nome])
    if escudo_nome:
        escudo = find_existing(pedido_dir, [escudo_nome])
    if escudo2_nome:
        escudo2 = find_existing(pedido_dir, [escudo2_nome])

    if not foto:
        foto = find_existing(
            pedido_dir,
            [
                "foto_jogo.png", "foto_jogo.jpg", "foto_jogo.jpeg", "foto_jogo.webp",
                "foto.png", "foto.jpg", "foto.jpeg", "foto.webp"
            ]
        )

    if not escudo:
        escudo = find_existing(
            pedido_dir,
            [
                "escudo_principal_sem_fundo.png", "escudo_principal.png",
                "escudo_principal.jpg", "escudo_principal.jpeg", "escudo_principal.webp",
                "escudo1_sem_fundo.png", "escudo1.png", "escudo1.jpg", "escudo1.jpeg", "escudo1.webp"
            ]
        )

    if not escudo2:
        escudo2 = find_existing(
            pedido_dir,
            [
                "escudo2_sem_fundo.png", "escudo2.png", "escudo2.jpg", "escudo2.jpeg", "escudo2.webp",
                "escudo_adversario_sem_fundo.png", "escudo_adversario.png",
                "escudo_adversario.jpg", "escudo_adversario.jpeg", "escudo_adversario.webp"
            ]
        )

    return {
        "foto": foto,
        "escudo": escudo,
        "escudo2": escudo2,
    }


def find_patrocinadores(pedido_dir: Path) -> list[Path]:
    arquivos = []

    for i in range(1, 21):
        pid = f"patrocinador_{i}"
        found = find_existing(
            pedido_dir,
            [
                f"{pid}.png", f"{pid}.jpg", f"{pid}.jpeg", f"{pid}.webp",
                f"patrocinador{i}.png", f"patrocinador{i}.jpg", f"patrocinador{i}.jpeg", f"patrocinador{i}.webp",
                f"pat{i:02d}.png", f"pat{i:02d}.jpg", f"pat{i:02d}.jpeg", f"pat{i:02d}.webp",
                f"pat{i}.png", f"pat{i}.jpg", f"pat{i}.jpeg", f"pat{i}.webp",
            ]
        )

        if found:
            arquivos.append(found)

    return arquivos


def collect_template_refs(template_dir: Path) -> list[Path]:
    refs = []

    for names in [
        ["moldura.png", "moldura.jpg", "moldura.jpeg", "moldura.webp"],
        ["topo_barra.png", "topo_barra.jpg", "topo_barra.jpeg", "topo_barra.webp", "topo.png", "topo.jpg"],
        ["faixa_principal.png", "faixa_principal.jpg", "faixa_principal.jpeg", "faixa_principal.webp"],
        ["faixa_secundaria.png", "faixa_secundaria.jpg", "faixa_secundaria.jpeg", "faixa_secundaria.webp"],
    ]:
        found = optional_template_file(template_dir, names)
        if found:
            refs.append(found)

    return refs


def collect_extra_images(pedido_dir: Path, already: set[Path]) -> list[Path]:
    extras = []

    for path in sorted(pedido_dir.iterdir()):
        if not is_image_file(path):
            continue

        resolved = path.resolve()
        if resolved in already:
            continue

        name = path.name.lower()
        if name.startswith("resultado_") or name in {"resultado_final.png", "resultado_final.jpg"}:
            continue

        if "_resultado_temp" in str(path):
            continue

        extras.append(path)

    return extras


def unique_append(lista: list[Path], path: Path | None, seen: set[Path]):
    if not path:
        return

    if not path.exists() or not path.is_file():
        return

    resolved = path.resolve()
    if resolved in seen:
        return

    lista.append(path)
    seen.add(resolved)


def build_reference_images(pedido_dir: Path, pedido: dict, text_ref_path: Path) -> list[Path]:
    categoria = get_categoria(pedido)
    template_dir = template_dir_for_categoria(categoria)
    assets = find_core_assets(pedido_dir, pedido)

    refs: list[Path] = []
    seen: set[Path] = set()

    # Ordem importante: em gpt-image-1.5, as primeiras referências têm mais peso.
    pedido_layout_img = pedido_dir / "pedido.png"
    unique_append(refs, pedido_layout_img, seen)
    # imagem de texto não vai para a API
    unique_append(refs, assets.get("escudo"), seen)

    if categoria not in ["proximo_jogo_jogador", "treino"]:
        unique_append(refs, assets.get("escudo2"), seen)

    unique_append(refs, assets.get("foto"), seen)

    for p in collect_template_refs(template_dir):
        unique_append(refs, p, seen)

    for p in find_patrocinadores(pedido_dir):
        unique_append(refs, p, seen)

    for p in collect_extra_images(pedido_dir, seen):
        unique_append(refs, p, seen)

    if len(refs) > MAX_REFERENCIAS:
        log(f"⚠️ Foram encontradas {len(refs)} imagens. Enviarei só as primeiras {MAX_REFERENCIAS}.")
        refs = refs[:MAX_REFERENCIAS]

    return refs


# =========================================================
# OPENAI IMAGE
# =========================================================

def ler_motivo_ajuste(pedido_dir: Path, pedido: dict) -> str:
    ajuste_file = pedido_dir / "ajuste_pendente.txt"

    if ajuste_file.exists():
        return normalize_text(ajuste_file.read_text(encoding="utf-8", errors="ignore"))

    if str(pedido.get("status", "")).strip().lower() == "ajuste_pendente":
        return normalize_text(pedido.get("motivo_ajuste", ""))

    return ""


def gerar_preview_protegida(imagem_final: Path, preview_path: Path):
    img = Image.open(imagem_final).convert("RGB")

    largura_max = 520
    if img.width > largura_max:
        proporcao = largura_max / img.width
        nova_altura = int(img.height * proporcao)
        img = img.resize((largura_max, nova_altura), Image.LANCZOS)

    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    texto = "PR\u00c9VIA IA4TUBE"

    try:
        font = load_font(max(44, img.width // 5), bold=True)
    except Exception:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), texto, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    while tw > img.width - 28 and hasattr(font, "size") and font.size > 28:
        try:
            font = load_font(font.size - 4, bold=True)
            bbox = draw.textbbox((0, 0), texto, font=font)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
        except Exception:
            break

    x = int((img.width - tw) / 2)
    posicoes_y = [
        int(img.height * 0.18 - th / 2),
        int(img.height * 0.50 - th / 2),
        int(img.height * 0.82 - th / 2),
    ]

    for y in posicoes_y:
        y = max(10, min(y, img.height - th - 10))
        draw.rectangle(
            (x - 16, y - 10, x + tw + 16, y + th + 10),
            fill=(0, 0, 0, 78)
        )
        for dx, dy in [(-2, 0), (2, 0), (0, -2), (0, 2)]:
            draw.text((x + dx, y + dy), texto, font=font, fill=(0, 0, 0, 165))
        draw.text((x, y), texto, font=font, fill=(255, 255, 255, 218))

    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    img.save(preview_path, "JPEG", quality=45, optimize=True)


def prepare_reference_image_file(caminho: Path, temp_files: list[Path]):
    if not caminho or not caminho.exists():
        return None

    try:
        with Image.open(caminho) as img:
            img.load()
            mode = "RGBA" if img.mode == "RGBA" else "RGB"
            normalized = img.convert(mode)
            if normalized.width < 128 or normalized.height < 128:
                original_size = (normalized.width, normalized.height)
                scale = max(256 / normalized.width, 256 / normalized.height)
                new_size = (
                    max(256, int(round(normalized.width * scale))),
                    max(256, int(round(normalized.height * scale))),
                )
                normalized = normalized.resize(new_size, Image.LANCZOS)
                log(
                    "Referencia pequena ampliada "
                    f"({original_size[0]}x{original_size[1]} -> {new_size[0]}x{new_size[1]}): {caminho}"
                )

            temp_path = caminho.with_suffix(".valid.png")
            normalized.save(temp_path, "PNG")
            temp_files.append(temp_path)
            return open(temp_path, "rb")
    except Exception as exc:
        log(f"Ignorando imagem invalida: {caminho} ({exc})")
        return None


def render_via_chatgpt_api(output_path: Path, prompt: str, arquivos_referencia: list[Path], allow_prompt_only: bool = False):
    api_key = load_api_key()
    client = OpenAI(api_key=api_key)

    image_files = []
    temp_files = []

    try:
        for caminho in arquivos_referencia:
            image_file = prepare_reference_image_file(caminho, temp_files)
            if image_file:
                image_files.append(image_file)
        if not image_files:
            if not allow_prompt_only:
                raise ValueError("Nenhuma imagem de referencia valida encontrada para enviar ao ChatGPT API.")
            log("Nenhuma referencia visual valida encontrada. Gerando somente com prompt.")

        log(f"Modelo: {MODEL} | Size: {SIZE} | Quality: {QUALITY} | Formato API: {OUTPUT_FORMAT}")

        if image_files:
            log(f"Enviando {len(image_files)} imagens para ChatGPT API...")
            result = client.images.edit(
                model=MODEL,
                image=image_files,
                prompt=prompt,
                size=SIZE,
                quality=QUALITY,
                output_format=OUTPUT_FORMAT,
                n=N,
            )
        else:
            result = client.images.generate(
                model=MODEL,
                prompt=prompt,
                size=SIZE,
                quality=QUALITY,
                output_format=OUTPUT_FORMAT,
                n=N,
            )

        imagem_b64 = result.data[0].b64_json
        imagem_bytes = base64.b64decode(imagem_b64)

        raw_path = output_path.with_suffix(f".raw.{OUTPUT_FORMAT}")
        raw_path.write_bytes(imagem_bytes)

        # Mantém compatibilidade com o site antigo: resultado_final.png.
        try:
            img = Image.open(BytesIO(imagem_bytes)).convert("RGB")
            img.save(output_path, "PNG")
        except Exception:
            output_path.write_bytes(imagem_bytes)

        log(f"✅ Resultado salvo em: {output_path}")

    finally:
        for f in image_files:
            try:
                f.close()
            except Exception:
                pass
        for temp_file in temp_files:
            try:
                temp_file.unlink(missing_ok=True)
            except Exception:
                pass


# =========================================================
# UPLOAD SITE
# =========================================================

def upload_resultado_para_site(pedido_dir: Path, pedido_id: str, imagem_path: Path, preview_path: Path | None = None):
    pedido_json = pedido_dir / "pedido.json"
    if not pedido_json.exists():
        raise FileNotFoundError("pedido.json não encontrado para upload do resultado.")

    pedido = load_json(pedido_json)
    whatsapp = normalize_text(pedido.get("whatsapp", ""))

    if not whatsapp:
        raise ValueError("whatsapp não encontrado no pedido.json.")

    whatsapp_login, senha_login = load_credentials()

    log("🔐 Fazendo login no site...")

    login_resp = requests.post(
        f"{API_BASE}/auth/login",
        json={
            "whatsapp": whatsapp_login,
            "senha": senha_login,
        },
        timeout=60,
    )

    if login_resp.status_code != 200:
        raise RuntimeError(f"Falha no login da API: {login_resp.status_code} | {login_resp.text[:500]}")

    login_data = login_resp.json()
    token = str(login_data.get("token", "")).strip()

    if not token:
        raise RuntimeError("Login da API não retornou token.")

    log("📤 Enviando resultado para o site...")

    files_upload = {}
    f_resultado = open(imagem_path, "rb")
    f_preview = None

    try:
        files_upload["resultado"] = ("resultado_final.png", f_resultado, "image/png")

        if preview_path and preview_path.exists():
            f_preview = open(preview_path, "rb")
            files_upload["preview"] = ("preview_ia4tube.jpg", f_preview, "image/jpeg")

        up_resp = requests.post(
            f"{API_BASE}/bot/pedidos/{pedido_id}/upload-resultado",
            headers={
                "Authorization": f"Bearer {token}",
            },
            files=files_upload,
            data={
                "descricao_instagram": pedido.get("descricao_instagram", "")
            },
            timeout=180,
        )
    finally:
        try:
            f_resultado.close()
        except Exception:
            pass

        if f_preview:
            try:
                f_preview.close()
            except Exception:
                pass

    if up_resp.status_code != 200:
        raise RuntimeError(f"Falha ao enviar resultado: {up_resp.status_code} | {up_resp.text[:500]}")

    log("✅ Resultado enviado para o site com sucesso.")


# =========================================================
# MAIN
# =========================================================

def main():
    import sys

    if len(sys.argv) < 2:
        raise SystemExit("Uso: python resultado_pipeline_api_only.py <PASTA_DO_PEDIDO>")

    pedido_dir = Path(sys.argv[1]).resolve()
    if not pedido_dir.exists():
        raise SystemExit(f"Pasta não encontrada: {pedido_dir}")

    pedido_json = pedido_dir / "pedido.json"
    if not pedido_json.exists():
        raise SystemExit("pedido.json não encontrado.")

    pedido_raw = load_json(pedido_json)
    order_model = normalize_pedido_for_pipeline(pedido_raw)
    pedido = order_model["legacy"]
    pedido_id = normalize_text(pedido.get("id") or pedido_raw.get("id") or "sem_id") or "sem_id"

    log(
        "ðŸ§­ Pedido normalizado: "
        f"schema_version={order_model['schema_version']} | "
        f"product_id={order_model['product_id'] or get_categoria(pedido)}"
    )

    temp_dir = pedido_dir / "_resultado_api_temp"
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    temp_dir.mkdir(parents=True, exist_ok=True)

    out_final_pedido = pedido_dir / "resultado_final.png"
    out_preview_pedido = pedido_dir / "preview_ia4tube.jpg"
    out_final_geral = OUT_DIR / f"resultado_{pedido_id}.png"

    linhas_texto = []

    texto_ref_path = temp_dir / "texto_referencia_chatgpt.png"

    if is_company_product(order_model):
        linhas_texto = build_company_text_lines_from_model(order_model)
    elif is_clean_product_enabled(order_model):
        linhas_texto = build_clean_product_text_lines(order_model)
    elif is_clean_result_product(order_model):
        linhas_texto = build_clean_result_text_lines(order_model)
    elif is_clean_structured_product(order_model):
        linhas_texto = build_clean_structured_text_lines(order_model)
    else:
        linhas_texto = build_text_lines(pedido)
    if not is_company_product(order_model):
        linhas_texto = corrigir_linhas_texto(linhas_texto)

    if is_company_product(order_model):
        set_company_client_photo_context(order_model, pedido_dir)

    prompt_base, prompt_file_usado = load_prompt_imagem(pedido, linhas_texto)

    motivo_ajuste = ler_motivo_ajuste(pedido_dir, pedido)

    bloco_ajuste = ""
    if motivo_ajuste:
        bloco_ajuste = f"""

AJUSTE SOLICITADO PELO CLIENTE:
{motivo_ajuste}

REGRAS DO AJUSTE:
- Corrija somente o problema apontado pelo cliente.
- Preserve todo o restante da arte.
- Use o pedido original como fonte da verdade.
- Não invente novas informações.
- Não altere escudos, rostos, nomes ou cores que não foram citados.
- Se o cliente pediu correção de texto, corrija somente esse texto.
- Se o cliente pediu escudo correto, priorize o escudo enviado nas referências.
- Entregue a imagem completa corrigida.
"""

    if motivo_ajuste and is_company_product(order_model):
        bloco_ajuste = f"""

AJUSTE SOLICITADO PELO CLIENTE:
{motivo_ajuste}

REGRAS DO AJUSTE:
- Corrija somente o problema apontado pelo cliente.
- Preserve o restante da arte.
- Use o pedido original como fonte da verdade.
- Nao invente novas informacoes.
- Se o cliente pediu correcao de texto, corrija somente esse texto.
- Entregue a imagem completa corrigida.
"""

    try:
        prompt, prompt_mode_niche = build_neutral_prompt(
            prompt_base,
            order_model,
            linhas_texto,
            bloco_ajuste,
            prompt_file_usado,
        )
    except Exception as exc:
        log(f"Aviso: falha ao montar prompt neutro ({exc}). Usando fallback tecnico.")
        prompt = "\n\n".join([
            build_prompt_section("PROMPT DO NICHO/PRODUTO", prompt_base),
            build_client_data_block(order_model, linhas_texto),
            build_prompt_section("AJUSTE SOLICITADO PELO CLIENTE", bloco_ajuste),
            build_universal_technical_rules(),
        ]).strip()
        prompt_mode_niche = "technical_fallback"
    log(f"📝 Prompt usado: {display_path_for_log(prompt_file_usado)}")
    log(f"Prompt mode: neutral | nicho: {prompt_mode_niche}")

    if is_company_product(order_model):
        referencias = build_company_reference_images(pedido_dir, order_model, texto_ref_path)
    elif is_clean_product_enabled(order_model):
        referencias = build_clean_product_reference_images(pedido_dir, order_model, texto_ref_path)
    elif is_clean_result_product(order_model):
        referencias = build_clean_result_reference_images(pedido_dir, order_model, texto_ref_path)
    elif is_clean_structured_product(order_model):
        referencias = build_clean_structured_reference_images(pedido_dir, order_model, texto_ref_path)
    else:
        referencias = build_reference_images(pedido_dir, pedido, texto_ref_path)
    if not referencias:
        raise RuntimeError("Nenhuma referência visual encontrada.")

    log("📦 Referências enviadas:")
    for idx, ref in enumerate(referencias, start=1):
        log(f"   {idx:02d}. {ref}")

    render_via_chatgpt_api(out_final_pedido, prompt, referencias, allow_prompt_only=is_company_product(order_model))

    try:
        gerar_preview_protegida(out_final_pedido, out_preview_pedido)
        log(f"✅ Preview protegida salva em: {out_preview_pedido}")
    except Exception as e:
        log(f"⚠️ Não consegui gerar preview protegida: {e}")

    shutil.copy2(out_final_pedido, out_final_geral)
    log(f"✅ Cópia salva em: {out_final_geral}")
    copy_final_image_to_all_images(pedido, pedido_dir, pedido_id, out_final_pedido)

    info = {
        "pedido_id": pedido_id,
        "modelo": MODEL,
        "size": SIZE,
        "quality": QUALITY,
        "input_fidelity": INPUT_FIDELITY,
        "output_format_api": OUTPUT_FORMAT,
        "resultado_final": str(out_final_pedido),
        "resultado_copia": str(out_final_geral),
        "prompt_file": str(prompt_file_usado),
        "prompt_mode": "neutral",
        "prompt_niche": prompt_mode_niche,
        "texto_referencia": "",
        "linhas_texto": linhas_texto,
        "referencias": [str(p) for p in referencias],
        "gerado_em": datetime.now().isoformat(timespec="seconds"),
    }

    (pedido_dir / "resultado_api_info.json").write_text(
        json.dumps(info, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    log("⚠️ Validador desativado - seguindo sem validação")

    descricao = gerar_descricao_instagram(pedido, linhas_texto)
    if not descricao:
        descricao = gerar_descricao_instagram_fallback(pedido, linhas_texto)

    try:
        pedido_raw["descricao_instagram"] = descricao
        if order_model["schema_version"] >= 2 and isinstance(pedido_raw.get("legacy"), dict):
            pedido_raw["legacy"]["descricao_instagram"] = descricao
        (pedido_dir / "pedido.json").write_text(
            json.dumps(pedido_raw, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )
    except Exception:
        pass

    upload_resultado_para_site(pedido_dir, pedido_id, out_final_pedido, out_preview_pedido)

    ajuste_file = pedido_dir / "ajuste_pendente.txt"
    if ajuste_file.exists():
        try:
            ajuste_file.unlink()
        except Exception:
            pass

    try:
        (pedido_dir / "status.txt").write_text("pronto", encoding="utf-8")
    except Exception:
        pass

    (pedido_dir / "processado_handoff.txt").write_text("OK", encoding="utf-8")


def _valor_legenda(pedido, *chaves):
    fields = safe_dict(pedido.get("fields"))
    legacy = safe_dict(pedido.get("legacy"))
    legacy_fields = safe_dict(legacy.get("fields"))
    sources = (
        pedido,
        fields,
        safe_dict(fields.get("campos_dinamicos")),
        legacy,
        legacy_fields,
        safe_dict(legacy_fields.get("campos_dinamicos")),
    )
    for source in sources:
        for chave in chaves:
            raw_value = source.get(chave)
            if isinstance(raw_value, (list, dict)):
                valor = json.dumps(raw_value, ensure_ascii=False)
            else:
                valor = normalize_text(raw_value or "").strip()
            if valor:
                return valor
    return ""


def _pedido_eh_patrocinador(pedido):
    contexto = " ".join([
        _valor_legenda(pedido, "product_id"),
        _valor_legenda(pedido, "categoria"),
        _valor_legenda(pedido, "objetivo"),
        _valor_legenda(pedido, "rodada"),
        _valor_legenda(pedido, "tipo_arte"),
    ]).lower()
    return "patrocin" in contexto


def _normalizar_linha_legenda(texto):
    texto = normalize_text(texto).strip()
    sem_acentos = "".join(
        char for char in unicodedata.normalize("NFD", texto)
        if unicodedata.category(char) != "Mn"
    )
    return sem_acentos.lower().strip().strip(",:;-.!? ")


def _remover_hashtags_patrocinador(linha):
    partes = []
    for parte in str(linha or "").split():
        normalizada = _normalizar_linha_legenda(parte)
        if normalizada in {"#patrocinador", "#patrocinadores"}:
            continue
        partes.append(parte)
    return " ".join(partes).strip()


def limpar_descricao_instagram(texto, pedido=None):
    pedido = pedido or {}
    linhas = [linha.strip() for linha in str(texto or "").splitlines() if linha.strip()]
    if not linhas:
        return ""

    rotulos = {
        "descricao para instagram",
        "descricao para postagem",
        "legenda para instagram",
        "sugestao de descricao",
        "sugestao de legenda",
        "caption",
        "instagram caption",
        "resultado",
        "proximo jogo",
        "escalação",
        "escalacao",
        "contratacao",
        "contratação",
        "dia de treino",
    }
    pode_usar_patrocinador = _pedido_eh_patrocinador(pedido)
    limpas = []

    for linha in linhas:
        normalizada = _normalizar_linha_legenda(linha)
        if normalizada in rotulos:
            continue
        if normalizada in {"patrocinador", "patrocinadores"}:
            continue
        if not pode_usar_patrocinador:
            linha = _remover_hashtags_patrocinador(linha)
            if not linha:
                continue
        limpas.append(linha)

    return "\n".join(limpas).strip()


def gerar_descricao_instagram(pedido, linhas_texto):
    try:
        client = OpenAI(api_key=load_api_key())
        categoria = get_categoria(pedido)
        product_id = _valor_legenda(pedido, "product_id", "categoria")
        nome_empresa = _valor_legenda(pedido, "nome_empresa", "empresa", "data")
        ramo = _valor_legenda(pedido, "ramo", "nicho")
        objetivo = _valor_legenda(pedido, "objetivo", "rodada")
        frase = _valor_legenda(pedido, "frase_foto", "oferta", "cta")
        historia = _valor_legenda(pedido, "historia_empresa")
        informacoes_empresa = _valor_legenda(
            pedido,
            "informacoes_empresa",
            "informacoes_importantes_empresa",
            "regras_empresa",
            "dados_importantes_empresa",
        )
        caracteristicas_empresa = normalize_company_text_items(_valor_legenda(
            pedido,
            "caracteristicas_empresa",
            "caracteristicasEmpresa",
            "company_characteristics",
            "companyCharacteristics",
        ))
        whatsapp = _valor_legenda(pedido, "whatsapp_contato", "whatsapp")
        instagram = _valor_legenda(pedido, "instagram")
        patrocinador_real = "sim" if _pedido_eh_patrocinador(pedido) else "nao"

        prompt = f"""
ESCREVA TODO O TEXTO EM PORTUGUÊS (BRASIL)

Crie uma legenda para Instagram baseada no conteúdo da arte.

A arte pode ser:
- resultado
- contratação
- escalação
- próximo jogo
- dia de treino
- patrocinador
- próximo jogo jogador
- resultado jogador
- jogador + escudo
- mascote + uniforme

Use o texto da arte como base principal.

TEXTO DA ARTE:
{chr(10).join(linhas_texto)}

REGRAS IMPORTANTES:
- Identifique automaticamente o tipo da arte pelo texto (ex: CONTRATAÇÃO, RESULTADO, ESCALAÇÃO)
- NÃO pedir mais informações
- NÃO fazer perguntas
- NÃO assumir que falta dado
- Sempre gerar a legenda com base no que já foi fornecido

Regras:
- Texto leve, natural e simples (não exagerado, não muito emocional)
- Evitar tom de torcida exagerada ou frases dramáticas
- Parecer uma legenda comum de time (humano, direto)
- Máximo 6 linhas
- CTA leve e opcional (sem pressão)
- Incluir hashtags no final
- SEMPRE incluir obrigatoriamente a hashtag #ia4tube na última linha
- Não inventar informações

Formato:
Texto + quebra de linha + hashtags
"""
        prompt += f"""

REGRAS DE QUALIDADE DA LEGENDA FINAL:
- Responda SOMENTE com a legenda final que o cliente vai colar no Instagram.
- Nunca inclua titulo, rotulo, explicacao ou cabecalho.
- Nunca escreva linhas soltas como "PATROCINADOR", "RESULTADO", "PROXIMO JOGO", "ESCALACAO" ou "DESCRICAO PARA INSTAGRAM".
- Nunca use rotulos como "Legenda:", "Descricao para Instagram:" ou "Sugestao de descricao:".
- Use o ramo, objetivo, nome da empresa/time, dados preenchidos e contexto real da arte.
- Se for empresa comum, nao invente termos de futebol, jogo, torcida, placar ou patrocinador.
- Para empresa comum, escreva de forma comercial e natural: fale da solucao, oferta, servico, produto ou beneficio quando existir.
- Evite frases genericas como "Apresentamos novidades", "Fique de olho" ou "Acompanhe para saber mais", salvo se isso estiver claramente no texto da arte.
- Se houver pergunta forte para o cliente final, beneficio claro ou chamada de venda, use isso como abertura.
- A palavra patrocinador so pode aparecer quando "Pedido realmente e patrocinador" for "sim".
- Hashtags como #patrocinador e #patrocinadores so podem aparecer quando "Pedido realmente e patrocinador" for "sim".
- Se for futebol, use termos de futebol apenas quando o ramo/tipo/objetivo indicar futebol.
- Hashtags podem aparecer no final, sem exagero.

DADOS ESTRUTURADOS DO PEDIDO:
- Nome da empresa/time: {nome_empresa}
- Ramo/nicho: {ramo}
- Categoria resolvida: {categoria}
- Produto/tipo da arte: {product_id}
- Objetivo escolhido: {objetivo}
- Frase/oferta/CTA: {frase}
- Historia/dados do cliente: {historia}
- Caracteristicas marcadas da empresa: {", ".join(caracteristicas_empresa) or "nenhuma"}
- Informacoes importantes da empresa: {informacoes_empresa or "nenhuma"}
- WhatsApp: {whatsapp}
- Instagram: {instagram}
- Pedido realmente e patrocinador: {patrocinador_real}

REGRAS SOBRE CARACTERISTICAS DA EMPRESA:
- As caracteristicas marcadas e as informacoes importantes representam regras reais da empresa e tem prioridade sobre criatividade.
- Pode mencionar uma caracteristica somente se ela estiver marcada ou escrita nas informacoes importantes.
- Nunca contradiga as regras reais da empresa.
- Nunca invente caracteristicas permanentes nao informadas, como delivery, estacionamento, Pix, cartao, parcelamento, drive-thru, horario especial ou atendimento 24 horas.
- So mencione delivery, entrega, receber em casa, app ou termos equivalentes se houver caracteristica marcada ligada a delivery/entrega ou se isso estiver escrito nas informacoes importantes.
"""

        response = client.responses.create(
            model="gpt-5-mini",
            input=prompt
        )

        return limpar_descricao_instagram(response.output_text, pedido)

    except Exception:
        return ""

def gerar_descricao_instagram_fallback(pedido, linhas_texto):
    nome = normalize_text(pedido.get("nome_empresa") or pedido.get("data") or "").strip()
    ramo = normalize_text(pedido.get("ramo") or "").strip()
    whatsapp = normalize_text(pedido.get("whatsapp_contato") or "").strip()
    instagram = normalize_text(pedido.get("instagram") or "").strip()
    base = nome or ramo or "sua marca"
    linhas = []

    contexto = " ".join([ramo, pedido.get("objetivo") or "", pedido.get("categoria") or "", pedido.get("product_id") or ""]).lower()
    if "marketing" in contexto or "redes" in contexto or "divulg" in contexto:
        linhas.append(f"{base}: sua empresa precisa aparecer melhor para vender mais e ser lembrada pelo cliente certo.")
        linhas.append("Artes profissionais ajudam a divulgar produtos, servicos e promocoes com mais impacto.")
    else:
        linhas.append(f"{base} preparou uma arte especial para voce conhecer.")
    if linhas_texto:
        destaque = normalize_text(linhas_texto[0]).strip()
        if destaque and destaque.lower() not in base.lower():
            linhas.append(destaque)
    if whatsapp:
        linhas.append(f"WhatsApp: {whatsapp}")
    if instagram:
        linhas.append(instagram if instagram.startswith("@") else f"@{instagram}")
    linhas.append("#IA4Tube #ArteComIA")

    return limpar_descricao_instagram("\n".join(linhas), pedido)

def validar_imagem(imagem_path, linhas_texto, pedido):
    try:
        api_key = load_api_key()
        client = OpenAI(api_key=api_key)

        categoria = get_categoria(pedido)

        with open(imagem_path, "rb") as f:
            img_bytes = f.read()

        if categoria == "escudo3d":
            checklist = [
                "A imagem final mostra um escudo como elemento principal?",
                "O escudo ficou com aparência 3D/profissional?",
                "O escudo mantém identidade visual parecida com o escudo enviado?",
                "A imagem não está quebrada, borrada demais, deformada ou muito feia?",
                "Não existe texto errado, palavra aleatória ou erro de escrita visível?"
            ]
        elif categoria == "resultado":
            checklist = [
                "O placar/time/resultado está correto conforme o pedido?",
                "Os nomes dos times aparecem corretos?",
                "A frase/texto principal está sem erro evidente?",
                "A imagem está bonita e pronta para postar?",
                "Escudos/foto não parecem trocados ou errados?"
            ]
        elif categoria == "resultado_jogo_jogador":
            checklist = [
                "A arte representa um resultado de jogo com foco no jogador?",
                "O placar/time/resultado está correto conforme o pedido?",
                "A foto do jogador aparece como destaque ou referência principal?",
                "A frase/texto principal está sem erro evidente?",
                "A imagem está bonita e pronta para postar?"
            ]
        elif categoria == "escalacao":
            checklist = [
                "A imagem representa uma escalação?",
                "Os nomes dos jogadores aparecem corretos quando visíveis?",
                "Não há erro evidente de texto ou nomes?",
                "O escudo/time parece correto?",
                "A imagem está bonita e pronta para postar?"
            ]
        elif categoria == "contratacao":
            checklist = [
                "O nome principal do jogador está correto conforme o pedido?",
                "A arte representa uma contratação de forma clara?",
                "O escudo do time está correto?",
                "A imagem está bonita e pronta para postar?",
                "A imagem não está quebrada, deformada ou muito feia?"
            ]
        elif categoria == "proximo_jogo_jogador":
            checklist = [
                "A arte representa um próximo jogo com foco no jogador?",
                "Os times/confronto aparecem corretos conforme o pedido?",
                "A foto do jogador aparece como destaque ou referência principal?",
                "Data, horário e competição estão sem erro evidente?",
                "A imagem está bonita e pronta para postar?"
            ]
        elif categoria == "treino":
            checklist = [
                "A arte representa um dia de treino, preparacao ou evolucao da equipe?",
                "A chamada e os textos do treino estao corretos conforme o pedido?",
                "O escudo/time aparece como referencia correta?",
                "A foto de treino/equipe, quando enviada, foi usada de forma coerente?",
                "A imagem esta bonita e pronta para postar?"
            ]
        elif categoria == "jogador_escudo":
            checklist = [
                "A arte tem foco no jogador e no escudo do time?",
                "O nome do jogador está correto conforme o pedido?",
                "A foto do jogador aparece como destaque ou referência principal?",
                "O escudo do time parece correto?",
                "A imagem está bonita e pronta para postar?"
            ]

        elif categoria == "mascote_uniforme":
            checklist = [
                "A arte mostra um mascote com uniforme do time?",
                "O nome do mascote ou time está correto conforme o pedido?",
                "O escudo do time parece correto?",
                "O uniforme/camiseta enviada aparece como referência visual principal?",
                "A imagem está bonita, profissional e pronta para postar?"
            ]

        else:
            checklist = [
                "O texto principal está correto conforme o pedido?",
                "Não há erro evidente de ortografia ou nomes?",
                "As imagens/escudos parecem coerentes com o pedido?",
                "A arte está bonita e pronta para postar?",
                "A imagem não está quebrada, deformada ou muito feia?"
            ]

        prompt = f"""
Você é um validador comercial de artes esportivas.

Analise a imagem e responda APENAS em JSON válido, sem markdown.

Formato obrigatório:
{{
  "aprovado": true,
  "motivo": "explicação curta",
  "categoria": "{categoria}",
  "itens": [
    {{
      "item": "nome do item avaliado",
      "aprovado": true,
      "observacao": "curto"
    }}
  ]
}}

Categoria do pedido:
{categoria}

Texto esperado:
{chr(10).join(linhas_texto)}

Checklist obrigatório:
{chr(10).join("- " + item for item in checklist)}

Critério:
- Reprove se existir erro claro que um cliente perceberia.
- Aprove se estiver bom o suficiente para vender.
- Pequenas imperfeições visuais são aceitáveis.
- Texto errado, nome errado ou palavra estranha deve reprovar.
- EXCEÇÃO PARA CONTRATAÇÃO: ignore completamente nomes que aparecem em uniforme, camisa, roupa ou detalhes visuais do jogador.
- Para contratação, valide apenas o nome principal exibido na arte, ou seja, o nome anunciado em destaque.
- REGRA ESPECIAL PARA NOMES EM ESCUDOS: se o nome escrito no escudo for diferente do nome digitado no pedido, o nome do escudo é a fonte mais importante e deve ser considerado correto.
- Não reprove por diferença pequena entre o nome digitado e o nome oficial visível no escudo, como SÃO LUIS x SÃO LUIZ, desde que o escudo pareça ser o correto.
"""

        response = client.responses.create(
            model="gpt-5-mini",
            input=[{
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {
                        "type": "input_image",
                        "image_url": "data:image/png;base64," + base64.b64encode(img_bytes).decode()
                    }
                ]
            }]
        )

        text = response.output_text.strip()

        try:
            data = json.loads(text)
            aprovado = bool(data.get("aprovado", False))
            motivo = str(data.get("motivo", "sem motivo"))
            return aprovado, motivo, data
        except Exception:
            return False, "erro ao interpretar resposta da IA", {
                "aprovado": False,
                "motivo": "erro ao interpretar resposta da IA",
                "resposta_bruta": text
            }

    except Exception as e:
        erro_txt = str(e).lower()

        bloqueio_openai = any(x in erro_txt for x in [
            "copyright",
            "policy",
            "safety",
            "blocked",
            "violation"
        ])

        if bloqueio_openai:
            try:
                pedido["status"] = "em_analise"

                (pedido_dir / "status.txt").write_text(
                    "em_analise",
                    encoding="utf-8"
                )

                (pedido_dir / "erro_openai_direitos_autorais.txt").write_text(
                    str(e),
                    encoding="utf-8"
                )
            except Exception:
                # sem ação
                pass

        return False, f"erro no validador: {e}", {
            "aprovado": False,
            "motivo": f"erro no validador: {e}"
        }


if __name__ == "__main__":
    main()

