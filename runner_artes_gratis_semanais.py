import os
import subprocess
import time
from datetime import datetime
from pathlib import Path

import requests


BASE_DIR = Path(os.environ.get("IA4TUBE_BASE_DIR", Path(__file__).resolve().parent))
CAMPAIGNS_DIR = Path(os.environ.get("IA4TUBE_FREE_ART_CAMPAIGNS_DIR", BASE_DIR / "dados" / "campanhas_artes_gratis"))
PIPELINE = BASE_DIR / "resultado_pipeline_arte_gratis_semanal.py"
API_BASE = os.environ.get("IA4TUBE_API_BASE", "https://ia4tube-api.onrender.com").rstrip("/")
BOT_TOKEN_FILE = BASE_DIR / "bot_token.txt"
INTERVAL_SECONDS = int(os.environ.get("IA4TUBE_FREE_ARTS_INTERVAL_SECONDS", "10"))
PROCESS_TIMEOUT_SECONDS = int(os.environ.get("IA4TUBE_FREE_ARTS_TIMEOUT_SECONDS", "900"))


def log(message):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def bot_token():
    token = os.environ.get("IA4TUBE_BOT_TOKEN", "").strip()
    if token:
        return token
    if BOT_TOKEN_FILE.exists():
        return BOT_TOKEN_FILE.read_text(encoding="utf-8", errors="ignore").strip()
    return ""


def api_get(path):
    token = bot_token()
    if not token:
        log("IA4TUBE_BOT_TOKEN/bot_token.txt nao configurado.")
        return None
    response = requests.get(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    try:
        return response.json()
    except Exception:
        return {"ok": response.ok, "status": response.status_code, "body": response.text[:500]}


def api_post(path, payload=None, files=None):
    token = bot_token()
    if not token:
        return None
    response = requests.post(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {token}"},
        data=payload if files else None,
        json=None if files else (payload or {}),
        files=files,
        timeout=120,
    )
    try:
        return response.json()
    except Exception:
        return {"ok": response.ok, "status": response.status_code, "body": response.text[:500]}


def art_dir(art):
    return CAMPAIGNS_DIR / art["campaign_id"] / "artes" / art["art_id"]


def write_art_json(local_dir, art):
    local_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "id": art["art_id"],
        "campaign_id": art["campaign_id"],
        "ramo": art.get("ramo", ""),
        "ramo_normalizado": art.get("ramo_normalizado", ""),
        "prompt_livre": art.get("prompt_livre", ""),
        "opcao_rapida": art.get("opcao_rapida", ""),
        "index": art.get("index", 0),
    }
    (local_dir / "arte.json").write_text(__import__("json").dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def process_art(art):
    campaign_id = art["campaign_id"]
    art_id = art["art_id"]
    local_dir = art_dir(art)
    write_art_json(local_dir, art)
    api_post(f"/bot/free-art-campaigns/{campaign_id}/artes/{art_id}/status", {"status": "gerando"})

    try:
        subprocess.run(
            ["python", str(PIPELINE), str(local_dir)],
            cwd=str(BASE_DIR),
            timeout=PROCESS_TIMEOUT_SECONDS,
            check=True,
        )
    except Exception as exc:
        log(f"Falha ao gerar {campaign_id}/{art_id}: {exc}")
        api_post(
            f"/bot/free-art-campaigns/{campaign_id}/artes/{art_id}/status",
            {"status": "erro", "message": str(exc)},
        )
        return

    result = local_dir / "resultado_final.png"
    description = local_dir / "descricao_instagram.txt"
    if not result.exists():
        api_post(
            f"/bot/free-art-campaigns/{campaign_id}/artes/{art_id}/status",
            {"status": "erro", "message": "resultado_final.png nao encontrado"},
        )
        return

    with result.open("rb") as image:
        files = {"resultado": ("resultado_final.png", image, "image/png")}
        payload = {
            "descricao_instagram": description.read_text(encoding="utf-8", errors="ignore") if description.exists() else ""
        }
        response = api_post(
            f"/bot/free-art-campaigns/{campaign_id}/artes/{art_id}/upload-resultado",
            payload=payload,
            files=files,
        )
    log(f"Upload {campaign_id}/{art_id}: {response}")


def loop_once():
    data = api_get("/bot/free-art-campaigns/artes/novas?limit=5")
    if not data or not data.get("ok"):
        return
    for art in data.get("artes", []):
        process_art(art)


def main():
    log("Runner de artes gratis semanais iniciado.")
    while True:
        loop_once()
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
