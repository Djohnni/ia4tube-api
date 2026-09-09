"""Synthetic only: no real credential, image API call, upload or order."""
import ast
import unittest
from pathlib import Path
from instagram_layout import layout_for, composition_instructions, MASTER_SIZE


class InstagramLayoutTest(unittest.TestCase):
    def test_legacy_is_not_reformatted(self):
        self.assertFalse(layout_for({}))
        self.assertEqual("", composition_instructions({"instagram_layout": "safe_master_v1"}))

    def test_exact_master_and_no_content_crop(self):
        self.assertEqual("1152x1440", MASTER_SIZE)
        prompt = composition_instructions({"planejamento_mensal": {"instagram_layout": "safe_master_v1"}})
        for marker in ("arte inteira", "NAO havera recorte", "92 pixels", "sem barras", "Nao duplique", "Story nao tem"):
            self.assertIn(marker, prompt)

    def test_generation_and_edit_share_bounded_size_without_changing_model_or_number(self):
        tree = ast.parse(Path("resultado_pipeline_ia4tube.py").read_text(encoding="utf-8-sig"))
        render = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "render_via_chatgpt_api")
        calls = [node for node in ast.walk(render) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("generate", "edit")]
        self.assertEqual(2, len(calls))
        for call in calls:
            args = {kw.arg: kw.value for kw in call.keywords}
            self.assertEqual("render_size", args["size"].id)
            self.assertEqual("MODEL", args["model"].id)
            self.assertEqual("N", args["n"].id)

    def test_monthly_pipeline_adds_layout_once_without_second_generation(self):
        tree = ast.parse(Path("resultado_pipeline_planejamento_mensal.py").read_text(encoding="utf-8-sig"))
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "main")
        calls = [node for node in ast.walk(main) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "render_via_chatgpt_api"]
        self.assertEqual(1, len(calls))
        self.assertIn("size_override", [kw.arg for kw in calls[0].keywords])


if __name__ == "__main__":
    unittest.main()
