"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const orderService = require("../src/orders/order.service");

test("ramo persisted from client input is bounded and contains no control characters", () => {
  const ramo = `Padaria\u0000\n${"<img src=x onerror=alert(1)>".repeat(20)}`;
  const normalized = orderService.normalizeOrderBody({ ramo });

  assert.ok(normalized.ramo.length <= 120);
  assert.doesNotMatch(normalized.ramo, /[\u0000-\u001f\u007f]/);
});

test("free-art admin panel renders server-controlled values without HTML injection sinks", () => {
  const panel = fs.readFileSync(
    path.resolve(__dirname, "..", "admin", "free_art_campaigns.html"),
    "utf8"
  );

  assert.doesNotMatch(panel, /\.innerHTML\s*=/);
  assert.match(panel, /title\.textContent\s*=/);
  assert.match(panel, /artId\.textContent\s*=/);
  assert.match(panel, /encodeURIComponent\(campaign\.id\)/);
  assert.match(panel, /encodeURIComponent\(art\.id\)/);

  const inlineScript = panel.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new Function(inlineScript[1]));
});
