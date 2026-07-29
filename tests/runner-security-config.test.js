"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const RUNNER_FILES = [
  "resultado_pipeline.py",
  "resultado_pipeline_ia4tube.py",
  "resultado_pipeline_planejamento_mensal.py",
  "runner_artes_gratis_semanais.py",
  "runner_artes_planejamento_mensal.py",
  "runner_ia4tube.py"
];

test("runners exigem API explicita e nao leem segredo de arquivo", () => {
  for (const relativePath of RUNNER_FILES) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    assert.match(source, /IA4TUBE_API_BASE/);
    assert.match(source, /startswith\("https:\/\/"\)/);
    assert.doesNotMatch(source, /ia4tube-api\.onrender\.com/i);
    assert.doesNotMatch(source, /api\.ia4tube\.com\.br/i);
    assert.doesNotMatch(source, /bot_token\.txt/i);
    assert.doesNotMatch(source, /BOT_TOKEN_FILE/);
  }
});
