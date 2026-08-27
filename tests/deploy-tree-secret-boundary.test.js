"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  })
    .split("\0")
    .filter(Boolean)
    .filter((relativePath) => fs.existsSync(path.join(ROOT, relativePath)));
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("deploy tree does not track local credentials or O Mascote bot scripts", () => {
  const tracked = trackedFiles();
  const forbiddenBasenames = new Set([
    "credenciais.txt",
    "analytics_config.json",
    "analytics-config.json",
    "bot_token.txt",
    "openai_key.txt",
    "omascote-bot.ahk",
    "omascote-bot - Copia.ahk"
  ]);

  for (const relativePath of tracked) {
    assert.equal(
      forbiddenBasenames.has(path.basename(relativePath).toLowerCase()),
      false,
      `${relativePath} must not be tracked`
    );
  }
});

test("IA4Tube runtime does not call the O Mascote API or require desktop bots", () => {
  const runtimeFiles = trackedFiles().filter(
    (relativePath) =>
      relativePath === "package.json" ||
      relativePath === "server.js" ||
      relativePath.startsWith("src/") ||
      relativePath.startsWith("scripts/")
  );

  for (const relativePath of runtimeFiles) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /api\.omascote\.com\.br/i, relativePath);
    assert.doesNotMatch(source, /credenciais\.txt/i, relativePath);
    assert.doesNotMatch(source, /omascote-bot(?: - Copia)?\.ahk/i, relativePath);
  }
});

test("tracked AHK files contain no hardcoded credential assignments", () => {
  const credentialAssignment = /^\s*(?:WHATSAPP|SENHA|PASSWORD|PASSWD|TOKEN|API_KEY|SECRET)\s*:=\s*"\s*[^"\s][^"]*"/gim;

  for (const relativePath of trackedFiles().filter((file) => file.toLowerCase().endsWith(".ahk"))) {
    assert.doesNotMatch(read(relativePath), credentialAssignment, relativePath);
  }
});

test("credential examples are explicit placeholders only", () => {
  assert.deepEqual(
    read("credenciais.example.txt").trim().split(/\r?\n/),
    ["SEU_WHATSAPP", "SUA_SENHA"]
  );

  const analyticsExample = JSON.parse(read("analytics_config.example.json"));
  assert.equal(new URL(analyticsExample.online.api_url).hostname.endsWith(".invalid"), true);
  assert.equal(analyticsExample.online.token, "");
});
