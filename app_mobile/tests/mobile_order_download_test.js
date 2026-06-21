const fs = require("fs");
const path = require("path");

const API_BASE = (process.env.API_BASE || "https://ia4tube-api.onrender.com").replace(/\/+$/, "");
const TOKEN = process.env.TOKEN || "";
const PEDIDO_ID = process.env.PEDIDO_ID || "";

function printUsageAndExit() {
  console.log("IA4Tube Mobile V1 - teste de download do resultado");
  console.log("");
  console.log("Uso:");
  console.log("  TOKEN=\"seu_jwt\" PEDIDO_ID=\"20260525_180819\" node app_mobile/tests/mobile_order_download_test.js");
  console.log("");
  console.log("PowerShell:");
  console.log("  $env:API_BASE=\"https://ia4tube-api.onrender.com\"");
  console.log("  $env:TOKEN=\"COLE_O_JWT_AQUI\"");
  console.log("  $env:PEDIDO_ID=\"20260525_180819\"");
  console.log("  node app_mobile\\tests\\mobile_order_download_test.js");
  console.log("");
  console.log("Cuidado: este teste pode marcar o pedido como baixado.");
  process.exit(1);
}

function assertInputs() {
  if (!TOKEN || !PEDIDO_ID) printUsageAndExit();
}

function safeId(value) {
  return String(value || "").replace(/[^\w.-]+/g, "_");
}

async function main() {
  assertInputs();

  const url = `${API_BASE}/pedidos/${encodeURIComponent(PEDIDO_ID)}/download-resultado`;
  console.log(`GET ${url}`);
  console.log("Cuidado: esta chamada pode marcar o pedido real como baixado.");
  console.log("");

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${TOKEN}`
    }
  });

  const contentType = response.headers.get("content-type") || "";
  const bytes = Buffer.from(await response.arrayBuffer());

  console.log(`HTTP ${response.status} ${response.statusText}`);
  console.log(`Content-Type: ${contentType || "(sem content-type)"}`);

  if (!response.ok || !contentType.toLowerCase().startsWith("image/")) {
    const text = bytes.toString("utf8");
    console.log(text || "(resposta vazia)");
    process.exitCode = 1;
    return;
  }

  const outputDir = path.join(__dirname, "output");
  fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `download_${safeId(PEDIDO_ID)}.png`);
  fs.writeFileSync(outputPath, bytes);

  console.log(`Arquivo salvo: ${outputPath}`);
  console.log(`Tamanho: ${bytes.length} bytes`);
}

main().catch((err) => {
  console.error("Erro ao baixar resultado:");
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
