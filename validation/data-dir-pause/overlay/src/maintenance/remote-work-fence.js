"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Read-only refusal fence for live source 1bd987f1ecbbd3a64f2ad0e905d30649704f4b3c.
// Never use the business readers here: listBotPending recovers/claims work.
// Only recorded terminal work is accepted. Queued work is refused too, because
// the legacy poll/download contract does not prove that a remote worker is idle.
const DEFINITIONS = Object.freeze([
  { directory: "pedidos", count: "orders", file: "pedido.json",
    terminal: ["pronto", "erro"], active: ["novo", "em_producao", "ajuste_pendente", "em_analise"] },
  { directory: "planejamentos_mensais", count: "plannings", file: "solicitacao.json", type: "planejamento_mensal",
    terminal: ["pronto", "erro", "cancelado"], active: ["em_analise", "processando"] },
  { directory: "materiais_graficos", count: "materials", file: "solicitacao.json", type: "material_grafico_empresa",
    terminal: ["pronto", "erro", "created"], active: ["novo", "em_producao", "processando"] },
  { directory: "carrosseis", count: "carousels", file: "solicitacao.json", type: "carrossel_ia4tube",
    terminal: ["pronto", "erro"], active: ["pendente", "baixado", "processando"] }
]);
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safeSegment = (value) => typeof value === "string" && value.length > 0 &&
  value !== "." && value !== ".." && !/[\\/\x00-\x1f:]/.test(value);

function inspectRemoteWorkFence({ dataDir, fileSystem = fs, nowMs = Date.now(), maxEntries = 100000 } = {}) {
  const counts = { orders: 0, plannings: 0, materials: 0, carousels: 0, campaigns: 0, arts: 0, active: 0, unknown: 0 };
  let visited = 0;
  const directoryWitnesses = [];
  const fileWitnesses = [];
  function refuse() { throw new Error("remote_work_unverifiable"); }
  function budget() { if (++visited > maxEntries) refuse(); }
  function sameStat(first, second) {
    return ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every((key) => first[key] === second[key]);
  }
  function stat(target, kind) {
    const value = fileSystem.lstatSync(target);
    if (value.isSymbolicLink() || (kind === "directory" ? !value.isDirectory() : !value.isFile())) refuse();
    if (kind === "file" && value.nlink !== 1) refuse();
    return value;
  }
  function entries(target) {
    const before = stat(target, "directory");
    const names = fileSystem.readdirSync(target);
    if (!Array.isArray(names) || names.some((name) => !safeSegment(name)) || new Set(names).size !== names.length) refuse();
    names.sort();
    for (const unused of names) { void unused; budget(); }
    if (!sameStat(before, stat(target, "directory"))) refuse();
    directoryWitnesses.push({ target, before, names });
    return names;
  }
  function readText(target, maxBytes = MAX_JSON_BYTES) {
    const before = stat(target, "file");
    if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > maxBytes) refuse();
    const bytes = fileSystem.readFileSync(target);
    if (!Buffer.isBuffer(bytes) || bytes.length !== before.size || !sameStat(before, stat(target, "file"))) refuse();
    fileWitnesses.push({ target, before });
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) refuse();
    return text;
  }
  function readJson(target) {
    const value = JSON.parse(readText(target));
    if (!isObject(value)) refuse();
    return value;
  }
  function classify(status, terminal, active) {
    if (typeof status !== "string") { counts.unknown++; return; }
    if (active.includes(status)) counts.active++;
    else if (!terminal.includes(status)) counts.unknown++;
  }
  function checkClaim(record) {
    const claimFields = ["runner_claim_id", "runner_claimed_em", "runner_claim_expires_em", "runner_claim_consumed_em"];
    for (const key of claimFields) {
      if (hasOwn(record, key) && typeof record[key] !== "string") { counts.unknown++; return; }
    }
    for (const key of claimFields.slice(1)) {
      if (record[key] && !Number.isFinite(Date.parse(record[key]))) { counts.unknown++; return; }
    }
    if (record.runner_claim_expires_em) {
      // An expired lease is not proof of termination. Even a terminal record
      // with an unconsumed claim is ambiguous; do not repair it in this fence.
      if (Date.parse(record.runner_claim_expires_em) > nowMs) counts.active++;
      else if (!record.runner_claim_consumed_em) counts.unknown++;
    } else if ((record.runner_claim_id || record.runner_claimed_em) && !record.runner_claim_consumed_em) {
      counts.unknown++;
    }
  }
  function checkLeafFiles(target, names, depth = 0) {
    if (depth > 8) refuse();
    for (const name of names) {
      const fullPath = path.join(target, name);
      const value = fileSystem.lstatSync(fullPath);
      if (value.isSymbolicLink()) refuse();
      if (value.isDirectory()) checkLeafFiles(fullPath, entries(fullPath), depth + 1);
      else if (!value.isFile() || value.nlink !== 1) refuse();
      // Partial metadata cannot be silently accepted as a settled job.
      if (/\.tmp(?:\.|$)/i.test(name)) refuse();
    }
  }
  function checkRecord(target, names, definition, owner, id) {
    counts[definition.count]++;
    if (!names.includes(definition.file) || !names.includes("status.txt")) refuse();
    const record = readJson(path.join(target, definition.file));
    if (record.id !== id || record.whatsapp !== owner || (definition.type && record.tipo !== definition.type)) refuse();
    const status = readText(path.join(target, "status.txt"), 256).trim();
    if (status !== record.status) counts.unknown++;
    classify(record.status, definition.terminal, definition.active);
    checkClaim(record);
    if (names.includes("ajuste_pendente.txt")) counts.active++;
    checkLeafFiles(target, names);
  }
  function checkHiddenCalendar(target) {
    const parsed = JSON.parse(readText(target));
    if (!Array.isArray(parsed) && !(isObject(parsed) &&
      ["hidden_items", "itens_ocultos", "hidden_keys"].some((key) => Array.isArray(parsed[key])))) refuse();
  }
  function scanFamily(root, definition) {
    const familyPath = path.join(root, definition.directory);
    for (const owner of entries(familyPath)) {
      const ownerPath = path.join(familyPath, owner);
      for (const cycle of entries(ownerPath)) {
        const cyclePath = path.join(ownerPath, cycle);
        if (definition.count === "plannings" && cycle === "calendario_oculto.json") {
          checkHiddenCalendar(cyclePath);
          continue;
        }
        for (const id of entries(cyclePath)) {
          const target = path.join(cyclePath, id);
          checkRecord(target, entries(target), definition, owner, id);
        }
      }
    }
  }
  function scanCampaigns(root, rootNames) {
    // Unlike the other four roots, the legacy server creates this one lazily.
    if (!rootNames.includes("campanhas_artes_gratis")) return;
    const familyPath = path.join(root, "campanhas_artes_gratis");
    for (const id of entries(familyPath)) {
      const target = path.join(familyPath, id);
      const names = entries(target);
      counts.campaigns++;
      const campaign = readJson(path.join(target, "campanha.json"));
      if (campaign.id !== id || campaign.tipo !== "arte_gratis_semanal" ||
        !Number.isInteger(campaign.quantidade_artes) || campaign.quantidade_artes < 1 || campaign.quantidade_artes > 20) refuse();
      classify(campaign.status, ["revisao", "distribuida"], ["gerando"]);
      const distribution = readJson(path.join(target, "distribuicao.json"));
      if (!Array.isArray(distribution.assignments) || distribution.assignments.some((value) => !isObject(value) || value.status !== "distribuida")) refuse();
      const artsPath = path.join(target, "artes");
      const artNames = entries(artsPath);
      if (artNames.length !== campaign.quantidade_artes) refuse();
      for (const artId of artNames) {
        const artPath = path.join(artsPath, artId);
        const artFiles = entries(artPath);
        counts.arts++;
        const art = readJson(path.join(artPath, "arte.json"));
        if (art.id !== artId || art.campaign_id !== id) refuse();
        classify(art.status, ["pronta", "aprovada", "excluida", "erro"], ["pendente", "gerando"]);
        checkClaim(art);
        checkLeafFiles(artPath, artFiles);
      }
      // Includes links and unexpected partial files in the campaign root.
      checkLeafFiles(target, names);
    }
  }
  try {
    if (typeof dataDir !== "string" || !path.isAbsolute(dataDir) || !Number.isFinite(nowMs) ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000000) refuse();
    const root = path.resolve(dataDir);
    if (root === path.parse(root).root || fileSystem.realpathSync(root) !== root) refuse();
    const rootNames = entries(root);
    for (const definition of DEFINITIONS) scanFamily(root, definition);
    scanCampaigns(root, rootNames);
    // This detects observed replacement/mutation during the read, but is not a
    // filesystem lock. The caller must already hold the local drained fence.
    for (const witness of directoryWitnesses) {
      if (!sameStat(witness.before, stat(witness.target, "directory"))) refuse();
      const names = fileSystem.readdirSync(witness.target).sort();
      if (JSON.stringify(names) !== JSON.stringify(witness.names)) refuse();
    }
    for (const witness of fileWitnesses) if (!sameStat(witness.before, stat(witness.target, "file"))) refuse();
  } catch {
    counts.unknown++;
  }
  const ok = counts.active === 0 && counts.unknown === 0;
  return Object.freeze({
    ok,
    code: counts.unknown ? "remote_work_unverifiable" : counts.active ? "remote_work_recorded_pending" : "remote_work_no_active_records",
    counts: Object.freeze(counts),
    noActiveRecordedWork: ok,
    remoteWorkersStopped: false
  });
}

module.exports = { inspectRemoteWorkFence };
