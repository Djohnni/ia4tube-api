import base64
import json
import os
import sys
import unicodedata
from io import BytesIO
from pathlib import Path
from datetime import datetime

import requests
from openai import OpenAI
from PIL import Image, ImageOps

BASE_DIR = Path(os.environ.get("IA4TUBE_BASE_DIR", Path(__file__).resolve().parent))
NICHOS_DIR = BASE_DIR / "nichos"
API_BASE = os.environ.get("IA4TUBE_API_BASE", "https://ia4tube-api.onrender.com").rstrip("/")
OPENAI_KEY_FILE = BASE_DIR / "openai_key.txt"
BOT_TOKEN_FILE = BASE_DIR / "bot_token.txt"

MODEL = os.environ.get("IA4TUBE_MATERIAIS_GRAFICOS_MODEL", "gpt-image-2")
SIZE = os.environ.get("IA4TUBE_MATERIAIS_GRAFICOS_SIZE", "1024x1536")
QUALITY = os.environ.get("IA4TUBE_MATERIAIS_GRAFICOS_QUALITY", "medium")
OUTPUT_FORMAT = "png"
TARGET_WIDTH = 1240
TARGET_HEIGHT = 1754

RAMO_ALIASES = [
    ("vidrac", "vidracaria"),
    ("lava", "lava_jato"),
    ("estetica_automotiva", "lava_jato"),
    ("automotivo", "lava_jato"),
    ("veiculo", "lava_jato"),
    ("carro", "lava_jato"),
    ("constr", "construcao"),
    ("obra", "construcao"),
    ("empreiteira", "construcao"),
    ("restaurante", "restaurante"),
    ("lanchonete", "restaurante"),
    ("pizzaria", "restaurante"),
    ("hamburgueria", "restaurante"),
    ("bar", "restaurante"),
    ("clinica", "clinica"),
    ("consultorio", "clinica"),
    ("medic", "clinica"),
    ("saude", "clinica"),
]


def log(msg):
    print(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}", flush=True)


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def write_status(pasta, status):
    (pasta / "status.txt").write_text(f"{status}\n", encoding="utf-8")


def append_runner_log(pasta, msg):
    with open(pasta / "runner_log.txt", "a", encoding="utf-8", errors="ignore") as f:
        f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}\n")


def normalize_slug(value):
    value = unicodedata.normalize("NFD", str(value or "").lower())
    value = "".join(ch for ch in value if unicodedata.category(ch) != "Mn")
    result = []
    last_sep = False
    for ch in value:
        if ch.isalnum():
            result.append(ch)
            last_sep = False
        elif not last_sep:
            result.append("_")
            last_sep = True
    return "".join(result).strip("_")


def folder_for_ramo(ramo):
    slug = normalize_slug(ramo)
    if not slug:
        return ""
    for token, folder in RAMO_ALIASES:
        if token in slug:
            return folder
    return slug


def load_api_key():
    token = os.environ.get("OPENAI_API_KEY", "").strip() or os.environ.get("IA4TUBE_OPENAI_API_KEY", "").strip()
    if token:
        return token
    if OPENAI_KEY_FILE.exists():
        token = OPENAI_KEY_FILE.read_text(encoding="utf-8").strip()
        if token:
            return token
    raise RuntimeError("OPENAI_API_KEY/IA4TUBE_OPENAI_API_KEY/openai_key.txt nao configurado.")


def load_bot_token():
    token = os.environ.get("IA4TUBE_BOT_TOKEN", "").strip()
    if token:
        return token
    if BOT_TOKEN_FILE.exists():
        return BOT_TOKEN_FILE.read_text(encoding="utf-8").strip()
    return ""


def update_remote_status(document_id, status, message=""):
    token = load_bot_token()
    if not token:
        return
    requests.post(
        f"{API_BASE}/bot/empresa/materiais-graficos/{document_id}/status",
        headers={"Authorization": f"Bearer {token}"},
        json={"status": status, "message": message},
        timeout=30,
    )


def prompt_path_for_request(solicitacao):
    material_id = normalize_slug(solicitacao.get("material_id") or solicitacao.get("id"))
    profile = solicitacao.get("profile") if isinstance(solicitacao.get("profile"), dict) else {}
    ramo_folder = str(solicitacao.get("ramo_folder") or "").strip()
    if not ramo_folder or ramo_folder == "_geral":
        ramo_folder = folder_for_ramo(profile.get("ramo"))

    candidates = []
    if ramo_folder and ramo_folder != "_geral":
        candidates.append(NICHOS_DIR / ramo_folder / "materiais_graficos" / "prompts" / f"{material_id}.txt")
    candidates.append(NICHOS_DIR / "_geral" / "materiais_graficos" / "prompts" / f"{material_id}.txt")

    for candidate in candidates:
        if candidate.exists():
            return candidate

    checked = "\n".join(str(candidate) for candidate in candidates)
    raise FileNotFoundError(f"Prompt do material grafico nao encontrado. Caminhos verificados:\n{checked}")


def build_prompt(solicitacao, prompt_path):
    profile = solicitacao.get("profile") if isinstance(solicitacao.get("profile"), dict) else {}
    base_prompt = prompt_path.read_text(encoding="utf-8")
    dados = [
        f"Nome da empresa: {profile.get('nome_empresa') or 'usar nome empresarial discreto se nao informado'}",
        f"Ramo: {profile.get('ramo') or 'empresa local'}",
        f"WhatsApp: {profile.get('whatsapp') or solicitacao.get('whatsapp') or ''}",
        f"Instagram: {profile.get('instagram') or ''}",
        f"Historia/contexto: {profile.get('historia') or ''}",
    ]

    return (
        f"{base_prompt}\n\n"
        "Dados para personalizacao:\n"
        + "\n".join(f"- {item}" for item in dados)
        + "\n\n"
        "Regras finais obrigatorias:\n"
        "- Criar uma unica imagem vertical A4 pronta para impressao.\n"
        "- Manter texto grande, legivel e em portugues do Brasil.\n"
        "- Incluir campos vazios para preenchimento manual.\n"
        "- Se houver logo como referencia, usar a marca de forma respeitosa no cabecalho.\n"
        "- Nao criar mockup em mesa, tela, celular, notebook ou interface digital.\n"
        "- Nao criar PDF, planilha ou sistema.\n"
    )


def prepare_reference(path):
    if not path.exists():
        return None
    try:
        img = Image.open(path).convert("RGBA")
        if img.width < 256 or img.height < 256:
            scale = max(256 / img.width, 256 / img.height)
            img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
        temp = path.with_suffix(".ref.png")
        img.save(temp, "PNG")
        return temp.open("rb")
    except Exception as exc:
        log(f"Ignorando logo invalido: {path} ({exc})")
        return None


def render_with_openai(prompt, logo_path, raw_path):
    client = OpenAI(api_key=load_api_key())
    image_files = []

    try:
        logo_file = prepare_reference(logo_path) if logo_path else None
        if logo_file:
            image_files.append(logo_file)

        log(f"Gerando imagem com {MODEL} | size={SIZE} | quality={QUALITY} | format={OUTPUT_FORMAT}")
        if image_files:
            result = client.images.edit(
                model=MODEL,
                image=image_files,
                prompt=prompt,
                size=SIZE,
                quality=QUALITY,
                output_format=OUTPUT_FORMAT,
                n=1,
            )
        else:
            result = client.images.generate(
                model=MODEL,
                prompt=prompt,
                size=SIZE,
                quality=QUALITY,
                output_format=OUTPUT_FORMAT,
                n=1,
            )

        image_bytes = base64.b64decode(result.data[0].b64_json)
        raw_path.write_bytes(image_bytes)
        return {
            "model": MODEL,
            "size": SIZE,
            "quality": QUALITY,
            "output_format": OUTPUT_FORMAT,
            "reference_count": len(image_files),
        }
    finally:
        for file_obj in image_files:
            try:
                temp_name = file_obj.name
                file_obj.close()
                Path(temp_name).unlink(missing_ok=True)
            except Exception:
                pass


def normalize_to_a4_png(raw_path, output_path):
    image = Image.open(raw_path).convert("RGB")
    fitted = ImageOps.fit(
        image,
        (TARGET_WIDTH, TARGET_HEIGHT),
        method=Image.LANCZOS,
        centering=(0.5, 0.5),
    )
    fitted.save(output_path, "PNG", optimize=True)


def upload_result(document_id, output_path, api_info):
    token = load_bot_token()
    if not token:
        raise RuntimeError("IA4TUBE_BOT_TOKEN/bot_token.txt nao configurado para upload do resultado.")

    with output_path.open("rb") as result_file:
        response = requests.post(
            f"{API_BASE}/bot/empresa/materiais-graficos/{document_id}/upload-resultado",
            headers={"Authorization": f"Bearer {token}"},
            files={"resultado": ("resultado_final.png", result_file, "image/png")},
            data={"api_info": json.dumps(api_info, ensure_ascii=False)},
            timeout=240,
        )

    if response.status_code != 200:
        raise RuntimeError(f"Upload do resultado falhou: HTTP {response.status_code} {response.text[:500]}")


def process_folder(pasta):
    solicitacao_path = pasta / "solicitacao.json"
    if not solicitacao_path.exists():
        raise RuntimeError(f"solicitacao.json nao encontrado em {pasta}")

    solicitacao = load_json(solicitacao_path)
    document_id = str(solicitacao.get("document_id") or solicitacao.get("id") or pasta.name).strip()
    prompt_path = prompt_path_for_request(solicitacao)
    logo_name = (solicitacao.get("assets") or {}).get("logo") if isinstance(solicitacao.get("assets"), dict) else ""
    logo_path = pasta / logo_name if logo_name else None

    append_runner_log(pasta, "Pipeline iniciado.")
    write_status(pasta, "em_producao")
    update_remote_status(document_id, "em_producao", "Pipeline de materiais graficos iniciado.")

    prompt = build_prompt(solicitacao, prompt_path)
    raw_path = pasta / "resultado_api_raw.png"
    output_path = pasta / "resultado_final.png"

    api_info = render_with_openai(prompt, logo_path, raw_path)
    api_info.update({
        "prompt_path": str(prompt_path),
        "target_width": TARGET_WIDTH,
        "target_height": TARGET_HEIGHT,
        "processed_at": datetime.now().isoformat(),
    })

    normalize_to_a4_png(raw_path, output_path)
    write_json(pasta / "resultado_api_info.json", api_info)
    upload_result(document_id, output_path, api_info)

    write_status(pasta, "pronto")
    (pasta / "processado_handoff.txt").write_text(datetime.now().isoformat(), encoding="utf-8")
    append_runner_log(pasta, "Pipeline finalizado com upload do resultado.")


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Uso: python pipeline_materiais_graficos.py <pasta_da_solicitacao>")

    pasta = Path(sys.argv[1]).resolve()
    try:
        process_folder(pasta)
    except Exception as exc:
        document_id = pasta.name
        try:
            solicitacao = load_json(pasta / "solicitacao.json")
            document_id = str(solicitacao.get("document_id") or solicitacao.get("id") or pasta.name)
        except Exception:
            pass
        write_status(pasta, "erro")
        append_runner_log(pasta, f"Erro no pipeline: {exc}")
        update_remote_status(document_id, "erro", str(exc))
        raise


if __name__ == "__main__":
    main()
