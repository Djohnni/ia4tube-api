import argparse
from pathlib import Path

from PIL import Image


def compose(base_image_path, logo_path, output_path):
    base = Image.open(base_image_path).convert("RGBA")
    logo = Image.open(logo_path).convert("RGBA")

    max_width = int(base.width * 0.22)
    max_height = int(base.height * 0.12)
    logo.thumbnail((max_width, max_height), Image.LANCZOS)

    margin = int(min(base.width, base.height) * 0.045)
    x = base.width - logo.width - margin
    y = base.height - logo.height - margin

    composed = base.copy()
    composed.alpha_composite(logo, (x, y))

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    composed.convert("RGB").save(output, "PNG")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--logo", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    compose(args.base, args.logo, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
