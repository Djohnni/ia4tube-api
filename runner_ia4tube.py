import subprocess
import time
import json
import os
import math
import io
import shutil
import zipfile
import urllib.request
from pathlib import Path
from datetime import datetime

BASE_DIR = Path(os.environ.get("IA4TUBE_BASE_DIR", Path(__file__).resolve().parent))
PEDIDOS_DIR = Path(os.environ.get("IA4TUBE_PEDIDOS_DIR", BASE_DIR / "dados" / "pedidos"))
DEFAULT_PIPELINE = BASE_DIR / "resultado_pipeline_ia4tube.py"
MONTHLY_PLANNING_PIPELINE = BASE_DIR / "resultado_pipeline_planejamento_mensal.py"
PIPELINE = DEFAULT_PIPELINE

MAX_PROCESSOS = 10
INTERVALO_SEGUNDOS = 5
PROCESS_TIMEOUT_SECONDS = int(os.environ.get("IA4TUBE_PROCESS_TIMEOUT_SECONDS", "900"))
RECOVERY_SCAN_INTERVAL_SECONDS = int(os.environ.get("IA4TUBE_RECOVERY_SCAN_INTERVAL_SECONDS", "60"))
RECOVERY_LOCK_STALE_SECONDS = int(os.environ.get("IA4TUBE_RECOVERY_LOCK_STALE_SECONDS", "180"))

ESTADO_FILE = BASE_DIR / "runner_estado.json"
TEMPOS_FILE = BASE_DIR / "runner_tempos.json"
INICIAR_A_PARTIR_DE = "20260428_182150"

API_BASE = os.environ.get("IA4TUBE_API_BASE", "https://ia4tube-api.onrender.com").rstrip("/")
BOT_TOKEN_FILE = BASE_DIR / "bot_token.txt"
TEMPO_PADRAO_SEGUNDOS = 0
HISTORICO_TEMPOS_MAX = 20

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def carregar_ultimo_pedido():
    if not ESTADO_FILE.exists():
        return INICIAR_A_PARTIR_DE

    try:
        data = json.loads(ESTADO_FILE.read_text(encoding="utf-8"))
        return str(data.get("ultimo_pedido_visto", INICIAR_A_PARTIR_DE)).strip() or INICIAR_A_PARTIR_DE
    except Exception:
        return INICIAR_A_PARTIR_DE

def salvar_ultimo_pedido(nome_pedido):
    ESTADO_FILE.write_text(
        json.dumps({"ultimo_pedido_visto": nome_pedido}, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

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

def mes_do_pedido(pedido):
    mes = str(pedido.get("mes", "")).strip()
    if mes:
        return safe_segment(mes, "sem_mes")

    pedido_id = str(pedido.get("id", "")).strip()
    if len(pedido_id) >= 6 and pedido_id[:6].isdigit():
        return f"{pedido_id[:4]}-{pedido_id[4:6]}"

    return datetime.now().strftime("%Y-%m")

def request_api_json(path, timeout=15):
    token = carregar_bot_token()
    if not token:
        log("Aviso: IA4TUBE_BOT_TOKEN/bot_token.txt nao configurado; nao consigo buscar pedidos na API.")
        return None

    req = urllib.request.Request(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {token}"}
    )

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

def safe_extract_zip(zip_bytes, destino):
    destino = destino.resolve()

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for item in zf.infolist():
            target = (destino / item.filename).resolve()
            if os.path.commonpath([str(destino), str(target)]) != str(destino):
                raise RuntimeError(f"Arquivo inválido no ZIP: {item.filename}")

        zf.extractall(destino)

def _asset_file_names_from_value(value):
    names = []

    if isinstance(value, str):
        value = value.strip()
        if value:
            names.append(value)
        return names

    if isinstance(value, list):
        for item in value:
            names.extend(_asset_file_names_from_value(item))
        return names

    if isinstance(value, dict):
        file_value = str(value.get("file") or value.get("name") or "").strip()
        if file_value:
            names.append(file_value)

        files_value = value.get("files")
        if isinstance(files_value, list):
            for item in files_value:
                names.extend(_asset_file_names_from_value(item))

    return names

def _collect_declared_asset_files(pedido):
    names = []

    for group_name in ("assets", "company_assets"):
        group = pedido.get(group_name)
        if not isinstance(group, dict):
            continue

        for key in ("logo", "fotos", "referencias", "modelo_existente"):
            names.extend(_asset_file_names_from_value(group.get(key)))

    clean = []
    seen = set()

    for name in names:
        safe_name = str(name or "").strip().replace("\\", "/").split("/")[-1]
        if not safe_name or safe_name in seen:
            continue
        clean.append(safe_name)
        seen.add(safe_name)

    return clean

def missing_declared_assets(pasta):
    pedido_path = pasta / "pedido.json"
    if not pedido_path.exists():
        return []

    try:
        pedido = json.loads(pedido_path.read_text(encoding="utf-8"))
    except Exception:
        return []

    missing = []
    for name in _collect_declared_asset_files(pedido):
        if not (pasta / name).exists():
            missing.append(name)

    return missing

def local_order_cache_complete(pasta):
    missing = missing_declared_assets(pasta)
    if missing:
        log(f"Cache local incompleto em {pasta.name}; faltando: {', '.join(missing)}")
        return False
    return True

def merge_missing_files(src, dst):
    dst.mkdir(parents=True, exist_ok=True)

    for item in src.iterdir():
        target = dst / item.name

        if item.is_dir():
            merge_missing_files(item, target)
            continue

        if not target.exists():
            shutil.copy2(item, target)

def baixar_zip_pedido(pedido):
    token = carregar_bot_token()
    if not token:
        return None

    pedido_id = safe_segment(pedido.get("id"), "pedido")
    whatsapp = safe_segment(pedido.get("whatsapp"), "sem_whatsapp")
    mes = mes_do_pedido(pedido)
    destino = PEDIDOS_DIR / whatsapp / mes / pedido_id

    if (destino / "pedido.json").exists():
        if local_order_cache_complete(destino):
            return destino
        log(f"Rebaixando ZIP do pedido {pedido_id} para recuperar assets ausentes.")

    tmp_destino = destino.parent / f".{pedido_id}.download"
    if tmp_destino.exists():
        shutil.rmtree(tmp_destino, ignore_errors=True)

    tmp_destino.mkdir(parents=True, exist_ok=True)

    try:
        req = urllib.request.Request(
            f"{API_BASE}/bot/pedidos/{pedido_id}/zip",
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

        log(f"Pedido baixado da API: {pedido_id}")
        return destino

    except Exception:
        shutil.rmtree(tmp_destino, ignore_errors=True)
        raise

def baixar_pedidos_novos_api():
    try:
        data = request_api_json("/bot/pedidos/novos")
        if not data or not data.get("ok"):
            return

        pedidos = data.get("pedidos", [])
        if not pedidos:
            return

        for pedido in pedidos:
            try:
                baixar_zip_pedido(pedido)
            except Exception as e:
                log(f"Aviso: erro ao baixar pedido {pedido.get('id', '')}: {e}")

    except Exception as e:
        log(f"Aviso: erro ao buscar pedidos novos na API: {e}")

def carregar_tempos():
    if not TEMPOS_FILE.exists():
        return []

    try:
        data = json.loads(TEMPOS_FILE.read_text(encoding="utf-8"))
        tempos = data.get("tempos_segundos", [])
        return [float(t) for t in tempos if float(t) > 0][-HISTORICO_TEMPOS_MAX:]
    except Exception:
        return []

def salvar_tempos(tempos):
    TEMPOS_FILE.write_text(
        json.dumps({"tempos_segundos": tempos[-HISTORICO_TEMPOS_MAX:]}, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

def registrar_tempo_pedido(segundos):
    if segundos <= 0:
        return

    tempos = carregar_tempos()
    tempos.append(round(float(segundos), 2))
    salvar_tempos(tempos)

def calcular_tempo_estimado(qtd_pedidos):
    tempos = carregar_tempos()

    if not tempos:
        media = 0
    else:
        ultimo = tempos[-1]

        if ultimo <= 120:
            media = ultimo
        else:
            ultimos_5 = tempos[-5:]
            media = sum(ultimos_5) / len(ultimos_5)

    lotes = max(1, math.ceil(max(1, qtd_pedidos) / MAX_PROCESSOS))
    estimado = int(round(media * lotes)) if media > 0 else 0

    return {
        "aprendendo": len(tempos) == 0,
        "tempo_medio_segundos": int(round(media)),
        "tempo_estimado_segundos": estimado,
        "pedidos_na_fila": int(qtd_pedidos),
        "lotes": int(lotes),
        "max_processos": int(MAX_PROCESSOS),
        "atualizado_em": datetime.now().isoformat()
    }

def enviar_tempo_est_api(payload):
    token = carregar_bot_token()
    if not token:
        return

    try:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{API_BASE}/bot/tempo-estimado",
            data=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json"
            },
            method="POST"
        )
        urllib.request.urlopen(req, timeout=5).read()
    except Exception as e:
        log(f"⚠️ Erro ao enviar tempo estimado para API: {e}")

def avisar_erro_pedido_api(pasta, motivo):
    token = carregar_bot_token()
    if not token:
        log("⚠️ Sem bot_token.txt: não consegui avisar suporte no site.")
        return

    try:
        pedido_path = pasta / "pedido.json"
        if not pedido_path.exists():
            log("⚠️ pedido.json não encontrado para avisar suporte.")
            return

        pedido = json.loads(pedido_path.read_text(encoding="utf-8"))
        pedido_id = str(pedido.get("id", pasta.name)).strip()
        whatsapp = str(pedido.get("whatsapp", "")).strip()

        if not whatsapp:
            log("⚠️ WhatsApp não encontrado no pedido.json.")
            return

        payload = {
            "pedido_id": pedido_id,
            "whatsapp": whatsapp,
            "motivo": motivo
        }

        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(
            f"{API_BASE}/bot/suporte/erro-pedido",
            data=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json"
            },
            method="POST"
        )

        urllib.request.urlopen(req, timeout=10).read()
        log(f"📩 Suporte avisado no site: {pedido_id}")

    except Exception as e:
        log(f"⚠️ Erro ao avisar suporte no site: {e}")

def append_runner_log(pasta, msg):
    try:
        with open(pasta / "runner_log.txt", "a", encoding="utf-8", errors="ignore") as f:
            f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}\n")
    except Exception:
        pass

def read_pedido_json(pasta):
    pedido_path = pasta / "pedido.json"
    if not pedido_path.exists():
        return {}

    try:
        return json.loads(pedido_path.read_text(encoding="utf-8"))
    except Exception:
        return {}

def is_arte_empresa_pedido(pasta):
    pedido = read_pedido_json(pasta)
    return str(pedido.get("categoria", "")).strip() == "arte_empresa" or \
        str(pedido.get("product_id", "")).strip() == "arte_empresa"

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

def select_pipeline_for_order(pasta):
    if is_monthly_planning_order(pasta):
        if MONTHLY_PLANNING_PIPELINE.exists():
            return MONTHLY_PLANNING_PIPELINE
        raise FileNotFoundError(
            "Pipeline de Planejamento Mensal nao encontrado: "
            f"{MONTHLY_PLANNING_PIPELINE}. "
            "Pedido de planejamento mensal nao pode usar o pipeline generico."
        )
    return DEFAULT_PIPELINE

def mark_pipeline_selection_error(pasta, error):
    message = str(error)
    append_runner_log(pasta, f"erro_selecao_pipeline: {message}")

    try:
        (pasta / "erro_runner.txt").write_text(message, encoding="utf-8", errors="ignore")
        (pasta / "status.txt").write_text("em_analise", encoding="utf-8")

        pedido_path = pasta / "pedido.json"
        if pedido_path.exists():
            pedido = json.loads(pedido_path.read_text(encoding="utf-8"))
            pedido["status"] = "em_analise"
            pedido["motivo_erro"] = "pipeline_planejamento_mensal_ausente"
            pedido["reembolso_pendente"] = True
            pedido_path.write_text(
                json.dumps(pedido, ensure_ascii=False, indent=2),
                encoding="utf-8"
            )
    except Exception as exc:
        log(f"Erro ao registrar falha de pipeline: {exc}")

    lock = pasta / "processando.lock"
    if lock.exists():
        try:
            lock.unlink()
        except Exception:
            pass

def is_download_staging_path(pasta):
    parts = {str(part).lower() for part in Path(pasta).parts}
    return "_downloads" in parts or "pedidos_downloads" in parts

def status_pedido_local(pasta):
    status_file = pasta / "status.txt"
    if not status_file.exists():
        return ""

    try:
        return status_file.read_text(encoding="utf-8", errors="ignore").strip().lower()
    except Exception:
        return ""

def lock_stale(pasta):
    lock = pasta / "processando.lock"
    if not lock.exists():
        return False

    try:
        return time.time() - lock.stat().st_mtime >= RECOVERY_LOCK_STALE_SECONDS
    except Exception:
        return False

def can_recover_finished_art(pasta, require_stale_lock=True):
    if not pasta.is_dir():
        return False
    if is_download_staging_path(pasta):
        return False
    if not is_arte_empresa_pedido(pasta):
        return False
    if status_pedido_local(pasta) == "pronto":
        return False
    if not (pasta / "resultado_final.png").exists():
        return False
    if not (pasta / "preview_ia4tube.jpg").exists():
        return False
    if require_stale_lock and not lock_stale(pasta):
        return False
    return True

def mark_local_ready_after_upload(pasta):
    pedido_path = pasta / "pedido.json"
    pedido = read_pedido_json(pasta)

    pedido["status"] = "pronto"
    pedido["aprovado_cliente"] = False
    pedido["baixado_cliente"] = False
    pedido["resultado_enviado_em"] = datetime.now().isoformat()

    if pedido_path.exists():
        pedido_path.write_text(
            json.dumps(pedido, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

    (pasta / "status.txt").write_text("pronto", encoding="utf-8")
    (pasta / "processado_handoff.txt").write_text("OK", encoding="utf-8")

    lock = pasta / "processando.lock"
    if lock.exists():
        try:
            lock.unlink()
        except Exception:
            pass

def recover_finished_art(pasta, reason="recovery"):
    pedido = read_pedido_json(pasta)
    pedido_id = str(pedido.get("id", pasta.name)).strip() or pasta.name
    token = carregar_bot_token()

    if not token:
        append_runner_log(pasta, f"{reason}: sem bot_token para upload de recuperacao")
        return False

    resultado_path = pasta / "resultado_final.png"
    preview_path = pasta / "preview_ia4tube.jpg"

    try:
        import requests

        append_runner_log(pasta, f"{reason}: tentando upload de recuperacao")
        with open(resultado_path, "rb") as f_resultado, open(preview_path, "rb") as f_preview:
            resp = requests.post(
                f"{API_BASE}/bot/pedidos/{pedido_id}/upload-resultado",
                headers={"Authorization": f"Bearer {token}"},
                files={
                    "resultado": ("resultado_final.png", f_resultado, "image/png"),
                    "preview": ("preview_ia4tube.jpg", f_preview, "image/jpeg")
                },
                data={"descricao_instagram": pedido.get("descricao_instagram", "")},
                timeout=180
            )

        if resp.status_code != 200:
            append_runner_log(
                pasta,
                f"{reason}: upload falhou status={resp.status_code} body={resp.text[:500]}"
            )
            return False

        mark_local_ready_after_upload(pasta)
        append_runner_log(pasta, f"{reason}: pedido recuperado e marcado como pronto")
        return True
    except Exception as e:
        append_runner_log(pasta, f"{reason}: falha na recuperacao: {e}")
        return False

def recover_stale_finished_orders():
    if not PEDIDOS_DIR.exists():
        return

    for pedido_json in PEDIDOS_DIR.rglob("pedido.json"):
        pasta = pedido_json.parent
        if is_download_staging_path(pasta):
            continue
        if can_recover_finished_art(pasta, require_stale_lock=True):
            if recover_finished_art(pasta, reason="stale_lock"):
                log(f"✅ Pedido recuperado: {pasta.name}")

def pedido_pendente(pasta, ultimo_pedido):
    if not pasta.is_dir():
        return False

    if is_download_staging_path(pasta):
        return False

    if not (pasta / "pedido.json").exists():
        return False

    if is_monthly_planning_order(pasta):
        return False

    if is_arte_empresa_pedido(pasta):
        missing = missing_declared_assets(pasta)
        if missing:
            append_runner_log(
                pasta,
                f"cache_incompleto: assets ausentes antes do pipeline: {', '.join(missing)}"
            )
            return False

    ajuste_pendente_file = pasta / "ajuste_pendente.txt"
    status_file = pasta / "status.txt"

    status = ""
    if status_file.exists():
        try:
            status = status_file.read_text(encoding="utf-8", errors="ignore").strip().lower()
        except Exception:
            status = ""

    eh_ajuste = ajuste_pendente_file.exists() or status == "ajuste_pendente"

    if not eh_ajuste and pasta.name <= ultimo_pedido:
        return False

    if not eh_ajuste and (pasta / "resultado_final.png").exists():
        return False

    if (pasta / "erro_validacao.txt").exists():
        return False

    if (pasta / "erro_runner.txt").exists():
        return False

    if (pasta / "processando.lock").exists():
        return False

    if not eh_ajuste and (pasta / "processado_handoff.txt").exists():
        return False

    return True

def pegar_pendentes():
    ultimo_pedido = carregar_ultimo_pedido()

    if not PEDIDOS_DIR.exists():
        return []

    pastas = []

    for pedido_json in PEDIDOS_DIR.rglob("pedido.json"):
        pasta = pedido_json.parent
        if is_download_staging_path(pasta):
            continue
        if pedido_pendente(pasta, ultimo_pedido):
            pastas.append(pasta)

    pastas_ordenadas = sorted(pastas, key=lambda p: p.name)
    pastas_unicas = []
    vistos = set()

    for pasta in pastas_ordenadas:
        chave = os.path.normcase(str(pasta.resolve()))
        if chave in vistos:
            continue
        vistos.add(chave)
        pastas_unicas.append(pasta)

    return pastas_unicas

def iniciar_pedido(pasta):
    lock = pasta / "processando.lock"
    try:
        with open(lock, "x", encoding="utf-8") as f:
            f.write("processando")
    except FileExistsError:
        log(f"Pedido ja esta com lock ativo, ignorando: {pasta.name}")
        return None, None

    if (pasta / "ajuste_pendente.txt").exists():
        handoff = pasta / "processado_handoff.txt"
        if handoff.exists():
            try:
                handoff.unlink()
            except Exception:
                pass

    log(f"🚀 Iniciando pedido: {pasta.name}")

    try:
        pipeline = select_pipeline_for_order(pasta)
    except Exception as error:
        mark_pipeline_selection_error(pasta, error)
        log(f"Erro de pipeline: {error}")
        return None, None

    log(f"Pipeline selecionado: {pipeline.name}")

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"

    log_file = open(pasta / "runner_log.txt", "w", encoding="utf-8", errors="replace")
    log_file.write(f"[{datetime.now().isoformat(timespec='seconds')}] pipeline_selecionado: {pipeline.name}\n")
    log_file.flush()
    proc = subprocess.Popen(
        ["python", str(pipeline), str(pasta)],
        cwd=str(BASE_DIR),
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
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

def read_runner_log(pasta):
    log_path = pasta / "runner_log.txt"
    if not log_path.exists():
        return ""

    try:
        return log_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""

def stop_process(proc):
    if proc.poll() is not None:
        return

    try:
        proc.terminate()
        proc.wait(timeout=8)
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=5)
        except Exception:
            pass

def main():
    ativos = {}
    last_recovery_scan = 0

    log("✅ Runner de fila iniciado")
    log(f"⚙️ Limite simultâneo: {MAX_PROCESSOS}")

    while True:
        finalizados = []

        for pasta, info in ativos.items():
            proc = info["proc"]
            inicio = info["inicio"]
            timed_out = proc.poll() is None and (time.time() - inicio) > PROCESS_TIMEOUT_SECONDS

            if timed_out:
                append_runner_log(pasta, f"timeout: processo excedeu {PROCESS_TIMEOUT_SECONDS}s")
                stop_process(proc)
                close_log_file(info)

                if can_recover_finished_art(pasta, require_stale_lock=False) and recover_finished_art(pasta, reason="timeout"):
                    duracao = time.time() - inicio
                    registrar_tempo_pedido(duracao)
                    log(f"✅ Recuperado apos timeout: {pasta.name} ({int(duracao)}s)")
                    salvar_ultimo_pedido(pasta.name)
                    finalizados.append(pasta)
                    continue

                erro = f"Timeout no runner apos {PROCESS_TIMEOUT_SECONDS}s.\n\n{read_runner_log(pasta)}"
                (pasta / "erro_runner.txt").write_text(erro, encoding="utf-8", errors="ignore")

                try:
                    (pasta / "status.txt").write_text("em_analise", encoding="utf-8")

                    pedido_path = pasta / "pedido.json"
                    if pedido_path.exists():
                        pedido = json.loads(pedido_path.read_text(encoding="utf-8"))
                        pedido["status"] = "em_analise"
                        pedido["motivo_erro"] = "timeout_pipeline"
                        pedido["reembolso_pendente"] = True
                        pedido_path.write_text(
                            json.dumps(pedido, ensure_ascii=False, indent=2),
                            encoding="utf-8"
                        )
                except Exception as e:
                    log(f"⚠️ Não consegui marcar pedido em análise: {e}")

                avisar_erro_pedido_api(pasta, "timeout_pipeline")
                log(f"❌ Timeout: {pasta.name}")
                finalizados.append(pasta)
                continue

            if proc.poll() is not None:
                close_log_file(info)
                saida = read_runner_log(pasta)

                lock = pasta / "processando.lock"
                if lock.exists():
                    lock.unlink()

                if proc.returncode == 0:
                    duracao = time.time() - inicio
                    registrar_tempo_pedido(duracao)
                    log(f"✅ Finalizado: {pasta.name} ({int(duracao)}s)")
                    salvar_ultimo_pedido(pasta.name)
                else:
                    erro = f"Erro no runner. Código: {proc.returncode}\n\n{saida}"
                    (pasta / "erro_runner.txt").write_text(erro, encoding="utf-8", errors="ignore")

                    try:
                        (pasta / "status.txt").write_text("em_analise", encoding="utf-8")

                        pedido_path = pasta / "pedido.json"
                        if pedido_path.exists():
                            pedido = json.loads(pedido_path.read_text(encoding="utf-8"))
                            pedido["status"] = "em_analise"
                            pedido["motivo_erro"] = "erro_pipeline"
                            pedido["reembolso_pendente"] = True
                            pedido_path.write_text(
                                json.dumps(pedido, ensure_ascii=False, indent=2),
                                encoding="utf-8"
                            )
                    except Exception as e:
                        log(f"⚠️ Não consegui marcar pedido em análise: {e}")

                    avisar_erro_pedido_api(pasta, "erro_pipeline")
                    log(f"❌ Erro: {pasta.name}")

                finalizados.append(pasta)

        for pasta in finalizados:
            ativos.pop(pasta, None)

        vagas = MAX_PROCESSOS - len(ativos)

        if vagas > 0:
            baixar_pedidos_novos_api()
            pendentes = pegar_pendentes()

            for pasta in pendentes[:vagas]:
                if pasta in ativos:
                    continue

                proc, log_file = iniciar_pedido(pasta)
                if proc is None:
                    continue

                ativos[pasta] = {
                    "proc": proc,
                    "inicio": time.time(),
                    "log_file": log_file
                }

        if time.time() - last_recovery_scan >= RECOVERY_SCAN_INTERVAL_SECONDS:
            recover_stale_finished_orders()
            last_recovery_scan = time.time()

        qtd_total_fila = len(ativos) + len(pegar_pendentes())
        enviar_tempo_est_api(calcular_tempo_estimado(qtd_total_fila))

        time.sleep(INTERVALO_SEGUNDOS)

if __name__ == "__main__":
    main()











