import io
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(os.environ.get("IA4TUBE_BASE_DIR", Path(__file__).resolve().parent))
MATERIAIS_DIR = Path(os.environ.get("IA4TUBE_MATERIAIS_GRAFICOS_DIR", BASE_DIR / "dados" / "materiais_graficos"))
PIPELINE = BASE_DIR / "pipeline_materiais_graficos.py"
API_BASE = os.environ.get("IA4TUBE_API_BASE", "https://ia4tube-api.onrender.com").rstrip("/")
BOT_TOKEN_FILE = BASE_DIR / "bot_token.txt"

MAX_PROCESSOS = int(os.environ.get("IA4TUBE_MATERIAIS_GRAFICOS_MAX_PROCESSOS", "2"))
INTERVALO_SEGUNDOS = int(os.environ.get("IA4TUBE_MATERIAIS_GRAFICOS_INTERVALO", "8"))
PROCESS_TIMEOUT_SECONDS = int(os.environ.get("IA4TUBE_MATERIAIS_GRAFICOS_TIMEOUT", "900"))


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def carregar_bot_token():
    token = os.environ.get("IA4TUBE_BOT_TOKEN", "").strip()
    if token:
        return token
    if BOT_TOKEN_FILE.exists():
        return BOT_TOKEN_FILE.read_text(encoding="utf-8").strip()
    return ""


def safe_segment(value, fallback):
    value = str(value or "").strip() or fallback
    return "".join(ch if ch.isalnum() or ch in "._@-+" else "_" for ch in value) or fallback


def request_api_json(path, timeout=20):
    token = carregar_bot_token()
    if not token:
        log("Aviso: IA4TUBE_BOT_TOKEN/bot_token.txt nao configurado; nao consigo buscar materiais na API.")
        return None

    req = urllib.request.Request(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {token}"}
    )

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def update_remote_status(document_id, status, message=""):
    token = carregar_bot_token()
    if not token:
        return

    body = json.dumps({"status": status, "message": message}).encode("utf-8")
    req = urllib.request.Request(
        f"{API_BASE}/bot/empresa/materiais-graficos/{document_id}/status",
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=20).read()
    except Exception as exc:
        log(f"Aviso: falha ao atualizar status remoto de {document_id}: {exc}")


def safe_extract_zip(zip_bytes, destino):
    destino = destino.resolve()
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for item in zf.infolist():
            target = (destino / item.filename).resolve()
            if os.path.commonpath([str(destino), str(target)]) != str(destino):
                raise RuntimeError(f"Arquivo invalido no ZIP: {item.filename}")
        zf.extractall(destino)


def baixar_zip_material(material):
    token = carregar_bot_token()
    if not token:
        return None

    document_id = safe_segment(material.get("document_id"), "documento")
    whatsapp = safe_segment(material.get("whatsapp"), "sem_whatsapp")
    ciclo = safe_segment(material.get("ciclo"), datetime.now().strftime("%Y-%m"))
    destino = MATERIAIS_DIR / whatsapp / ciclo / document_id

    if (destino / "solicitacao.json").exists():
        return destino

    tmp_destino = destino.parent / f".{document_id}.download"
    if tmp_destino.exists():
        shutil.rmtree(tmp_destino, ignore_errors=True)
    tmp_destino.mkdir(parents=True, exist_ok=True)

    try:
        req = urllib.request.Request(
            f"{API_BASE}/bot/empresa/materiais-graficos/{document_id}/zip",
            headers={"Authorization": f"Bearer {token}"}
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            safe_extract_zip(resp.read(), tmp_destino)

        destino.parent.mkdir(parents=True, exist_ok=True)
        if destino.exists():
            shutil.rmtree(destino, ignore_errors=True)
        tmp_destino.rename(destino)
        return destino
    except Exception as exc:
        shutil.rmtree(tmp_destino, ignore_errors=True)
        log(f"Falha ao baixar ZIP do material {document_id}: {exc}")
        return None


def status_local(pasta):
    status_path = pasta / "status.txt"
    if not status_path.exists():
        return ""
    return status_path.read_text(encoding="utf-8", errors="ignore").strip().lower()


def append_runner_log(pasta, msg):
    with open(pasta / "runner_log.txt", "a", encoding="utf-8", errors="ignore") as f:
        f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}\n")


def material_pendente(pasta):
    if not pasta.is_dir():
        return False
    if not (pasta / "solicitacao.json").exists():
        return False
    if (pasta / "resultado_final.png").exists() or (pasta / "processado_handoff.txt").exists():
        return False
    if (pasta / "processando.lock").exists():
        return False
    return status_local(pasta) in ("", "novo")


def listar_pendentes_locais():
    if not MATERIAIS_DIR.exists():
        return []
    pendentes = []
    for solicitacao_path in MATERIAIS_DIR.rglob("solicitacao.json"):
        pasta = solicitacao_path.parent
        if material_pendente(pasta):
            pendentes.append(pasta)
    return sorted(pendentes, key=lambda p: p.stat().st_mtime)


def buscar_novos_da_api():
    data = request_api_json("/bot/empresa/materiais-graficos/novos?limit=20")
    if not data or not data.get("ok"):
        return []

    pastas = []
    for material in data.get("materiais", []):
        pasta = baixar_zip_material(material)
        if pasta and material_pendente(pasta):
            pastas.append(pasta)
    return pastas


def processar_pasta(pasta):
    document_id = pasta.name
    lock = pasta / "processando.lock"
    lock.write_text(datetime.now().isoformat(), encoding="utf-8")
    (pasta / "status.txt").write_text("processando\n", encoding="utf-8")
    append_runner_log(pasta, "Runner iniciou processamento.")
    update_remote_status(document_id, "processando", "Runner de materiais graficos iniciou processamento.")

    try:
        subprocess.run(
            [sys.executable, str(PIPELINE), str(pasta)],
            cwd=str(BASE_DIR),
            timeout=PROCESS_TIMEOUT_SECONDS,
            check=True,
        )
        append_runner_log(pasta, "Runner concluiu processamento.")
    except Exception as exc:
        (pasta / "status.txt").write_text("erro\n", encoding="utf-8")
        append_runner_log(pasta, f"Erro no runner: {exc}")
        update_remote_status(document_id, "erro", str(exc))
    finally:
        try:
            lock.unlink(missing_ok=True)
        except Exception:
            pass


def main():
    MATERIAIS_DIR.mkdir(parents=True, exist_ok=True)
    log("Runner de Materiais Graficos da Empresa iniciado.")

    while True:
        try:
            buscar_novos_da_api()
            pendentes = listar_pendentes_locais()
            if not pendentes:
                time.sleep(INTERVALO_SEGUNDOS)
                continue

            for pasta in pendentes[:MAX_PROCESSOS]:
                log(f"Processando material grafico: {pasta.name}")
                processar_pasta(pasta)
        except KeyboardInterrupt:
            log("Runner interrompido pelo usuario.")
            break
        except Exception as exc:
            log(f"Erro no loop do runner: {exc}")
            time.sleep(INTERVALO_SEGUNDOS)


if __name__ == "__main__":
    main()
