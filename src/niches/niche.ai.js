const fs = require("fs");
const path = require("path");
const schema = require("./niche.schema");

const PROMPT_FILE = path.join(__dirname, "..", "..", "prompts", "prompt_dna_nicho.txt");
const DEFAULT_MODEL = process.env.OPENAI_DNA_MODEL || "gpt-4.1-mini";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function readPromptTemplate() {
  try {
    if (fs.existsSync(PROMPT_FILE)) {
      return fs.readFileSync(PROMPT_FILE, "utf8");
    }
  } catch {}

  return "Crie um DNA visual e comercial em JSON para o ramo informado.";
}

function fillPrompt(template, context = {}) {
  return template
    .replaceAll("{{ramo}}", schema.normalizeText(context.ramo))
    .replaceAll("{{nome_empresa}}", schema.normalizeText(context.nome_empresa))
    .replaceAll("{{objetivo}}", schema.normalizeText(context.objetivo))
    .replaceAll("{{oferta}}", schema.normalizeText(context.oferta))
    .replaceAll("{{cta}}", schema.normalizeText(context.cta))
    .replaceAll("{{observacoes}}", schema.normalizeText(context.observacoes));
}

function extractTextFromResponse(data) {
  if (typeof data?.output_text === "string") return data.output_text;

  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }

  return parts.join("\n").trim();
}

function parseJsonObject(text) {
  const clean = String(text || "").trim();
  if (!clean) return null;

  try {
    return JSON.parse(clean);
  } catch {}

  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function gerarDnaNicho(context = {}) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    return {
      ok: false,
      dna: schema.createEmptyDna(),
      origem: "fallback",
      status: "pendente",
      erro: "OPENAI_API_KEY ausente"
    };
  }

  if (typeof fetch !== "function") {
    return {
      ok: false,
      dna: schema.createEmptyDna(),
      origem: "fallback",
      status: "pendente",
      erro: "fetch nativo indisponivel"
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const prompt = fillPrompt(readPromptTemplate(), context);
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        input: prompt,
        text: {
          format: {
            type: "json_object"
          }
        }
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error?.message || `OpenAI HTTP ${response.status}`);
    }

    const parsed = parseJsonObject(extractTextFromResponse(data));
    if (!parsed) {
      throw new Error("Resposta da IA nao retornou JSON valido");
    }

    return {
      ok: true,
      dna: schema.normalizeDna(parsed),
      origem: "ia",
      status: "gerado",
      erro: ""
    };
  } catch (error) {
    return {
      ok: false,
      dna: schema.createEmptyDna(),
      origem: "fallback",
      status: "pendente",
      erro: error?.message || "erro_ia_nicho"
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  PROMPT_FILE,
  gerarDnaNicho
};
