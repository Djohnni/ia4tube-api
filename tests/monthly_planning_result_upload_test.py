import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import resultado_pipeline_planejamento_mensal as pipeline
import runner_artes_planejamento_mensal as runner


class MonthlyPlanningResultUploadTest(unittest.TestCase):
    def test_ready_video_uses_the_existing_order_handoff_without_image_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            order = Path(tmp)
            (order / "pedido.json").write_text(json.dumps({"id": "order-1"}), encoding="utf-8")
            video = order / "resultado_final.mp4"
            video.write_bytes(b"test media bytes")
            with patch.object(sys, "argv", ["pipeline", str(order)]), patch.object(
                pipeline, "upload_resultado_planejamento"
            ) as upload, patch.object(pipeline, "render_via_chatgpt_api") as render, patch.object(
                pipeline, "gerar_descricao_planejamento", return_value="Legenda do planejamento"
            ) as caption:
                upload.side_effect = lambda *args: self.assertEqual(
                    "Legenda do planejamento",
                    json.loads((order / "pedido.json").read_text(encoding="utf-8"))["descricao_instagram"],
                )
                pipeline.main()
            upload.assert_called_once_with(order, "order-1", video, order / "preview_ia4tube.jpg")
            render.assert_not_called()
            caption.assert_called_once()
            self.assertEqual(
                "Legenda do planejamento",
                json.loads((order / "pedido.json").read_text(encoding="utf-8"))["descricao_instagram"],
            )
            self.assertEqual("pronto", (order / "status.txt").read_text(encoding="utf-8"))
            self.assertEqual("OK", (order / "processado_handoff.txt").read_text(encoding="utf-8"))

    def test_ready_video_preserves_existing_caption_without_regenerating_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            order = Path(tmp)
            (order / "pedido.json").write_text(
                json.dumps({"id": "order-1", "descricao_instagram": "Legenda aprovada\n#ia4tube"}), encoding="utf-8"
            )
            (order / "resultado_final.mp4").write_bytes(b"test media bytes")
            with patch.object(sys, "argv", ["pipeline", str(order)]), patch.object(
                pipeline, "upload_resultado_planejamento"
            ) as upload, patch.object(pipeline, "gerar_descricao_planejamento") as caption:
                pipeline.main()
            caption.assert_not_called()
            upload.assert_called_once()
            self.assertEqual(
                "Legenda aprovada\n#ia4tube",
                json.loads((order / "pedido.json").read_text(encoding="utf-8"))["descricao_instagram"],
            )

    def test_unsupported_result_is_not_uploaded(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = Path(tmp) / "resultado_final.mov"
            result.write_bytes(b"test media bytes")
            with patch.object(pipeline.requests, "post") as post:
                with self.assertRaises(ValueError):
                    pipeline.upload_resultado_planejamento(Path(tmp), "order-1", result)
                post.assert_not_called()

    def test_same_upload_route_accepts_image_and_ready_video(self):
        with tempfile.TemporaryDirectory() as tmp:
            order = Path(tmp)
            (order / "pedido.json").write_text(
                json.dumps({"descricao_instagram": "Legenda mantida"}), encoding="utf-8"
            )
            for suffix, expected_mime in ((".png", "image/png"), (".mp4", "video/mp4")):
                result = order / f"resultado_final{suffix}"
                result.write_bytes(b"test media bytes")
                with patch.object(pipeline, "load_bot_token", return_value="test-token"), patch.object(
                    pipeline.requests, "post"
                ) as post:
                    post.return_value.status_code = 200
                    pipeline.upload_resultado_planejamento(order, "order-1", result)
                args, kwargs = post.call_args
                self.assertTrue(args[0].endswith("/artes/order-1/upload-resultado"))
                self.assertEqual((result.name, expected_mime), (kwargs["files"]["resultado"][0], kwargs["files"]["resultado"][2]))
                self.assertEqual("Legenda mantida", kwargs["data"]["descricao_instagram"])

    def test_runner_does_not_recreate_an_existing_video_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            order = Path(tmp)
            (order / "pedido.json").write_text("{}", encoding="utf-8")
            (order / "resultado_final.mp4").write_bytes(b"video")
            with patch.object(runner, "is_monthly_planning_order", return_value=True):
                self.assertTrue(runner.arte_pendente(order))
                (order / "processado_handoff.txt").write_text("OK", encoding="utf-8")
                self.assertFalse(runner.arte_pendente(order))


if __name__ == "__main__":
    unittest.main()
