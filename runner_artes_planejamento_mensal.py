import io
import json
import os
import shutil
import subprocess
import time
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path

import requests


BASE_DIR = Path(os.environ.get("IA4TUBE_BASE_DIR", Path(__file__).resolve().parent))
PEDIDOS_DIR = Path(os.environ.get("IA4TUBE_PEDIDOS_DIR", BASE_DIR / "dados" / "pedidos"))
PIPELINE = BASE_DIR / "resultado_pipeline_planejamento_mensal.py"

API_BASE = os.environ.get("IA4TUBE_API_BASE", "https://ia4tube-api.onrender.com").rstrip("/")
BOT_TOKEN_FILE = BASE_DIR / "bot_token.txt"

MAX_PROCESSOS = int(os.environ.get("IA4TUBE_PLANNING_ARTS_MAX_PROCESSOS", "4"))
INTERVALO_SEGUNDOS = int(os.environ.get("IA4TUBE_PLANNING_ARTS_INTERVALO_SEGUNDOS", "5"))
PROCESS_TIMEOUT_SECONDS = int(os.environ.get("IA4TUBE_PLANNING_ARTS_TIMEOUT_SECONDS", "900"))


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def carregar_bot_token():
    token = os.environ.get("IA4TUBE_BOT_TOKEN", "").strip()
    if token:
        return token

    if BOT_TOKEN_FILE.exists():
        try:
            return BOT_TOKEN_FILE.read_text(encoding="utf-8").strip()
        except Exception:
            return ""

    return ""


def safe_segment(value, fallback):
    value = str(value or "").strip()
    if not value:
        value = fallback
    return "".join(ch if ch.isalnum() or ch in "._@-+" else "_" for ch in value) or fallback


def read_pedido_json(pasta):
    pedido_path = pasta / "pedido.json"
    if not pedido_path.exists():
        return {}

    try:
        return json.loads(pedido_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def is_monthly_planning_order(pasta):
    pedido = read_pedido_json(pasta)
    origem = str(pedido.get("origem", "")).strip().lower()
    planning = pedido.get("planejamento_mensal")

    if origem == "planejamento_mensal":
        return True

    if isinstance(planning, dict):
        planning_origem = str(planning.get("origem", "")).strip().lower()
        if planning_origem == "planejamento_mensal":
            return True

    return bool(
        str(pedido.get("planejamento_id", "")).strip()
        and str(pedido.get("planejamento_item_id", "")).strip()
    )


def request_api_json(path, timeout=20):
    token = carregar_bot_token()
    if not token:
        log("Aviso: IA4TUBE_BOT_TOKEN/bot_token.txt nao configurado; nao consigo buscar artes do planejamento.")
        return None

    req = urllib.request.Request(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {token}"}
    )

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def post_api_json(path, payload, timeout=30):
    token = carregar_bot_token()
    if not token:
        return None

    resp = requests.post(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
        timeout=timeout,
    )
    try:
        return resp.json()
    except Exception:
        return {"ok": resp.ok, "status_code": resp.status_code, "body": resp.text[:500]}


def safe_extract_zip(zip_bytes, destino):
    destino = destino.resolve()

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for item in zf.infolist():
            target = (destino / item.filename).resolve()
            if os.path.commonpath([str(destino), str(target)]) != str(destino):
                raise RuntimeError(f"Arquivo invalido no ZIP: {item.filename}")

        zf.extractall(destino)


def merge_missing_files(src, dst):
    dst.mkdir(parents=True, exist_ok=True)

    for item in src.iterdir():
        target = dst / item.name

        if item.is_dir():
            merge_missing_files(item, target)
            continue

        if not target.exists():
            shutil.copy2(item, target)


def baixar_zip_arte(arte):
    token = carregar_bot_token()
    if not token:
        return None

    pedido_id = safe_segment(arte.get("pedido_id") or arte.get("id"), "pedido")
    whatsapp = safe_segment(arte.get("whatsapp"), "sem_whatsapp")
    mes = safe_segment(arte.get("mes"), datetime.now().strftime("%Y-%m"))
    destino = PEDIDOS_DIR / whatsapp / mes / pedido_id

    if (destino / "pedido.json").exists() and is_monthly_planning_order(destino):
        return destino

    tmp_destino = destino.parent / f".{pedido_id}.download"
    if tmp_destino.exists():
        shutil.rmtree(tmp_destino, ignore_errors=True)

    tmp_destino.mkdir(parents=True, exist_ok=True)

    try:
        req = urllib.request.Request(
            f"{API_BASE}/bot/empresa/planejamento-mensal/artes/{pedido_id}/zip",
            headers={"Authorization": f"Bearer {token}"}
        )

        with urllib.request.urlopen(req, timeout=60) as resp:
            zip_bytes = resp.read()

        safe_extract_zip(zip_bytes, tmp_destino)

        if destino.exists():
            merge_missing_files(tmp_destino, destino)
            shutil.rmtree(tmp_destino, ignore_errors=True)
        else:
            tmp_destino.rename(destino)

        log(f"Arte do planejamento baixada da API: {pedido_id}")
        return destino

    except Exception:
        shutil.rmtree(tmp_destino, ignore_errors=True)
        raise


def baixar_artes_novas_api():
    try:
        data = request_api_json("/bot/empresa/planejamento-mensal/artes/novas")
        if not data or not data.get("ok"):
            return

        artes = data.get("artes", [])
        if not artes:
            return

        for arte in artes:
            try:
                baixar_zip_arte(arte)
            except Exception as exc:
                log(f"Aviso: erro ao baixar arte {arte.get('pedido_id') or arte.get('id')}: {exc}")

    except Exception as exc:
        log(f"Aviso: erro ao buscar artes novas do Planejamento Mensal: {exc}")


def append_runner_log(pasta, message):
    try:
        with open(pasta / "runner_log.txt", "a", encoding="utf-8", errors="replace") as f:
            f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {message}\n")
    except Exception:
        pass


def status_pedido_local(pasta):
    status_file = pasta / "status.txt"
    if not status_file.exists():
        return ""

    try:
        return status_file.read_text(encoding="utf-8", errors="ignore").strip().lower()
    except Exception:
        return ""


def arte_pendente(pasta):
    if not pasta.is_dir():
        return False
    if not (pasta / "pedido.json").exists():
        return False
    if not is_monthly_planning_order(pasta):
        return False
    if (pasta / "resultado_final.png").exists():
        return False
    if (pasta / "processando.lock").exists():
        return False
    if (pasta / "erro_runner.txt").exists():
        return False
    if (pasta / "erro_validacao.txt").exists():
        return False

    status = status_pedido_local(pasta)
    return status in {"", "novo", "ajuste_pendente"}


def pegar_pendentes():
    if not PEDIDOS_DIR.exists():
        return []

    pendentes = []
    for pedido_json in PEDIDOS_DIR.rglob("pedido.json"):
        pasta = pedido_json.parent
        if arte_pendente(pasta):
            pendentes.append(pasta)

    return sorted(pendentes, key=lambda p: p.name)


def marcar_status_api(pasta, status, message=""):
    pedido_id = pasta.name
    post_api_json(
        f"/bot/empresa/planejamento-mensal/artes/{pedido_id}/status",
        {"status": status, "message": message},
        timeout=30,
    )


def registrar_erro_local(pasta, message):
    append_runner_log(pasta, f"erro: {message}")
    try:
        (pasta / "erro_runner.txt").write_text(str(message), encoding="utf-8", errors="ignore")
        (pasta / "status.txt").write_text("erro", encoding="utf-8")
    except Exception:
        pass
    marcar_status_api(pasta, "erro", str(message))


def iniciar_arte(pasta):
    if not PIPELINE.exists():
        registrar_erro_local(
            pasta,
            f"Pipeline de Planejamento Mensal nao encontrado: {PIPELINE}"
        )
        return None, None

    lock = pasta / "processando.lock"
    try:
        with open(lock, "x", encoding="utf-8") as f:
            f.write("processando")
    except FileExistsError:
        log(f"Arte ja esta com lock ativo, ignorando: {pasta.name}")
        return None, None

    marcar_status_api(pasta, "processando")
    log(f"Iniciando arte do Planejamento Mensal: {pasta.name}")

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["IA4TUBE_PLANNING_ART_UPLOAD_ENDPOINT"] = (
        f"{API_BASE}/bot/empresa/planejamento-mensal/artes/{pasta.name}/upload-resultado"
    )

    log_file = open(pasta / "runner_log.txt", "w", encoding="utf-8", errors="replace")
    log_file.write(
        f"[{datetime.now().isoformat(timespec='seconds')}] "
        f"pipeline_selecionado: {PIPELINE.name}\n"
    )
    log_file.flush()

    proc = subprocess.Popen(
        ["python", str(PIPELINE), str(pasta)],
        cwd=str(BASE_DIR),
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    return proc, log_file


def close_log_file(info):
    log_file = info.get("log_file")
    if log_file:
        try:
            log_file.flush()
            log_file.close()
        except Exception:
            pass


def finalizar_processo(pasta, proc, info):
    close_log_file(info)
    lock = pasta / "processando.lock"

    if proc.returncode == 0:
        log(f"Arte do Planejamento Mensal pronta: {pasta.name}")
        try:
            if lock.exists():
                lock.unlink()
        except Exception:
            pass
        return

    registrar_erro_local(pasta, f"pipeline retornou codigo {proc.returncode}")
    try:
        if lock.exists():
            lock.unlink()
    except Exception:
        pass


def main():
    log("Runner de artes do Planejamento Mensal iniciado.")
    log(f"Base: {BASE_DIR}")
    log(f"Pedidos: {PEDIDOS_DIR}")
    log(f"Pipeline: {PIPELINE}")

    ativos = {}

    while True:
        baixar_artes_novas_api()

        for pasta in pegar_pendentes():
            if len(ativos) >= MAX_PROCESSOS:
                break

            chave = str(pasta.resolve())
            if chave in ativos:
                continue

            proc, log_file = iniciar_arte(pasta)
            if proc is not None:
                ativos[chave] = {
                    "pasta": pasta,
                    "proc": proc,
                    "log_file": log_file,
                    "inicio": time.time(),
                }

        for chave, info in list(ativos.items()):
            proc = info["proc"]
            pasta = info["pasta"]
            retorno = proc.poll()

            if retorno is not None:
                finalizar_processo(pasta, proc, info)
                ativos.pop(chave, None)
                continue

            if time.time() - info["inicio"] > PROCESS_TIMEOUT_SECONDS:
                proc.kill()
                registrar_erro_local(pasta, "timeout no pipeline de Planejamento Mensal")
                close_log_file(info)
                try:
                    (pasta / "processando.lock").unlink(missing_ok=True)
                except Exception:
                    pass
                ativos.pop(chave, None)

        time.sleep(INTERVALO_SEGUNDOS)


if __name__ == "__main__":
    main()
