"""Synthetic, network-free checks. Never loads a real key or submits an order."""
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock

import editorial_niche as niche
import nicho_knowledge_local as legacy
import resultado_pipeline_planejamento_mensal as monthly
import resultado_pipeline_ia4tube as single


class EditorialNicheTest(unittest.TestCase):
    def setUp(self):
        self.order = {"ramo": "Núcleo Editorial 01", "nome_empresa": "IA4Tube",
                      "objetivo": "Apresentar o serviço", "texto_obrigatorio_imagem": "Você cuida do negócio"}
        self.network = patch("socket.socket.connect", side_effect=AssertionError("Network forbidden in synthetic test"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def test_only_explicit_opt_in_and_no_reads_for_other_niches(self):
        with patch.object(niche, "_read", side_effect=AssertionError("No files for other niches")):
            for value in ("marketing", "Agência Digital", "IA4Tube", "", "Núcleo Editorial 02"):
                self.assertEqual("", niche.editorial_context({"ramo": value}))
                self.assertIsNone(niche.editorial_strategies(value))
        self.assertTrue(niche.is_editorial_order(self.order))
        self.assertTrue(niche.is_editorial_order({"legacy": {"fields": {"ramo": "nucleo_editorial_01"}}}))
        self.assertFalse(niche.is_editorial_order({"ramo": "Padaria", "legacy": self.order}))

    def test_complete_context_budget_and_compact_loader(self):
        for purpose in ("art", "caption"):
            context = niche.editorial_context(self.order, purpose)
            self.assertLessEqual(len(context), 9000)
            self.assertIn("conta profissional conectada", context)
            self.assertIn("visão futura", context.lower())
            self.assertIn("IA4Tube", context)
        self.assertEqual(niche.NICHE_ID, legacy.resolve_local_nicho_id(self.order["ramo"]))
        compact = legacy.build_local_niche_knowledge_for_order(self.order)["context"]
        self.assertLessEqual(len(compact), 1800)
        self.assertIn("Não inventar preços", compact)

    def test_twelve_distinct_strategies(self):
        strategies = niche.editorial_strategies(self.order["ramo"])
        self.assertEqual(12, len(strategies))
        self.assertEqual(12, len({theme for theme, _ in strategies}))
        self.assertTrue(all(objective for _, objective in strategies))

    def test_monthly_image_prompt_uses_context_preserves_briefing_and_logo(self):
        order = dict(self.order, assets={"logo": "logo.png"})
        prompt = monthly.build_prompt(order, [Path("logo.png")])
        self.assertIn("DIRECAO EDITORIAL INTERNA", prompt)
        self.assertIn("Você cuida do negócio", prompt)
        self.assertIn("LOGO FORNECIDA - PRESENCA VISUAL OBRIGATORIA", prompt)
        self.assertIn("Não vender o produto fotografado", prompt)
        other = monthly.build_prompt({"ramo": "Padaria"}, [])
        self.assertNotIn("DIRECAO EDITORIAL INTERNA", other)
        self.assertNotIn("funcionário digital", other)

    def test_monthly_caption_context_and_model_unchanged(self):
        client = Mock()
        client.responses.create.return_value = SimpleNamespace(output_text="Conheça a IA4Tube.\n#ia4tube")
        with patch.object(monthly, "load_api_key", return_value="synthetic-not-a-key"), patch.object(monthly, "OpenAI", return_value=client):
            result = monthly.gerar_descricao_planejamento(self.order)
        self.assertIn("Conheça", result)
        args = client.responses.create.call_args.kwargs
        self.assertEqual("gpt-5-mini", args["model"])
        self.assertIn("Direção da legenda", args["input"])
        self.assertEqual(1, client.responses.create.call_count)

    def test_caption_failure_and_internal_label_never_become_public_text(self):
        for bad in ("#nucleo_editorial_01", "Núcleo Editorial 01", "NucleoEditorial01", ""):
            result = niche.editorial_caption(self.order, bad)
            self.assertNotIn("nucleoeditorial01", legacy.normalize_nicho_id(result).replace("_", ""))
            self.assertIn("IA4Tube", result)
        with patch.object(monthly, "load_api_key", side_effect=RuntimeError("synthetic provider failure")):
            self.assertEqual(niche.editorial_fallback(self.order), monthly.gerar_descricao_planejamento(self.order))
        self.assertEqual("Padaria", niche.editorial_caption({"ramo": "Padaria"}, "Padaria"))

    def test_single_art_caption_and_fallback_get_same_editorial_rules(self):
        client = Mock()
        client.responses.create.return_value = SimpleNamespace(output_text="Conheça a IA4Tube.\n#ia4tube")
        with patch.object(single, "load_api_key", return_value="synthetic-not-a-key"), patch.object(single, "OpenAI", return_value=client):
            self.assertIn("Conheça", single.gerar_descricao_instagram(self.order, ["Texto sintético"]))
        self.assertIn("Direção da legenda", client.responses.create.call_args.kwargs["input"])
        self.assertEqual(niche.editorial_fallback(self.order), single.gerar_descricao_instagram_fallback(self.order, []))

    def test_missing_context_fails_before_loading_key(self):
        with patch.object(niche, "_read", side_effect=FileNotFoundError("synthetic missing context")), patch.object(monthly, "load_api_key") as key:
            with self.assertRaises(FileNotFoundError):
                monthly.gerar_descricao_planejamento(self.order)
            key.assert_not_called()


if __name__ == "__main__":
    unittest.main()
