const API_BASE = (process.env.API_BASE || "https://ia4tube-api.onrender.com").replace(/\/+$/, "");
const TOKEN = process.env.TOKEN || "";
const PEDIDO_ID = process.env.PEDIDO_ID || "";
const MOTIVO_AJUSTE = "Teste mobile: ajuste solicitado pelo simulador Android.";

function printUsageAndExit() {
  console.log("IA4Tube Mobile V1 - teste de solicitacao de ajuste");
  console.log("");
  console.log("Uso:");
  console.log("  TOKEN=\"seu_jwt\" PEDIDO_ID=\"20260525_180819\" node app_mobile/tests/mobile_order_adjust_test.js");
  console.log("");
  console.log("PowerShell:");
  console.log("  $env:API_BASE=\"https://ia4tube-api.onrender.com\"");
  console.log("  $env:TOKEN=\"COLE_O_JWT_AQUI\"");
  console.log("  $env:PEDIDO_ID=\"20260525_180819\"");
  console.log("  node app_mobile\\tests\\mobile_order_adjust_test.js");
  console.log("");
  console.log("Cuidado: este teste aciona o fluxo real de ajuste do pedido.");
  process.exit(1);
}

function assertInputs() {
  if (!TOKEN || !PEDIDO_ID) printUsageAndExit();
}

async function main() {
  assertInputs();

  const url = `${API_BASE}/pedidos/${encodeURIComponent(PEDIDO_ID)}/solicitar-ajuste`;
  console.log(`POST ${url}`);
  console.log("Cuidado: esta chamada aciona o fluxo real de ajuste.");
  console.log("");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      motivo_ajuste: MOTIVO_AJUSTE
    })
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
  console.error("Erro ao solicitar ajuste:");
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
