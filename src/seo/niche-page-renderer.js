const fs = require("fs");
const path = require("path");

const BRAND_NAME = "iA4Tube";
const BRANDED_AI = "Inteligencia Artificial da iA4Tube";
const BRAND_PLACEHOLDER = "__IA4TUBE_BRAND__";
const BRANDED_AI_ASCII_PLACEHOLDER = "__IA4TUBE_BRANDED_AI_ASCII__";
const BRANDED_AI_ACCENT_PLACEHOLDER = "__IA4TUBE_BRANDED_AI_ACCENT__";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeBrandReferences(value) {
  return String(value ?? "")
    .replace(/Inteligencia Artificial da iA4Tube/g, BRANDED_AI_ASCII_PLACEHOLDER)
    .replace(/Inteligência Artificial da iA4Tube/g, BRANDED_AI_ACCENT_PLACEHOLDER)
    .replace(/iA4Tube/g, BRAND_PLACEHOLDER)
    .replace(/\bA IA\b/g, "A iA4Tube")
    .replace(/\ba IA\b/g, "a iA4Tube")
    .replace(/\bIA\b/g, "iA4Tube")
    .replace(/\bInteligencia Artificial\b(?! da iA4Tube)/g, BRANDED_AI)
    .replace(/\bInteligência Artificial\b(?! da iA4Tube)/g, "Inteligência Artificial da iA4Tube")
    .replaceAll(BRANDED_AI_ASCII_PLACEHOLDER, BRANDED_AI)
    .replaceAll(BRANDED_AI_ACCENT_PLACEHOLDER, "Inteligência Artificial da iA4Tube")
    .replaceAll(BRAND_PLACEHOLDER, BRAND_NAME)
    .replace(/\biA4Tube\s+iA4Tube\b/g, BRAND_NAME)
    .replace(/\b(Inteligencia Artificial da iA4Tube)\s+da iA4Tube\b/g, "$1")
    .replace(/\b(Inteligência Artificial da iA4Tube)\s+da iA4Tube\b/g, "$1")
    .replace(/\bcom a iA4Tube\s+com a iA4Tube\b/g, `com a ${BRAND_NAME}`);
}

function ensureBrand(value, suffix = ` | ${BRAND_NAME}`) {
  const text = normalizeBrandReferences(value).trim();

  if (!text) {
    return BRAND_NAME;
  }

  return text.includes(BRAND_NAME) ? text : `${text}${suffix}`;
}

function readNichePageData(nichesDir, slug) {
  const filePath = path.join(nichesDir, `${slug}.json`);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

  if (String(data.slug || "").toLowerCase() !== slug) {
    throw new Error(`Slug do arquivo ${filePath} nao confere com a URL /${slug}`);
  }

  return data;
}

function renderCards(items) {
  return normalizeArray(items)
    .map((item) => `
          <article class="card">
            <h3>${escapeHtml(normalizeBrandReferences(item.titulo))}</h3>
            <p>${escapeHtml(normalizeBrandReferences(item.texto))}</p>
          </article>`)
    .join("");
}

function renderList(items) {
  return normalizeArray(items)
    .map((item) => `          <li>${escapeHtml(normalizeBrandReferences(item))}</li>`)
    .join("\n");
}

function renderSteps(items) {
  return normalizeArray(items)
    .map((item) => `
          <article class="step">
            <h3>${escapeHtml(normalizeBrandReferences(item.titulo))}</h3>
            <p>${escapeHtml(normalizeBrandReferences(item.texto))}</p>
          </article>`)
    .join("");
}

function renderPremiumListSection(title, items) {
  const validItems = normalizeArray(items).filter((item) => String(item || "").trim());

  if (!validItems.length) {
    return "";
  }

  return `
    <section>
      <div class="wrap">
        <h2>${escapeHtml(title)}</h2>
        <ul class="premium-list">
${validItems.map((item) => `          <li>${escapeHtml(normalizeBrandReferences(item))}</li>`).join("\n")}
        </ul>
      </div>
    </section>`;
}

function renderFaqSection(items) {
  const validItems = normalizeArray(items).filter((item) => item && (item.pergunta || item.resposta));

  if (!validItems.length) {
    return "";
  }

  return `
    <section>
      <div class="wrap">
        <h2>Perguntas frequentes</h2>
        <div class="faq-list">${validItems.map((item) => `
          <article class="faq-item">
            <h3>${escapeHtml(normalizeBrandReferences(item.pergunta))}</h3>
            <p>${escapeHtml(normalizeBrandReferences(item.resposta))}</p>
          </article>`).join("")}
        </div>
      </div>
    </section>`;
}

function renderNichePage(data) {
  const slug = escapeHtml(data.slug);
  const nicheName = escapeHtml(data.nome_nicho);
  const seoTitle = escapeHtml(ensureBrand(data.titulo_seo));
  const seoDescription = escapeHtml(ensureBrand(data.descricao_seo, ` com a ${BRAND_NAME}.`));
  const h1 = escapeHtml(ensureBrand(data.h1, ` com a ${BRAND_NAME}`));
  const subtitle = escapeHtml(ensureBrand(data.subtitulo, ` Conheca a ${BRAND_NAME}.`));
  const eyebrow = escapeHtml(normalizeBrandReferences(data.chamada_superior || `Marketing para ${data.nome_nicho} com a Inteligencia Artificial da iA4Tube`));
  const mainCta = escapeHtml(normalizeBrandReferences(data.ctas?.principal || `Criar Arte para Minha ${data.nome_nicho}`));
  const appUrl = escapeHtml(data.ctas?.url || `/app.html?ramo=${encodeURIComponent(data.nome_nicho || "")}`);
  const middleTitle = escapeHtml(normalizeBrandReferences(data.ctas?.meio_titulo || `Quer divulgar melhor sua ${data.nome_nicho}?`));
  const middleText = escapeHtml(ensureBrand(data.ctas?.meio_texto || "Crie uma arte profissional em poucos minutos e publique pelo celular.", ` com a ${BRAND_NAME}.`));
  const finalTitle = escapeHtml(normalizeBrandReferences(data.ctas?.final_titulo || `Pronto para melhorar seu marketing?`));
  const finalText = escapeHtml(ensureBrand(data.ctas?.final_texto || "Crie uma arte profissional para divulgar sua empresa em poucos minutos.", ` com a ${BRAND_NAME}.`));
  const keywordsText = escapeHtml(normalizeArray(data.palavras_chave).join(", "));
  const premiumSections = [
    renderPremiumListSection("Ideias de posts", data.ideias_posts),
    renderPremiumListSection("Campanhas sazonais", data.campanhas_sazonais),
    renderPremiumListSection("Exemplos do dia a dia", data.exemplos_dia_a_dia),
    renderFaqSection(data.faq)
  ].join("");

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${seoTitle}</title>
  <meta name="description" content="${seoDescription}">
  <link rel="canonical" href="https://ia4tube.com/${slug}">
  <meta name="robots" content="index, follow">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="iA4Tube">
  <meta property="og:title" content="${h1}">
  <meta property="og:description" content="${seoDescription}">
  <meta property="og:url" content="https://ia4tube.com/${slug}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${seoTitle}">
  <meta name="twitter:description" content="${seoDescription}">
  <style>
    :root {
      color-scheme: light;
      --bg: #fff8ec;
      --ink: #21150d;
      --muted: #6b5948;
      --brand: #c47a21;
      --brand-dark: #8a4b12;
      --card: #ffffff;
      --line: #ead8c3;
      --soft: #fff1d6;
    }

    * { box-sizing: border-box; }
    html {
      overflow-x: hidden;
      text-size-adjust: 100%;
      -webkit-text-size-adjust: 100%;
    }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: var(--bg);
      color: var(--ink);
      line-height: 1.6;
      overflow-x: hidden;
    }
    img,
    picture,
    svg {
      display: block;
      max-width: 100%;
      height: auto;
    }
    a { color: inherit; }
    .wrap {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
    }
    header {
      padding: 22px 0;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 248, 236, 0.92);
      position: sticky;
      top: 0;
      backdrop-filter: blur(10px);
      z-index: 5;
    }
    .topbar {
      display: flex;
      align-items: center;
      flex-direction: column;
      justify-content: center;
      gap: 12px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: min(230px, 68vw);
      min-height: 72px;
      text-decoration: none;
    }
    .brand img {
      width: 100%;
      max-height: 90px;
      object-fit: contain;
    }
    .nav-cta,
    .primary-cta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      font-weight: 900;
      text-decoration: none;
      white-space: nowrap;
    }
    .nav-cta {
      min-height: 42px;
      padding: 10px 16px;
      background: var(--ink);
      color: #fff;
    }
    .primary-cta {
      min-height: 52px;
      padding: 14px 22px;
      background: var(--brand);
      color: #fff;
      box-shadow: 0 12px 28px rgba(138, 75, 18, 0.22);
    }
    .hero {
      padding: 72px 0 48px;
      background:
        linear-gradient(110deg, rgba(255, 248, 236, 0.96), rgba(255, 241, 214, 0.78)),
        radial-gradient(circle at 80% 30%, rgba(196, 122, 33, 0.20), transparent 34%);
    }
    .hero-content { max-width: 860px; }
    .eyebrow {
      color: var(--brand-dark);
      font-weight: 900;
      text-transform: uppercase;
      font-size: 13px;
      letter-spacing: 0.06em;
      margin-bottom: 14px;
    }
    h1 {
      margin: 0 0 18px;
      font-size: clamp(36px, 6vw, 64px);
      line-height: 1.02;
      letter-spacing: 0;
    }
    .subtitle {
      margin: 0 0 28px;
      font-size: clamp(18px, 2.4vw, 22px);
      color: var(--muted);
      max-width: 760px;
    }
    .cta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      align-items: center;
      margin-top: 26px;
    }
    .secondary-note {
      color: var(--muted);
      font-weight: 700;
      font-size: 14px;
    }
    section { padding: 54px 0; }
    h2 {
      margin: 0 0 18px;
      font-size: clamp(28px, 4vw, 42px);
      line-height: 1.12;
      letter-spacing: 0;
    }
    .lead {
      max-width: 860px;
      color: var(--muted);
      font-size: 18px;
      margin: 0 0 26px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 18px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 22px;
    }
    .card h3 {
      margin: 0 0 10px;
      font-size: 21px;
      line-height: 1.2;
    }
    .card p {
      margin: 0;
      color: var(--muted);
    }
    .objective-list {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      padding: 0;
      margin: 0;
      list-style: none;
    }
    .objective-list li {
      background: var(--soft);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      font-weight: 800;
      color: var(--brand-dark);
    }
    .mid-cta {
      margin-top: 28px;
      background: var(--soft);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
    }
    .mid-cta strong {
      display: block;
      font-size: 22px;
      line-height: 1.2;
      margin-bottom: 6px;
    }
    .mid-cta span {
      color: var(--muted);
      font-weight: 700;
    }
    .steps {
      counter-reset: step;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 18px;
    }
    .step {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 22px;
    }
    .step::before {
      counter-increment: step;
      content: counter(step);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--brand);
      color: #fff;
      font-weight: 900;
      margin-bottom: 12px;
    }
    .benefits {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .benefits li {
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      font-weight: 750;
    }
    .premium-list {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .premium-list li {
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      color: var(--ink);
      font-weight: 750;
    }
    .faq-list {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
    }
    .faq-item {
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 20px;
    }
    .faq-item h3 {
      margin: 0 0 8px;
      font-size: 20px;
      line-height: 1.25;
    }
    .faq-item p {
      margin: 0;
      color: var(--muted);
    }
    .final-cta {
      background: var(--ink);
      color: #fff;
      border-radius: 8px;
      padding: 42px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 24px;
      align-items: center;
    }
    .final-cta h2,
    .final-cta p { color: #fff; }
    .final-cta p {
      margin: 0;
      color: #f4dfc2;
      font-size: 18px;
    }
    footer {
      padding: 34px 0;
      color: var(--muted);
      border-top: 1px solid var(--line);
      font-size: 14px;
    }
    @media (max-width: 860px) {
      .grid,
      .steps,
      .premium-list,
      .benefits,
      .final-cta {
        grid-template-columns: 1fr;
      }
      .mid-cta {
        align-items: flex-start;
        flex-direction: column;
      }
      .objective-list {
        grid-template-columns: repeat(2, 1fr);
      }
      .hero { padding-top: 44px; }
      .final-cta { padding: 28px; }
    }
    @media (max-width: 700px) {
      header {
        padding: 12px 0;
      }
      .topbar {
        align-items: center;
        flex-direction: column;
        gap: 10px;
      }
      .nav-cta,
      .primary-cta {
        width: 100%;
        min-height: 52px;
        padding: 14px 18px;
        text-align: center;
        white-space: normal;
      }
      .hero {
        padding: 34px 0 30px;
      }
      section {
        padding: 38px 0;
      }
      .subtitle,
      .lead {
        font-size: 17px;
      }
      .secondary-note {
        width: 100%;
      }
      .mid-cta,
      .card,
      .step,
      .premium-list li,
      .faq-item,
      .benefits li {
        padding: 18px;
      }
      .final-cta {
        gap: 18px;
      }
    }
    @media (max-width: 520px) {
      .wrap { width: min(100% - 24px, 1120px); }
      h1 {
        font-size: clamp(32px, 10vw, 42px);
        line-height: 1.06;
      }
      h2 {
        font-size: clamp(25px, 8vw, 32px);
      }
      .objective-list { grid-template-columns: 1fr; }
      .final-cta p {
        font-size: 16px;
      }
      .mid-cta strong {
        font-size: 20px;
      }
    }
    @media (max-width: 380px) {
      .wrap { width: min(100% - 20px, 1120px); }
      .brand {
        width: min(210px, 72vw);
        min-height: 66px;
      }
      h1 { font-size: 30px; }
      .subtitle,
      .lead {
        font-size: 16px;
      }
      .card,
      .step,
      .mid-cta,
      .premium-list li,
      .faq-item,
      .benefits li {
        padding: 16px;
      }
    }
  </style>
  <script type="application/ld+json">
  ${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Service",
    name: `iA4Tube para ${data.nome_nicho}`,
    provider: {
      "@type": "Organization",
      name: "iA4Tube",
      url: "https://ia4tube.com/"
    },
    areaServed: "BR",
    serviceType: normalizeBrandReferences(data.service_type || `Criacao de artes para ${data.nome_nicho} com a Inteligencia Artificial da iA4Tube`),
    description: ensureBrand(data.descricao_seo, ` com a ${BRAND_NAME}.`),
    keywords: normalizeArray(data.palavras_chave).map(normalizeBrandReferences)
  }, null, 2)}
  </script>
</head>
<body>
  <header>
    <div class="wrap topbar">
      <a class="brand" href="/app.html" aria-label="iA4Tube">
        <img src="/assets/ia4tube-logo.png" alt="iA4Tube" width="473" height="343">
      </a>
      <a class="nav-cta" href="${appUrl}">${mainCta}</a>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="wrap">
        <div class="hero-content">
          <div class="eyebrow">${eyebrow}</div>
          <h1>${h1}</h1>
          <p class="subtitle">${subtitle}</p>
          <div class="cta-row">
            <a class="primary-cta" href="${appUrl}">${mainCta}</a>
            <span class="secondary-note">${escapeHtml(data.nota_cta || keywordsText)}</span>
          </div>
        </div>
      </div>
    </section>

    <section>
      <div class="wrap">
        <h2>${escapeHtml(normalizeBrandReferences(data.secoes?.dores_titulo || `Por que ${data.nome_nicho} precisa divulgar melhor`))}</h2>
        <p class="lead">${escapeHtml(normalizeBrandReferences(data.secoes?.dores_intro || ""))}</p>
        <div class="grid">${renderCards(data.dores_cliente)}
        </div>
      </div>
    </section>

    <section>
      <div class="wrap">
        <h2>${escapeHtml(normalizeBrandReferences(data.secoes?.cria_titulo || `O que a iA4Tube cria para ${data.nome_nicho}`))}</h2>
        <p class="lead">${escapeHtml(normalizeBrandReferences(data.secoes?.cria_intro || ""))}</p>
        <ul class="objective-list">
${renderList(data.exemplos_objetivos)}
        </ul>
        <div class="mid-cta">
          <div>
            <strong>${middleTitle}</strong>
            <span>${middleText}</span>
          </div>
          <a class="primary-cta" href="${appUrl}">${mainCta}</a>
        </div>
      </div>
    </section>

    <section>
      <div class="wrap">
        <h2>${escapeHtml(normalizeBrandReferences(data.secoes?.exemplos_titulo || `Exemplos de artes para ${data.nome_nicho}`))}</h2>
        <div class="grid">${renderCards(data.exemplos_artes)}
        </div>
      </div>
    </section>

    <section>
      <div class="wrap">
        <h2>${escapeHtml(normalizeBrandReferences(data.secoes?.como_funciona_titulo || "Como funciona"))}</h2>
        <div class="steps">${renderSteps(data.como_funciona)}
        </div>
      </div>
    </section>

    <section>
      <div class="wrap">
        <h2>${escapeHtml(normalizeBrandReferences(data.secoes?.beneficios_titulo || "Beneficios"))}</h2>
        <ul class="benefits">
${renderList(data.beneficios)}
        </ul>
      </div>
    </section>
${premiumSections}

    <section>
      <div class="wrap">
        <div class="final-cta">
          <div>
            <h2>${finalTitle}</h2>
            <p>${finalText}</p>
          </div>
          <a class="primary-cta" href="${appUrl}">${mainCta}</a>
        </div>
      </div>
    </section>
  </main>

  <footer>
    <div class="wrap">
      iA4Tube - Artes profissionais com a Inteligencia Artificial da iA4Tube para empresas, comercios e prestadores de servico.
    </div>
  </footer>
</body>
</html>`;
}

module.exports = {
  readNichePageData,
  renderNichePage
};
