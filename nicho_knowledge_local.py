import json
import re
import unicodedata
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
NICHOS_DIR = BASE_DIR / "nichos"
ALIASES_FILE = NICHOS_DIR / "aliases.json"
MAX_SUMMARY_CHARS = 2400
MAX_CONTEXT_CHARS = 1800


def truncate_text_safely(text: str, max_chars: int) -> str:
    text = str(text or "").strip()
    if max_chars <= 0 or len(text) <= max_chars:
        return text

    cut = text[:max_chars].rstrip()

    paragraph_break = cut.rfind("\n\n")
    if paragraph_break >= int(max_chars * 0.55):
        return remove_dangling_heading(cut[:paragraph_break])

    line_break = cut.rfind("\n")
    if line_break >= int(max_chars * 0.65):
        return remove_dangling_heading(cut[:line_break])

    word_break = cut.rfind(" ")
    if word_break >= int(max_chars * 0.75):
        return remove_dangling_heading(cut[:word_break])

    return remove_dangling_heading(cut.rstrip(" ,.;:-"))


def remove_dangling_heading(text: str) -> str:
    lines = str(text or "").rstrip().splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    if lines and lines[-1].lstrip().startswith("#"):
        lines.pop()
    return "\n".join(lines).rstrip()


def normalize_nicho_id(value: str) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = re.sub(r"[^a-z0-9]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_")
    return text


def load_aliases() -> dict:
    aliases = {
        "marketing_visual_para_empresas": "marketing_visual_empresas",
        "advocacia": "advogado",
        "escritorio_de_advocacia": "advogado",
        "clinica_de_estetica": "clinica_estetica",
        "pet_shopp": "pet_shop",
        "petshop": "pet_shop",
        "pet_shop": "pet_shop",
    }

    if not ALIASES_FILE.exists():
        return aliases

    try:
        data = json.loads(ALIASES_FILE.read_text(encoding="utf-8"))
        raw_aliases = data.get("aliases", data if isinstance(data, dict) else {})
        if isinstance(raw_aliases, dict):
            for source, target in raw_aliases.items():
                source_id = normalize_nicho_id(source)
                target_id = normalize_nicho_id(target)
                if source_id and target_id:
                    aliases[source_id] = target_id
    except Exception:
        pass

    return aliases


def build_tolerant_slug_variants(slug: str) -> list[str]:
    slug = normalize_nicho_id(slug)
    if not slug:
        return []

    variants: list[str] = []
    parts = slug.split("_")
    for index, part in enumerate(parts):
        if len(part) > 3 and len(part) >= 2 and part[-1] == part[-2]:
            reduced_parts = parts[:]
            reduced_parts[index] = part[:-1]
            variants.append("_".join(reduced_parts))

    collapsed = re.sub(r"([a-z])\1{1,}$", r"\1", slug)
    if collapsed != slug:
        variants.append(collapsed)

    unique: list[str] = []
    for item in variants:
        if item and item != slug and item not in unique:
            unique.append(item)
    return unique


def resolve_local_nicho_id(ramo: str) -> str:
    slug = normalize_nicho_id(ramo)
    if not slug:
        return ""

    aliases = load_aliases()
    candidates = []
    alias = aliases.get(slug)
    if alias:
        candidates.append(alias)
    candidates.append(slug)
    candidates.extend(build_tolerant_slug_variants(slug))

    for nicho_id in candidates:
        summary_path = NICHOS_DIR / nicho_id / "KNOWLEDGE_SUMMARY.md"
        if summary_path.exists():
            return nicho_id

    return ""


def load_knowledge_summary(nicho_id: str) -> str:
    nicho_id = normalize_nicho_id(nicho_id)
    if not nicho_id:
        return ""

    summary_path = NICHOS_DIR / nicho_id / "KNOWLEDGE_SUMMARY.md"
    if not summary_path.exists():
        return ""

    try:
        return truncate_text_safely(summary_path.read_text(encoding="utf-8"), MAX_SUMMARY_CHARS)
    except Exception:
        return ""


def build_local_knowledge_context(nicho_id: str, summary: str) -> str:
    nicho_id = normalize_nicho_id(nicho_id)
    summary = str(summary or "").strip()
    if not nicho_id or not summary:
        return ""

    lines = [
        f"CONHECIMENTO DO NICHO ({nicho_id}):",
        "Use este conhecimento apenas como apoio estrategico local do motor IA4Tube.",
        "Prioridade: dados do cliente > briefing do pedido > DNA/modelo interno > conhecimento do nicho.",
        "Nao invente informacoes que o cliente nao enviou.",
        summary,
    ]
    return truncate_text_safely("\n".join(lines), MAX_CONTEXT_CHARS)


def build_local_niche_knowledge_for_order(pedido: dict) -> dict:
    pedido = pedido if isinstance(pedido, dict) else {}
    fields = pedido.get("fields") if isinstance(pedido.get("fields"), dict) else {}
    ramo = pedido.get("ramo") or fields.get("ramo") or ""
    nicho_id = resolve_local_nicho_id(ramo)
    if not nicho_id:
        return {"ok": False, "nicho_id": "", "context": "", "reason": "nicho_not_found"}

    summary = load_knowledge_summary(nicho_id)
    if not summary:
        return {"ok": False, "nicho_id": nicho_id, "context": "", "reason": "summary_not_found"}

    context = build_local_knowledge_context(nicho_id, summary)
    if not context:
        return {"ok": False, "nicho_id": nicho_id, "context": "", "reason": "empty_context"}

    return {"ok": True, "nicho_id": nicho_id, "context": context, "reason": "ok"}
