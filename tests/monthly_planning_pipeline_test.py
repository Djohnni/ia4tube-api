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

    def test_provided_logo_is_mandatory_for_discovered_product_without_losing_product_focus(self):
        pedido = {
            "tipo_referencia": "produto_descoberto",
            "produto_identificado": "Mouse optico Philips USB",
            "assets": {"fotos": ["foto01.jpg"], "logo": "logo.png"},
        }

        prompt = pipeline.build_prompt(pedido, [Path("foto01.jpg"), Path("logo.png")])

        self.assertIn("LOGO FORNECIDA - PRESENCA VISUAL OBRIGATORIA", prompt)
        self.assertIn("A imagem final DEVE mostrar essa mesma logo", prompt)
        self.assertIn("claramente visivel e legivel", prompt)
        self.assertIn("Preserve fielmente desenho, simbolo, texto, proporcoes, cores", prompt)
        self.assertIn("Nao use a logo apenas como inspiracao", prompt)
        self.assertIn("Nao omita, oculte, substitua, redesenhe, estilize, deforme, recorte nem invente outra logo", prompt)
        self.assertIn("Nao deixe a logo pequena demais para leitura", prompt)
        self.assertIn("nem parcialmente fora dos limites da arte", prompt)
        self.assertIn("o produto ou servico continua sendo o foco principal da arte", prompt)
        self.assertNotIn("incluindo logo, apenas como apoio", prompt)

    def test_provided_logo_has_same_mandatory_contract_for_manual_photo(self):
        pedido = {
            "assets": {"fotos": ["foto01.jpg"], "logo": "logo.png"},
        }

        prompt = pipeline.build_prompt(pedido, [Path("foto01.jpg"), Path("logo.png")])

        self.assertIn("Tipo da referencia: foto_manual", prompt)
        self.assertIn("A imagem enviada manda na composicao visual", prompt)
        self.assertIn("LOGO FORNECIDA - PRESENCA VISUAL OBRIGATORIA", prompt)
        self.assertIn("A imagem final DEVE mostrar essa mesma logo", prompt)

    def test_order_without_logo_does_not_invent_or_reserve_logo_space(self):
        pedido = {"assets": {"fotos": ["foto01.jpg"], "logo": ""}}

        prompt = pipeline.build_prompt(pedido, [Path("foto01.jpg")])

        self.assertIn("Nenhuma logo valida foi fornecida neste pedido", prompt)
        self.assertIn("Nao invente logo, marca ou simbolo", prompt)
        self.assertIn("nao reserve espaco vazio para uma logo inexistente", prompt)
        self.assertNotIn("LOGO FORNECIDA - PRESENCA VISUAL OBRIGATORIA", prompt)

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
