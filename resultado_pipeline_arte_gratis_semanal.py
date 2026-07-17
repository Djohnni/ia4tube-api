import json
import os
import sys
from pathlib import Path


BASE_DIR = Path(os.environ.get("IA4TUBE_BASE_DIR", Path(__file__).resolve().parent))
PROMPT_FILE = BASE_DIR / "prompt_arte_gratis_semanal.txt"
OUTPUT_NAME = "resultado_final.png"


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return {}


def render_prompt(order):
    template = PROMPT_FILE.read_text(encoding="utf-8", errors="ignore")
    return template.format(
        ramo=str(order.get("ramo") or "").strip(),
        direcao=str(order.get("opcao_rapida") or "faca algo criativo").strip(),
        prompt_livre=str(order.get("prompt_livre") or "").strip(),
    )


def main():
    if len(sys.argv) < 2:
        print("Uso: python resultado_pipeline_arte_gratis_semanal.py <pasta_arte>", file=sys.stderr)
        return 2

    art_dir = Path(sys.argv[1]).resolve()
    art_dir.mkdir(parents=True, exist_ok=True)
    order = read_json(art_dir / "arte.json")
    prompt = render_prompt(order)
    (art_dir / "prompt_final.txt").write_text(prompt, encoding="utf-8")
    output_path = art_dir / OUTPUT_NAME

    try:
      from resultado_pipeline_ia4tube import render_via_chatgpt_api
      render_via_chatgpt_api(output_path, prompt, [], allow_prompt_only=True)
    except Exception as exc:
      (art_dir / "erro_pipeline.txt").write_text(str(exc), encoding="utf-8", errors="replace")
      print(f"Falha ao gerar arte gratis semanal: {exc}", file=sys.stderr)
      return 1

    descricao = (
        "Arte gratis da semana para divulgar seu negocio com mais presenca nas redes.\n"
        "#IA4Tube #ArteComIA"
    )
    (art_dir / "descricao_instagram.txt").write_text(descricao, encoding="utf-8")
    print(str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
