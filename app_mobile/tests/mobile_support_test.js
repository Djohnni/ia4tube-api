const API_BASE = (process.env.API_BASE || "https://ia4tube-api.onrender.com").replace(/\/+$/, "");
const TOKEN = process.env.TOKEN || "";
const SUPPORT_MESSAGE = process.env.SUPPORT_MESSAGE || "Teste mobile: mensagem enviada pelo simulador Android.";

function printUsageAndExit() {
  console.log("IA4Tube Mobile V1 - teste de suporte");
  console.log("");
  console.log("Uso:");
  console.log("  TOKEN=\"seu_jwt\" node app_mobile/tests/mobile_support_test.js");
  console.log("");
  console.log("PowerShell:");
  console.log("  $env:API_BASE=\"https://ia4tube-api.onrender.com\"");
  console.log("  $env:TOKEN=\"COLE_O_JWT_AQUI\"");
  console.log("  $env:SUPPORT_MESSAGE=\"Teste mobile: mensagem enviada pelo simulador Android.\"");
  console.log("  node app_mobile\\tests\\mobile_support_test.js");
  console.log("");
  console.log("Cuidado: este teste pode criar ou atualizar conversa real de suporte.");
  process.exit(1);
}

function assertInputs() {
  if (!TOKEN) printUsageAndExit();
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text || null;
  }
}

function printResult(label, response, data) {
  console.log(label);
  console.log(`HTTP ${response.status} ${response.statusText}`);
  if (typeof data === "string") {
    console.log(data || "(resposta vazia)");
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
  console.log("");
}

async function main() {
  assertInputs();

  const listUrl = `${API_BASE}/suporte/minhas-mensagens`;
  const chatUrl = `${API_BASE}/suporte/chat`;

  console.log(`GET ${listUrl}`);
  const beforeResponse = await fetch(listUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "X-IA4-Chat": "true"
    }
  });
  const beforeData = await readJsonResponse(beforeResponse);
  printResult("Mensagens antes do envio", beforeResponse, beforeData);

  console.log(`POST ${chatUrl}`);
  console.log("Cuidado: esta chamada pode criar ou atualizar conversa real de suporte.");
  const sendResponse = await fetch(chatUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      mensagem: SUPPORT_MESSAGE
    })
  });
  const sendData = await readJsonResponse(sendResponse);
  printResult("Envio de mensagem", sendResponse, sendData);

  console.log(`GET ${listUrl}`);
  const afterResponse = await fetch(listUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "X-IA4-Chat": "true"
    }
  });
  const afterData = await readJsonResponse(afterResponse);
  printResult("Mensagens depois do envio", afterResponse, afterData);

  if (!beforeResponse.ok || !sendResponse.ok || !afterResponse.ok) {
    process.exitCode = 1;
    return;
  }

  if (
    !beforeData ||
    !sendData ||
    !afterData ||
    beforeData.ok !== true ||
    sendData.ok !== true ||
    afterData.ok !== true
  ) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Erro ao testar suporte:");
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
