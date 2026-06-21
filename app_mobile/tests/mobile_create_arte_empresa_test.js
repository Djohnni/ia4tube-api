const fs = require("fs");
const path = require("path");

const API_BASE = (process.env.API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const TOKEN = process.env.TOKEN || "";
const LOGO_PATH = process.env.LOGO_PATH || "";

function printUsageAndExit() {
  console.log("IA4Tube Mobile V1 - teste de criacao de pedido arte_empresa");
  console.log("");
  console.log("Uso:");
  console.log("  TOKEN=\"seu_jwt\" LOGO_PATH=\"C:\\\\caminho\\\\logo.png\" node app_mobile/tests/mobile_create_arte_empresa_test.js");
  console.log("");
  console.log("Variaveis opcionais:");
  console.log("  API_BASE=\"http://localhost:3000\"  # padrao");
  console.log("");
  console.log("Como obter TOKEN:");
  console.log("  1. Faça login pela API ou pelo site atual.");
  console.log("  2. Use o JWT retornado pelas rotas /auth/login, /auth/google ou /auth/auto-register.");
  console.log("");
  process.exit(1);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function assertInputs() {
  if (!TOKEN || !LOGO_PATH) {
    printUsageAndExit();
  }

  if (!fs.existsSync(LOGO_PATH)) {
    console.error(`LOGO_PATH nao encontrado: ${LOGO_PATH}`);
    process.exit(1);
  }

  const stat = fs.statSync(LOGO_PATH);
  if (!stat.isFile()) {
    console.error(`LOGO_PATH nao e um arquivo: ${LOGO_PATH}`);
    process.exit(1);
  }
}

async function main() {
  assertInputs();

  const fields = {
    ramo: "Vidracaria",
    ramo_origem: "manual",
    nome_empresa: "Vidros Alfa Teste Mobile",
    objetivo: "Quero divulgar uma promocao",
    objetivo_origem: "manual",
    estilo_visual_cliente: "normal",
    oferta: "Orcamento gratis nesta semana",
    cta: "Chame no WhatsApp",
    whatsapp: "15999999999",
    instagram: "@vidrosalfa",
    observacoes: "Pedido de teste criado pelo simulador Mobile V1.",
    campos_dinamicos: {
      promocao: "20% de desconto",
      validade: "ate sabado"
    }
  };

  const logoFileName = path.basename(LOGO_PATH);
  const assets = {
    logo: {
      legacyName: "logo",
      files: [logoFileName]
    },
    fotos: {
      legacyName: "fotos",
      files: []
    },
    referencias: {
      legacyName: "referencias",
      files: []
    }
  };

  const form = new FormData();

  form.append("flyer_tipo", "arte_empresa");
  form.append("product_id", "arte_empresa");
  form.append("schema_version", "2");
  form.append("fields_json", JSON.stringify(fields));
  form.append("assets_json", JSON.stringify(assets));

  // Campos legados que o backend atual ainda usa para compatibilidade.
  form.append("ramo", fields.ramo);
  form.append("ramo_origem", fields.ramo_origem);
  form.append("nome_empresa", fields.nome_empresa);
  form.append("objetivo", fields.objetivo);
  form.append("objetivo_origem", fields.objetivo_origem);
  form.append("estilo_visual_cliente", fields.estilo_visual_cliente);
  form.append("oferta", fields.oferta);
  form.append("cta", fields.cta);
  form.append("whatsapp", fields.whatsapp);
  form.append("instagram", fields.instagram);
  form.append("observacoes", fields.observacoes);
  form.append("rodada", "Arte para Empresa");
  form.append("data", "Arte para Empresa");

  const logoBytes = fs.readFileSync(LOGO_PATH);
  const logoBlob = new Blob([logoBytes], { type: getMimeType(LOGO_PATH) });
  form.append("logo", logoBlob, logoFileName);

  const url = `${API_BASE}/pedidos`;

  console.log(`POST ${url}`);
  console.log(`Produto: arte_empresa`);
  console.log(`Logo: ${LOGO_PATH}`);
  console.log("");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`
    },
    body: form
  });

  const text = await response.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  console.log(`HTTP ${response.status} ${response.statusText}`);

  if (json) {
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log(text || "(resposta vazia)");
  }

  if (!response.ok || !json || json.ok !== true) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Erro ao executar teste mobile:");
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
