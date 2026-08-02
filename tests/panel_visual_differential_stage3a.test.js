'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PANEL = path.join(ROOT, 'painel_ia4tube.ahk');
const BASELINE_COMMIT = 'd24034c24f5e925d0c96b90cc9fa1bdef1df1a37';

const VISUAL_HELPERS = [
  'ChaveCacheVisual',
  'RegistrarResultadoVisual',
  'AplicarTextoVisualSeMudou',
  'AplicarCorVisualSeMudou',
  'AplicarFonteVisualSeMudou',
  'InvalidarCacheVisual',
];

const PROHIBITED_FUNCTIONS = [
  'ColetarStatsPlanejamentoMensal',
  'ArquivoPlanejamentoHoje',
  'ObterUltimoPlanejamento',
  'ObterUltimaAnalisePlanejamento',
  'LerStatusPlanejamento',
  'LerCampoJsonSimples',
  'AbrirDetalhes',
  'GetProgramStatus',
  'IsBotAtivo',
  'IsRunnerAtivo',
  'FecharBot',
  'FecharTudo',
  'ApiGet',
  'ApiPostJson',
];

function readCandidate() {
  return fs.readFileSync(PANEL, 'utf8');
}

function readBaseline() {
  return execFileSync(
    'git',
    ['show', `${BASELINE_COMMIT}:painel_ia4tube.ahk`],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true },
  );
}

function findMatching(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let inComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inComment) {
      if (char === '\n') inComment = false;
      continue;
    }

    if (inString) {
      if (char === '"' && next === '"') {
        index += 1;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === ';') {
      inComment = true;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new Error(`Unbalanced ${openChar}${closeChar} block at offset ${openIndex}`);
}

function extractFunction(source, name) {
  const expression = new RegExp(`^${name}\\s*\\([^\\n]*\\)\\s*\\{`, 'm');
  const match = expression.exec(source);
  assert.ok(match, `Function ${name} must exist`);
  const openBrace = source.indexOf('{', match.index);
  const closeBrace = findMatching(source, openBrace, '{', '}');
  return source.slice(match.index, closeBrace + 1);
}

function splitTopLevelArguments(text) {
  const parts = [];
  let start = 0;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let inString = false;
  let inComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inComment) {
      if (char === '\n') inComment = false;
      continue;
    }
    if (inString) {
      if (char === '"' && next === '"') {
        index += 1;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === ';') inComment = true;
    else if (char === '"') inString = true;
    else if (char === '(') parens += 1;
    else if (char === ')') parens -= 1;
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets -= 1;
    else if (char === '{') braces += 1;
    else if (char === '}') braces -= 1;
    else if (char === ',' && parens === 0 && brackets === 0 && braces === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(text.slice(start).trim());
  return parts;
}

function replaceCalls(source, functionName, replacement) {
  const marker = `${functionName}(`;
  let result = '';
  let cursor = 0;

  while (true) {
    const start = source.indexOf(marker, cursor);
    if (start === -1) {
      result += source.slice(cursor);
      return result;
    }

    result += source.slice(cursor, start);
    const openParen = start + functionName.length;
    const closeParen = findMatching(source, openParen, '(', ')');
    const args = splitTopLevelArguments(source.slice(openParen + 1, closeParen));
    result += replacement(args);
    cursor = closeParen + 1;
  }
}

function reverseDifferentialVisualCalls(source) {
  let normalized = replaceCalls(source, 'AplicarTextoVisualSeMudou', (args) => {
    assert.equal(args.length, 3, 'Text helper arity changed');
    assert.equal(args[0], 'GuiPainel', 'Text helper must target GuiPainel');
    return `${args[1]}.Text := ${args[2]}`;
  });

  normalized = replaceCalls(normalized, 'AplicarCorVisualSeMudou', (args) => {
    assert.equal(args.length, 3, 'Color helper arity changed');
    assert.equal(args[0], 'GuiPainel', 'Color helper must target GuiPainel');
    return `${args[1]}.SetFont(${args[2]})`;
  });

  normalized = normalized.replace(/^\s*RegistrarCicloVisual\(\)\s*$/gm, '');
  normalized = normalized.replace(/^\s*InvalidarCacheVisual\(GuiPainel\)\s*$/gm, '');
  normalized = normalized.replace(/^\s*global[^\r\n]*$/gm, '');
  return normalized;
}

function canonicalAhk(source) {
  let result = '';
  let inString = false;
  let inComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inComment) {
      if (char === '\n') inComment = false;
      continue;
    }
    if (inString) {
      result += char;
      if (char === '"' && next === '"') {
        result += next;
        index += 1;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === ';') inComment = true;
    else if (char === '"') {
      inString = true;
      result += char;
    } else if (!/\s/.test(char)) {
      result += char;
    }
  }

  return result;
}

function visualSetterCount(source) {
  return {
    text: (source.match(/\.[A-Za-z_][A-Za-z0-9_]*\s*:=/g) || [])
      .filter((item) => item.startsWith('.Text')).length,
    colorOrFont: (source.match(/\.SetFont\s*\(/g) || []).length,
  };
}

function collectTimerStatements(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => /\bSetTimer\s*\(/.test(line))
    .map((line) => canonicalAhk(line));
}

function locateAutoHotkey() {
  const candidates = [
    process.env.AUTOHOTKEY_V2,
    'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe',
    'C:\\Program Files\\AutoHotkey\\AutoHotkey.exe',
  ].filter(Boolean);

  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(executable, 'AutoHotkey v2 executable is required for the concrete helper harness');
  return executable;
}

function buildConcreteHarness(candidate) {
  const helpers = VISUAL_HELPERS
    .map((name) => extractFunction(candidate, name))
    .join('\n\n');

  return `#Requires AutoHotkey v2.0
#SingleInstance Off

g_cacheVisual := Map()
g_metricasVisuais := Map(
    "ciclos", 0,
    "textoAplicado", 0,
    "corAplicada", 0,
    "fonteAplicada", 0,
    "textoEvitado", 0,
    "corEvitada", 0,
    "fonteEvitada", 0,
    "invalidacoes", 0
)

${helpers}

class FakeGui {
    __New(hwnd) {
        this.Hwnd := hwnd
    }
}

class FakeControl {
    __New(hwnd) {
        this.Hwnd := hwnd
        this._text := ""
        this._color := ""
        this._fontOptions := ""
        this._fontName := ""
        this.textSets := 0
        this.colorSets := 0
        this.fontSets := 0
    }

    Text {
        get => this._text
        set {
            this._text := value
            this.textSets += 1
        }
    }

    SetFont(options, name := "") {
        if RegExMatch(options, "i)^c[0-9a-f]{6}$") {
            this._color := options
            this.colorSets += 1
        } else {
            this._fontOptions := options
            this._fontName := name
            this.fontSets += 1
        }
    }
}

ResetVisualState() {
    global g_cacheVisual, g_metricasVisuais
    g_cacheVisual := Map()
    g_metricasVisuais := Map(
        "ciclos", 0,
        "textoAplicado", 0,
        "corAplicada", 0,
        "fonteAplicada", 0,
        "textoEvitado", 0,
        "corEvitada", 0,
        "fonteEvitada", 0,
        "invalidacoes", 0
    )
}

AssertTrue(condition, message) {
    if !condition
        throw Error(message)
}

AssertEqual(actual, expected, message) {
    if (actual != expected)
        throw Error(message " expected=" expected " actual=" actual)
}

Pass(name) {
    FileAppend("PASS|" name Chr(10), "*")
}

SimularAlerta(gui, alertControl, alert, &lastAlert, &soundCount) {
    if (alert != "") {
        AplicarTextoVisualSeMudou(gui, alertControl, "Alerta: " alert)
        AplicarCorVisualSeMudou(gui, alertControl, "cFF6666")
        if (alert != lastAlert) {
            soundCount += 1
            lastAlert := alert
        }
    } else {
        AplicarTextoVisualSeMudou(gui, alertControl, "Alerta: tudo ok")
        AplicarCorVisualSeMudou(gui, alertControl, "c66FF99")
        lastAlert := ""
    }
}

ScenarioFirstRender() {
    global g_metricasVisuais
    ResetVisualState()
    gui := FakeGui(100)
    control := FakeControl(200)
    AssertTrue(AplicarTextoVisualSeMudou(gui, control, "normal"), "first text not applied")
    AssertTrue(AplicarCorVisualSeMudou(gui, control, "c66FF99"), "first color not applied")
    AssertTrue(AplicarFonteVisualSeMudou(gui, control, "s10 w600", "Segoe UI"), "first font not applied")
    AssertEqual(control.Text, "normal", "first text")
    AssertEqual(control._color, "c66FF99", "first color")
    AssertEqual(control._fontOptions, "s10 w600", "first font options")
    AssertEqual(control._fontName, "Segoe UI", "first font name")
    AssertEqual(g_metricasVisuais["textoAplicado"], 1, "first text metric")
    AssertEqual(g_metricasVisuais["corAplicada"], 1, "first color metric")
    AssertEqual(g_metricasVisuais["fonteAplicada"], 1, "first font metric")
    Pass("01_primeira_renderizacao")
}

ScenarioStableCycles() {
    global g_metricasVisuais
    ResetVisualState()
    gui := FakeGui(101)
    control := FakeControl(201)
    AplicarTextoVisualSeMudou(gui, control, "normal")
    AplicarCorVisualSeMudou(gui, control, "c66FF99")
    AplicarFonteVisualSeMudou(gui, control, "s10", "Segoe UI")
    Loop 25 {
        AssertTrue(!AplicarTextoVisualSeMudou(gui, control, "normal"), "stable text reapplied")
        AssertTrue(!AplicarCorVisualSeMudou(gui, control, "c66FF99"), "stable color reapplied")
        AssertTrue(!AplicarFonteVisualSeMudou(gui, control, "s10", "Segoe UI"), "stable font reapplied")
    }
    AssertEqual(control.textSets, 1, "stable text setters")
    AssertEqual(control.colorSets, 1, "stable color setters")
    AssertEqual(control.fontSets, 1, "stable font setters")
    AssertEqual(g_metricasVisuais["textoEvitado"], 25, "stable text avoided")
    AssertEqual(g_metricasVisuais["corEvitada"], 25, "stable color avoided")
    AssertEqual(g_metricasVisuais["fonteEvitada"], 25, "stable font avoided")
    Pass("02_ciclos_estaveis")
}

ScenarioTextOnly() {
    ResetVisualState()
    gui := FakeGui(102)
    control := FakeControl(202)
    AplicarTextoVisualSeMudou(gui, control, "A")
    AplicarCorVisualSeMudou(gui, control, "cFFFFFF")
    AplicarFonteVisualSeMudou(gui, control, "s8", "Segoe UI")
    AssertTrue(AplicarTextoVisualSeMudou(gui, control, "B"), "text change lost")
    AssertTrue(!AplicarCorVisualSeMudou(gui, control, "cFFFFFF"), "color changed with text")
    AssertTrue(!AplicarFonteVisualSeMudou(gui, control, "s8", "Segoe UI"), "font changed with text")
    AssertEqual(control.textSets, 2, "text-only text setters")
    AssertEqual(control.colorSets, 1, "text-only color setters")
    AssertEqual(control.fontSets, 1, "text-only font setters")
    AssertEqual(control.Text, "B", "text-only same-cycle result")
    Pass("03_mudanca_somente_texto")
}

ScenarioColorOnly() {
    ResetVisualState()
    gui := FakeGui(103)
    control := FakeControl(203)
    AplicarTextoVisualSeMudou(gui, control, "Alerta")
    AplicarCorVisualSeMudou(gui, control, "c66FF99")
    AssertTrue(!AplicarTextoVisualSeMudou(gui, control, "Alerta"), "same text reapplied on color change")
    AssertTrue(AplicarCorVisualSeMudou(gui, control, "cFF6666"), "color change lost")
    AssertEqual(control.textSets, 1, "color-only text setters")
    AssertEqual(control.colorSets, 2, "color-only color setters")
    AssertEqual(control._color, "cFF6666", "color-only same-cycle result")
    Pass("04_mudanca_somente_cor")
}

ScenarioFontOnly() {
    ResetVisualState()
    gui := FakeGui(104)
    control := FakeControl(204)
    AplicarTextoVisualSeMudou(gui, control, "IA4Tube")
    AplicarFonteVisualSeMudou(gui, control, "s8", "Segoe UI")
    AssertTrue(!AplicarTextoVisualSeMudou(gui, control, "IA4Tube"), "same text reapplied on font change")
    AssertTrue(AplicarFonteVisualSeMudou(gui, control, "s9 w600", "Segoe UI"), "font change lost")
    AssertEqual(control.textSets, 1, "font-only text setters")
    AssertEqual(control.fontSets, 2, "font-only font setters")
    AssertEqual(control._fontOptions, "s9 w600", "font-only same-cycle result")
    Pass("05_mudanca_somente_fonte")
}

ScenarioSameTextDifferentColor() {
    ResetVisualState()
    gui := FakeGui(105)
    control := FakeControl(205)
    AplicarTextoVisualSeMudou(gui, control, "Suporte: 1")
    AplicarCorVisualSeMudou(gui, control, "cFFD166")
    AplicarTextoVisualSeMudou(gui, control, "Suporte: 1")
    AplicarCorVisualSeMudou(gui, control, "cFF3333")
    AssertEqual(control.textSets, 1, "same-text text setters")
    AssertEqual(control.colorSets, 2, "same-text color setters")
    AssertEqual(control._color, "cFF3333", "same-text final color")
    Pass("06_texto_igual_cor_diferente")
}

ScenarioErrorsEnterAndLeave() {
    ResetVisualState()
    gui := FakeGui(106)
    title := FakeControl(206)
    line1 := FakeControl(207)
    line2 := FakeControl(208)
    AplicarTextoVisualSeMudou(gui, title, "Erros dos pedidos: 2")
    AplicarCorVisualSeMudou(gui, title, "cFF6666")
    AplicarTextoVisualSeMudou(gui, line1, "1. sintético-1 - erro.txt")
    AplicarTextoVisualSeMudou(gui, line2, "2. sintético-2 - erro.txt")
    AplicarTextoVisualSeMudou(gui, title, "Erros dos pedidos: nenhum")
    AplicarCorVisualSeMudou(gui, title, "c66FF99")
    AplicarTextoVisualSeMudou(gui, line1, "")
    AplicarTextoVisualSeMudou(gui, line2, "")
    AssertEqual(title.Text, "Erros dos pedidos: nenhum", "error title stale")
    AssertEqual(line1.Text, "", "error line 1 stale")
    AssertEqual(line2.Text, "", "error line 2 stale")
    Pass("07_erros_entrada_saida")
}

ScenarioSupportValidInvalid() {
    ResetVisualState()
    gui := FakeGui(107)
    support := FakeControl(209)
    AplicarTextoVisualSeMudou(gui, support, "Suporte: 0")
    AplicarCorVisualSeMudou(gui, support, "c66FF99")
    AplicarTextoVisualSeMudou(gui, support, "Suporte: 0 [indisponível]")
    AplicarCorVisualSeMudou(gui, support, "cFFD166")
    AplicarTextoVisualSeMudou(gui, support, "Suporte: 2")
    AplicarCorVisualSeMudou(gui, support, "cFF3333")
    AssertEqual(support.Text, "Suporte: 2", "support recovery text")
    AssertEqual(support._color, "cFF3333", "support recovery color")
    AssertEqual(support.textSets, 3, "support text transitions")
    AssertEqual(support.colorSets, 3, "support color transitions")
    Pass("08_suporte_valido_invalido")
}

ScenarioAlerts() {
    ResetVisualState()
    gui := FakeGui(108)
    alertControl := FakeControl(210)
    lastAlert := ""
    soundCount := 0

    SimularAlerta(gui, alertControl, "RUNNER PARADO", &lastAlert, &soundCount)
    SimularAlerta(gui, alertControl, "RUNNER PARADO", &lastAlert, &soundCount)
    AssertEqual(soundCount, 1, "alert permanence repeated sound")
    SimularAlerta(gui, alertControl, "", &lastAlert, &soundCount)
    AssertEqual(alertControl.Text, "Alerta: tudo ok", "alert exit text")
    AssertEqual(alertControl._color, "c66FF99", "alert exit color")
    SimularAlerta(gui, alertControl, "RUNNER PARADO", &lastAlert, &soundCount)
    AssertEqual(soundCount, 2, "alert re-entry missing sound")
    Pass("09_alertas_entrada_permanencia_saida")
}

ScenarioMinimizeRestore() {
    global g_metricasVisuais
    ResetVisualState()
    gui := FakeGui(109)
    title := FakeControl(211)
    status := FakeControl(212)
    AplicarTextoVisualSeMudou(gui, title, "IA4Tube")
    AplicarCorVisualSeMudou(gui, title, "cFFFFFF")
    AplicarTextoVisualSeMudou(gui, status, "normal")
    InvalidarCacheVisual(gui)
    AplicarTextoVisualSeMudou(gui, title, "IA4Tube on 0 - 4")
    AplicarCorVisualSeMudou(gui, title, "c66FF99")
    AplicarTextoVisualSeMudou(gui, status, "")
    InvalidarCacheVisual(gui)
    AplicarTextoVisualSeMudou(gui, title, "IA4Tube")
    AplicarCorVisualSeMudou(gui, title, "cFFFFFF")
    AplicarTextoVisualSeMudou(gui, status, "normal")
    AssertEqual(title.Text, "IA4Tube", "restored title")
    AssertEqual(title._color, "cFFFFFF", "restored title color")
    AssertEqual(status.Text, "normal", "restored status")
    AssertEqual(g_metricasVisuais["invalidacoes"], 2, "minimize/restore invalidations")
    Pass("10_minimizar_restaurar")
}

ScenarioRecreation() {
    ResetVisualState()
    gui1 := FakeGui(110)
    control1 := FakeControl(213)
    AplicarTextoVisualSeMudou(gui1, control1, "normal")
    AplicarCorVisualSeMudou(gui1, control1, "c66FF99")
    AplicarFonteVisualSeMudou(gui1, control1, "s8", "Segoe UI")
    gui2 := FakeGui(110)
    control2 := FakeControl(213)
    AssertTrue(AplicarTextoVisualSeMudou(gui2, control2, "normal"), "recreated text not applied")
    AssertTrue(AplicarCorVisualSeMudou(gui2, control2, "c66FF99"), "recreated color not applied")
    AssertTrue(AplicarFonteVisualSeMudou(gui2, control2, "s8", "Segoe UI"), "recreated font not applied")
    AssertEqual(control2.textSets, 1, "recreated text setter")
    AssertEqual(control2.colorSets, 1, "recreated color setter")
    AssertEqual(control2.fontSets, 1, "recreated font setter")
    Pass("11_recriacao_janela_controles")
}

ScenarioSameTextTwoControls() {
    ResetVisualState()
    gui := FakeGui(111)
    first := FakeControl(214)
    second := FakeControl(215)
    AssertTrue(AplicarTextoVisualSeMudou(gui, first, "normal"), "first control not updated")
    AssertTrue(AplicarTextoVisualSeMudou(gui, second, "normal"), "second control not updated")
    AssertEqual(first.textSets, 1, "first same-text control")
    AssertEqual(second.textSets, 1, "second same-text control")
    Pass("12_mesmo_texto_dois_controles")
}

ScenarioRapidCycles() {
    ResetVisualState()
    gui := FakeGui(112)
    first := FakeControl(216)
    second := FakeControl(217)
    expectedFirstText := ""
    expectedFirstColor := ""
    expectedSecondText := ""

    Loop 500 {
        expectedFirstText := Mod(A_Index, 2) ? "A" : "B"
        expectedFirstColor := Mod(A_Index, 3) ? "c66FF99" : "cFF6666"
        expectedSecondText := "ciclo-" A_Index
        AplicarTextoVisualSeMudou(gui, first, expectedFirstText)
        AplicarCorVisualSeMudou(gui, first, expectedFirstColor)
        AplicarTextoVisualSeMudou(gui, second, expectedSecondText)
        AssertEqual(first.Text, expectedFirstText, "rapid first text partial")
        AssertEqual(first._color, expectedFirstColor, "rapid first color partial")
        AssertEqual(second.Text, expectedSecondText, "rapid second text partial")
    }

    AssertEqual(first.Text, "B", "rapid final first text")
    AssertEqual(second.Text, "ciclo-500", "rapid final second text")
    Pass("13_ciclos_rapidos_sem_perda")
}

try {
    ScenarioFirstRender()
    ScenarioStableCycles()
    ScenarioTextOnly()
    ScenarioColorOnly()
    ScenarioFontOnly()
    ScenarioSameTextDifferentColor()
    ScenarioErrorsEnterAndLeave()
    ScenarioSupportValidInvalid()
    ScenarioAlerts()
    ScenarioMinimizeRestore()
    ScenarioRecreation()
    ScenarioSameTextTwoControls()
    ScenarioRapidCycles()
    FileAppend("RESULT|13/13" Chr(10), "*")
    ExitApp(0)
} catch as err {
    safeMessage := StrReplace(StrReplace(err.Message, Chr(13), " "), Chr(10), " ")
    FileAppend("FAIL|line=" err.Line "|what=" err.What "|" safeMessage Chr(10), "*")
    ExitApp(1)
}
`;
}

test('static gate preserves prohibited functions, timers, scan order, and visual operands', () => {
  const baseline = readBaseline();
  const candidate = readCandidate();

  for (const functionName of PROHIBITED_FUNCTIONS) {
    assert.equal(
      canonicalAhk(extractFunction(candidate, functionName)),
      canonicalAhk(extractFunction(baseline, functionName)),
      `${functionName} changed outside the authorized visual scope`,
    );
  }

  assert.deepEqual(
    collectTimerStatements(candidate),
    collectTimerStatements(baseline),
    'A timer declaration or frequency changed',
  );
  assert.equal(
    (candidate.match(/SetTimer\s*\(\s*AtualizarPainel\s*,\s*5000\s*\)/g) || []).length,
    1,
    'The 5-second panel timer must remain exactly once',
  );

  for (const functionName of ['AtualizarPainel', 'RenderizarErrosPainel', 'MinimizarPainel']) {
    const before = extractFunction(baseline, functionName);
    const after = extractFunction(candidate, functionName);
    assert.equal(
      canonicalAhk(reverseDifferentialVisualCalls(after)),
      canonicalAhk(reverseDifferentialVisualCalls(before)),
      `${functionName} changed beyond differential visual calls/invalidation/metrics`,
    );

    assert.doesNotMatch(
      after,
      /\btxt[A-Za-z0-9_]*\.Text\s*:=|\btxt[A-Za-z0-9_]*\.SetFont\s*\(/,
      `${functionName} still contains a direct visual setter`,
    );
  }

  const baselineVisualScope = ['AtualizarPainel', 'RenderizarErrosPainel', 'MinimizarPainel']
    .map((name) => extractFunction(baseline, name))
    .join('\n');
  const candidateVisualScope = ['AtualizarPainel', 'RenderizarErrosPainel', 'MinimizarPainel']
    .map((name) => extractFunction(candidate, name))
    .join('\n');
  const baselineCounts = visualSetterCount(baselineVisualScope);
  const textWrappers = (candidateVisualScope.match(/AplicarTextoVisualSeMudou\s*\(/g) || []).length;
  const colorWrappers = (candidateVisualScope.match(/AplicarCorVisualSeMudou\s*\(/g) || []).length;
  assert.equal(textWrappers, baselineCounts.text, 'Text visual operand count changed');
  assert.equal(colorWrappers, baselineCounts.colorOrFont, 'Color/font visual operand count changed');

  const helperSource = VISUAL_HELPERS.map((name) => extractFunction(candidate, name)).join('\n');
  assert.match(
    extractFunction(candidate, 'ChaveCacheVisual'),
    /ObjPtr\(gui\).*gui\.Hwnd.*ObjPtr\(controle\).*controle\.Hwnd.*propriedade/s,
    'The cache key must bind window object/HWND, control object/HWND, and property',
  );
  assert.doesNotMatch(
    helperSource,
    /\b(?:FileExist|FileRead|FileGetTime|DirGetFiles|ComObjGet|ComObject|WinHttpRequest|ApiGet|ApiPostJson|GetProgramStatus)\b/,
    'A visual helper reads or caches forbidden business/external state',
  );
  assert.match(
    candidate,
    /RegisterWindowMessage[^\r\n]*IA4Tube\.Painel\.MetricasVisuais\.Etapa3A/,
    'Visual metrics must use a uniquely registered Windows message',
  );
  assert.doesNotMatch(
    candidate,
    /WM_METRICAS_VISUAIS\s*:=\s*0x[0-9A-F]+/i,
    'Visual metrics must not reserve a fixed application message id',
  );
  assert.match(
    extractFunction(candidate, 'MinimizarPainel'),
    /InvalidarCacheVisual\s*\(\s*GuiPainel\s*\)/,
    'Minimize/restore must invalidate the window visual cache',
  );

  const alertBefore = extractFunction(baseline, 'AtualizarPainel');
  const alertAfter = reverseDifferentialVisualCalls(extractFunction(candidate, 'AtualizarPainel'));
  assert.equal(
    (alertAfter.match(/SoundBeep\s*\(\s*900\s*,\s*180\s*\)/g) || []).length,
    (alertBefore.match(/SoundBeep\s*\(\s*900\s*,\s*180\s*\)/g) || []).length,
    'Alert sound behavior changed',
  );
});

test('real AutoHotkey helpers pass all 13 isolated visual scenarios', { timeout: 20_000 }, () => {
  const candidate = readCandidate();
  const executable = locateAutoHotkey();
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ia4tube-panel-3a-'));
  const harnessPath = path.join(temporaryDirectory, 'visual-helper-harness.ahk');

  try {
    fs.writeFileSync(harnessPath, buildConcreteHarness(candidate), 'utf8');
    const result = spawnSync(executable, ['/ErrorStdOut', harnessPath], {
      cwd: temporaryDirectory,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });

    assert.equal(result.error, undefined, `AutoHotkey harness failed to start: ${result.error?.message}`);
    assert.equal(result.signal, null, 'AutoHotkey harness timed out');
    assert.equal(
      result.status,
      0,
      `AutoHotkey harness failed (sanitized output): ${(result.stdout + result.stderr).slice(0, 2000)}`,
    );

    const output = result.stdout.replace(/\r/g, '');
    const passes = output.split('\n').filter((line) => line.startsWith('PASS|'));
    assert.equal(passes.length, 13, `Expected 13 concrete scenarios, got ${passes.length}`);
    assert.match(output, /RESULT\|13\/13/, 'Concrete harness did not report complete success');
    assert.doesNotMatch(output, /https?:\/\/|Authorization|Bearer|token|senha|password/i);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

class VisualControlModel {
  constructor(id, geometry, zOrder) {
    this.id = id;
    this.text = '';
    this.color = '';
    this.fontOptions = '';
    this.fontName = '';
    this.geometry = { ...geometry };
    this.visible = true;
    this.zOrder = zOrder;
  }

  snapshot() {
    return {
      id: this.id,
      text: this.text,
      color: this.color,
      fontOptions: this.fontOptions,
      fontName: this.fontName,
      geometry: { ...this.geometry },
      visible: this.visible,
      zOrder: this.zOrder,
    };
  }
}

class VisualEquivalenceRenderer {
  constructor(mode) {
    this.mode = mode;
    this.windowId = `${mode}-window`;
    this.cache = new Map();
    this.controls = new Map();
    this.window = { width: 220, height: 950, visible: true };
    this.lastAlert = '';
    this.soundTrace = [];
    this.cycle = 0;
    this.wasMinimized = false;
    this.counts = {
      text: 0,
      color: 0,
      font: 0,
      textAvoided: 0,
      colorAvoided: 0,
      fontAvoided: 0,
      invalidations: 0,
    };

    const definitions = [
      ['title', { x: 8, y: 4, width: 65, height: 18 }],
      ['status', { x: 76, y: 4, width: 75, height: 18 }],
      ['bot', { x: 10, y: 30, width: 170, height: 18 }],
      ['programs', { x: 10, y: 158, width: 200, height: 18 }],
      ['support', { x: 10, y: 642, width: 200, height: 18 }],
      ['alert', { x: 10, y: 664, width: 200, height: 18 }],
      ['errorTitle', { x: 10, y: 752, width: 200, height: 18 }],
      ['errorLine1', { x: 10, y: 774, width: 200, height: 18 }],
      ['errorLine2', { x: 10, y: 794, width: 200, height: 18 }],
    ];
    definitions.forEach(([id, geometry], index) => {
      this.controls.set(id, new VisualControlModel(id, geometry, index));
    });
  }

  cacheKey(control, property) {
    return `${this.windowId}|${control.id}|${property}`;
  }

  invalidate() {
    if (this.mode !== 'candidate') return;
    this.cache.clear();
    this.counts.invalidations += 1;
  }

  apply(property, controlId, value, applyValue) {
    const control = this.controls.get(controlId);
    const key = this.cacheKey(control, property);
    const counter = property;
    const avoidedCounter = `${property}Avoided`;

    if (this.mode === 'candidate' && this.cache.has(key) && this.cache.get(key) === value) {
      this.counts[avoidedCounter] += 1;
      return false;
    }

    applyValue(control, value);
    this.counts[counter] += 1;
    if (this.mode === 'candidate') this.cache.set(key, value);
    return true;
  }

  text(controlId, value) {
    return this.apply('text', controlId, value, (control, desired) => {
      control.text = desired;
    });
  }

  color(controlId, value) {
    return this.apply('color', controlId, value, (control, desired) => {
      control.color = desired;
    });
  }

  font(controlId, options, name) {
    const value = `${options}|${name}`;
    return this.apply('font', controlId, value, (control) => {
      control.fontOptions = options;
      control.fontName = name;
    });
  }

  render(state) {
    this.cycle += 1;
    if (state.minimized !== this.wasMinimized) this.invalidate();
    this.wasMinimized = state.minimized;

    for (const controlId of this.controls.keys()) {
      this.font(controlId, 's8', 'Segoe UI');
    }

    const title = this.controls.get('title');
    if (state.minimized) {
      title.geometry = { x: 8, y: 4, width: 145, height: 18 };
      this.window.height = 24;
      this.text('title', `IA4Tube ${state.botActive ? 'on' : 'off'} ${state.pending} - ${state.doneToday}`);
      this.color('title', state.alert ? 'cFF6666' : (state.botActive ? 'c66FF99' : 'cFF6666'));
      this.text('status', '');
    } else {
      title.geometry = { x: 8, y: 4, width: 65, height: 18 };
      this.window.height = 950;
      this.text('title', 'IA4Tube');
      this.color('title', 'cFFFFFF');
      if (!state.runnerActive) {
        this.text('status', 'runner parado');
        this.color('status', 'cFF6666');
      } else if (state.errors.length > 0) {
        this.text('status', 'erro');
        this.color('status', 'cFF6666');
      } else if (state.processing > 0) {
        this.text('status', 'processando');
        this.color('status', 'cFFD166');
      } else {
        this.text('status', 'normal');
        this.color('status', 'c66FF99');
      }
    }

    this.text('bot', `Bot: ${state.botActive ? 'aberto' : 'fechado'}`);
    this.color('bot', state.botActive ? 'c66FF99' : 'cFF6666');
    this.text('programs', `Run: ${state.runnerActive ? 'ON' : 'OFF'}  Pipe: ${state.pipelineActive ? 'ON' : 'OFF'}`);
    this.color('programs', state.botActive && state.runnerActive ? 'c66FF99' : 'cFFD166');

    if (state.supportValid) {
      this.text('support', `Suporte: ${state.supportCount}`);
      this.color('support', state.supportCount > 0 ? 'cFF3333' : 'c66FF99');
    } else {
      this.text('support', `Suporte: ${state.supportCount} [${state.supportError}]`);
      this.color('support', 'cFFD166');
    }

    if (state.alert) {
      this.text('alert', `Alerta: ${state.alert}`);
      this.color('alert', 'cFF6666');
      if (state.alert !== this.lastAlert) {
        this.soundTrace.push({ cycle: this.cycle, frequency: 900, duration: 180, alert: state.alert });
        this.lastAlert = state.alert;
      }
    } else {
      this.text('alert', 'Alerta: tudo ok');
      this.color('alert', 'c66FF99');
      this.lastAlert = '';
    }

    this.text('errorTitle', state.errors.length > 0
      ? `Erros dos pedidos: ${state.errors.length}`
      : 'Erros dos pedidos: nenhum');
    this.color('errorTitle', state.errors.length > 0 ? 'cFF6666' : 'c66FF99');
    for (let index = 0; index < 2; index += 1) {
      const item = state.errors[index];
      const id = `errorLine${index + 1}`;
      this.text(id, item ? `${index + 1}. ${item.order} - ${item.file}` : '');
      if (item) this.color(id, 'cFF6666');
    }

    return this.snapshot();
  }

  snapshot() {
    return {
      cycle: this.cycle,
      window: { ...this.window },
      controls: [...this.controls.values()]
        .sort((left, right) => left.zOrder - right.zOrder)
        .map((control) => control.snapshot()),
      soundTrace: this.soundTrace.map((entry) => ({ ...entry })),
    };
  }
}

function equivalenceScenarios() {
  const base = {
    botActive: true,
    runnerActive: true,
    pipelineActive: true,
    pending: 0,
    processing: 0,
    doneToday: 4,
    supportValid: true,
    supportCount: 0,
    supportError: '',
    alert: '',
    errors: [],
    minimized: false,
  };

  return [
    ['normal', { ...base }],
    ['alerta', { ...base, alert: 'PIPELINE PARADO', pipelineActive: false }],
    ['erros', {
      ...base,
      alert: 'ERRO EM PEDIDO',
      errors: [
        { order: 'sintetico-1', file: 'erro-a.txt' },
        { order: 'sintetico-2', file: 'erro-b.txt' },
      ],
    }],
    ['suporte_valido', { ...base, supportCount: 2 }],
    ['suporte_invalido', {
      ...base,
      supportValid: false,
      supportCount: 2,
      supportError: 'indisponivel',
    }],
    ['bot_ativo', { ...base, botActive: true }],
    ['bot_parado', { ...base, botActive: false, alert: 'BOT PARADO' }],
    ['runner_ativo', { ...base, runnerActive: true }],
    ['runner_parado', { ...base, runnerActive: false, alert: 'RUNNER PARADO' }],
    ['minimizar', { ...base, minimized: true }],
    ['restaurar', { ...base, minimized: false }],
  ];
}

test('baseline and candidate are visually equivalent cycle-by-cycle in the required panel states', () => {
  const baselineSource = readBaseline();
  const candidateSource = readCandidate();
  for (const functionName of ['AtualizarPainel', 'RenderizarErrosPainel', 'MinimizarPainel']) {
    assert.equal(
      canonicalAhk(reverseDifferentialVisualCalls(extractFunction(candidateSource, functionName))),
      canonicalAhk(reverseDifferentialVisualCalls(extractFunction(baselineSource, functionName))),
      `${functionName} must be semantically identical before scenario equivalence is meaningful`,
    );
  }

  const baseline = new VisualEquivalenceRenderer('baseline');
  const candidate = new VisualEquivalenceRenderer('candidate');
  const scenarioResults = [];

  for (const [name, state] of equivalenceScenarios()) {
    const baselineSnapshot = baseline.render(state);
    const candidateSnapshot = candidate.render(state);
    assert.deepEqual(
      candidateSnapshot,
      baselineSnapshot,
      `${name}: text/color/font/position/visibility/z-order/window/sound differs`,
    );

    assert.equal(candidateSnapshot.cycle, scenarioResults.length + 1, `${name}: logical cycle drifted`);
    if (name === 'alerta') {
      assert.equal(
        candidateSnapshot.controls.find((control) => control.id === 'alert').text,
        'Alerta: PIPELINE PARADO',
        'Alert text was not visible in the same cycle',
      );
    }
    if (name === 'erros') {
      assert.equal(
        candidateSnapshot.controls.find((control) => control.id === 'errorLine2').text,
        '2. sintetico-2 - erro-b.txt',
        'Second error was not visible in the same cycle',
      );
    }
    if (name === 'suporte_invalido') {
      assert.equal(
        candidateSnapshot.controls.find((control) => control.id === 'support').color,
        'cFFD166',
        'Invalid support state was not visible in the same cycle',
      );
    }
    if (name === 'minimizar') assert.equal(candidateSnapshot.window.height, 24);
    if (name === 'restaurar') assert.equal(candidateSnapshot.window.height, 950);
    scenarioResults.push(name);
  }

  assert.deepEqual(scenarioResults, [
    'normal',
    'alerta',
    'erros',
    'suporte_valido',
    'suporte_invalido',
    'bot_ativo',
    'bot_parado',
    'runner_ativo',
    'runner_parado',
    'minimizar',
    'restaurar',
  ]);
  assert.deepEqual(candidate.soundTrace, baseline.soundTrace, 'Alert/sound traces diverged');

  assert.deepEqual(baseline.counts, {
    text: 99,
    color: 78,
    font: 99,
    textAvoided: 0,
    colorAvoided: 0,
    fontAvoided: 0,
    invalidations: 0,
  });
  assert.deepEqual(candidate.counts, {
    text: 50,
    color: 40,
    font: 27,
    textAvoided: 49,
    colorAvoided: 38,
    fontAvoided: 72,
    invalidations: 2,
  });
  assert.equal(candidate.counts.text + candidate.counts.textAvoided, baseline.counts.text);
  assert.equal(candidate.counts.color + candidate.counts.colorAvoided, baseline.counts.color);
  assert.equal(candidate.counts.font + candidate.counts.fontAvoided, baseline.counts.font);
  assert.equal(
    candidate.counts.textAvoided + candidate.counts.colorAvoided + candidate.counts.fontAvoided,
    159,
    'Exact avoided setter total changed',
  );
});
