import tempfile
import unittest
from pathlib import Path

import resultado_pipeline_planejamento_mensal as pipeline


class MonthlyPlanningPipelineTest(unittest.TestCase):
    def test_discovered_product_reference_ignores_environment_without_losing_product_or_price(self):
        pedido = {
            "tipo_referencia": "produto_descoberto",
            "produto_identificado": "Mouse optico Philips USB",
            "preco": "R$ 19,00",
            "texto_obrigatorio_imagem": "Aproveite hoje",
            "assets": {"fotos": ["foto01.jpg"]},
        }

        prompt = pipeline.build_prompt(pedido, [Path("foto01.jpg")])

        self.assertIn("Produto identificado: Mouse optico Philips USB", prompt)
        self.assertIn("Preco do produto: R$ 19,00", prompt)
        self.assertIn("Texto que deve aparecer na imagem: Aproveite hoje", prompt)
        self.assertIn("Preserve fielmente o produto principal", prompt)
        self.assertIn("Ignore fundo, prateleira, cabos e objetos vizinhos", prompt)
        self.assertIn("Nao copie a composicao original do ambiente", prompt)
        self.assertNotIn("Preserve produto, ambiente, pessoa, cor e contexto da foto", prompt)

    def test_manual_or_legacy_reference_preserves_previous_photo_behavior(self):
        pedido = {"assets": {"fotos": ["foto01.jpg"]}}

        prompt = pipeline.build_prompt(pedido, [Path("foto01.jpg")])

        self.assertIn("Tipo da referencia: foto_manual", prompt)
        self.assertIn("A imagem enviada manda na composicao visual", prompt)
        self.assertIn("Preserve produto, ambiente, pessoa, cor e contexto da foto", prompt)
        self.assertNotIn("Nao copie a composicao original do ambiente", prompt)

    def test_more_than_eight_declared_references_fails_without_silent_truncation(self):
        with tempfile.TemporaryDirectory() as tmp:
            pedido_dir = Path(tmp)
            names = []
            for index in range(9):
                name = f"foto{index + 1:02d}.jpg"
                (pedido_dir / name).write_bytes(b"image")
                names.append(name)
            pedido = {"assets": {"fotos": names}}

            with self.assertRaisesRegex(ValueError, "9 referencias obrigatorias"):
                pipeline.collect_monthly_reference_images(pedido_dir, pedido)


if __name__ == "__main__":
    unittest.main()
