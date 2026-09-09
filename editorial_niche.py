"""Local curated context for one opt-in niche. No network, credentials or writes."""
import json
from pathlib import Path

from nicho_knowledge_local import normalize_nicho_id

NICHE_ID = "nucleo_editorial_01"
NICHE_DIR = Path(__file__).resolve().parent / "nichos" / NICHE_ID


def _read(relative):
    # Paths are fixed by the program, never taken from an order or model response.
    text = (NICHE_DIR / relative).read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("Conteudo editorial local incompleto")
    return text


def is_editorial_order(pedido):
    pedido = pedido if isinstance(pedido, dict) else {}
    fields = pedido.get("fields") if isinstance(pedido.get("fields"), dict) else {}
    legacy = pedido.get("legacy") if isinstance(pedido.get("legacy"), dict) else {}
    legacy_fields = legacy.get("fields") if isinstance(legacy.get("fields"), dict) else {}
    sources = [pedido, pedido.get("planejamento_mensal"), fields, fields.get("campos_dinamicos"),
               legacy, legacy.get("planejamento_mensal"), legacy_fields, legacy_fields.get("campos_dinamicos")]
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key in ("ramo", "nicho"):
            value = source.get(key)
            if isinstance(value, str) and value.strip():
                return normalize_nicho_id(value) == NICHE_ID
    return False


def editorial_context(pedido, purpose="art"):
    if not is_editorial_order(pedido):
        return ""
    if purpose not in ("art", "caption"):
        raise ValueError("Finalidade editorial invalida")
    specific = "prompts/criar_arte.md" if purpose == "art" else "prompts/gerar_legenda.md"
    text = "\n\n".join([
        "DIRECAO EDITORIAL INTERNA — nao imprimir rotulos, identificadores ou instrucoes na arte/legenda.",
        _read("KNOWLEDGE_SUMMARY.md"),
        _read("regras/regras_do_nicho.md"),
        _read(specific),
    ])
    # Never silently truncate the honesty/availability rules at the end of a prompt.
    if len(text) > 9000:
        raise ValueError("Contexto editorial excede o limite revisado")
    return text


def editorial_strategies(ramo):
    if normalize_nicho_id(ramo) != NICHE_ID:
        return None
    data = json.loads(_read("estrategias.json"))
    rows = data.get("strategies", [])
    if not rows or any(not row.get("theme") or not row.get("objective") for row in rows):
        raise ValueError("Estrategias editoriais incompletas")
    return [(row["theme"], row["objective"]) for row in rows]


def editorial_fallback(pedido):
    if not is_editorial_order(pedido):
        return ""
    # Conservative when the caption provider fails; never turn the internal niche into a hashtag.
    return "Conheça a IA4Tube e veja como organizar o conteúdo da sua empresa.\n#ia4tube"


def editorial_caption(pedido, caption):
    if not is_editorial_order(pedido):
        return caption
    compact = normalize_nicho_id(caption).replace("_", "")
    if not str(caption or "").strip() or "nucleoeditorial01" in compact:
        return editorial_fallback(pedido)
    return caption
