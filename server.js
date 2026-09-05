const { installConsoleRedaction } = require("./src/security/log-redaction");
const {
  sanitizeInstagramScopeEvidence
} = require("./src/social/oauth/instagram-scope-evidence");
const {
  sanitizeInstagramDiscoveryEvidence
} = require("./src/social/oauth/instagram-provider");
installConsoleRedaction();
const {
  assertWebServiceDatabaseCredentialBoundary
} = require("./src/persistence/postgres/config");
assertWebServiceDatabaseCredentialBoundary(process.env);
const {
  initializeSocialServerRuntime,
  installSocialRuntimeShutdown,
  safeErrorCode
} = require("./src/social/server-runtime");
const {
  createInstagramOAuthRouter
} = require("./src/social/oauth/instagram-oauth-router");
const {
  APP_REVIEW_LOGIN_PREFIX
} = require("./src/social/app-review-policy");
const {
  createInstagramOAuthVisualReturn
} = require("./src/social/oauth/instagram-oauth-visual-return");
const {
  createMetaComplianceRouter
} = require("./src/social/compliance");
const {
  ReviewerSandboxError,
  createReviewerSandboxRouter,
  createReviewerSandboxService
} = require("./src/social/reviewer-sandbox/reviewer-sandbox");
const {
  GATE5A_REVIEWER_COMPANY_NAME,
  GATE5A_REVIEWER_LOGIN,
  createGate5aSyntheticReviewerResolver,
  gate5aReviewerSurfaceGateState
} = require("./scripts/social-gate5a-synthetic-bridge");
const {
  CONTROLLED_GATE4_PUBLIC_PATH,
  createControlledGate4JpegPublicHandler,
  isControlledGate4RequestPath,
  isControlledGate4StagingOrigin,
  normalizeControlledGate4RequestPath
} = require("./src/social/publication/controlled-gate4-jpeg");
const {
  createInstagramPublicationRouter
} = require("./src/social/publication/instagram-publication-router");
const {
  REAL_REVIEWER_CONTENT_SECURITY_POLICY,
  createInstagramRealReviewerRouter,
  isRealReviewerLoginHandoffUrl,
  reviewerMediaIdentity,
  realReviewerUiGateState
} = require("./src/social/reviewer-real/reviewer-real");

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const crypto = require("crypto");
const { Transform, pipeline } = require("stream");
const { spawnSync } = require("child_process");
const productsRegistry = require("./src/products");
const orderStorage = require("./src/orders/order.storage");
const orderStatus = require("./src/orders/order.status");
const orderService = require("./src/orders/order.service");
const billingService = require("./src/billing/billing.service");
const billingPlans = require("./src/billing/plans");
const graphicMaterialsService = require("./src/company-graphic-materials/materials.service");
const graphicMaterialsCatalog = require("./src/company-graphic-materials/materials.catalog");
const carouselService = require("./src/company-carousels/carousels.service");
const monthlyPlanningService = require("./src/company-monthly-planning/planning.service");
const productDiscoveryService = require("./src/company-monthly-planning/product-discovery.service");
const fcmService = require("./src/notifications/fcm.service");
const fcmTokenStore = require("./src/notifications/fcm-token-store");
const {
  createArtReadyNotificationService
} = require("./src/notifications/art-ready-notification.service");
const {
  successfulCompletionTransition
} = require("./src/notifications/art-ready-generation");
const freeArtCampaignsService = require("./src/admin-free-art-campaigns/free-art-campaigns.service");
const freeArtCampaignsStorage = require("./src/admin-free-art-campaigns/free-art-campaigns.storage");
const freeArtCampaignsScheduler = require("./src/admin-free-art-campaigns/free-art-campaigns.scheduler");
const { createFreeArtCampaignRoutes } = require("./src/admin-free-art-campaigns/free-art-campaigns.routes");
const seoNichePages = require("./src/seo/niche-page-renderer");
const {
  configuredSecrets,
  createConcurrencyLimiter,
  createEssentialSecurityHeaders,
  createHttpsEnforcement,
  createRateLimiter,
  envFlag,
  requestIp,
  requireHttpsOrigin,
  requireSecret,
  timingSafeSecretMatch
} = require("./src/security/runtime-security");
const { createOrderMediaAccess } = require("./src/security/order-media-access");
const {
  createTenantContextMiddleware,
  requireTenantContext
} = require("./src/security/tenant-context");
const { createLegalPagesRouter } = require("./src/legal/legal-pages.routes");
const { createPublicUrlConfig } = require("./src/config/public-urls");
const { streamDirectoryZip } = require("./src/zip/zip-stream");

const app = express();
let socialRuntimeState = null;
app.disable("x-powered-by");
app.set("trust proxy", 1);

// ===== CONFIG BÁSICA =====
const PORT = process.env.PORT || 3000;
const IS_DEPLOYED_RUNTIME =
  String(process.env.NODE_ENV || "").trim().toLowerCase() === "production" ||
  String(process.env.RENDER || "").trim().toLowerCase() === "true";
function requireJwtSecret(env = process.env) {
  return requireSecret("JWT_SECRET", {
    env,
    minLength: 32,
    rejectedValues: ["TROQUE_ISSO_AGORA"]
  });
}
const JWT_SECRET = requireJwtSecret();
const USER_TOKEN_ISSUER = "ia4tube-api";
const USER_TOKEN_AUDIENCE = "ia4tube-client";
const PASSWORD_BCRYPT_COST = 12;

function signUserToken(whatsapp) {
  const normalizedOwner = normalizarLoginId(whatsapp);
  if (!normalizedOwner) {
    throw new Error("Nao foi possivel criar uma sessao segura.");
  }

  return jwt.sign(
    {
      sub: normalizedOwner,
      whatsapp: normalizedOwner,
      company_id: normalizedOwner,
      token_version: 2
    },
    JWT_SECRET,
    {
      algorithm: "HS256",
      expiresIn: "7d",
      issuer: USER_TOKEN_ISSUER,
      audience: USER_TOKEN_AUDIENCE,
      jwtid: crypto.randomUUID()
    }
  );
}

function verifyUserToken(token) {
  const user = jwt.verify(token, JWT_SECRET, {
    algorithms: ["HS256"]
  });

  if (Number(user?.token_version || 0) >= 2) {
    if (
      user.iss !== USER_TOKEN_ISSUER ||
      user.aud !== USER_TOKEN_AUDIENCE ||
      !user.jti ||
      user.sub !== user.whatsapp
    ) {
      throw new Error("Token invalido");
    }
  }

  if (!orderStorage.isSafePathSegment(user?.whatsapp)) {
    throw new Error("Token invalido");
  }

  return user;
}

function strongPasswordError(password) {
  const value = String(password || "");
  if (value.length < 10) return "A senha deve ter pelo menos 10 caracteres.";
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    return "A senha deve combinar letras e numeros.";
  }
  return "";
}

function requireDeployedPath(name, rawValue, fallback) {
  const value = String(rawValue || fallback || "").trim();
  if (!value || (IS_DEPLOYED_RUNTIME && !path.isAbsolute(value))) {
    throw new Error(`Configuracao obrigatoria invalida: ${name}`);
  }
  if (IS_DEPLOYED_RUNTIME && path.resolve(value) === path.resolve(__dirname, "dados")) {
    throw new Error(`Configuracao persistente obrigatoria ausente: ${name}`);
  }
  return path.resolve(value);
}

function resolvePublicApiBaseUrl() {
  const configured = String(process.env.PUBLIC_API_BASE_URL || "").trim();
  if (!configured) {
    throw new Error("Configuracao obrigatoria invalida: PUBLIC_API_BASE_URL");
  }
  if (IS_DEPLOYED_RUNTIME) {
    return requireHttpsOrigin("PUBLIC_API_BASE_URL", configured);
  }
  if (/^https:\/\//i.test(configured)) {
    return requireHttpsOrigin("PUBLIC_API_BASE_URL", configured);
  }
  const parsed = new URL(configured);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Configuracao local invalida: PUBLIC_API_BASE_URL");
  }
  return parsed.origin;
}

// ===== DATA STORAGE (RENDER DISK) =====
const DATA_DIR = requireDeployedPath(
  "DATA_DIR",
  process.env.DATA_DIR,
  IS_DEPLOYED_RUNTIME ? "" : path.join(__dirname, "dados")
);

const PEDIDOS_DIR = path.join(DATA_DIR, "pedidos");
const TMP_UPLOADS_DIR = path.join(DATA_DIR, "tmp_uploads");
const REAL_REVIEWER_MEDIA_DIR = path.join(DATA_DIR, "reviewer_media");
const GRAPHIC_MATERIALS_DIR = path.join(DATA_DIR, "materiais_graficos");
const CAROUSELS_DIR = path.join(DATA_DIR, "carrosseis");
const MONTHLY_PLANNINGS_DIR = path.join(DATA_DIR, "planejamentos_mensais");
const FREE_ART_CAMPAIGNS_DIR = path.join(DATA_DIR, "campanhas_artes_gratis");
const CLIENTES_FILE = path.join(DATA_DIR, "clientes.json");
const ART_READY_OUTBOX_FILE = path.join(
  DATA_DIR,
  "notifications",
  "art-ready-outbox.json"
);
const BOT_ADMIN_WHATSAPP = String(process.env.BOT_ADMIN_WHATSAPP || "").trim() ||
  (IS_DEPLOYED_RUNTIME ? "" : "local_admin");
if (!orderStorage.isSafePathSegment(BOT_ADMIN_WHATSAPP)) {
  throw new Error("Configuracao obrigatoria invalida: BOT_ADMIN_WHATSAPP");
}
const BOT_RUNNER_TOKENS = configuredSecrets([
  "BOT_RUNNER_TOKEN",
  "BOT_RUNNER_TOKEN_NEXT"
]);
if (IS_DEPLOYED_RUNTIME) {
  for (const tokenName of ["BOT_RUNNER_TOKEN", "BOT_RUNNER_TOKEN_NEXT"]) {
    if (String(process.env[tokenName] || "").trim()) {
      requireSecret(tokenName, { minLength: 32 });
    }
  }
}
const PUBLIC_URLS = createPublicUrlConfig(process.env);
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const MP_NOTIFICATION_URL = PUBLIC_URLS.mercadoPagoNotificationUrl;
const PUBLIC_API_BASE_URL = PUBLIC_URLS.publicApiBaseUrl;
const PUBLIC_WEB_BASE_URL = PUBLIC_URLS.publicWebBaseUrl;
const PAYMENT_RETURN_URL = PUBLIC_URLS.paymentReturnUrl;
const PAYMENT_PAYER_EMAIL_DOMAIN = PUBLIC_URLS.paymentPayerEmailDomain;
const GATE5A_STAGING_ORIGIN =
  "https://ia4tube-api-staging-checkpoint-a.onrender.com";
const GATE5A_REVIEWER_SURFACE_GATE =
  gate5aReviewerSurfaceGateState(process.env);
const GATE5A_SYNTHETIC_BRIDGE_ENABLED =
  GATE5A_REVIEWER_SURFACE_GATE.persistent;
const GATE5A_STAGING_ENABLED = GATE5A_REVIEWER_SURFACE_GATE.enabled;
const REAL_REVIEWER_UI_GATE = realReviewerUiGateState(process.env);
const REAL_REVIEWER_UI_ENABLED = REAL_REVIEWER_UI_GATE.enabled;
const REVIEWER_MEDIA_ASSET = "controlled-review-jpeg";
const REVIEWER_MEDIA_SENTINEL_PATH =
  "/v1/social/reviewer-sandbox/media/unavailable";
const REVIEWER_MEDIA_CAPABILITY_PREFIX =
  "/v1/social/reviewer-sandbox/media-capability";
const REAL_REVIEWER_MEDIA_CAPABILITY_PREFIX =
  "/v1/social/reviewer/media-capability";
const REVIEWER_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const REAL_REVIEWER_MEDIA_SCHEMA_VERSION = 1;
const REAL_REVIEWER_MEDIA_MAX_ITEMS = 20;
const REAL_REVIEWER_MEDIA_ID_PATTERN = /^reviewer-jpeg:[0-9a-f]{64}$/;
const REAL_REVIEWER_MEDIA_DIRECTORY_PATTERN = /^[0-9a-f]{64}$/;
const REAL_REVIEWER_SOURCE_ID_PATTERN = /^upload-[0-9a-f]{32}$/;
const REAL_REVIEWER_COMPANY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVIEWER_MEDIA_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf
]);

function reviewerSandboxFail(
  code,
  status = 400,
  message = "Operacao de demonstracao recusada."
) {
  throw new ReviewerSandboxError(code, status, message);
}

function reviewerTenantKey(context) {
  const tenantId = String(context?.tenantId || "");
  const principalId = String(context?.principalId || "");
  if (
    !orderStorage.isSafePathSegment(tenantId) ||
    !orderStorage.isSafePathSegment(principalId) ||
    tenantId !== principalId
  ) {
    reviewerSandboxFail(
      "reviewer_tenant_invalid",
      403,
      "Empresa autenticada recusada."
    );
  }
  return `${tenantId}\u0000${principalId}`;
}

function gate5aReviewerContextFromRequest(req) {
  const context = requireTenantContext(req);
  const claims = req?.auth;
  const client = readClientes()[context.tenantId];
  if (
    !claims ||
    typeof claims !== "object" ||
    Array.isArray(claims) ||
    Object.getPrototypeOf(claims) !== Object.prototype ||
    context.tenantId !== GATE5A_REVIEWER_LOGIN ||
    context.principalId !== GATE5A_REVIEWER_LOGIN ||
    context.role !== "owner" ||
    !client ||
    client.ativo === false ||
    client.nome_time !== GATE5A_REVIEWER_COMPANY_NAME
  ) {
    reviewerSandboxFail(
      "reviewer_authenticated_claims_required",
      401,
      "Autenticacao obrigatoria."
    );
  }
  return Object.freeze({
    ...context,
    companyName: GATE5A_REVIEWER_COMPANY_NAME,
    verifiedClaims: Object.freeze({ ...claims })
  });
}

function reviewerJpegDimensions(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 16 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    return null;
  }

  let offset = 2;
  let dimensions = null;
  let hasQuantizationTable = false;
  let hasHuffmanTable = false;
  let hasScan = false;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) break;
    if (marker === 0xda) {
      hasScan = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (marker === 0xdb) hasQuantizationTable = true;
    if (marker === 0xc4) hasHuffmanTable = true;
    if (REVIEWER_MEDIA_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1) return null;
      dimensions = { width, height };
    }
    offset += segmentLength;
  }
  return dimensions && hasQuantizationTable && hasHuffmanTable && hasScan
    ? dimensions
    : null;
}

function realReviewerUploadJpegDimensions(bytes) {
  const dimensions = reviewerJpegDimensions(bytes);
  if (!dimensions) return null;

  let offset = 2;
  let validFrame = false;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) return null;
    if (marker === 0xda) {
      if (!validFrame || offset + 2 >= bytes.length) return null;
      const scanLength = bytes.readUInt16BE(offset);
      const scanComponents = bytes[offset + 2];
      return scanComponents >= 1 &&
        scanComponents <= 4 &&
        scanLength === 6 + (2 * scanComponents) &&
        offset + scanLength < bytes.length - 2
        ? dimensions
        : null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (REVIEWER_MEDIA_SOF_MARKERS.has(marker)) {
      if (segmentLength < 11) return null;
      const frameComponents = bytes[offset + 7];
      if (
        bytes[offset + 2] !== 8 ||
        frameComponents < 1 ||
        frameComponents > 4 ||
        segmentLength !== 8 + (3 * frameComponents)
      ) {
        return null;
      }
      validFrame = true;
    }
    offset += segmentLength;
  }
  return null;
}

function reviewerDemoText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function reviewerDemoCompany(client) {
  const label = reviewerDemoText(client?.nome_time);
  return Boolean(
    client &&
    client.ativo !== false &&
    /(^|[^A-Z0-9])DEMO([^A-Z0-9]|$)/.test(label)
  );
}

function reviewerDemoCaption(value) {
  const caption = reviewerDemoText(value);
  return /(^|[^A-Z0-9])DEMO([^A-Z0-9]|$)/.test(caption) &&
    caption.includes("NAO PUBLICAR");
}

function readTenantOwnedReviewerMedia(
  owner,
  orderId,
  { includeBytes = false, demoOnly = true } = {}
) {
  if (
    !orderStorage.isSafePathSegment(owner) ||
    !orderStorage.isSafePathSegment(orderId)
  ) {
    return null;
  }
  const base = getPedidoBase(owner, orderId);
  if (!base) return null;
  const pedido = safeReadJson(path.join(base, "pedido.json")) || null;
  if (
    !pedido ||
    String(pedido.whatsapp || "").trim() !== owner ||
    isAdminFreeArtOrderHidden(pedido) ||
    readOrderStatus(base, String(pedido.status || "")) !== "pronto"
  ) {
    return null;
  }

  const previewPath = path.join(base, "preview_ia4tube.jpg");
  let stat;
  let bytes;
  try {
    stat = fs.lstatSync(previewPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 16 ||
      stat.size > REVIEWER_MEDIA_MAX_BYTES
    ) {
      return null;
    }
    bytes = fs.readFileSync(previewPath);
    const dimensions = reviewerJpegDimensions(bytes);
    if (!dimensions) {
      bytes.fill(0);
      return null;
    }
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const relativeStorageKey = path.relative(DATA_DIR, previewPath);
    if (
      !relativeStorageKey ||
      relativeStorageKey.startsWith("..") ||
      path.isAbsolute(relativeStorageKey)
    ) {
      bytes.fill(0);
      return null;
    }
    const caption = descricaoPostagemPedido(pedido);
    if (demoOnly && !reviewerDemoCaption(caption)) {
      bytes.fill(0);
      return null;
    }
    const media = {
      owner,
      orderId,
      previewPath,
      storageKey: relativeStorageKey.split(path.sep).join("/"),
      sha256,
      width: dimensions.width,
      height: dimensions.height,
      caption
    };
    if (includeBytes) return { ...media, bytes };
    bytes.fill(0);
    return media;
  } catch {
    if (bytes) bytes.fill(0);
    return null;
  }
}

function latestTenantOwnedReviewerMedia(context) {
  reviewerTenantKey(context);
  const owner = String(context.tenantId);
  if (!reviewerDemoCompany(readClientes()[owner])) return null;
  for (const item of listPedidoBasesByWhatsapp(owner)) {
    const media = readTenantOwnedReviewerMedia(owner, item.id);
    if (media) return media;
  }
  return null;
}

function reviewerMediaCapabilityPath(media) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(media.selectionNonce || "")) {
    reviewerSandboxFail("reviewer_media_selection_invalid", 503);
  }
  const expiresAt = Math.floor(Date.now() / 1000) + ORDER_MEDIA_URL_TTL_SECONDS;
  const nonce = crypto.randomBytes(18).toString("base64url");
  const ownerReference = orderMediaAccess.sign({
    owner: media.owner,
    orderId: "gate5a-reviewer-owner-ref",
    variant: "thumbnail",
    nonce: media.selectionNonce,
    expiresAt: 0
  });
  const signature = orderMediaAccess.sign({
    owner: media.owner,
    orderId: `${media.orderId}:${media.sha256}:${media.selectionNonce}`,
    variant: "thumbnail",
    nonce,
    expiresAt
  });
  const capabilityPath = [
    REVIEWER_MEDIA_CAPABILITY_PREFIX,
    encodeURIComponent(media.orderId),
    String(expiresAt),
    nonce,
    ownerReference,
    signature
  ].join("/");
  if (capabilityPath.length > 300) {
    reviewerSandboxFail(
      "reviewer_media_capability_invalid",
      503,
      "Midia de demonstracao temporariamente indisponivel."
    );
  }
  return capabilityPath;
}

function reviewerMediaRequestIsExact(input) {
  return Boolean(
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.getPrototypeOf(input) === Object.prototype &&
    Object.keys(input).length === 1 &&
    input.asset === REVIEWER_MEDIA_ASSET
  );
}

function reviewerPersistentContent(media) {
  if (
    !media ||
    !/^[0-9a-f]{64}$/.test(String(media.sha256 || "")) ||
    !orderStorage.isSafePathSegment(media.owner) ||
    !orderStorage.isSafePathSegment(media.orderId) ||
    typeof media.storageKey !== "string" ||
    !media.storageKey ||
    !reviewerDemoCaption(media.caption)
  ) {
    reviewerSandboxFail("reviewer_media_persistence_invalid", 503);
  }
  const locatorDigest = crypto.createHash("sha256").update(
    `${media.owner}\u0000${media.orderId}\u0000${media.storageKey}`,
    "utf8"
  ).digest("hex").slice(0, 32);
  return Object.freeze({
    caption: media.caption,
    mediaReference: `gate5a-content:${media.sha256}:${locatorDigest}`
  });
}

function createTenantOwnedReviewerSandboxService(baseService) {
  const selectedMedia = new Map();

  function currentSelectedMedia(context) {
    const key = reviewerTenantKey(context);
    const selected = selectedMedia.get(key);
    if (!selected) return null;
    if (!reviewerDemoCompany(readClientes()[selected.owner])) {
      selectedMedia.delete(key);
      return null;
    }
    const current = readTenantOwnedReviewerMedia(selected.owner, selected.orderId);
    if (!current || current.sha256 !== selected.sha256) {
      selectedMedia.delete(key);
      return null;
    }
    const refreshed = {
      ...current,
      selectionNonce: selected.selectionNonce
    };
    selectedMedia.set(key, refreshed);
    return refreshed;
  }

  function decorate(context, result) {
    if (!result?.state || typeof result.state !== "object") return result;
    reviewerTenantKey(context);
    const client = readClientes()[context.tenantId] || {};
    const companyLabel = String(client.nome_time || "").trim().slice(0, 120) ||
      "Empresa autenticada";
    const state = {
      ...result.state,
      company: {
        label: companyLabel,
        controlled: true
      }
    };
    if (state.media?.selected === true) {
      const media = currentSelectedMedia(context);
      if (!media) {
        state.media = { selected: false, item: null };
      } else {
        state.media = {
          selected: true,
          item: {
            id: "tenant-controlled-review-jpeg",
            fileName: "preview_ia4tube.jpg",
            mimeType: "image/jpeg",
            width: media.width,
            height: media.height,
            assetPath: reviewerMediaCapabilityPath(media),
            caption: media.caption,
            synthetic: true,
            tenantOwned: true
          }
        };
      }
    }
    return Object.freeze({ ...result, state });
  }

  async function invoke(name, context, ...args) {
    return decorate(context, await baseService[name](context, ...args));
  }

  return Object.freeze({
    read: (context) => invoke("read", context),
    authorize: (context, input) => invoke("authorize", context, input),
    callback: (context, input) => invoke("callback", context, input),
    async selectMedia(context, input) {
      if (!reviewerMediaRequestIsExact(input)) {
        reviewerSandboxFail("reviewer_request_invalid");
      }
      const media = latestTenantOwnedReviewerMedia(context);
      if (!media) {
        reviewerSandboxFail(
          "reviewer_media_unavailable",
          404,
          "Nenhum JPEG elegivel foi encontrado para a empresa autenticada."
        );
      }
      const selection = {
        ...media,
        selectionNonce: crypto.randomBytes(18).toString("base64url")
      };
      reviewerMediaCapabilityPath(selection);
      const result = await baseService.selectMedia(context, input);
      selectedMedia.set(reviewerTenantKey(context), selection);
      return decorate(context, result);
    },
    async publish(context, input) {
      const media = currentSelectedMedia(context);
      if (!media) {
        reviewerSandboxFail("reviewer_media_required", 409);
      }
      return invoke("publish", context, input, reviewerPersistentContent(media));
    },
    advance: (context, publicationId, input) => (
      invoke("advance", context, publicationId, input)
    ),
    listPublications: (context) => invoke("listPublications", context),
    getPublication: (context, publicationId) => (
      invoke("getPublication", context, publicationId)
    ),
    async disconnect(context) {
      const result = await baseService.disconnect(context);
      selectedMedia.delete(reviewerTenantKey(context));
      return decorate(context, result);
    },
    async deleteConnectionData(context, input) {
      const result = await baseService.deleteConnectionData(context, input);
      selectedMedia.delete(reviewerTenantKey(context));
      return decorate(context, result);
    },
    async reset(context, input) {
      const result = await baseService.reset(context, input);
      selectedMedia.delete(reviewerTenantKey(context));
      return decorate(context, result);
    },
    resolveMediaCapability(req) {
      const ownerReference = String(req.params.ownerReference || "");
      if (!/^[A-Za-z0-9_-]{43}$/.test(ownerReference)) return null;
      let selected = null;
      for (const candidate of [...selectedMedia.values()]) {
        const expectedReference = orderMediaAccess.sign({
          owner: candidate.owner,
          orderId: "gate5a-reviewer-owner-ref",
          variant: "thumbnail",
          nonce: candidate.selectionNonce,
          expiresAt: 0
        });
        const expectedBytes = Buffer.from(expectedReference, "utf8");
        const receivedBytes = Buffer.from(ownerReference, "utf8");
        if (
          expectedBytes.length === receivedBytes.length &&
          crypto.timingSafeEqual(expectedBytes, receivedBytes)
        ) {
          selected = currentSelectedMedia({
            principalId: candidate.owner,
            tenantId: candidate.owner
          });
          break;
        }
      }
      return reviewerMediaFromCapability(req, selected);
    }
  });
}

function reviewerMediaFromCapability(req, selected) {
  const orderId = String(req.params.orderId || "");
  const expiresAt = Number(req.params.expiresAt);
  const nonce = String(req.params.nonce || "");
  const ownerReference = String(req.params.ownerReference || "");
  const signature = String(req.params.signature || "");
  if (
    !orderStorage.isSafePathSegment(orderId) ||
    !Number.isSafeInteger(expiresAt) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
    !/^[A-Za-z0-9_-]{43}$/.test(ownerReference) ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(signature)
  ) {
    return null;
  }
  const owner = String(selected?.owner || "");
  if (!owner) return null;
  const client = readClientes()[owner];
  if (
    !reviewerDemoCompany(client) ||
    !selected ||
    selected.owner !== owner ||
    selected.orderId !== orderId
  ) {
    return null;
  }
  const media = readTenantOwnedReviewerMedia(owner, orderId, {
    includeBytes: true
  });
  if (!media) return null;
  if (media.sha256 !== selected.sha256) {
    media.bytes.fill(0);
    return null;
  }
  const verified = orderMediaAccess.verify({
    owner,
    orderId: `${orderId}:${media.sha256}:${selected.selectionNonce}`,
    variant: "thumbnail",
    nonce,
    expiresAt,
    signature
  });
  if (!verified) {
    media.bytes.fill(0);
    return null;
  }
  return media;
}
const CANONICAL_WEB_APP_FILE = path.join(__dirname, "app.html");
const CANONICAL_REVIEWER_FLOW_FILE = path.join(
  __dirname,
  "gate5a-reviewer-flow.js"
);
const instagramOAuthVisualReturn = (
  GATE5A_STAGING_ENABLED || REAL_REVIEWER_UI_ENABLED
)
  ? createInstagramOAuthVisualReturn({
      publicOrigin: PUBLIC_API_BASE_URL,
      returnPath: REAL_REVIEWER_UI_ENABLED ? "/reviewer" : "/app.html",
      surfaceMode: REAL_REVIEWER_UI_ENABLED ? "reviewer-real" : "sandbox"
    })
  : null;
const reviewerPersistentConnection = GATE5A_SYNTHETIC_BRIDGE_ENABLED
  ? createGate5aSyntheticReviewerResolver({
      env: process.env,
      getRuntime() {
        return socialRuntimeState;
      }
    })
  : null;
const reviewerSandboxService = GATE5A_STAGING_ENABLED
  ? createTenantOwnedReviewerSandboxService(
      createReviewerSandboxService({
        publicOrigin: PUBLIC_API_BASE_URL,
        controlledAssetPath: REVIEWER_MEDIA_SENTINEL_PATH,
        persistentConnection: reviewerPersistentConnection
      })
    )
  : null;

process.once("exit", () => {
  instagramOAuthVisualReturn?.destroy();
});
const ORDER_MEDIA_URL_TTL_SECONDS = Math.max(
  60,
  Math.min(Number(process.env.ORDER_MEDIA_URL_TTL_SECONDS || 5 * 60), 15 * 60)
);
const ORDER_MEDIA_NOTIFICATION_TTL_SECONDS = Math.max(
  ORDER_MEDIA_URL_TTL_SECONDS,
  Math.min(Number(process.env.ORDER_MEDIA_NOTIFICATION_TTL_SECONDS || 48 * 60 * 60), 7 * 24 * 60 * 60)
);
const ORDER_MEDIA_SIGNING_SECRET = IS_DEPLOYED_RUNTIME
  ? requireSecret("ORDER_MEDIA_SIGNING_SECRET", { minLength: 32 })
  : String(process.env.ORDER_MEDIA_SIGNING_SECRET || crypto.randomBytes(32).toString("base64url"));
const orderMediaAccess = createOrderMediaAccess({
  secret: ORDER_MEDIA_SIGNING_SECRET,
  defaultTtlSeconds: ORDER_MEDIA_URL_TTL_SECONDS,
  maxTtlSeconds: 7 * 24 * 60 * 60,
  allowLoopbackHttp: !IS_DEPLOYED_RUNTIME
});
if (MP_ACCESS_TOKEN) {
  const parsedMpNotificationUrl = new URL(MP_NOTIFICATION_URL);
  if (
    parsedMpNotificationUrl.protocol !== "https:" ||
    parsedMpNotificationUrl.origin !== PUBLIC_API_BASE_URL ||
    parsedMpNotificationUrl.pathname !== "/webhook/mercadopago"
  ) {
    throw new Error("Configuracao obrigatoria invalida: MP_NOTIFICATION_URL");
  }
}
const ARTE_AVULSA_COMPRA = billingPlans.getSingleArtPurchase();
const EMPRESA_ARTE_AVULSA_VALOR = Number(ARTE_AVULSA_COMPRA.amount || productsRegistry.getProductPrice("arte_empresa") || 5.99);
const MP_PROCESSANDO_RETRY_MS = 10 * 60 * 1000;
const MONTHLY_PLANNING_NOTIFICATIONS_INTERVAL_MS = Math.max(
  30 * 1000,
  Number(process.env.MONTHLY_PLANNING_NOTIFICATIONS_INTERVAL_MS || 60 * 1000)
);
const MP_PROCESSADOS_FILE = path.join(DATA_DIR, "mp_processados.json");
const TEMPO_ESTIMADO_FILE = path.join(DATA_DIR, "tempo_estimado.json");
const ONLINE_FILE = path.join(DATA_DIR, "usuarios_online.json");
const SUPORTE_ABERTAS_FILE = path.join(DATA_DIR, "suporte_conversas_abertas.json");
const SUPORTE_FINALIZADAS_FILE = path.join(DATA_DIR, "suporte_conversas_finalizadas.json");
const ANALYTICS_DIR = path.join(DATA_DIR, "analytics");
const EVENTOS_CLIENTES_FILE = path.join(DATA_DIR, "eventos_clientes.json");
const MARKETING_VIDEOS_DIR = path.join(DATA_DIR, "marketing_videos");
const MARKETING_VIDEO_VIEWS_FILE = path.join(MARKETING_VIDEOS_DIR, "views.json");
const FREE_ART_IP_LOCKS_FILE = path.join(DATA_DIR, "free_art_ip_locks.json");
const FREE_ART_IP_LOCK_DAYS = Math.max(1, Number(process.env.IA4TUBE_FREE_ART_IP_LOCK_DAYS || 7));
const FREE_ART_IP_LOCK_MS = FREE_ART_IP_LOCK_DAYS * 24 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, "public");
const PUBLIC_VIDEOS_DIR = path.join(PUBLIC_DIR, "videos");
const SEO_NICHES_DIR = path.join(PUBLIC_DIR, "nichos");
const ADMIN_MOBILE_ANALYTICS_FILE = path.join(__dirname, "admin", "mobile_analytics.html");
const ADMIN_FREE_ART_CAMPAIGNS_FILE = path.join(__dirname, "admin", "free_art_campaigns.html");
const ADMIN_ANALYTICS_COOKIE = "ia4tube_admin_token";

function directoryExists(dirPath) {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return true;
  }
}

function encodedTenantDirectoryName(login) {
  return `tenant_${Buffer.from(String(login || ""), "utf8").toString("base64url")}`;
}

function legacyTenantDirectoryName(login, { preserveDots = true } = {}) {
  const allowed = preserveDots ? /[^a-zA-Z0-9_.@+-]+/g : /[^a-zA-Z0-9_-]+/g;
  return String(login || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(allowed, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
}

function tenantNamespaceExists(login) {
  const owner = normalizarLoginId(login);
  if (!loginIdIsValid(owner)) return true;

  const encoded = encodedTenantDirectoryName(owner);
  const legacyWithDots = legacyTenantDirectoryName(owner);
  const legacyWithoutDots = legacyTenantDirectoryName(owner, { preserveDots: false });
  const tenantDirectories = [
    path.join(PEDIDOS_DIR, owner),
    path.join(GRAPHIC_MATERIALS_DIR, owner),
    path.join(GRAPHIC_MATERIALS_DIR, legacyWithoutDots),
    path.join(CAROUSELS_DIR, encoded),
    path.join(CAROUSELS_DIR, legacyWithDots),
    path.join(MONTHLY_PLANNINGS_DIR, encoded),
    path.join(MONTHLY_PLANNINGS_DIR, legacyWithDots)
  ];
  if (tenantDirectories.some(directoryExists)) return true;

  const supportRecords = [
    ...readJsonArraySafe(SUPORTE_ABERTAS_FILE),
    ...readJsonArraySafe(SUPORTE_FINALIZADAS_FILE)
  ];
  if (supportRecords.some((record) => String(record?.whatsapp || "") === owner)) {
    return true;
  }

  for (const campaign of freeArtCampaignsStorage.listCampaigns(FREE_ART_CAMPAIGNS_DIR)) {
    const distribution = freeArtCampaignsStorage.readDistribution(
      FREE_ART_CAMPAIGNS_DIR,
      campaign.id
    );
    if ((distribution.assignments || []).some(
      (assignment) => String(assignment?.whatsapp || "") === owner
    )) {
      return true;
    }
    if (directoryExists(path.join(
      freeArtCampaignsStorage.campaignDir(FREE_ART_CAMPAIGNS_DIR, campaign.id),
      "clientes",
      owner
    ))) {
      return true;
    }
  }

  return false;
}

const CLIENTES_TESTE = [
  "Los Hermanos",
  "TESTE",
  "admin"
];

const MONTHLY_PLANNING_RESERVED_ROUTE_SEGMENTS = new Set([
  "calendario"
]);

const HTTPS_ENFORCE = envFlag("HTTPS_ENFORCE", IS_DEPLOYED_RUNTIME);
const HTTPS_ALLOW_LOCAL_HTTP = envFlag("HTTPS_ALLOW_LOCAL_HTTP", !IS_DEPLOYED_RUNTIME);
app.use(createEssentialSecurityHeaders({
  trustProxy: "express"
}));
app.use(createHttpsEnforcement({
  enabled: HTTPS_ENFORCE,
  allowLocalHttp: HTTPS_ALLOW_LOCAL_HTTP,
  trustProxy: "express",
  canonicalOrigin: /^https:\/\//i.test(PUBLIC_API_BASE_URL) ? PUBLIC_API_BASE_URL : ""
}));

function securityRateLimitKey(req) {
  return requestIp(req, {
    trustProxy: IS_DEPLOYED_RUNTIME ? "express" : false,
    trustedProxyHops: 1
  });
}

const clientUploadConcurrencyLimit = createConcurrencyLimiter({
  maxGlobal: 4,
  maxPerKey: 1,
  keyGenerator: (req) => req.user?.whatsapp || securityRateLimitKey(req),
  code: "client_upload_in_progress",
  message: "Ja existe um envio de imagem em andamento."
});

app.use(["/auth", "/oauth", "/v1/social"], (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  return next();
});

// CORS: permite seu site chamar a API
app.use(cors({
  origin: [
    PUBLIC_WEB_BASE_URL,
    ...(String(process.env.NODE_ENV || "").toLowerCase() === "production"
      ? []
      : ["http://127.0.0.1:8080", "http://localhost:8080"])
  ],
  credentials: false
}));

const globalJsonParser = express.json({ limit: "1mb" });
const globalUrlencodedParser = express.urlencoded({ extended: false, limit: "1mb" });
const securitySensitiveJsonParser = express.json({ limit: "32kb" });
const securitySensitiveUrlencodedParser = express.urlencoded({ extended: false, limit: "32kb" });
const analyticsJsonParser = express.json({ limit: "256kb" });

function isSecuritySensitiveBodyRoute(req) {
  const routePath = String(req.path || "").toLowerCase();
  return routePath === "/bot/mobile-analytics/login" ||
    routePath === "/v1/social/connections/instagram/authorization" ||
    routePath.startsWith("/v1/social/compliance/meta/") ||
    routePath.startsWith("/v1/social/reviewer/") ||
    routePath.startsWith("/v1/social/reviewer-sandbox/") ||
    routePath === "/oauth" ||
    routePath.startsWith("/oauth/") ||
    routePath === "/auth" ||
    routePath.startsWith("/auth/");
}

app.use((req, res, next) => {
  if (req.path === "/evento") {
    req.restrictedBodyParser = "analytics";
    return analyticsJsonParser(req, res, next);
  }
  if (!isSecuritySensitiveBodyRoute(req)) return next();
  req.restrictedBodyParser = "security";
  return securitySensitiveJsonParser(req, res, (jsonError) => {
    if (jsonError) return next(jsonError);
    return securitySensitiveUrlencodedParser(req, res, next);
  });
});

app.use((req, res, next) => {
  if (req.restrictedBodyParser) return next();
  return globalJsonParser(req, res, next);
});
app.use((req, res, next) => {
  if (req.restrictedBodyParser) return next();
  return globalUrlencodedParser(req, res, next);
});
app.use((err, req, res, next) => {
  if (
    req.restrictedBodyParser &&
    ["entity.parse.failed", "entity.too.large"].includes(err?.type)
  ) {
    return res.status(err.type === "entity.too.large" ? 413 : 400).json({
      ok: false,
      code: err.type === "entity.too.large"
        ? "request_payload_too_large"
        : "request_payload_invalid",
      error: "Requisicao invalida."
    });
  }
  return next(err);
});

const loginRateLimitByIp = createRateLimiter({
  windowMs: Number(process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.AUTH_LOGIN_RATE_LIMIT_MAX || 20),
  keyGenerator: securityRateLimitKey,
  skipSuccessfulRequests: true,
  code: "login_rate_limit"
});
const loginRateLimitByAccount = createRateLimiter({
  windowMs: Number(process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX || 10),
  keyGenerator: (req) => `${securityRateLimitKey(req)}:${normalizarLoginId(req.body?.whatsapp || req.body?.login || "sem_login")}`,
  skipSuccessfulRequests: true,
  code: "login_account_rate_limit"
});
const accountCreationRateLimit = createRateLimiter({
  windowMs: Number(process.env.AUTH_REGISTER_RATE_LIMIT_WINDOW_MS || 60 * 60 * 1000),
  max: Number(process.env.AUTH_REGISTER_RATE_LIMIT_MAX || 10),
  keyGenerator: securityRateLimitKey,
  code: "account_creation_rate_limit"
});
const futureOauthRateLimit = createRateLimiter({
  windowMs: Number(process.env.OAUTH_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.OAUTH_RATE_LIMIT_MAX || 20),
  keyGenerator: securityRateLimitKey,
  code: "oauth_rate_limit"
});
app.use(["/oauth", "/v1/social"], futureOauthRateLimit);

app.get(["/mobile_analytics.html", "/public/mobile_analytics.html"], (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.status(404).send("Not found");
});

app.use("/videos", express.static(PUBLIC_VIDEOS_DIR, {
  acceptRanges: true,
  setHeaders: (res, filePath) => {
    const normalizedPath = String(filePath || "").toLowerCase();
    if (normalizedPath.endsWith(".mp4")) {
      res.type("video/mp4");
    }
    if (normalizedPath.endsWith(".jpg") || normalizedPath.endsWith(".jpeg")) {
      res.type("image/jpeg");
    }
    res.setHeader("Cache-Control", "public, max-age=300");
  }
}));

const controlledGate4JpegPublicHandler =
  isControlledGate4StagingOrigin(process.env.PUBLIC_API_BASE_URL)
    ? createControlledGate4JpegPublicHandler({ publicDirectory: PUBLIC_DIR })
    : null;
app.use((req, res, next) => {
  if (!isControlledGate4RequestPath(req.originalUrl || req.url)) {
    return next();
  }
  if (
    !controlledGate4JpegPublicHandler ||
    req.method !== "GET" ||
    normalizeControlledGate4RequestPath(req.originalUrl || req.url) !==
      CONTROLLED_GATE4_PUBLIC_PATH
  ) {
    return res.status(404).end();
  }
  return controlledGate4JpegPublicHandler(req, res, next);
});
app.use(express.static(PUBLIC_DIR));

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

// ===== GARANTE PASTAS =====
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

ensureDir(DATA_DIR);
ensureDir(PEDIDOS_DIR);
ensureDir(TMP_UPLOADS_DIR);
if (REAL_REVIEWER_UI_ENABLED) ensureDir(REAL_REVIEWER_MEDIA_DIR);
ensureDir(GRAPHIC_MATERIALS_DIR);
ensureDir(CAROUSELS_DIR);
ensureDir(MONTHLY_PLANNINGS_DIR);
ensureDir(ANALYTICS_DIR);
ensureDir(MARKETING_VIDEOS_DIR);

if (!fs.existsSync(CLIENTES_FILE)) {
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify({}, null, 2), "utf8");
}

if (!fs.existsSync(MP_PROCESSADOS_FILE)) {
  fs.writeFileSync(MP_PROCESSADOS_FILE, JSON.stringify({}, null, 2), "utf8");
}

if (!fs.existsSync(TEMPO_ESTIMADO_FILE)) {
  fs.writeFileSync(TEMPO_ESTIMADO_FILE, JSON.stringify({
    tempo_medio_segundos: 135,
    tempo_estimado_segundos: 135,
    pedidos_na_fila: 0,
    lotes: 1,
    max_processos: 5,
    atualizado_em: new Date().toISOString()
  }, null, 2), "utf8");
}

if (!fs.existsSync(ONLINE_FILE)) {
  fs.writeFileSync(ONLINE_FILE, JSON.stringify({}, null, 2), "utf8");
}

if (!fs.existsSync(SUPORTE_ABERTAS_FILE)) {
  fs.writeFileSync(SUPORTE_ABERTAS_FILE, JSON.stringify([], null, 2), "utf8");
}

if (!fs.existsSync(SUPORTE_FINALIZADAS_FILE)) {
  fs.writeFileSync(SUPORTE_FINALIZADAS_FILE, JSON.stringify([], null, 2), "utf8");
}

if (!fs.existsSync(EVENTOS_CLIENTES_FILE)) {
  fs.writeFileSync(EVENTOS_CLIENTES_FILE, JSON.stringify([], null, 2), "utf8");
}

if (!fs.existsSync(MARKETING_VIDEO_VIEWS_FILE)) {
  fs.writeFileSync(MARKETING_VIDEO_VIEWS_FILE, JSON.stringify({}, null, 2), "utf8");
}

if (!fs.existsSync(FREE_ART_IP_LOCKS_FILE)) {
  fs.writeFileSync(FREE_ART_IP_LOCKS_FILE, JSON.stringify({}, null, 2), "utf8");
}

// ===== HELPERS =====
function readClientes() {
  return JSON.parse((fs.readFileSync(CLIENTES_FILE, "utf8") || "{}").replace(/^\uFEFF/, ""));
}

function writeClientes(obj) {
  fcmTokenStore.assertNoLegacyFcmTokens(obj);
  fcmTokenStore.atomicWriteJson(CLIENTES_FILE, obj);
}

const fcmTokenStorageStartup = fcmTokenStore.migrateLegacyFcmTokensFile({
  filePath: CLIENTES_FILE,
  expectedLegacySha256: process.env.FCM_TOKEN_LEGACY_EXPECTED_SHA256,
  expectedLegacyCount: 1,
  env: process.env
});

if (fcmTokenStorageStartup.storageAfter.total > 0) {
  console.info("[fcm-token-storage]", {
    code: "fcm_token_storage_ready",
    migrated: fcmTokenStorageStartup.migrated,
    total: fcmTokenStorageStartup.storageAfter.total,
    active: fcmTokenStorageStartup.storageAfter.active,
    encrypted: fcmTokenStorageStartup.storageAfter.encrypted,
    legacy: fcmTokenStorageStartup.storageAfter.legacy
  });
}

function isMonthlyPlanningReservedRouteSegment(value) {
  return MONTHLY_PLANNING_RESERVED_ROUTE_SEGMENTS.has(
    String(value || "").trim().toLowerCase()
  );
}

function readMpProcessados() {
  return JSON.parse(fs.readFileSync(MP_PROCESSADOS_FILE, "utf8") || "{}");
}

function writeMpProcessados(obj) {
  fs.writeFileSync(MP_PROCESSADOS_FILE, JSON.stringify(obj, null, 2), "utf8");
}

function isMpProcessandoStale(registro) {
  if (!registro || registro.status !== "processando") return false;

  const tentativaEm = new Date(registro.ultima_tentativa_em || registro.criado_em || 0).getTime();
  if (!tentativaEm || Number.isNaN(tentativaEm)) return true;

  return Date.now() - tentativaEm > MP_PROCESSANDO_RETRY_MS;
}

function readTempoEstimado() {
  try {
    return JSON.parse(fs.readFileSync(TEMPO_ESTIMADO_FILE, "utf8") || "{}");
  } catch {
    return {
      tempo_medio_segundos: 135,
      tempo_estimado_segundos: 135,
      pedidos_na_fila: 0,
      lotes: 1,
      max_processos: 5,
      atualizado_em: new Date().toISOString()
    };
  }
}

function writeTempoEstimado(obj) {
  fs.writeFileSync(TEMPO_ESTIMADO_FILE, JSON.stringify(obj, null, 2), "utf8");
}

function getCustoPedido(categoria, cliente) {
  const registryPrice = productsRegistry.getProductPrice(categoria, cliente);
  if (registryPrice !== null) return registryPrice;

  if (categoria === "resultado") return 8.00;
  if (categoria === "escalacao") return 8.00;
  if (categoria === "contratacao") return 7.00;
  if (categoria === "proximo_jogo") return 7.00;
  if (categoria === "treino") return 7.00;
  if (categoria === "patrocinador") return 8.00;
  if (categoria === "escudo3d") return 4.00;

  if (categoria === "proximo_jogo_jogador") return 7.00;
  if (categoria === "resultado_jogo_jogador") return 8.00;
  if (categoria === "jogador_escudo") return 6.00;
  if (categoria === "mascote_uniforme") {
    if (cliente && cliente.brinde_mascote_disponivel === true) return 0;
    return 18.00;
  }

  return 0;
}

function nomeCategoriaPedido(categoria) {
  const registryName = productsRegistry.getProductName(categoria);
  if (registryName) return registryName;

  const nomes = {
    resultado: "Resultado do jogo",
    escalacao: "Escalação",
    contratacao: "Contratação",
    proximo_jogo: "Próximo jogo",
    treino: "Dia de Treino",
    patrocinador: "Patrocinador / Apoio",
    escudo3d: "Escudo 3D",
    proximo_jogo_jogador: "Próximo jogo jogador",
    resultado_jogo_jogador: "Resultado jogador",
    jogador_escudo: "Jogador + escudo",
    mascote_uniforme: "Mascote + uniforme"
  };

  return nomes[categoria] || categoria || "";
}

function normalizarLoginId(valor) {
  return String(valor || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "");
}

function loginIdIsValid(value) {
  const login = String(value || "");
  return login.length >= 3 && login.length <= 160;
}

function loginIdIsReserved(value) {
  const login = normalizarLoginId(value);
  return login === BOT_ADMIN_WHATSAPP ||
    login.startsWith(APP_REVIEW_LOGIN_PREFIX) ||
    login.startsWith("google_") ||
    login.startsWith("auto_");
}

function tenantKeyForLogin(login, clientes) {
  const normalizedLogin = normalizarLoginId(login);
  if (!normalizedLogin || !clientes || typeof clientes !== "object") return "";

  const aliasMatches = Object.entries(clientes)
    .filter(([, client]) => (
      client &&
      typeof client === "object" &&
      normalizarLoginId(client.login_id) === normalizedLogin
    ))
    .map(([tenantKey]) => tenantKey);
  if (aliasMatches.length === 1) {
    return aliasMatches[0];
  }
  if (aliasMatches.length > 1) return "";

  const direct = clientes[normalizedLogin];
  if (!direct || typeof direct !== "object") return "";
  const publicLogin = normalizarLoginId(direct.login_id);
  return !publicLogin || publicLogin === normalizedLogin ? normalizedLogin : "";
}

function loginIdExists(login, clientes) {
  return Boolean(tenantKeyForLogin(login, clientes) || clientes?.[normalizarLoginId(login)]);
}

function gerarSenhaAutomatica() {
  return `ia4-${crypto.randomBytes(12).toString("base64url")}-9A`;
}

function criarLoginAutomaticoUnico(base, clientes) {
  let loginBase = normalizarLoginId(base).slice(0, 100);

  if (!loginBase || loginBase.length < 3) {
    loginBase = "jogador";
  }

  let login = `auto_${loginBase}_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;

  while (loginIdExists(login, clientes)) {
    login = `auto_${loginBase}_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
  }

  return login;
}

function nowYYYYMM() {
  return orderStorage.nowYYYYMM();
}

function newPedidoId() {
  return orderStorage.newPedidoId();
}

function getPedidoBase(whatsapp, pedidoId) {
  return orderStorage.getPedidoBase(PEDIDOS_DIR, whatsapp, pedidoId);
}

const ORDER_MEDIA_URL_CACHE_REUSE_MS = 4 * 60 * 1000;
const ORDER_MEDIA_URL_CACHE_MAX_ENTRIES = 20_000;
const orderMediaUrlCache = new Map();

function allowProtectedCrossOriginMedia(res) {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

function safeReadJson(filePath) {
  return orderStorage.safeReadJson(filePath);
}

function isBotAdmin(req) {
  return req.user && req.user.whatsapp === BOT_ADMIN_WHATSAPP;
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const idx = item.indexOf("=");
      if (idx === -1) return cookies;
      const key = decodeURIComponent(item.slice(0, idx).trim());
      const value = decodeURIComponent(item.slice(idx + 1).trim());
      cookies[key] = value;
      return cookies;
    }, {});
}

function bearerTokenFromRequest(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  const cookies = parseCookies(req);
  return String(cookies[ADMIN_ANALYTICS_COOKIE] || "").trim();
}

function verifyBotAdminToken(token) {
  if (!token) return null;
  try {
    const user = verifyUserToken(token);
    if (user?.whatsapp !== BOT_ADMIN_WHATSAPP) return null;
    const client = readClientes()[user.whatsapp];
    if (!client || client.ativo === false) return null;
    return user;
  } catch {
    return null;
  }
}

function setAdminAnalyticsCookie(res, token) {
  res.cookie(ADMIN_ANALYTICS_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 12 * 60 * 60 * 1000,
    path: "/bot"
  });
}

function botAdminAuth(req, res, next) {
  const token = bearerTokenFromRequest(req);
  const user = verifyBotAdminToken(token);

  if (!user) {
    return res.status(401).json({ ok: false, error: "Acesso restrito ao admin" });
  }

  req.user = user;
  return next();
}

function adminAnalyticsLoginPage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Analytics Mobile IA4Tube - Acesso restrito</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090d14;color:#eef4ff;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(420px,calc(100% - 32px));background:#111827;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:24px;box-shadow:0 18px 50px rgba(0,0,0,.35)}
    h1{margin:0 0 8px;font-size:24px}p{color:#93a4bd}label{display:block;margin-top:18px;color:#cbd5e1}input{width:100%;margin-top:8px;border:1px solid rgba(255,255,255,.14);border-radius:12px;background:#0b1220;color:#fff;padding:12px}button{width:100%;margin-top:16px;border:0;border-radius:12px;background:#35d07f;color:#06110b;font-weight:800;padding:12px;cursor:pointer}.msg{min-height:22px;color:#ff6b7a}
  </style>
</head>
<body>
  <main>
    <h1>Analytics Mobile</h1>
    <p>Acesso restrito ao admin iA4Tube.</p>
    <label>Token admin
      <input id="token" type="password" autocomplete="off" autofocus>
    </label>
    <button id="enter" type="button">Entrar</button>
    <p id="msg" class="msg"></p>
  </main>
  <script>
    async function login(){
      const token = document.getElementById("token").value.trim();
      const msg = document.getElementById("msg");
      msg.textContent = "";
      if(!token){ msg.textContent = "Informe o token admin."; return; }
      const response = await fetch("/bot/mobile-analytics/login", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({ token })
      });
      if(response.ok){ location.href = "/bot/mobile-analytics"; return; }
      msg.textContent = "Acesso negado. Confira o token admin.";
    }
    document.getElementById("enter").addEventListener("click", login);
    document.getElementById("token").addEventListener("keydown", (event) => {
      if(event.key === "Enter") login();
    });
  </script>
</body>
</html>`;
}

function mobileAnalyticsPanelAuth(req, res, next) {
  const user = verifyBotAdminToken(bearerTokenFromRequest(req));
  if (!user) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(401).send(adminAnalyticsLoginPage());
  }
  req.user = user;
  return next();
}

app.post("/bot/mobile-analytics/login", (req, res) => {
  const token = String(req.body?.token || "").trim();
  const user = verifyBotAdminToken(token);

  if (!user) {
    return res.status(401).json({ ok: false, error: "Acesso restrito ao admin" });
  }

  setAdminAnalyticsCookie(res, token);
  return res.json({ ok: true });
});

app.post("/bot/mobile-analytics/logout", (_req, res) => {
  res.clearCookie(ADMIN_ANALYTICS_COOKIE, {
    secure: true,
    sameSite: "strict",
    path: "/bot"
  });
  return res.json({ ok: true });
});

app.get("/bot/mobile-analytics", mobileAnalyticsPanelAuth, (_req, res) => {
  if (!fs.existsSync(ADMIN_MOBILE_ANALYTICS_FILE)) {
    return res.status(404).send("Painel mobile analytics nao encontrado");
  }

  res.setHeader("Cache-Control", "no-store");
  return res.sendFile(ADMIN_MOBILE_ANALYTICS_FILE);
});

function maskSensitiveIdentifier(value = "") {
  const raw = String(value || "").replace(/\D+/g, "");
  if (!raw) return "";
  if (raw.length <= 4) return "****";
  return `${raw.slice(0, 2)}****${raw.slice(-3)}`;
}

function sanitizeAnalyticsPayloadForResponse(value, depth = 0) {
  const sensitiveParts = [
    "telefone",
    "phone",
    "whatsapp",
    "cliente_id",
    "cliente",
    "nome",
    "empresa",
    "email",
    "senha",
    "password",
    "documento",
    "cpf",
    "cnpj",
    "endereco",
    "address",
    "token",
    "authorization",
    "auth",
    "pix",
    "copia_cola",
    "copiaecola",
    "prompt",
    "image",
    "imagem",
    "foto",
    "url",
    "uri",
    "base64"
  ];

  if (depth > 4 || value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeAnalyticsPayloadForResponse(item, depth + 1));
  }

  if (typeof value === "object") {
    return Object.entries(value).reduce((safe, [key, item]) => {
      const normalizedKey = String(key || "").toLowerCase();
      if (!normalizedKey || sensitiveParts.some((part) => normalizedKey.includes(part))) {
        return safe;
      }
      safe[key] = sanitizeAnalyticsPayloadForResponse(item, depth + 1);
      return safe;
    }, {});
  }

  if (typeof value === "string") {
    if (value.length > 180) return `${value.slice(0, 177)}...`;
    return value;
  }

  if (["number", "boolean"].includes(typeof value)) return value;
  return "";
}

function sanitizeAnalyticsEventForResponse(event = {}) {
  const maskedClient = maskSensitiveIdentifier(event.whatsapp || event.cliente_id);
  const safe = sanitizeAnalyticsPayloadForResponse(event) || {};

  safe.cliente_mascarado = maskedClient;
  safe.payload = sanitizeAnalyticsPayloadForResponse(event.payload || {});

  delete safe.whatsapp;
  delete safe.cliente_id;
  delete safe.cliente;
  delete safe.email;
  delete safe.token;

  return safe;
}

function sanitizeOnlineUserForResponse(user = {}) {
  const safe = sanitizeAnalyticsPayloadForResponse(user) || {};
  const maskedClient = maskSensitiveIdentifier(user.whatsapp || user.cliente_id);

  safe.cliente_mascarado = maskedClient;
  safe.online = Boolean(user.online);
  safe.ultima_atividade = user.ultima_atividade || "";
  safe.pagina_atual = user.pagina_atual || "";
  safe.produto_atual = user.produto_atual || "";
  safe.chat_aberto = Boolean(user.chat_aberto);
  safe.ultima_acao = user.ultima_acao || "";
  safe.campo_atual = user.campo_atual || "";
  safe.ultima_acao_evento = user.ultima_acao_evento || "";
  safe.tempo_inativo_ms = Number(user.tempo_inativo_ms || 0);
  safe.ultimo_evento = user.ultimo_evento || "";

  delete safe.whatsapp;
  delete safe.cliente_id;
  delete safe.email;
  delete safe.token;
  delete safe.foto_google;

  return safe;
}

function getPedidoBaseGlobal(pedidoId) {
  return orderStorage.getPedidoBaseGlobal(PEDIDOS_DIR, pedidoId);
}

function getPedidoOwnerFromBase(base) {
  const relative = path.relative(
    path.resolve(PEDIDOS_DIR),
    path.resolve(String(base || ""))
  );
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return "";
  }
  const [owner] = relative.split(path.sep);
  return orderStorage.isSafePathSegment(owner) ? owner : "";
}

function listPedidoBasesByWhatsapp(whatsapp) {
  return orderStorage.listPedidoBasesByWhatsapp(PEDIDOS_DIR, whatsapp);
}

function removeOldPedidos(whatsapp, maxKeep = 15) {
  return orderStorage.removeOldPedidos(PEDIDOS_DIR, whatsapp, maxKeep);
}

function readPedido(base) {
  return orderStorage.readOrder(base);
}

function writePedido(base, pedido) {
  return orderStorage.writeOrder(base, pedido);
}

function readOrderStatus(base, fallback = "") {
  return orderStorage.readStatus(base, fallback);
}

function writeOrderStatus(base, status) {
  return orderStorage.writeStatus(base, status);
}

function readJsonArraySafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = JSON.parse(fs.readFileSync(filePath, "utf8") || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeJsonSafe(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function readJsonObjectSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const data = JSON.parse(fs.readFileSync(filePath, "utf8") || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

const activeFreeArtClaimLocks = new Set();

function firstHeaderValue(value) {
  if (Array.isArray(value)) return firstHeaderValue(value[0]);
  return String(value || "").split(",")[0].trim();
}

function normalizeClientIp(value) {
  let ip = String(value || "").trim();
  if (!ip) return "";

  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));

  return ip;
}

function getClientIp(req) {
  const candidates = [
    firstHeaderValue(req.headers["cf-connecting-ip"]),
    firstHeaderValue(req.headers["true-client-ip"]),
    firstHeaderValue(req.headers["x-real-ip"]),
    firstHeaderValue(req.headers["x-forwarded-for"]),
    req.ip,
    req.socket?.remoteAddress
  ];

  for (const candidate of candidates) {
    const ip = normalizeClientIp(candidate);
    if (ip) return ip;
  }

  return "";
}

function hashFreeArtIp(ip) {
  const normalizedIp = normalizeClientIp(ip);
  if (!normalizedIp) return "";
  return crypto
    .createHash("sha256")
    .update(`ia4tube-free-art-ip:${JWT_SECRET}:${normalizedIp}`)
    .digest("hex");
}

function maskClientIp(ip) {
  const normalizedIp = normalizeClientIp(ip);
  if (!normalizedIp) return "";

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalizedIp)) {
    const parts = normalizedIp.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }

  const segments = normalizedIp.split(":").filter(Boolean);
  return segments.length ? `${segments.slice(0, 3).join(":")}::` : "";
}

function readFreeArtIpLocks() {
  return readJsonObjectSafe(FREE_ART_IP_LOCKS_FILE);
}

function writeFreeArtIpLocks(locks) {
  writeJsonSafe(FREE_ART_IP_LOCKS_FILE, locks && typeof locks === "object" ? locks : {});
}

function cleanupExpiredFreeArtIpLocks(locks, now = new Date()) {
  let changed = false;
  const current = now instanceof Date ? now : new Date(now);

  for (const [key, lock] of Object.entries(locks || {})) {
    const blockedUntil = new Date(lock?.bloqueado_ate || 0);
    if (!lock || Number.isNaN(blockedUntil.getTime()) || blockedUntil <= current) {
      delete locks[key];
      changed = true;
    }
  }

  return changed;
}

function getFreeArtIpLockStatus(req, now = new Date()) {
  const ip = getClientIp(req);
  const ipHash = hashFreeArtIp(ip);
  const ipMasked = maskClientIp(ip);

  if (!ipHash) {
    return { blocked: false, ipHash: "", ipMasked: "", lock: null };
  }

  const locks = readFreeArtIpLocks();
  const cleaned = cleanupExpiredFreeArtIpLocks(locks, now);
  const lock = locks[ipHash] || null;
  const blockedUntil = new Date(lock?.bloqueado_ate || 0);
  const blocked = lock && !Number.isNaN(blockedUntil.getTime()) && blockedUntil > now;

  if (cleaned) writeFreeArtIpLocks(locks);

  return {
    blocked: Boolean(blocked),
    ipHash,
    ipMasked,
    lock: blocked ? lock : null
  };
}

function acquireFreeArtClaimLocks(whatsapp, ipHash) {
  const keys = [
    `user:${String(whatsapp || "").trim()}`,
    ipHash ? `ip:${ipHash}` : ""
  ].filter(Boolean);

  if (!keys.length || keys.some((key) => activeFreeArtClaimLocks.has(key))) return [];
  keys.forEach((key) => activeFreeArtClaimLocks.add(key));
  return keys;
}

function releaseFreeArtClaimLocks(keys = []) {
  for (const key of keys) {
    activeFreeArtClaimLocks.delete(key);
  }
}

function recordFreeArtIpLock(req, { whatsapp, pedidoId, context = "arte_empresa" } = {}) {
  try {
    const ip = getClientIp(req);
    const ipHash = hashFreeArtIp(ip);
    if (!ipHash) return null;

    const now = new Date();
    const blockedUntil = new Date(now.getTime() + FREE_ART_IP_LOCK_MS);
    const locks = readFreeArtIpLocks();
    cleanupExpiredFreeArtIpLocks(locks, now);

    const lock = {
      ip_hash: ipHash,
      ip_mascarado: maskClientIp(ip),
      cliente: String(whatsapp || "").trim(),
      pedido_id: String(pedidoId || "").trim(),
      contexto: String(context || "").trim() || "arte_empresa",
      usado_em: now.toISOString(),
      bloqueado_ate: blockedUntil.toISOString(),
      dias_bloqueio: FREE_ART_IP_LOCK_DAYS
    };

    locks[ipHash] = lock;
    writeFreeArtIpLocks(locks);

    return lock;
  } catch (error) {
    console.warn("[free-art-ip] erro ao registrar bloqueio", { message: error?.message });
    return null;
  }
}

function marketingVideoViewKey(videoId, version, context) {
  return [context, videoId, version]
    .map((value) => String(value || "").trim().replace(/\s+/g, "_"))
    .join("|");
}

function readMarketingVideoViews() {
  return readJsonObjectSafe(MARKETING_VIDEO_VIEWS_FILE);
}

function writeMarketingVideoViews(views) {
  writeJsonSafe(MARKETING_VIDEO_VIEWS_FILE, views && typeof views === "object" ? views : {});
}

function getMarketingVideoViewStatus(whatsapp, videoId, version, context) {
  const userId = String(whatsapp || "").trim();
  if (!userId || !videoId) {
    return { ja_visto: false };
  }

  const views = readMarketingVideoViews();
  const key = marketingVideoViewKey(videoId, version, context);
  const record = views[userId]?.[key] || null;
  return {
    ja_visto: Boolean(record?.started_at || record?.viewed_at || record?.completed_at)
  };
}

function marketingVideoEventDetails(event) {
  const payload = event?.p && typeof event.p === "object" ? event.p : {};
  const nested = payload.payload && typeof payload.payload === "object" ? payload.payload : {};
  return { ...payload, ...nested };
}

function updateMarketingVideoViewsFromEvents(whatsapp, eventos = [], atIso = new Date().toISOString()) {
  const userId = String(whatsapp || "").trim();
  if (!userId || !Array.isArray(eventos) || eventos.length === 0) return;

  let views = null;
  let changed = false;

  eventos.forEach((event) => {
    const eventName = String(event?.e || "").trim();
    if (!eventName.startsWith("mobile_video_marketing_")) return;
    if (eventName === "mobile_video_marketing_erro") return;

    const details = marketingVideoEventDetails(event);
    const videoId = String(details.video_id || details.videoId || "").trim();
    if (!videoId) return;

    const version = String(details.versao || details.version || "").trim();
    const context = String(details.contexto || details.context || FIRST_FREE_ART_VIDEO_CONTEXT).trim() || FIRST_FREE_ART_VIDEO_CONTEXT;
    const watchedSeconds = Number(details.tempo_assistido_segundos || details.segundos || 0);
    const percentFromName = Number((eventName.match(/_(25|50|75|100)$/) || [])[1] || 0);
    const percent = Math.max(percentFromName, Number(details.percentual || 0) || 0);
    const shouldMarkStarted =
      eventName === "mobile_video_marketing_iniciado" ||
      percent > 0 ||
      (eventName === "mobile_video_marketing_abandonou" && watchedSeconds > 0);

    if (!shouldMarkStarted) return;

    if (!views) views = readMarketingVideoViews();
    const key = marketingVideoViewKey(videoId, version, context);
    const userViews = views[userId] && typeof views[userId] === "object" ? views[userId] : {};
    const record = userViews[key] && typeof userViews[key] === "object" ? userViews[key] : {};

    record.video_id = videoId;
    record.versao = version;
    record.contexto = context;
    record.last_seen_at = atIso;
    record.last_event = eventName;
    record.max_percent = Math.max(Number(record.max_percent || 0), percent);
    record.last_watched_seconds = Math.max(Number(record.last_watched_seconds || 0), watchedSeconds);

    if (!record.started_at) record.started_at = atIso;
    if (eventName === "mobile_video_marketing_iniciado") {
      record.started_count = Number(record.started_count || 0) + 1;
    }
    if (percent >= 75 && !record.viewed_at) record.viewed_at = atIso;
    if (percent >= 100 && !record.completed_at) record.completed_at = atIso;

    const pedidoId = String(details.pedido_id || details.pedidoId || event?.pedido_id || "").trim();
    if (pedidoId) record.last_pedido_id = pedidoId;

    userViews[key] = record;
    views[userId] = userViews;
    changed = true;
  });

  if (changed) {
    writeMarketingVideoViews(views);
  }
}

function salvarEventosCliente(req, eventos = []) {
  try {
    if (!Array.isArray(eventos) || eventos.length === 0) return;

    const agora = new Date();
    const agoraIso = agora.toISOString();

    const yyyy = agora.getFullYear();
    const mm = String(agora.getMonth() + 1).padStart(2, "0");
    const dd = String(agora.getDate()).padStart(2, "0");

    const analyticsDiaFile = path.join(
      ANALYTICS_DIR,
      `${yyyy}-${mm}-${dd}.json`
    );

    const atuais = readJsonArraySafe(analyticsDiaFile);

    const cliente = req.user ? getClienteResumo(req.user.whatsapp) : null;
    updateMarketingVideoViewsFromEvents(req.user?.whatsapp, eventos, agoraIso);

    if (
      cliente?.nome_time &&
      CLIENTES_TESTE.includes(cliente.nome_time)
    ) {
      return;
    }

    const ultimoEventoPorSessao = {};

    atuais.slice(-300).forEach(ev => {
      if (!ev?.sessao) return;
      ultimoEventoPorSessao[ev.sessao] = ev;
    });

    eventos.forEach(ev => {
      const payload = ev.p || {};
      const pedidoId = String(payload.pedido_id || ev.pedido_id || "").trim();

      const item = {
        data: agoraIso,
        cliente_id: cliente?.cliente_id || "",
        nome_time: cliente?.nome_time || "",
        whatsapp: cliente?.whatsapp || "",
        sessao: ev.sessao || "",
        evento: ev.e || "",
        produto: ev.produto || "",
        categoria: ev.categoria || "",
        pedido_id: pedidoId,
        pagina: ev.url || "",
        logado: !!ev.logado,

        campo_atual: payload.campo_atual || "",
        ultima_acao: payload.ultima_acao || "",
        tempo_inativo_ms: Number(payload.tempo_inativo_ms || 0),

        payload
      };

      const ultimo = ultimoEventoPorSessao[item.sessao];

      if (
        item.evento === "campo_foco" &&
        ultimo &&
        ultimo.evento === "campo_foco" &&
        ultimo.campo_atual === item.campo_atual
      ) {
        return;
      }

      if (
        item.evento === "click_interface" &&
        ultimo &&
        ultimo.evento === "click_interface" &&
        ultimo.campo_atual === item.campo_atual &&
        (new Date(item.data).getTime() - new Date(ultimo.data).getTime()) < 2000
      ) {
        return;
      }

      if (
        item.evento === "usuario_inativo"
      ) {
        const tempo = Number(item.tempo_inativo_ms || 0);

        const faixa =
          tempo >= 900000 ? "15m" :
          tempo >= 300000 ? "5m" :
          tempo >= 60000 ? "1m" :
          "0";

        item.faixa_inatividade = faixa;

        if (
          ultimo &&
          ultimo.evento === "usuario_inativo" &&
          ultimo.faixa_inatividade === faixa
        ) {
          return;
        }
      }

      atuais.push(item);
      ultimoEventoPorSessao[item.sessao] = item;

      if (pedidoId && req.user?.whatsapp) {
        try {
          const basePedido = getPedidoBase(req.user.whatsapp, pedidoId);

          if (basePedido) {
            const eventosPedidoFile = path.join(basePedido, "eventos_cliente.json");
            const eventosPedido = readJsonArraySafe(eventosPedidoFile);

            eventosPedido.push(item);

            const limitePedido = 500;

            if (eventosPedido.length > limitePedido) {
              eventosPedido.splice(0, eventosPedido.length - limitePedido);
            }

            writeJsonSafe(eventosPedidoFile, eventosPedido);
          }
        } catch {}
      }
    });

    const limite = 50000;

    if (atuais.length > limite) {
      atuais.splice(0, atuais.length - limite);
    }

    writeJsonSafe(analyticsDiaFile, atuais);

    const resumo = {
      atualizado_em: agoraIso,
      total_eventos: atuais.length,
      visitas: atuais.filter(e => e.evento === "pagina_aberta").length,
      pedidos_concluidos: atuais.filter(e => e.evento === "pedido_concluido").length,
      downloads: atuais.filter(e => e.evento === "baixou_imagem").length,
      suporte: atuais.filter(e => e.evento === "abriu_suporte").length,
      erros: atuais.filter(e => String(e.evento || "").includes("erro")).length
    };

    writeJsonSafe(
      path.join(ANALYTICS_DIR, "analytics_resumo.json"),
      resumo
    );

  } catch {}
}

function sanitizeServerAnalyticsPayload(payload = {}) {
  const sensitiveParts = [
    "telefone",
    "phone",
    "whatsapp",
    "email",
    "senha",
    "password",
    "token",
    "authorization",
    "auth",
    "pix",
    "copia_cola",
    "copiaecola",
    "prompt",
    "image",
    "imagem",
    "foto",
    "url",
    "uri",
    "base64"
  ];

  return Object.entries(payload || {}).reduce((safe, [key, value]) => {
    const normalizedKey = String(key || "").toLowerCase();
    if (!normalizedKey || sensitiveParts.some((part) => normalizedKey.includes(part))) {
      return safe;
    }

    if (value === null || value === undefined) {
      return safe;
    }

    if (["string", "number", "boolean"].includes(typeof value)) {
      safe[key] = typeof value === "string" ? value.slice(0, 160) : value;
    }

    return safe;
  }, {});
}

function registrarEventoServidor(evento, options = {}) {
  try {
    const eventName = String(evento || "").trim();
    if (!eventName) return;

    const whatsapp = String(options.whatsapp || "").trim();
    const pedidoId = String(options.pedidoId || options.pedido_id || "").trim();
    const payload = sanitizeServerAnalyticsPayload({
      origem: "backend",
      ...options.payload,
      pedido_id: pedidoId
    });

    salvarEventosCliente(
      { user: whatsapp ? { whatsapp } : null },
      [{
        e: eventName,
        sessao: `server_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        t: Date.now(),
        produto: String(options.produto || "").trim(),
        categoria: String(options.categoria || "").trim(),
        logado: Boolean(whatsapp),
        p: payload
      }]
    );
  } catch {}
}

function getClienteResumo(whatsapp) {
  const clientes = readClientes();
  const c = clientes[whatsapp] || {};

  return {
    whatsapp,
    cliente_id: whatsapp,
    nome_time: c.nome_time || "",
    login_tipo: c.login_tipo || "whatsapp",
    email: c.email || "",
    foto_google: c.foto_google || "",
    saldo: Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0),
    usados_no_ciclo: Number(c.usados_no_ciclo || 0)
  };
}

function registrarOnline(req, extra = {}) {
  try {
    if (!req.user || !req.user.whatsapp) return;

    const online = safeReadJson(ONLINE_FILE) || {};
    const whatsapp = req.user.whatsapp;
    const cliente = getClienteResumo(whatsapp);

    online[whatsapp] = {
      ...cliente,
      online: true,
      ultima_atividade: new Date().toISOString(),
      pagina_atual: extra.pagina_atual || req.headers["x-ia4-page"] || "",
      produto_atual: extra.produto_atual || req.headers["x-ia4-product"] || "",
      chat_aberto: String(extra.chat_aberto ?? req.headers["x-ia4-chat"] ?? "") === "true",
      ultima_acao: extra.ultima_acao || req.headers["x-ia4-action"] || ""
    };

    fs.writeFileSync(ONLINE_FILE, JSON.stringify(online, null, 2), "utf8");
  } catch {}
}

function listarOnlineRecentes() {
  const online = safeReadJson(ONLINE_FILE) || {};
  const eventos = readJsonArraySafe(EVENTOS_CLIENTES_FILE);

  const agora = Date.now();
  const limiteMs = 2 * 60 * 1000;

  const usuarios = Object.values(online)
    .filter(u => {
      const t = new Date(u.ultima_atividade || 0).getTime();
      return t && agora - t <= limiteMs;
    })
    .sort((a, b) => new Date(b.ultima_atividade) - new Date(a.ultima_atividade));

  return usuarios.map(u => {
    const ultimos = eventos
      .filter(ev => ev.whatsapp === u.whatsapp)
      .slice(-30);

    const ultimo = ultimos[ultimos.length - 1] || {};

    return {
      ...u,
      campo_atual: ultimo.campo_atual || "",
      ultima_acao_evento: ultimo.ultima_acao || "",
      tempo_inativo_ms: Number(ultimo.tempo_inativo_ms || 0),
      ultimo_evento: ultimo.evento || ""
    };
  });
}

function salvarMensagemSuporteAberta(whatsapp, mensagemCliente, respostaIA, origem = "ia") {
  finalizarConversasSuporteInativas();

  const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
  const cliente = getClienteResumo(whatsapp);

  let conversa = abertas.find(c => c.whatsapp === whatsapp && !c.finalizada);

  if (!conversa) {
    conversa = {
      id: `${whatsapp}_${Date.now()}`,
      whatsapp,
      cliente,
      inicio: new Date().toISOString(),
      finalizada: false,
      status: "aberta",
      precisa_humano: false,
      cliente_leu: false,
      mensagens: []
    };
    abertas.push(conversa);
  }

  conversa.cliente = cliente;
  conversa.ultima_atualizacao = new Date().toISOString();

  if (mensagemCliente && String(mensagemCliente).trim()) {
    conversa.mensagens.push({
      id: `${Date.now()}_cliente`,
      data: new Date().toISOString(),
      autor: "cliente",
      texto: String(mensagemCliente || "").trim()
    });

    conversa.cliente_leu = true;
  }

  if (respostaIA && String(respostaIA).trim()) {
    conversa.mensagens.push({
      id: `${Date.now()}_${origem}`,
      data: new Date().toISOString(),
      autor: origem,
      texto: String(respostaIA || "").trim()
    });

    conversa.cliente_leu = false;
  }

  writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
  return conversa;
}

function finalizarConversaSuporte(whatsapp, motivo) {
  const abertasPath = SUPORTE_ABERTAS_FILE;
  const finalizadasPath = SUPORTE_FINALIZADAS_FILE;

  const abertas = readJsonArraySafe(abertasPath);
  const finalizadas = readJsonArraySafe(finalizadasPath);

  const idx = abertas.findIndex(c => c.whatsapp === whatsapp && !c.finalizada);

  if (idx === -1) return false;

  const conversa = abertas[idx];
  conversa.finalizada = true;
  conversa.fim = new Date().toISOString();
  conversa.motivo_finalizacao = motivo || "finalizacao_automatica";

  finalizadas.push(conversa);
  abertas.splice(idx, 1);

  writeJsonSafe(abertasPath, abertas);
  writeJsonSafe(finalizadasPath, finalizadas);

  return true;
}

function finalizarConversasSuporteInativas() {
  const abertasPath = SUPORTE_ABERTAS_FILE;
  const finalizadasPath = SUPORTE_FINALIZADAS_FILE;

  const abertas = readJsonArraySafe(abertasPath);
  if (abertas.length === 0) return;

  const finalizadas = readJsonArraySafe(finalizadasPath);
  const agora = Date.now();
  const limiteMs = 10 * 60 * 1000;

  const aindaAbertas = [];

  for (const conversa of abertas) {
    const ultima = new Date(conversa.ultima_atualizacao || conversa.inicio || 0).getTime();

    if (ultima && agora - ultima >= limiteMs) {
      conversa.finalizada = true;
      conversa.fim = new Date().toISOString();
      conversa.motivo_finalizacao = "inatividade_10_minutos";
      finalizadas.push(conversa);
    } else {
      aindaAbertas.push(conversa);
    }
  }

  writeJsonSafe(abertasPath, aindaAbertas);
  writeJsonSafe(finalizadasPath, finalizadas);
}

const legacyTenantContextMiddleware = createTenantContextMiddleware({
  resolveLegacyTenant: async ({ principalId }) => principalId,
  resolveTenant: async ({ tenantId }) => {
    const client = readClientes()[tenantId];
    if (!client) return null;
    return {
      id: tenantId,
      active: client.ativo !== false
    };
  },
  resolveMembership: async ({ tenantId, principalId }) => {
    if (tenantId !== principalId) return null;
    const client = readClientes()[tenantId];
    if (!client) return null;
    return {
      tenant_id: tenantId,
      principal_id: principalId,
      role: "owner",
      active: client.ativo !== false
    };
  }
});

app.use(createLegalPagesRouter());

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";

  if (!token) {
    return res.status(401).json({ ok: false, error: "Sem token" });
  }

  try {
    req.user = verifyUserToken(token);
    const client = readClientes()[req.user.whatsapp];
    if (!client) {
      return res.status(401).json({ ok: false, error: "Sessao sem conta ativa" });
    }
    if (client.ativo === false) {
      return res.status(403).json({ ok: false, error: "Conta inativa" });
    }
    req.auth = req.user;
    return legacyTenantContextMiddleware(req, res, next);
  } catch {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
}

if (GATE5A_STAGING_ENABLED) {
  app.use(
    "/v1/social/compliance",
    createMetaComplianceRouter({
      getService() {
        return socialRuntimeState?.enabled
          ? socialRuntimeState.metaCompliance
          : null;
      }
    })
  );
}

app.use("/v1/social", createInstagramOAuthRouter({
  authenticate: auth,
  visualReturn: instagramOAuthVisualReturn,
  getService() {
    return socialRuntimeState?.enabled
      ? socialRuntimeState.instagramOAuth
      : null;
  }
}));

if (REAL_REVIEWER_UI_ENABLED) {
  app.get(
    `${REAL_REVIEWER_MEDIA_CAPABILITY_PREFIX}/:mediaId/:expiresAt/:nonce/:ownerContext/:signature`,
    (req, res) => {
      const media = resolveRealReviewerMediaCapability(req);
      if (!media) return res.status(404).end();
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", String(media.bytes.length));
      res.setHeader("Cache-Control", "private, no-store, no-transform");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
      res.once("finish", () => media.bytes.fill(0));
      res.once("close", () => media.bytes.fill(0));
      return res.status(200).send(media.bytes);
    }
  );
  app.use(
    "/v1/social/reviewer",
    createInstagramRealReviewerRouter({
      authenticate: auth,
      getService() {
        return socialRuntimeState?.enabled
          ? socialRuntimeState.instagramReviewer
          : null;
      }
    })
  );
}

if (reviewerSandboxService) {
  app.get(
    `${REVIEWER_MEDIA_CAPABILITY_PREFIX}/:orderId/:expiresAt/:nonce/:ownerReference/:signature`,
    (req, res) => {
      const media = reviewerSandboxService.resolveMediaCapability(req);
      if (!media) return res.status(404).end();
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", String(media.bytes.length));
      res.setHeader("Cache-Control", "private, no-store, no-transform");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
      return res.status(200).send(media.bytes);
    }
  );
  app.use(
    "/v1/social/reviewer-sandbox",
    createReviewerSandboxRouter({
      authenticate: auth,
      ...(GATE5A_SYNTHETIC_BRIDGE_ENABLED
        ? { contextFromRequest: gate5aReviewerContextFromRequest }
        : {}),
      enabled: true,
      service: reviewerSandboxService
    })
  );
}

app.use("/v1/social", createInstagramPublicationRouter({
  authenticate: auth,
  getService() {
    return socialRuntimeState?.enabled
      ? socialRuntimeState.instagramPublication
      : null;
  }
}));

function botRunnerAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";

  if (!token) {
    return res.status(401).json({ ok: false, error: "Sem token" });
  }

  if (timingSafeSecretMatch(token, BOT_RUNNER_TOKENS)) {
    req.user = {
      whatsapp: BOT_ADMIN_WHATSAPP,
      bot_runner: true
    };
    return next();
  }

  try {
    req.user = verifyUserToken(token);
    const client = readClientes()[req.user.whatsapp];
    if (!client || client.ativo === false) {
      return res.status(client ? 403 : 401).json({ ok: false, error: "Acesso negado" });
    }

    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
}

// ===== UPLOAD (multer) =====
const TMP_UPLOAD_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const TMP_UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function flattenUploadedFiles(files = {}) {
  return Object.values(files).flat().filter(Boolean);
}

function cleanupUploadedFiles(files = {}) {
  for (const file of flattenUploadedFiles(files)) {
    try {
      if (file?.path) {
        const uploadRoot = path.resolve(TMP_UPLOADS_DIR);
        const resolvedFile = path.resolve(file.path);
        const relative = path.relative(uploadRoot, resolvedFile);
        if (
          relative &&
          !relative.startsWith("..") &&
          !path.isAbsolute(relative) &&
          fs.existsSync(resolvedFile)
        ) {
          fs.unlinkSync(resolvedFile);
        }
      }
    } catch (error) {
      console.warn("[uploads] falha ao remover temporario da requisicao", {
        path: file?.path,
        message: error?.message
      });
    }
  }
}

function cleanupOldTmpUploads() {
  try {
    ensureDir(TMP_UPLOADS_DIR);
    const now = Date.now();
    let removed = 0;
    let freedBytes = 0;

    for (const entry of fs.readdirSync(TMP_UPLOADS_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;

      const filePath = path.join(TMP_UPLOADS_DIR, entry.name);
      const stat = fs.statSync(filePath);

      if (now - stat.mtimeMs < TMP_UPLOAD_MAX_AGE_MS) continue;

      fs.unlinkSync(filePath);
      removed += 1;
      freedBytes += stat.size;
    }

    if (removed > 0) {
      console.log("[uploads] limpeza tmp_uploads", {
        removed,
        freed_mb: Number((freedBytes / 1024 / 1024).toFixed(2))
      });
    }
  } catch (error) {
    console.warn("[uploads] falha na limpeza tmp_uploads", {
      message: error?.message
    });
  }
}

function uploadExtensionForMime(file) {
  const mime = String(file?.mimetype || "").trim().toLowerCase();
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  return ".bin";
}

const storage = multer.diskStorage({
  destination: (req, file, cb) =>
    cb(null, TMP_UPLOADS_DIR),

  filename: (req, file, cb) => {
    cb(
      null,
      `${Date.now()}_${crypto.randomBytes(16).toString("hex")}${uploadExtensionForMime(file)}`
    );
  }
});

const CLIENT_UPLOAD_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function createAggregateLimitedDiskStorage({
  destination,
  maxTotalBytes = CLIENT_UPLOAD_MAX_TOTAL_BYTES
}) {
  const uploadRoot = path.resolve(destination);
  ensureDir(uploadRoot);

  return {
    _handleFile(req, file, cb) {
      const filename =
        `${Date.now()}_${crypto.randomBytes(16).toString("hex")}${uploadExtensionForMime(file)}`;
      const finalPath = path.join(uploadRoot, filename);
      const counter = new Transform({
        transform(chunk, encoding, done) {
          req.ia4tubeClientUploadBytes =
            Number(req.ia4tubeClientUploadBytes || 0) + chunk.length;
          if (req.ia4tubeClientUploadBytes > maxTotalBytes) {
            const error = new multer.MulterError("LIMIT_FILE_SIZE", file.fieldname);
            error.code = "LIMIT_TOTAL_FILE_SIZE";
            return done(error);
          }
          return done(null, chunk);
        }
      });
      const output = fs.createWriteStream(finalPath, { flags: "wx" });

      pipeline(file.stream, counter, output, (error) => {
        if (error) {
          return fs.rm(finalPath, { force: true }, () => cb(error));
        }
        return cb(null, {
          destination: uploadRoot,
          filename,
          path: finalPath,
          size: output.bytesWritten
        });
      });
    },

    _removeFile(req, file, cb) {
      const filePath = file?.path;
      delete file.destination;
      delete file.filename;
      delete file.path;
      if (!filePath) return cb(null);
      return fs.rm(filePath, { force: true }, cb);
    }
  };
}

const clientUploadStorage = createAggregateLimitedDiskStorage({
  destination: TMP_UPLOADS_DIR
});

const upload = multer({
  storage: clientUploadStorage,
  limits: {
    // Busboy emits LIMIT_FILE_COUNT when the configured count is reached.
    // Keep room for the monthly-planning schema: 36 photos plus the other
    // declared image fields total 81 files.
    files: 82,
    fields: 128,
    parts: 200,
    fieldSize: 256 * 1024,
    fileSize: 8 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const permitidos = [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp"
    ];

    if (!permitidos.includes(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("Apenas imagens PNG, JPG e WEBP são permitidas."));
    }

    cb(null, true);
  }
});

function requestUploadedFiles(req) {
  return [
    ...flattenUploadedFiles(req?.files || {}),
    ...(req?.file ? [req.file] : [])
  ];
}

function cleanupRequestUploadedFiles(req) {
  cleanupUploadedFiles({
    fields: flattenUploadedFiles(req?.files || {}),
    single: req?.file ? [req.file] : []
  });
}

function uploadedImageMatchesDeclaredType(file) {
  if (!file?.path || !fs.existsSync(file.path)) return false;
  const header = Buffer.alloc(12);
  let descriptor;
  let bytesRead = 0;
  try {
    descriptor = fs.openSync(file.path, "r");
    bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
  }

  const mime = String(file.mimetype || "").trim().toLowerCase();
  const isPng = bytesRead >= 8 &&
    header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = bytesRead >= 3 &&
    header[0] === 0xff &&
    header[1] === 0xd8 &&
    header[2] === 0xff;
  const isWebp = bytesRead >= 12 &&
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP";

  if (mime === "image/png") return isPng;
  if (mime === "image/jpeg" || mime === "image/jpg") return isJpeg;
  if (mime === "image/webp") return isWebp;
  return false;
}

function validateClientImageUploads(req, res, next) {
  const invalid = requestUploadedFiles(req).find(
    (file) => !uploadedImageMatchesDeclaredType(file)
  );
  if (invalid) {
    cleanupRequestUploadedFiles(req);
    return res.status(415).json({
      ok: false,
      code: "invalid_image_content",
      error: "O conteudo do arquivo nao corresponde a uma imagem permitida."
    });
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupRequestUploadedFiles(req);
  };
  res.once("finish", cleanup);
  res.once("close", cleanup);
  return next();
}

function secureClientUpload(middleware) {
  return (req, res, next) => {
    const contentLength = Number(req.headers["content-length"]);
    if (
      Number.isFinite(contentLength) &&
      contentLength > CLIENT_UPLOAD_MAX_TOTAL_BYTES
    ) {
      return res.status(413).json({
        ok: false,
        code: "upload_limit_exceeded",
        error: "O envio ultrapassa o limite total permitido."
      });
    }

    return middleware(req, res, (error) => {
      if (error) {
        cleanupRequestUploadedFiles(req);
        return next(error);
      }
      return validateClientImageUploads(req, res, next);
    });
  };
}

function secureClientUploadFields(fields) {
  return secureClientUpload(upload.fields(fields));
}

function secureClientUploadSingle(field) {
  return secureClientUpload(upload.single(field));
}

const productDiscoveryUpload = multer({
  storage,
  limits: {
    files: 1,
    fileSize: 3 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const permitidos = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
    if (!permitidos.includes(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("Apenas imagens PNG, JPG e WEBP são permitidas."));
    }
    return cb(null, true);
  }
});

const uploadResultado = multer({ storage });

const PEDIDO_UPLOAD_FIELDS = [
  { name: "escudo1", maxCount: 1 },
  { name: "escudo2", maxCount: 1 },
  { name: "mascote", maxCount: 1 },
  { name: "patrocinadores", maxCount: 20 },
  { name: "logo", maxCount: 1 },
  { name: "fotos", maxCount: 20 },
  { name: "referencias", maxCount: 20 },
  { name: "modelo_existente", maxCount: 1 }
];

const MONTHLY_PLANNING_REQUEST_MAX_ITEMS = Math.max(
  1,
  Number(monthlyPlanningService._private?.MAX_MONTHLY_PLANNING_REQUEST_ITEMS || 20) || 20
);
const MONTHLY_PLANNING_UPLOAD_FIELDS = PEDIDO_UPLOAD_FIELDS.map((field) => (
  field.name === "fotos"
    ? { ...field, maxCount: Math.max(field.maxCount, MONTHLY_PLANNING_REQUEST_MAX_ITEMS) }
    : field
));
const productDiscoveryInFlight = new Set();

app.use("/bot/free-art-campaigns", createFreeArtCampaignRoutes({
  service: freeArtCampaignsService,
  storage: freeArtCampaignsStorage,
  uploadResultado,
  config: {
    enabled: adminFreeArtsEnabled,
    maxArts: adminFreeArtsMaxArts,
    stuckTimeoutMs: adminFreeArtsGeneratingTimeoutMs,
    stuckAction: adminFreeArtsStuckAction
  },
  paths: {
    baseDir: FREE_ART_CAMPAIGNS_DIR,
    pedidosDir: PEDIDOS_DIR,
    panelFile: ADMIN_FREE_ART_CAMPAIGNS_FILE
  },
  auth: botAdminAuth,
  botRunnerAuth,
  isBotAdmin,
  readClientes,
  cleanupUploadedFiles,
  composeLogo: composeFreeArtLogo
}));

// ===== ROTAS =====

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, msg: "omascote-api online" });
});

function sendReviewerApplication(req, res, { realReviewer = false } = {}) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (realReviewer || isRealReviewerLoginHandoffUrl(req.originalUrl)) {
    res.setHeader(
      "Content-Security-Policy",
      REAL_REVIEWER_CONTENT_SECURITY_POLICY
    );
  }
  return res.sendFile(CANONICAL_WEB_APP_FILE);
}

app.get("/app.html", (req, res) => {
  if (!(GATE5A_STAGING_ENABLED || REAL_REVIEWER_UI_ENABLED)) {
    return res.status(404).end();
  }
  return sendReviewerApplication(req, res);
});

app.get("/reviewer", (req, res) => {
  if (!REAL_REVIEWER_UI_ENABLED) return res.status(404).end();
  return sendReviewerApplication(req, res, { realReviewer: true });
});

app.get("/gate5a-reviewer-flow.js", (_req, res) => {
  if (!(GATE5A_STAGING_ENABLED || REAL_REVIEWER_UI_ENABLED)) {
    return res.status(404).end();
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  return res.type("application/javascript").sendFile(CANONICAL_REVIEWER_FLOW_FILE);
});

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (["1", "true", "yes", "sim", "on"].includes(value)) return true;
  if (["0", "false", "no", "nao", "n\u00e3o", "off"].includes(value)) return false;
  return fallback;
}

function adminFreeArtsEnabled() {
  return envBool("IA4TUBE_ADMIN_FREE_ARTS_ENABLED", false);
}

function adminFreeArtsNotificationsEnabled() {
  return adminFreeArtsEnabled() && envBool("IA4TUBE_ADMIN_FREE_ARTS_NOTIFICATIONS_ENABLED", false);
}

function adminFreeArtsMaxArts() {
  return Math.max(1, Math.min(envInt("IA4TUBE_ADMIN_FREE_ARTS_MAX_ARTS", 20), 20));
}

function adminFreeArtsGeneratingTimeoutMs() {
  return Math.max(
    60 * 1000,
    envInt("IA4TUBE_ADMIN_FREE_ARTS_GENERATING_TIMEOUT_MS", 30 * 60 * 1000)
  );
}

function adminFreeArtsStuckAction() {
  const action = String(process.env.IA4TUBE_ADMIN_FREE_ARTS_STUCK_ACTION || "pendente").trim().toLowerCase();
  return action === "erro" ? "erro" : "pendente";
}

function adminFreeArtsRecoveryIntervalMs() {
  return Math.max(
    60 * 1000,
    envInt("IA4TUBE_ADMIN_FREE_ARTS_RECOVERY_INTERVAL_MS", 5 * 60 * 1000)
  );
}

function adminFreeArtsNotificationsIntervalMs() {
  return Math.max(
    30 * 1000,
    envInt("IA4TUBE_ADMIN_FREE_ARTS_NOTIFICATIONS_INTERVAL_MS", 60 * 1000)
  );
}

function isAdminFreeArtOrderHidden(pedido = {}) {
  return freeArtCampaignsService.isFreeArtOrder(pedido) && !adminFreeArtsEnabled();
}

function sendHiddenAdminFreeArtOrder(res) {
  return res.status(404).json({
    ok: false,
    code: "admin_free_arts_disabled",
    error: "Pedido nao encontrado"
  });
}

function composeFreeArtLogo({ baseImagePath, logoPath, outputPath }) {
  const scriptPath = path.join(__dirname, "scripts", "compose_free_art_logo.py");
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: "compose_script_not_found" };
  }

  const result = spawnSync("python", [
    scriptPath,
    "--base", baseImagePath,
    "--logo", logoPath,
    "--out", outputPath
  ], {
    cwd: __dirname,
    encoding: "utf8",
    timeout: 30 * 1000
  });

  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr || result.stdout || "compose_failed"
    };
  }

  return { ok: true, output_path: outputPath };
}

function envMarketingVideo(name, context = "primeira_arte_gratis") {
  const suffix = String(context || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const scopedName = suffix ? `IA4TUBE_MARKETING_VIDEO_${suffix}_${name}` : "";
  return String((scopedName && process.env[scopedName]) || process.env[`IA4TUBE_MARKETING_VIDEO_${name}`] || "").trim();
}

function isHttpMediaUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const FIRST_FREE_ART_VIDEO_CONTEXT = "primeira_arte_gratis";
const DEFAULT_FIRST_FREE_ART_VIDEO_URL = `${PUBLIC_WEB_BASE_URL}/videos/primeira-arte-gratis.mp4`;
const DEFAULT_FIRST_FREE_ART_THUMBNAIL_URL = `${PUBLIC_WEB_BASE_URL}/videos/thumb-primeira-arte-gratis.jpg`;

function marketingVideoUrl(context) {
  const configuredVideoUrl = String(process.env.IA4TUBE_MARKETING_VIDEO_URL || "").trim();
  if (configuredVideoUrl) return configuredVideoUrl;
  return context === FIRST_FREE_ART_VIDEO_CONTEXT ? DEFAULT_FIRST_FREE_ART_VIDEO_URL : "";
}

function marketingVideoThumbnailUrl(context) {
  const configuredThumbnailUrl = envMarketingVideo("THUMBNAIL", context);
  if (configuredThumbnailUrl) return configuredThumbnailUrl;
  return context === FIRST_FREE_ART_VIDEO_CONTEXT ? DEFAULT_FIRST_FREE_ART_THUMBNAIL_URL : "";
}

app.get("/app/version", (req, res) => {
  const latestVersionCode = envInt("IA4TUBE_ANDROID_LATEST_VERSION_CODE", 5);
  const minimumVersionCode = envInt("IA4TUBE_ANDROID_MINIMUM_VERSION_CODE", 1);
  const latestVersionName = process.env.IA4TUBE_ANDROID_LATEST_VERSION_NAME || "0.1.0";

  return res.json({
    ok: true,
    latest_version_code: latestVersionCode,
    minimum_version_code: minimumVersionCode,
    latest_version_name: latestVersionName,
    update_required: envBool("IA4TUBE_ANDROID_UPDATE_REQUIRED", false),
    title: process.env.IA4TUBE_ANDROID_UPDATE_TITLE || "Nova vers\u00e3o dispon\u00edvel",
    message: process.env.IA4TUBE_ANDROID_UPDATE_MESSAGE ||
      "Atualize o app para receber melhorias, corre\u00e7\u00f5es e uma experi\u00eancia mais est\u00e1vel.",
    play_store_url: process.env.IA4TUBE_ANDROID_PLAY_STORE_URL ||
      "https://play.google.com/store/apps/details?id=com.ia4tube.app"
  });
});

app.get("/marketing/video", auth, (req, res) => {
  const context = String(req.query?.context || FIRST_FREE_ART_VIDEO_CONTEXT).trim() || FIRST_FREE_ART_VIDEO_CONTEXT;
  const enabledByFlag = envBool("IA4TUBE_MARKETING_VIDEO_ENABLED", context === FIRST_FREE_ART_VIDEO_CONTEXT);
  const videoUrl = marketingVideoUrl(context);
  const enabled = enabledByFlag && isHttpMediaUrl(videoUrl);
  const thumbnail = marketingVideoThumbnailUrl(context);
  const version = envMarketingVideo("VERSION", context) || new Date().toISOString().slice(0, 10);
  const id = envMarketingVideo("ID", context) || `${context}_${version}`.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const viewStatus = getMarketingVideoViewStatus(req.user?.whatsapp, id, version, context);
  const autoplay = enabled && !viewStatus.ja_visto;

  res.setHeader("Cache-Control", "no-store");

  return res.json({
    ok: true,
    ativo: enabled,
    id,
    context,
    contexto: context,
    titulo: envMarketingVideo("TITLE", context) || "Enquanto sua primeira arte fica pronta...",
    descricao: envMarketingVideo("DESCRIPTION", context) || "Veja como a iA4Tube pode ajudar seu negócio.",
    url_video: enabled ? videoUrl : "",
    thumbnail: isHttpMediaUrl(thumbnail) ? thumbnail : "",
    autoplay,
    ja_visto: viewStatus.ja_visto,
    duracao: envInt("IA4TUBE_MARKETING_VIDEO_DURATION", 0),
    versao: version,
    fallback: "progress_card"
  });
});

app.get("/tempo-estimado", (req, res) => {
  return res.json({
    ok: true,
    ...readTempoEstimado()
  });
});

app.post("/evento", (req, res) => {
  try {
    const eventos = Array.isArray(req.body?.eventos)
      ? req.body.eventos
      : [];
  const referencesOrder = eventos.some((event) => {
      const payload = event?.p || {};
      return Boolean(String(payload.pedido_id || event?.pedido_id || "").trim());
    });

    let clienteFake = null;
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";

    if (token) {
      try {
        clienteFake = verifyUserToken(token);
        const client = readClientes()[clienteFake.whatsapp];
        if (!client || client.ativo === false) {
          return res.status(client ? 403 : 401).json({ ok: false, error: "Acesso negado" });
        }
      } catch {
        return res.status(401).json({ ok: false, error: "Token invalido" });
      }
    }

    if (referencesOrder && !clienteFake) {
      return res.status(401).json({
        ok: false,
        code: "order_event_auth_required",
        error: "Autorizacao obrigatoria para eventos de pedido."
      });
    }

    if (referencesOrder) {
      const referencedOrderIds = [...new Set(eventos
        .map((event) => {
          const payload = event?.p || {};
          return String(payload.pedido_id || event?.pedido_id || "").trim();
        })
        .filter(Boolean))];
      const hasForeignOrMissingOrder = referencedOrderIds.some(
        (pedidoId) => !getPedidoBase(clienteFake.whatsapp, pedidoId)
      );
      if (hasForeignOrMissingOrder) {
        return res.status(404).json({
          ok: false,
          code: "order_event_not_found",
          error: "Pedido nao encontrado."
        });
      }
    }

    salvarEventosCliente(
      { user: clienteFake },
      eventos
    );

    return res.json({ ok:true });
  } catch {
    return res.status(500).json({
      ok:false,
      error:"erro_eventos"
    });
  }
});

app.post("/bot/tempo-estimado", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const payload = req.body || {};

  const tempo = {
    tempo_medio_segundos: Number(payload.tempo_medio_segundos ?? 0),
    tempo_estimado_segundos: Number(payload.tempo_estimado_segundos ?? 0),
    pedidos_na_fila: Number(payload.pedidos_na_fila || 0),
    lotes: Number(payload.lotes || 1),
    max_processos: Number(payload.max_processos || 5),
    atualizado_em: payload.atualizado_em || new Date().toISOString()
  };

  writeTempoEstimado(tempo);

  return res.json({ ok: true });
});

async function verificarGoogleIdToken(id_token) {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error("GOOGLE_CLIENT_ID não configurado");
  }

  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(id_token));
  const data = await r.json();

  if (!r.ok || data.aud !== GOOGLE_CLIENT_ID || !data.sub) {
    throw new Error("Token Google inválido");
  }

  return data;
}

app.get("/auth/google-config", (req, res) => {
  return res.json({
    ok: true,
    client_id: GOOGLE_CLIENT_ID
  });
});

app.post("/auth/google", loginRateLimitByIp, async (req, res) => {
  try {
    const { id_token } = req.body || {};

    if (!id_token) {
      return res.status(400).json({ ok: false, error: "id_token obrigatório" });
    }

    const google = await verificarGoogleIdToken(id_token);
    const clientes = readClientes();

    const chaveCliente = "google_" + String(google.sub).replace(/[^\w\-]+/g, "");
    const nomeGoogle = google.name || google.given_name || "Meu time";
    const emailGoogle = google.email || "";

    let c = clientes[chaveCliente];

    if (!c && tenantNamespaceExists(chaveCliente)) {
      return res.status(409).json({
        ok: false,
        code: "tenant_namespace_reserved",
        error: "Conta nao pode ser criada sobre dados existentes."
      });
    }

    if (
      c &&
      (
        c.login_tipo !== "google" ||
        String(c.google_id || "") !== String(google.sub)
      )
    ) {
      return res.status(409).json({
        ok: false,
        code: "google_identity_binding_conflict",
        error: "Identidade Google nao pode ser vinculada a esta conta."
      });
    }

    if (!c) {
      c = {
        nome_time: nomeGoogle,
        login_id: chaveCliente,
        senha_hash: "",
        login_tipo: "google",
        google_id: google.sub,
        email: emailGoogle,
        foto_google: google.picture || "",
        plano: 0,
        saldo_mensal: 0,
        saldo_extra: 0,
        artes_avulsas_restantes: 0,
        artes_avulsas_usadas: 0,
        artes_avulsas_total_compradas: 0,
        artes_avulsas_compras: [],
        artes_avulsas_consumos: [],
        usados_no_ciclo: 0,
        ciclo_mes: nowYYYYMM(),
        ativo: true
      };
      billingService.markFreeArtEligible(c);

      clientes[chaveCliente] = c;
      writeClientes(clientes);
    }

    const mesAtual = nowYYYYMM();
    if (c.ciclo_mes !== mesAtual) {
      c.ciclo_mes = mesAtual;
      c.usados_no_ciclo = 0;
      clientes[chaveCliente] = c;
      writeClientes(clientes);
    }

    const token = signUserToken(chaveCliente);

    return res.json({
      ok: true,
      token,
      nome_time: c.nome_time,
      plano: c.plano,
      saldo_mensal: Number(c.saldo_mensal || 0),
      saldo_extra: Number(c.saldo_extra || 0),
      ...billingService.getStandaloneArtStatus(c),
      saldo: Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0),
      usados_no_ciclo: c.usados_no_ciclo
    });

  } catch (e) {
    return res.status(401).json({
      ok: false,
      error: e.message || "Erro ao entrar com Google"
    });
  }
});

// Login automático invisível
app.post("/auth/auto-register", accountCreationRateLimit, (req, res) => {
  try {
    const body = req.body || {};
    const clientes = readClientes();

    const nome_time = String(
      body.nome_time ||
      body.nome_jogador ||
      body.login ||
      "Jogador"
    ).trim();

    const produtoOrigem = String(body.produto || "");
    const creditoPreviewInterno = getCustoPedido(produtoOrigem, null);
    const login = criarLoginAutomaticoUnico(body.login || nome_time, clientes);
    const senhaCliente = gerarSenhaAutomatica();
    const senha_hash = bcrypt.hashSync(senhaCliente, PASSWORD_BCRYPT_COST);

    const novo = {
      nome_time: nome_time || "Jogador",
      login_id: login,
      senha_hash,
      login_tipo: "automatico",
      cadastro_automatico: true,
      conta_finalizada: false,
      produto_origem: produtoOrigem,
      credito_preview_interno: Number(creditoPreviewInterno || 0),
      device_id: String(body.device_id || ""),
      plano: 0,
      saldo_mensal: 0,
      saldo_extra: 0,
      artes_avulsas_restantes: 0,
      artes_avulsas_usadas: 0,
      artes_avulsas_total_compradas: 0,
      artes_avulsas_compras: [],
      artes_avulsas_consumos: [],
      usados_no_ciclo: 0,
      ciclo_mes: nowYYYYMM(),
      ativo: true,
      criado_em: new Date().toISOString()
    };
    billingService.markFreeArtEligible(novo);

    clientes[login] = novo;
    writeClientes(clientes);

    const token = signUserToken(login);

    return res.json({
      ok: true,
      token,
      login,
      whatsapp: login,
      nome_time: novo.nome_time,
      plano: novo.plano,
      saldo_mensal: Number(novo.saldo_mensal || 0),
      saldo_extra: Number(novo.saldo_extra || 0),
      ...billingService.getStandaloneArtStatus(novo),
      saldo: Number(novo.saldo_mensal || 0) + Number(novo.saldo_extra || 0),
      usados_no_ciclo: novo.usados_no_ciclo
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Erro ao criar acesso automático."
    });
  }
});

// Login
app.post("/auth/register", accountCreationRateLimit, (req, res) => {
  const body = req.body || {};
  const whatsapp = normalizarLoginId(body.whatsapp);
  const senha = body.senha || "";
  const nome_time = String(body.nome_time || whatsapp || "").trim();

  if (!whatsapp || !senha) {
    return res.status(400).json({ ok: false, error: "login e senha obrigatórios" });
  }

  if (!loginIdIsValid(whatsapp)) {
    return res.status(400).json({ ok: false, error: "Login deve ter entre 3 e 160 caracteres" });
  }

  if (loginIdIsReserved(whatsapp)) {
    return res.status(403).json({ ok: false, error: "Login reservado" });
  }

  const passwordError = strongPasswordError(senha);
  if (passwordError) {
    return res.status(400).json({ ok: false, error: passwordError });
  }

  const clientes = readClientes();

  if (loginIdExists(whatsapp, clientes)) {
    return res.status(400).json({
      ok: false,
      error: `Esse login já existe. Tente algo como: ${whatsapp}${Math.floor(Math.random()*99)}`
    });
  }
  if (tenantNamespaceExists(whatsapp)) {
    return res.status(409).json({
      ok: false,
      code: "tenant_namespace_reserved",
      error: "Login reservado por dados existentes."
    });
  }

  const senha_hash = bcrypt.hashSync(senha, PASSWORD_BCRYPT_COST);

  const novo = {
    nome_time,
    login_id: whatsapp,
    senha_hash,
    plano: 0,
    saldo_mensal: 0,
    saldo_extra: 0,
    artes_avulsas_restantes: 0,
    artes_avulsas_usadas: 0,
    artes_avulsas_total_compradas: 0,
    artes_avulsas_compras: [],
    artes_avulsas_consumos: [],
    usados_no_ciclo: 0,
    ciclo_mes: nowYYYYMM(),
    ativo: true
  };
  billingService.markFreeArtEligible(novo);

  const clientesAtualizados = readClientes();

  if (loginIdExists(whatsapp, clientesAtualizados)) {
    return res.status(400).json({
      ok: false,
      error: `Esse login já existe. Tente outro nome.`
    });
  }
  if (tenantNamespaceExists(whatsapp)) {
    return res.status(409).json({
      ok: false,
      code: "tenant_namespace_reserved",
      error: "Login reservado por dados existentes."
    });
  }

  clientesAtualizados[whatsapp] = novo;
  writeClientes(clientesAtualizados);

  const token = signUserToken(whatsapp);

  return res.json({
    ok: true,
    token,
    nome_time: novo.nome_time,
    plano: novo.plano,
    ...billingService.getStandaloneArtStatus(novo),
    usados_no_ciclo: novo.usados_no_ciclo
  });
});

app.post("/auth/finalizar-conta-auto", auth, (req, res) => {
  try {
    const loginAtual = req.user.whatsapp;
    const novoLogin = normalizarLoginId(req.body?.login);
    const senha = String(req.body?.senha || "");

    if (!loginIdIsValid(novoLogin)) {
      return res.status(400).json({ ok:false, error:"Login deve ter entre 3 e 160 caracteres" });
    }

    if (loginIdIsReserved(novoLogin) && novoLogin !== loginAtual) {
      return res.status(403).json({ ok:false, error:"Login reservado" });
    }

    const passwordError = strongPasswordError(senha);
    if (passwordError) {
      return res.status(400).json({ ok:false, error: passwordError });
    }

    const clientes = readClientes();
    const clienteAtual = clientes[loginAtual];

    if (!clienteAtual) {
      return res.status(404).json({ ok:false, error:"Conta automática não encontrada" });
    }

    if (clienteAtual.cadastro_automatico !== true || clienteAtual.conta_finalizada === true) {
      return res.status(400).json({ ok:false, error:"Essa conta já foi finalizada" });
    }

    const existingTenantKey = tenantKeyForLogin(novoLogin, clientes);
    if (existingTenantKey && existingTenantKey !== loginAtual) {
      return res.status(400).json({
        ok:false,
        error:`Esse login já existe. Tente algo como: ${novoLogin}${Math.floor(Math.random()*99)}`
      });
    }
    if (novoLogin !== loginAtual && tenantNamespaceExists(novoLogin)) {
      return res.status(409).json({
        ok: false,
        code: "tenant_namespace_reserved",
        error: "Login reservado por dados existentes."
      });
    }

    clienteAtual.nome_time = novoLogin;
    clienteAtual.login_id = novoLogin;
    clienteAtual.senha_hash = bcrypt.hashSync(senha, PASSWORD_BCRYPT_COST);
    clienteAtual.conta_finalizada = true;
    clienteAtual.finalizado_em = new Date().toISOString();
    clientes[loginAtual] = clienteAtual;

    writeClientes(clientes);

    const token = signUserToken(loginAtual);

    return res.json({
      ok:true,
      token,
      whatsapp: novoLogin,
      nome_time: clienteAtual.nome_time,
      plano: clienteAtual.plano,
      saldo_mensal: Number(clienteAtual.saldo_mensal || 0),
      saldo_extra: Number(clienteAtual.saldo_extra || 0),
      ...billingService.getStandaloneArtStatus(clienteAtual),
      saldo: Number(clienteAtual.saldo_mensal || 0) + Number(clienteAtual.saldo_extra || 0),
      usados_no_ciclo: clienteAtual.usados_no_ciclo
    });

  } catch (e) {
    return res.status(500).json({
      ok:false,
      error:"Erro ao finalizar conta automática"
    });
  }
});

app.post("/auth/login", loginRateLimitByIp, loginRateLimitByAccount, (req, res) => {
  const body = req.body || {};
  const whatsapp = normalizarLoginId(body.whatsapp);
  const senha = body.senha || "";

  if (!whatsapp || !senha) {
    return res.status(400).json({ ok: false, error: "login e senha obrigatórios" });
  }

  const clientes = readClientes();
  const tenantKey = tenantKeyForLogin(whatsapp, clientes);
  const c = tenantKey ? clientes[tenantKey] : null;

  if (!c) {
    return res.status(401).json({ ok: false, error: "Login não encontrado" });
  }

  if (!c.ativo) {
    return res.status(403).json({ ok: false, error: "Mensalidade inativa" });
  }

  const ok = bcrypt.compareSync(senha, c.senha_hash);
  if (!ok) {
    return res.status(401).json({ ok: false, error: "Senha incorreta" });
  }

  const mesAtual = nowYYYYMM();
  if (c.ciclo_mes !== mesAtual) {
    c.ciclo_mes = mesAtual;
    c.usados_no_ciclo = 0;
    clientes[tenantKey] = c;
    writeClientes(clientes);
  }

  const token = signUserToken(tenantKey);

  return res.json({
    ok: true,
    token,
    nome_time: c.nome_time,
    plano: c.plano,
    saldo_mensal: Number(c.saldo_mensal || 0),
    saldo_extra: Number(c.saldo_extra || 0),
    ...billingService.getStandaloneArtStatus(c),
    saldo: Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0),
    usados_no_ciclo: c.usados_no_ciclo
  });
});

// Perfil
app.get("/me", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil" });

  const clientes = readClientes();
  const c = clientes[req.user.whatsapp];

  if (!c) {
    return res.status(404).json({ ok: false, error: "Cliente não encontrado" });
  }

  const freeArtIpLock = getFreeArtIpLockStatus(req);
  const cicloAtualizado = billingService.refreshManualPlanCycle(c);
  const carrosselCycleBefore = JSON.stringify({
    carrosseis_ciclo: c.carrosseis_ciclo || "",
    carrosseis_criados: c.carrosseis_criados || null
  });
  const billing = billingService.getBillingStatus(c, { freeArtBlocked: freeArtIpLock.blocked });
  const carrosselUsage = carouselService.carouselUsagePayload(c);
  const carrosselCycleAfter = JSON.stringify({
    carrosseis_ciclo: c.carrosseis_ciclo || "",
    carrosseis_criados: c.carrosseis_criados || null
  });

  if (cicloAtualizado.changed || carrosselCycleBefore !== carrosselCycleAfter) {
    clientes[req.user.whatsapp] = c;
    writeClientes(clientes);
  }

  const bonusTesteVisual = req.user.whatsapp === "15991120599" ? 999 : 0;
  const saldoVisivel = Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0) + bonusTesteVisual;

  return res.json({
    ok: true,
    nome_time: c.nome_time,
    plano: c.plano,
    plano_atual: billing.plano_atual,
    plano_status: billing.plano_status,
    plano_nome: billing.plano_nome,
    plano_renova_em: billing.plano_renova_em,
    artes_mensais_total: billing.artes_mensais_total,
    artes_mensais_usadas: billing.artes_mensais_usadas,
    artes_mensais_restantes: billing.artes_mensais_restantes,
    artes_avulsas_restantes: billing.artes_avulsas_restantes,
    artes_avulsas_usadas: billing.artes_avulsas_usadas,
    artes_avulsas_total_compradas: billing.artes_avulsas_total_compradas,
    arte_avulsa_valor: billing.arte_avulsa_valor,
    arte_avulsa_produto_id: billing.arte_avulsa_produto_id,
    arte_avulsa_titulo: billing.arte_avulsa_titulo,
    saldo_mensal: Number(c.saldo_mensal || 0),
    saldo_extra: Number(c.saldo_extra || 0),
    saldo: saldoVisivel,
    usados_no_ciclo: c.usados_no_ciclo,
    carrosseis_limite: carrosselUsage.limite_plano,
    carrosseis_usados: carrosselUsage.usado_no_ciclo,
    carrosseis_restantes: carrosselUsage.restante_no_ciclo,
    carrosseis_ciclo: carrosselUsage.ciclo,
    brinde_mascote_disponivel: c.brinde_mascote_disponivel === true,
    ativo: c.ativo,
    billing
  });
});

app.get("/billing/free-art/status", auth, (req, res) => {
  const clientes = readClientes();
  const c = clientes[req.user.whatsapp];

  if (!c) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  const freeArtIpLock = getFreeArtIpLockStatus(req);

  return res.json({
    ok: true,
    ...billingService.getFreeArtStatus(c, { freeArtBlocked: freeArtIpLock.blocked }),
    arte_gratis_bloqueada_ip: freeArtIpLock.blocked,
    arte_gratis_bloqueada_ate: freeArtIpLock.lock?.bloqueado_ate || "",
    arte_gratis_mensagem_bloqueio: freeArtIpLock.blocked
      ? "O limite de testes gratuitos nesta rede foi atingido. Voce ainda pode continuar usando com combo ou arte avulsa."
      : ""
  });
});

app.post("/me/fcm-token", auth, (req, res) => {
  const fcmToken = String(req.body?.token || "").trim();
  const platform = String(req.body?.platform || "android").trim().toLowerCase() || "android";

  if (!fcmToken) {
    return res.status(400).json({ ok: false, error: "Token FCM obrigatorio" });
  }

  const clientes = readClientes();
  const c = clientes[req.user.whatsapp];

  if (!c) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  const now = new Date().toISOString();
  c.notificacoes = c.notificacoes && typeof c.notificacoes === "object" && !Array.isArray(c.notificacoes)
    ? c.notificacoes
    : {};

  let registration;
  try {
    registration = fcmTokenStore.registerFcmToken({
      cliente: c,
      token: fcmToken,
      platform,
      now
    });
    clientes[req.user.whatsapp] = c;
    writeClientes(clientes);
  } catch (error) {
    console.warn("[fcm-token-storage]", {
      code: error?.code || "fcm_token_storage_error",
      operation: "register"
    });
    return res.status(503).json({
      ok: false,
      code: "fcm_token_storage_unavailable",
      error: "Armazenamento seguro de token FCM indisponivel."
    });
  }

  return res.json({
    ok: true,
    salvo: true,
    tokens_ativos: registration.activeCount
  });
});

function fcmSenderForType(tipo = "") {
  switch (String(tipo || "").trim().toLowerCase()) {
    case "arte_pronta":
      return fcmService.sendArtePronta;
    case "pedido_atualizado":
      return fcmService.sendPedidoAtualizado;
    case "planejamento_mensal":
      return fcmService.sendPlanejamentoMensal;
    case "arte_gratis_semanal":
      return fcmService.sendArteGratisSemanal;
    case "nova_versao":
      return fcmService.sendNovaVersao;
    case "aviso_geral":
    default:
      return fcmService.sendAvisoGeral;
  }
}

function deactivateInvalidFcmTokens(whatsapp, invalidTokens = [], reason = "firebase_invalid_token") {
  const tokenSet = new Set(
    (Array.isArray(invalidTokens) ? invalidTokens : [])
      .map((token) => String(token || "").trim())
      .filter(Boolean)
  );

  if (!tokenSet.size) {
    return { deactivated: 0 };
  }

  const clientes = readClientes();
  const cliente = clientes[whatsapp];
  if (!cliente) {
    return { deactivated: 0 };
  }

  let deactivated = 0;
  try {
    ({ deactivated } = fcmTokenStore.deactivateFcmTokens({
      cliente,
      tokens: [...tokenSet],
      reason
    }));
  } catch (error) {
    console.warn("[fcm-token-storage]", {
      code: error?.code || "fcm_token_storage_error",
      operation: "deactivate"
    });
    return { deactivated: 0 };
  }

  if (deactivated > 0) {
    clientes[whatsapp] = cliente;
    writeClientes(clientes);
  }

  return { deactivated };
}

function publicApiUrl(pathname = "") {
  const cleanPath = String(pathname || "").startsWith("/")
    ? String(pathname || "")
    : `/${pathname || ""}`;
  return `${PUBLIC_API_BASE_URL}${cleanPath}`;
}

function signedOrderMediaUrl({
  owner,
  orderId,
  variant = "preview",
  baseUrl = PUBLIC_API_BASE_URL,
  ttlSeconds = ORDER_MEDIA_URL_TTL_SECONDS
}) {
  const now = Date.now();
  const cacheKey = JSON.stringify([owner, orderId, variant, baseUrl, ttlSeconds]);
  const cached = orderMediaUrlCache.get(cacheKey);
  if (cached && cached.reuseUntil > now) return cached.url;

  const url = orderMediaAccess.buildUrl({
    baseUrl,
    owner,
    orderId,
    variant,
    ttlSeconds
  });
  if (orderMediaUrlCache.size >= ORDER_MEDIA_URL_CACHE_MAX_ENTRIES) {
    const removeCount = Math.ceil(ORDER_MEDIA_URL_CACHE_MAX_ENTRIES / 4);
    for (const key of orderMediaUrlCache.keys()) {
      orderMediaUrlCache.delete(key);
      if (orderMediaUrlCache.size <= ORDER_MEDIA_URL_CACHE_MAX_ENTRIES - removeCount) break;
    }
  }
  const reuseForMs = Math.max(
    0,
    Math.min(ORDER_MEDIA_URL_CACHE_REUSE_MS, Number(ttlSeconds) * 1000 - 5_000)
  );
  orderMediaUrlCache.set(cacheKey, {
    url,
    reuseUntil: now + reuseForMs
  });
  return url;
}

function realReviewerMediaError(code) {
  const error = new Error("Midia do revisor recusada.");
  error.code = code;
  return error;
}

function realReviewerDirectoryIsSafe(directoryPath) {
  try {
    const stat = fs.lstatSync(directoryPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function realReviewerDirectoryIsContained(root, directory, expectedRelative) {
  try {
    const realRoot = fs.realpathSync(root);
    const realDirectory = fs.realpathSync(directory);
    return path.relative(realRoot, realDirectory) === expectedRelative;
  } catch {
    return false;
  }
}

function realReviewerOwnerBinding(owner) {
  if (!orderStorage.isSafePathSegment(owner)) return null;
  return crypto.createHash("sha256")
    .update("ia4tube-real-reviewer-owner-v1\0", "utf8")
    .update(owner, "utf8")
    .digest("hex");
}

function realReviewerOwnerMediaDirectory(owner, { create = false } = {}) {
  const binding = realReviewerOwnerBinding(owner);
  const root = path.resolve(REAL_REVIEWER_MEDIA_DIR);
  if (!binding || !realReviewerDirectoryIsSafe(root)) return null;
  const directory = path.resolve(root, binding);
  const relative = path.relative(root, directory);
  if (
    relative !== binding ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  if (create) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") return null;
    }
  }
  return realReviewerDirectoryIsSafe(directory) &&
    realReviewerDirectoryIsContained(root, directory, binding)
    ? Object.freeze({ binding, directory })
    : null;
}

function realReviewerMediaPath(ownerDirectory, mediaId) {
  if (!REAL_REVIEWER_MEDIA_ID_PATTERN.test(String(mediaId || ""))) {
    return null;
  }
  const directoryName = mediaId.slice("reviewer-jpeg:".length);
  if (!REAL_REVIEWER_MEDIA_DIRECTORY_PATTERN.test(directoryName)) return null;
  const mediaDirectory = path.resolve(ownerDirectory, directoryName);
  const relative = path.relative(ownerDirectory, mediaDirectory);
  if (
    relative !== directoryName ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return mediaDirectory;
}

function realReviewerMetadataIsValid(metadata, expected = {}) {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.getPrototypeOf(metadata) !== Object.prototype
  ) {
    return false;
  }
  const keys = [
    "schemaVersion",
    "status",
    "mediaId",
    "sourceId",
    "companyId",
    "ownerBinding",
    "sha256",
    "width",
    "height",
    "size",
    "caption",
    "createdAt"
  ];
  if (
    Object.keys(metadata).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(metadata, key)) ||
    metadata.schemaVersion !== REAL_REVIEWER_MEDIA_SCHEMA_VERSION ||
    metadata.status !== "ready" ||
    metadata.mediaId !== expected.mediaId ||
    metadata.ownerBinding !== expected.ownerBinding ||
    !REAL_REVIEWER_MEDIA_ID_PATTERN.test(metadata.mediaId) ||
    !REAL_REVIEWER_SOURCE_ID_PATTERN.test(metadata.sourceId) ||
    !REAL_REVIEWER_COMPANY_ID_PATTERN.test(metadata.companyId) ||
    (expected.companyId && metadata.companyId !== expected.companyId) ||
    !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
    metadata.width !== 1080 ||
    metadata.height !== 1080 ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 16 ||
    metadata.size > REVIEWER_MEDIA_MAX_BYTES ||
    typeof metadata.caption !== "string" ||
    metadata.caption !== metadata.caption.trim() ||
    metadata.caption.length < 1 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(metadata.caption) ||
    typeof metadata.createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(metadata.createdAt) ||
    !Number.isFinite(Date.parse(metadata.createdAt))
  ) {
    return false;
  }
  const descriptor = reviewerMediaIdentity({
    orderId: metadata.sourceId,
    jpegSha256: metadata.sha256,
    caption: metadata.caption
  });
  return descriptor?.mediaId === metadata.mediaId;
}

function readDirectRealReviewerMedia(
  owner,
  mediaId,
  { companyId = null, includeBytes = false } = {}
) {
  if (
    companyId !== null &&
    !REAL_REVIEWER_COMPANY_ID_PATTERN.test(String(companyId || ""))
  ) {
    return null;
  }
  const ownerDirectory = realReviewerOwnerMediaDirectory(owner);
  if (!ownerDirectory) return null;
  const mediaDirectory = realReviewerMediaPath(
    ownerDirectory.directory,
    mediaId
  );
  if (
    !mediaDirectory ||
    !realReviewerDirectoryIsSafe(mediaDirectory) ||
    !realReviewerDirectoryIsContained(
      ownerDirectory.directory,
      mediaDirectory,
      mediaId.slice("reviewer-jpeg:".length)
    )
  ) {
    return null;
  }
  const metadataPath = path.join(mediaDirectory, "metadata.json");
  const jpegPath = path.join(mediaDirectory, "media.jpg");
  let bytes = null;
  try {
    const metadataStat = fs.lstatSync(metadataPath);
    const jpegStat = fs.lstatSync(jpegPath);
    if (
      !metadataStat.isFile() ||
      metadataStat.isSymbolicLink() ||
      metadataStat.size < 2 ||
      metadataStat.size > 32 * 1024 ||
      !jpegStat.isFile() ||
      jpegStat.isSymbolicLink()
    ) {
      return null;
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (!realReviewerMetadataIsValid(metadata, {
      mediaId,
      ownerBinding: ownerDirectory.binding,
      companyId
    }) || jpegStat.size !== metadata.size) {
      return null;
    }
    if (includeBytes) {
      bytes = fs.readFileSync(jpegPath);
      const dimensions = realReviewerUploadJpegDimensions(bytes);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.length !== metadata.size ||
        sha256 !== metadata.sha256 ||
        dimensions?.width !== metadata.width ||
        dimensions?.height !== metadata.height
      ) {
        bytes.fill(0);
        return null;
      }
    }
    const relativeStorageKey = path.relative(DATA_DIR, jpegPath);
    if (
      !relativeStorageKey ||
      relativeStorageKey.startsWith("..") ||
      path.isAbsolute(relativeStorageKey)
    ) {
      if (bytes) bytes.fill(0);
      return null;
    }
    return {
      owner,
      orderId: metadata.sourceId,
      previewPath: jpegPath,
      storageKey: relativeStorageKey.split(path.sep).join("/"),
      sha256: metadata.sha256,
      width: metadata.width,
      height: metadata.height,
      caption: metadata.caption,
      createdAt: metadata.createdAt,
      ...(bytes ? { bytes } : {})
    };
  } catch {
    if (bytes) bytes.fill(0);
    return null;
  }
}

function listDirectRealReviewerMedia({ context, owner }) {
  if (
    !context ||
    !REAL_REVIEWER_COMPANY_ID_PATTERN.test(String(context.companyId || ""))
  ) {
    return [];
  }
  const ownerDirectory = realReviewerOwnerMediaDirectory(owner);
  if (!ownerDirectory) return [];
  let entries;
  try {
    entries = fs.readdirSync(ownerDirectory.directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => (
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      REAL_REVIEWER_MEDIA_DIRECTORY_PATTERN.test(entry.name)
    ))
    .map((entry) => readDirectRealReviewerMedia(
      owner,
      `reviewer-jpeg:${entry.name}`,
      { companyId: context.companyId }
    ))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function writeExclusiveReviewerFile(filePath, contents) {
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function realReviewerOwnedUploadCount(ownerDirectory) {
  try {
    return fs.readdirSync(ownerDirectory, { withFileTypes: true })
      .filter((entry) => (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        REAL_REVIEWER_MEDIA_DIRECTORY_PATTERN.test(entry.name)
      ))
      .length;
  } catch {
    return null;
  }
}

function storeDirectRealReviewerMedia({ context, owner, bytes, caption }) {
  if (
    !context ||
    !REAL_REVIEWER_COMPANY_ID_PATTERN.test(String(context.companyId || "")) ||
    !orderStorage.isSafePathSegment(owner) ||
    !Buffer.isBuffer(bytes) ||
    bytes.length < 16
  ) {
    throw realReviewerMediaError("reviewer_media_invalid");
  }
  if (bytes.length > REVIEWER_MEDIA_MAX_BYTES) {
    throw realReviewerMediaError("reviewer_media_too_large");
  }
  const client = readClientes()[owner];
  const dimensions = realReviewerUploadJpegDimensions(bytes);
  if (
    !client ||
    client.ativo === false ||
    dimensions?.width !== 1080 ||
    dimensions?.height !== 1080 ||
    typeof caption !== "string" ||
    caption !== caption.trim() ||
    caption.length < 1
  ) {
    throw realReviewerMediaError("reviewer_media_invalid");
  }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const ownerDirectory = realReviewerOwnerMediaDirectory(owner, { create: true });
  if (!ownerDirectory) {
    throw realReviewerMediaError("reviewer_media_storage_unavailable");
  }
  const currentUploadCount = realReviewerOwnedUploadCount(
    ownerDirectory.directory
  );
  if (currentUploadCount === null) {
    throw realReviewerMediaError("reviewer_media_storage_unavailable");
  }
  if (currentUploadCount >= REAL_REVIEWER_MEDIA_MAX_ITEMS) {
    throw realReviewerMediaError("reviewer_media_limit_reached");
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const sourceId = `upload-${crypto.randomBytes(16).toString("hex")}`;
    const selected = reviewerMediaIdentity({
      orderId: sourceId,
      jpegSha256: sha256,
      caption
    });
    if (!selected) throw realReviewerMediaError("reviewer_media_invalid");
    const finalDirectory = realReviewerMediaPath(
      ownerDirectory.directory,
      selected.mediaId
    );
    const pendingName = `.pending-${crypto.randomBytes(18).toString("hex")}`;
    const pendingDirectory = path.resolve(ownerDirectory.directory, pendingName);
    const pendingRelative = path.relative(
      ownerDirectory.directory,
      pendingDirectory
    );
    if (
      !finalDirectory ||
      pendingRelative !== pendingName ||
      path.isAbsolute(pendingRelative)
    ) {
      throw realReviewerMediaError("reviewer_media_storage_unavailable");
    }
    if (fs.existsSync(finalDirectory)) continue;
    let pendingCreated = false;
    try {
      fs.mkdirSync(pendingDirectory, { mode: 0o700 });
      pendingCreated = true;
      if (
        !realReviewerDirectoryIsSafe(pendingDirectory) ||
        !realReviewerDirectoryIsContained(
          ownerDirectory.directory,
          pendingDirectory,
          pendingName
        )
      ) {
        throw realReviewerMediaError("reviewer_media_storage_unavailable");
      }
      const metadata = Object.freeze({
        schemaVersion: REAL_REVIEWER_MEDIA_SCHEMA_VERSION,
        status: "ready",
        mediaId: selected.mediaId,
        sourceId,
        companyId: context.companyId,
        ownerBinding: ownerDirectory.binding,
        sha256,
        width: dimensions.width,
        height: dimensions.height,
        size: bytes.length,
        caption,
        createdAt: new Date().toISOString()
      });
      writeExclusiveReviewerFile(path.join(pendingDirectory, "media.jpg"), bytes);
      writeExclusiveReviewerFile(
        path.join(pendingDirectory, "metadata.json"),
        `${JSON.stringify(metadata, null, 2)}\n`
      );
      fs.renameSync(pendingDirectory, finalDirectory);
      pendingCreated = false;
      const source = readDirectRealReviewerMedia(owner, selected.mediaId, {
        companyId: context.companyId
      });
      if (!source) {
        fs.rmSync(finalDirectory, { recursive: true, force: true });
        throw realReviewerMediaError("reviewer_media_storage_unavailable");
      }
      return source;
    } catch (error) {
      if (pendingCreated) {
        try {
          fs.rmSync(pendingDirectory, { recursive: true, force: true });
        } catch {}
      }
      if (error?.code === "EEXIST") continue;
      if (/^reviewer_media_/.test(String(error?.code || ""))) throw error;
      throw realReviewerMediaError("reviewer_media_storage_unavailable");
    }
  }
  throw realReviewerMediaError("reviewer_media_storage_unavailable");
}

function realReviewerMediaDescriptor(source) {
  return reviewerMediaIdentity({
    orderId: source?.orderId,
    jpegSha256: source?.sha256,
    caption: source?.caption
  });
}

function realReviewerMediaCapabilityUrl(owner, source, mediaId) {
  const expiresAt = Math.floor(Date.now() / 1000) + ORDER_MEDIA_URL_TTL_SECONDS;
  const nonce = crypto.randomBytes(18).toString("base64url");
  const ownerContext = orderMediaAccess.sealOwnerContext(owner);
  const signature = orderMediaAccess.sign({
    owner,
    orderId: `${mediaId}:${source.sha256}`,
    variant: "thumbnail",
    nonce,
    expiresAt
  });
  return `${PUBLIC_API_BASE_URL}${REAL_REVIEWER_MEDIA_CAPABILITY_PREFIX}/` +
    `${encodeURIComponent(mediaId)}/${expiresAt}/${encodeURIComponent(nonce)}/` +
    `${encodeURIComponent(ownerContext)}/${encodeURIComponent(signature)}`;
}

function realReviewerMediaRecord(context, owner, source, descriptor) {
  const selected = descriptor || realReviewerMediaDescriptor(source);
  if (!selected) return null;
  const url = realReviewerMediaCapabilityUrl(owner, source, selected.mediaId);
  return Object.freeze({
    companyId: context.companyId,
    mediaId: selected.mediaId,
    mimeType: "image/jpeg",
    width: source.width,
    height: source.height,
    caption: selected.caption,
    publicUrl: url,
    thumbnailUrl: url
  });
}

function listRealReviewerMedia({ context, owner }) {
  if (
    !context ||
    typeof context.companyId !== "string" ||
    !orderStorage.isSafePathSegment(owner)
  ) {
    return [];
  }
  const client = readClientes()[owner];
  if (!client || client.ativo === false) return [];
  const values = [];
  for (const source of listDirectRealReviewerMedia({ context, owner })) {
    const record = realReviewerMediaRecord(context, owner, source);
    if (!record) continue;
    values.push(record);
    if (values.length >= 20) return Object.freeze(values);
  }
  for (const item of listPedidoBasesByWhatsapp(owner)) {
    const source = readTenantOwnedReviewerMedia(owner, item.id, {
      demoOnly: false
    });
    const record = source
      ? realReviewerMediaRecord(context, owner, source)
      : null;
    if (!record) continue;
    values.push(record);
    if (values.length >= 20) break;
  }
  return Object.freeze(values);
}

const realReviewerMedia = Object.freeze({
  async listOwnedJpegs(input) {
    return listRealReviewerMedia(input);
  },
  async storeOwnedJpeg({ context, owner, bytes, caption }) {
    const source = storeDirectRealReviewerMedia({
      context,
      owner,
      bytes,
      caption
    });
    const record = realReviewerMediaRecord(context, owner, source);
    if (!record) {
      throw realReviewerMediaError("reviewer_media_storage_unavailable");
    }
    return record;
  },
  async resolveOwnedJpeg({ context, owner, mediaId }) {
    const expectedId = String(mediaId || "");
    const direct = readDirectRealReviewerMedia(owner, expectedId, {
      companyId: context?.companyId || null
    });
    if (direct) {
      const descriptor = realReviewerMediaDescriptor(direct);
      const record = descriptor?.mediaId === expectedId
        ? realReviewerMediaRecord(context, owner, direct, descriptor)
        : null;
      if (record) return record;
    }
    for (const item of listPedidoBasesByWhatsapp(owner).slice(0, 100)) {
      const source = readTenantOwnedReviewerMedia(owner, item.id, {
        demoOnly: false
      });
      const descriptor = source ? realReviewerMediaDescriptor(source) : null;
      if (!descriptor || descriptor.mediaId !== expectedId) continue;
      const record = realReviewerMediaRecord(
        context,
        owner,
        source,
        descriptor
      );
      if (record) {
        return record;
      }
    }
    return null;
  }
});

function resolveRealReviewerMediaCapability(req) {
  const mediaId = String(req.params.mediaId || "");
  const expiresAt = Number(req.params.expiresAt);
  const nonce = String(req.params.nonce || "");
  const owner = orderMediaAccess.openOwnerContext(req.params.ownerContext);
  const signature = String(req.params.signature || "");
  const client = owner ? readClientes()[owner] : null;
  if (
    !/^reviewer-jpeg:[0-9a-f]{64}$/.test(mediaId) ||
    !Number.isSafeInteger(expiresAt) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
    !owner ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
    !client ||
    client.ativo === false
  ) {
    return null;
  }
  const direct = readDirectRealReviewerMedia(owner, mediaId, {
    includeBytes: true
  });
  if (direct) {
    if (orderMediaAccess.verify({
      owner,
      orderId: `${mediaId}:${direct.sha256}`,
      variant: "thumbnail",
      nonce,
      expiresAt,
      signature
    })) {
      return direct;
    }
    direct.bytes.fill(0);
    return null;
  }
  for (const item of listPedidoBasesByWhatsapp(owner).slice(0, 100)) {
    const observed = readTenantOwnedReviewerMedia(owner, item.id, {
      includeBytes: true,
      demoOnly: false
    });
    if (
      !observed ||
      realReviewerMediaDescriptor(observed)?.mediaId !== mediaId
    ) {
      if (observed?.bytes) observed.bytes.fill(0);
      continue;
    }
    if (!orderMediaAccess.verify({
      owner,
      orderId: `${mediaId}:${observed.sha256}`,
      variant: "thumbnail",
      nonce,
      expiresAt,
      signature
    })) {
      observed.bytes.fill(0);
      return null;
    }
    return observed;
  }
  return null;
}

function protectOrderMediaPayload(
  payload,
  owner,
  baseUrl = PUBLIC_API_BASE_URL,
  ttlSeconds = ORDER_MEDIA_URL_TTL_SECONDS
) {
  return orderMediaAccess.protectPayload(payload, {
    owner,
    baseUrl,
    ttlSeconds,
    buildMediaUrl: ({ orderId, variant }) => signedOrderMediaUrl({
      owner,
      orderId,
      variant,
      baseUrl,
      ttlSeconds
    })
  });
}

const artReadyNotificationService = createArtReadyNotificationService({
  outboxPath: ART_READY_OUTBOX_FILE,
  deliveryEnabled: fcmService.fcmDeliveryEnabled,
  automaticNotificationsEnabled: fcmService.automaticNotificationsEnabled,
  getClienteByOwner: (ownerId) => readClientes()[ownerId] || null,
  listActiveTokenRecords: (cliente) =>
    fcmTokenStore.activeEncryptedFcmTokenRecords({ cliente }),
  sendToClient: fcmService.sendToClient,
  deactivateInvalidTokens: (ownerId, invalidTokens) =>
    deactivateInvalidFcmTokens(ownerId, invalidTokens)
});

app.post("/bot/notificacoes/teste", botRunnerAuth, async (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const whatsapp = String(req.body?.whatsapp || "").trim();
  const tipo = String(req.body?.tipo || "aviso_geral").trim() || "aviso_geral";

  if (!whatsapp) {
    return res.status(400).json({ ok: false, error: "WhatsApp obrigatorio" });
  }

  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const sender = fcmSenderForType(tipo);
    const invalidTokens = [];
    const result = await sender(cliente, {
      title: req.body?.title,
      body: req.body?.body || req.body?.message,
      pedido_id: req.body?.pedido_id,
      planejamento_id: req.body?.planejamento_id,
      planejamento_item_id: req.body?.planejamento_item_id,
      latest_version_code: req.body?.latest_version_code,
      latest_version_name: req.body?.latest_version_name,
      image_url: req.body?.image_url || req.body?.imageUrl || req.body?.image || req.body?.picture,
      data: req.body?.data && typeof req.body.data === "object" ? req.body.data : {}
    }, {
      onInvalidToken: (token) => invalidTokens.push(token)
    });

    const cleanup = deactivateInvalidFcmTokens(whatsapp, invalidTokens);
    if (cleanup.deactivated > 0) {
      result.tokens_invalidos_desativados = cleanup.deactivated;
    }

    return res.json({ ok: result?.ok === true, result });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || "Falha ao enviar notificacao de teste"
    });
  }
});

// ===== MERCADO PAGO =====
async function createMercadoPagoPixPayment({ amount, description, payerKey, externalReference, metadata, idempotencyKey }) {
  if (!MP_ACCESS_TOKEN) {
    const error = new Error("MP_ACCESS_TOKEN nao configurado");
    error.statusCode = 500;
    throw error;
  }

  const payerEmail = `${String(payerKey).replace(/\D/g, "") || "cliente"}@${PAYMENT_PAYER_EMAIL_DOMAIN}`;
  const paymentPayload = {
    transaction_amount: Number(Number(amount).toFixed(2)),
    description,
    payment_method_id: "pix",
    payer: {
      email: payerEmail
    },
    external_reference: externalReference,
    metadata,
    notification_url: MP_NOTIFICATION_URL
  };

  const r = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify(paymentPayload)
  });

  const data = await r.json();

  if (!r.ok) {
    const error = new Error("Erro ao gerar Pix");
    error.statusCode = 500;
    error.detail = data;
    throw error;
  }

  const transactionData = data.point_of_interaction?.transaction_data || {};
  return {
    data,
    pixCopiaCola: transactionData.qr_code || "",
    qrCodeBase64: transactionData.qr_code_base64 || "",
    ticketUrl: transactionData.ticket_url || ""
  };
}

app.get("/billing/status", auth, (req, res) => {
  const clientes = readClientes();
  const c = clientes[req.user.whatsapp];

  if (!c) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  const cicloAtualizado = billingService.refreshManualPlanCycle(c);
  if (cicloAtualizado.changed) {
    clientes[req.user.whatsapp] = c;
    writeClientes(clientes);
  }

  return res.json({
    ok: true,
    ...billingService.getBillingStatus(c)
  });
});

function createArteAvulsaPurchaseId(whatsapp) {
  const cleanWhatsapp = String(whatsapp || "").replace(/\W+/g, "").slice(0, 32) || "cliente";
  return `arte_avulsa_${cleanWhatsapp}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

async function criarArteAvulsaPixHandler(req, res) {
  try {
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const c = clientes[whatsapp];

    if (!c) {
      return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
    }

    const produto = billingPlans.getSingleArtPurchase();
    const quantidade = Math.max(
      1,
      Math.min(20, Math.round(Number(req.body?.quantidade || produto.quantity || 1)))
    );
    const valorTotal = billingService.roundMoney(Number(produto.amount) * quantidade);
    const purchaseId = createArteAvulsaPurchaseId(whatsapp);

    const result = await createMercadoPagoPixPayment({
      amount: valorTotal,
      description: quantidade > 1 ? `${produto.title} (${quantidade} artes)` : produto.title,
      payerKey: whatsapp,
      externalReference: `arte_avulsa_pix|${whatsapp}|${purchaseId}`,
      metadata: {
        tipo: "arte_avulsa_pix",
        whatsapp,
        purchase_id: purchaseId,
        produto_id: produto.id,
        quantidade,
        valor_unitario: Number(produto.amount),
        valor_pago: valorTotal
      },
      idempotencyKey: `arte_avulsa_pix_${purchaseId}`
    });

    billingService.recordStandaloneArtPurchasePending(c, {
      purchaseId,
      paymentId: String(result.data.id || ""),
      amount: valorTotal,
      quantity: quantidade,
      createdAt: new Date().toISOString()
    });
    clientes[whatsapp] = c;
    writeClientes(clientes);

    return res.json({
      ok: true,
      pix_copia_cola: result.pixCopiaCola,
      qr_code_base64: result.qrCodeBase64,
      ticket_url: result.ticketUrl,
      payment_id: result.data.id,
      purchase_id: purchaseId,
      tipo: "arte_avulsa_pix",
      produto_id: produto.id,
      valor_pago: valorTotal,
      valor_unitario: Number(produto.amount),
      quantidade,
      cta_label: quantidade > 1
        ? `Comprar ${quantidade} artes por R$ ${valorTotal.toFixed(2).replace(".", ",")}`
        : "Comprar 1 arte por R$ 5,99",
      artes_avulsas_restantes: Number(c.artes_avulsas_restantes || 0)
    });
  } catch (e) {
    return res.status(e.statusCode || 500).json({
      ok: false,
      error: e.message || "Erro interno ao gerar Pix da arte avulsa",
      detalhe: e.detail
    });
  }
}

app.post("/billing/arte-avulsa/pix", auth, criarArteAvulsaPixHandler);
app.post("/billing/artes-avulsas/pix", auth, criarArteAvulsaPixHandler);

app.post("/billing/saldo/pix", auth, async (req, res) => {
  try {
    const { pacote = "saldo_990" } = req.body || {};
    const whatsapp = req.user.whatsapp;
    const p = billingPlans.getBalancePackage(pacote);

    if (!p) {
      return res.status(400).json({ ok: false, error: "Pacote invalido" });
    }

    const result = await createMercadoPagoPixPayment({
      amount: p.amount,
      description: p.title,
      payerKey: whatsapp,
      externalReference: `saldo_extra|${whatsapp}|${p.id}|${Date.now()}`,
      metadata: {
        tipo: "saldo_extra",
        whatsapp,
        pacote: p.id,
        credito: Number(p.credit)
      },
      idempotencyKey: `saldo_extra_${whatsapp}_${p.id}_${Date.now()}`
    });

    return res.json({
      ok: true,
      pix_copia_cola: result.pixCopiaCola,
      qr_code_base64: result.qrCodeBase64,
      ticket_url: result.ticketUrl,
      payment_id: result.data.id,
      pacote: p.id,
      valor_pago: Number(p.amount),
      credito: Number(p.credit)
    });
  } catch (e) {
    return res.status(e.statusCode || 500).json({
      ok: false,
      error: e.message || "Erro interno ao gerar Pix",
      detalhe: e.detail
    });
  }
});

app.post("/billing/planos/:planId/pix", auth, async (req, res) => {
  try {
    const whatsapp = req.user.whatsapp;
    const plan = billingPlans.getPlan(req.params.planId);

    if (!plan) {
      return res.status(400).json({ ok: false, error: "Combo invalido" });
    }

    const result = await createMercadoPagoPixPayment({
      amount: plan.price,
      description: `IA4Tube - ${plan.name}`,
      payerKey: whatsapp,
      externalReference: `plano_pix|${whatsapp}|${plan.id}|${Date.now()}`,
      metadata: {
        tipo: "plano_pix",
        whatsapp,
        plan_id: plan.id,
        plan_name: plan.name,
        artes_mes: Number(plan.artsPerMonth)
      },
      idempotencyKey: `plano_pix_${whatsapp}_${plan.id}_${Date.now()}`
    });

    return res.json({
      ok: true,
      pix_copia_cola: result.pixCopiaCola,
      qr_code_base64: result.qrCodeBase64,
      ticket_url: result.ticketUrl,
      payment_id: result.data.id,
      plan_id: plan.id,
      plan_name: plan.name,
      valor_pago: Number(plan.price),
      artes_mes: Number(plan.artsPerMonth)
    });
  } catch (e) {
    return res.status(e.statusCode || 500).json({
      ok: false,
      error: e.message || "Erro interno ao gerar Pix",
      detalhe: e.detail
    });
  }
});

app.post("/comprar-creditos", auth, async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ ok: false, error: "MP_ACCESS_TOKEN não configurado" });
    }

    const { pacote } = req.body || {};
    const whatsapp = req.user.whatsapp;

    const pacotes = {
      saldo_800: { titulo: "Saldo IA4Tube - R$8", valor_pago: 8.00, credito: 8.00 },
      saldo_1800: { titulo: "Saldo IA4Tube - R$18", valor_pago: 18.00, credito: 18.00 },
      saldo_2800: { titulo: "Saldo IA4Tube - R$28", valor_pago: 28.00, credito: 28.00 },
      saldo_4800: { titulo: "Saldo IA4Tube - R$48", valor_pago: 48.00, credito: 48.00 }
    };

    const p = pacotes[pacote];

    if (!p) {
      return res.status(400).json({ ok: false, error: "Pacote inválido" });
    }

    const preference = {
      items: [{
        title: p.titulo,
        quantity: 1,
        currency_id: "BRL",
        unit_price: Number(p.valor_pago)
      }],
      external_reference: `${whatsapp}|${pacote}|${Date.now()}`,
      metadata: {
        tipo: "saldo",
        whatsapp,
        pacote,
        credito: Number(p.credito)
      },
      back_urls: {
        success: PAYMENT_RETURN_URL,
        failure: PAYMENT_RETURN_URL,
        pending: PAYMENT_RETURN_URL
      },
      notification_url: MP_NOTIFICATION_URL,
      auto_return: "approved"
    };

    const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(preference)
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(500).json({ ok: false, error: "Erro ao criar checkout", detalhe: data });
    }

    return res.json({
      ok: true,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro interno ao criar compra" });
  }
});

app.post("/comprar-creditos-pix", auth, async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ ok: false, error: "MP_ACCESS_TOKEN não configurado" });
    }

    const { pacote } = req.body || {};
    const whatsapp = req.user.whatsapp;

    const pacotes = {
      saldo_800: { titulo: "Saldo IA4Tube - R$8", valor_pago: 8.00, credito: 8.00 },
      saldo_1800: { titulo: "Saldo IA4Tube - R$18", valor_pago: 18.00, credito: 18.00 },
      saldo_2800: { titulo: "Saldo IA4Tube - R$28", valor_pago: 28.00, credito: 28.00 },
      saldo_4800: { titulo: "Saldo IA4Tube - R$48", valor_pago: 48.00, credito: 48.00 }
    };

    const p = pacotes[pacote];

    if (!p) {
      return res.status(400).json({ ok: false, error: "Pacote inválido" });
    }

    const payerEmail = `${String(whatsapp).replace(/\D/g, "") || "cliente"}@${PAYMENT_PAYER_EMAIL_DOMAIN}`;
    const paymentPayload = {
      transaction_amount: Number(Number(p.valor_pago).toFixed(2)),
      description: p.titulo,
      payment_method_id: "pix",
      payer: {
        email: payerEmail
      },
      external_reference: `saldo_pix|${whatsapp}|${pacote}|${Date.now()}`,
      metadata: {
        tipo: "saldo",
        whatsapp,
        pacote,
        credito: Number(p.credito)
      },
      notification_url: MP_NOTIFICATION_URL
    };

    const r = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": `saldo_pix_${whatsapp}_${pacote}_${Date.now()}`
      },
      body: JSON.stringify(paymentPayload)
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(500).json({ ok: false, error: "Erro ao gerar Pix", detalhe: data });
    }

    const transactionData = data.point_of_interaction?.transaction_data || {};

    return res.json({
      ok: true,
      pix_copia_cola: transactionData.qr_code || "",
      qr_code_base64: transactionData.qr_code_base64 || "",
      ticket_url: transactionData.ticket_url || "",
      payment_id: data.id,
      valor_pago: Number(p.valor_pago),
      credito: Number(p.credito)
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro interno ao gerar Pix" });
  }
});

app.post("/webhook/mercadopago", async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(503).json({
        ok: false,
        error: "Integracao de pagamento desativada"
      });
    }

    const body = req.body || {};
    const paymentId = body?.data?.id || body?.id || req.query?.id;

    if (!paymentId) {
      return res.json({ ok: true });
    }

    let processados = readMpProcessados();
    const registroAtual = processados[paymentId];

    if (registroAtual && registroAtual.status !== "processando") {
      return res.json({ ok: true, duplicado: true });
    }

    if (registroAtual && !isMpProcessandoStale(registroAtual)) {
      return res.json({ ok: true, processando: true });
    }

    processados[paymentId] = {
      status: "processando",
      criado_em: registroAtual?.criado_em || new Date().toISOString(),
      ultima_tentativa_em: new Date().toISOString(),
      tentativas: Number(registroAtual?.tentativas || 0) + 1
    };

    writeMpProcessados(processados);

    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`
      }
    });

    const pagamento = await r.json();

    if (!r.ok || pagamento.status !== "approved") {
      processados = readMpProcessados();
      delete processados[paymentId];
      writeMpProcessados(processados);

      return res.json({ ok: true, status: pagamento.status || "ignorado" });
    }

    const external = String(pagamento.external_reference || "");
    const tipo = pagamento.metadata?.tipo || "";

    if (tipo === "pedido_pix") {
      const whatsapp = pagamento.metadata?.whatsapp || external.split("|")[1];
      const pedidoId = pagamento.metadata?.pedido_id || external.split("|")[2];

      if (!whatsapp || !pedidoId) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          status: "erro_sem_pedido",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const base = getPedidoBase(whatsapp, pedidoId);

      if (!base) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          whatsapp,
          pedido_id: pedidoId,
          status: "pedido_nao_encontrado",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const pedidoPath = path.join(base, "pedido.json");
      const pedido = safeReadJson(pedidoPath) || {};

      if (pedido.pagamento_pendente !== true) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          whatsapp,
          pedido_id: pedidoId,
          status: "ja_liberado",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      if (String(pedido.mp_payment_id || "") !== String(paymentId)) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          whatsapp,
          pedido_id: pedidoId,
          status: "payment_id_divergente",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      pedido.pagamento_pendente = false;
      pedido.pagamento_metodo = "pix";
      pedido.pagamento_confirmado_em = new Date().toISOString();
      pedido.mp_payment_status = "approved";

      const deveCreditarBonusPedido = pedido.creditar_saldo_ao_pagar_pix === true;
      const valorBonusPedido = deveCreditarBonusPedido ? Number(
        pedido.valor_pendente ||
        pagamento.metadata?.valor_pendente ||
        pagamento.transaction_amount ||
        0
      ) : 0;

      if (valorBonusPedido > 0) {
        const clientes = readClientes();
        const c = clientes[whatsapp];

        if (c) {
          c.saldo_extra = Number(c.saldo_extra || 0) + valorBonusPedido;
          clientes[whatsapp] = c;
          writeClientes(clientes);
          pedido.bonus_saldo_extra = valorBonusPedido;
          pedido.bonus_saldo_extra_em = new Date().toISOString();
        }
      }

      fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");

      processados = readMpProcessados();
      processados[paymentId] = {
        tipo: "pedido_pix",
        whatsapp,
        pedido_id: pedidoId,
        status: pagamento.status,
        criado_em: new Date().toISOString()
      };
      writeMpProcessados(processados);

      registrarEventoServidor("pix_pago", {
        whatsapp,
        pedidoId,
        produto: pedido.product_id || pedido.categoria || "pedido",
        payload: {
          tipo: "pedido_pix",
          valor_pago: Number(pagamento.transaction_amount || pedido.valor_pendente || 0),
          status: pagamento.status
        }
      });
      registrarEventoServidor("compra_aprovada", {
        whatsapp,
        pedidoId,
        produto: pedido.product_id || pedido.categoria || "pedido",
        payload: {
          tipo: "pedido_pix",
          valor_pago: Number(pagamento.transaction_amount || pedido.valor_pendente || 0)
        }
      });
      if (valorBonusPedido > 0) {
        registrarEventoServidor("saldo_creditado", {
          whatsapp,
          pedidoId,
          produto: "saldo_extra",
          payload: {
            tipo: "bonus_pedido_pix",
            credito: valorBonusPedido
          }
        });
      }

      return res.json({ ok: true });
    }

    if (tipo === "plano_pix") {
      const whatsapp = pagamento.metadata?.whatsapp || external.split("|")[1];
      const planId = pagamento.metadata?.plan_id || external.split("|")[2];
      const plan = billingPlans.getPlan(planId);

      if (!whatsapp || !plan) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "plano_pix",
          whatsapp,
          plan_id: planId,
          status: "erro_plano_invalido",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const clientes = readClientes();
      const c = clientes[whatsapp];

      if (!c) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "plano_pix",
          whatsapp,
          plan_id: plan.id,
          status: "cliente_nao_encontrado",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const resultadoPlano = billingService.applyManualPlanPayment(c, plan, {
        paymentId: String(paymentId),
        paidAt: pagamento.date_approved || pagamento.date_last_updated || new Date().toISOString()
      });

      c.ultimo_pix_plano_valor = Number(pagamento.transaction_amount || plan.price);
      c.ultimo_pix_plano_status = resultadoPlano.status;
      clientes[whatsapp] = c;
      writeClientes(clientes);

      processados = readMpProcessados();
      processados[paymentId] = {
        tipo: "plano_pix",
        whatsapp,
        plan_id: plan.id,
        plano_status: resultadoPlano.status,
        status: pagamento.status,
        criado_em: new Date().toISOString()
      };
      writeMpProcessados(processados);

      registrarEventoServidor("pix_pago", {
        whatsapp,
        produto: "combo",
        payload: {
          tipo: "plano_pix",
          plano_id: plan.id,
          valor_pago: Number(pagamento.transaction_amount || plan.price),
          status: pagamento.status
        }
      });
      registrarEventoServidor("compra_aprovada", {
        whatsapp,
        produto: "combo",
        payload: {
          tipo: "plano_pix",
          plano_id: plan.id,
          plano_status: resultadoPlano.status,
          artes_mes: Number(plan.artsPerMonth || 0)
        }
      });
      registrarEventoServidor("saldo_creditado", {
        whatsapp,
        produto: "combo",
        payload: {
          tipo: "combo_artes_mensais",
          plano_id: plan.id,
          artes_mes: Number(plan.artsPerMonth || 0),
          plano_status: resultadoPlano.status
        }
      });

      return res.json({ ok: true });
    }

    if (tipo === "arte_avulsa_pix") {
      const externalParts = external.split("|");
      const whatsapp = String(pagamento.metadata?.whatsapp || externalParts[1] || "").trim();
      const purchaseId = String(pagamento.metadata?.purchase_id || externalParts[2] || "").trim();
      const produto = billingPlans.getSingleArtPurchase();
      const quantidade = Math.max(1, Math.round(Number(pagamento.metadata?.quantidade || produto.quantity || 1)));
      const valorPago = billingService.roundMoney(pagamento.transaction_amount || pagamento.metadata?.valor_pago || 0);
      const valorEsperado = billingService.roundMoney(Number(produto.amount) * quantidade);

      if (!whatsapp || !purchaseId || valorPago !== valorEsperado) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "arte_avulsa_pix",
          whatsapp,
          purchase_id: purchaseId,
          valor_pago: valorPago,
          valor_esperado: valorEsperado,
          status: "erro_dados_ou_valor_invalido",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const clientes = readClientes();
      const c = clientes[whatsapp];

      if (!c) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "arte_avulsa_pix",
          whatsapp,
          purchase_id: purchaseId,
          status: "cliente_nao_encontrado",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const credito = billingService.creditStandaloneArtPurchase(c, {
        purchaseId,
        paymentId: String(paymentId),
        amount: valorPago,
        quantity: quantidade,
        paidAt: pagamento.date_approved || pagamento.date_last_updated || new Date().toISOString()
      });

      clientes[whatsapp] = c;
      writeClientes(clientes);

      processados = readMpProcessados();
      processados[paymentId] = {
        tipo: "arte_avulsa_pix",
        whatsapp,
        purchase_id: purchaseId,
        produto_id: produto.id,
        quantidade,
        valor_pago: valorPago,
        creditado: credito.credited === true,
        duplicado: credito.duplicate === true,
        artes_avulsas_restantes: Number(c.artes_avulsas_restantes || 0),
        status: pagamento.status,
        criado_em: new Date().toISOString()
      };
      writeMpProcessados(processados);

      registrarEventoServidor("pix_pago", {
        whatsapp,
        produto: "arte_avulsa",
        payload: {
          tipo: "arte_avulsa_pix",
          produto_id: produto.id,
          quantidade,
          valor_pago: valorPago,
          status: pagamento.status
        }
      });
      registrarEventoServidor("compra_aprovada", {
        whatsapp,
        produto: "arte_avulsa",
        payload: {
          tipo: "arte_avulsa_pix",
          produto_id: produto.id,
          quantidade,
          valor_pago: valorPago
        }
      });
      if (credito.credited === true) {
        registrarEventoServidor("saldo_creditado", {
          whatsapp,
          produto: "arte_avulsa",
          payload: {
            tipo: "arte_avulsa",
            quantidade,
            artes_avulsas_restantes: Number(c.artes_avulsas_restantes || 0)
          }
        });
      }

      return res.json({ ok: true });
    }

    if (tipo !== "saldo" && tipo !== "saldo_extra") {
      processados = readMpProcessados();
      processados[paymentId] = {
        tipo: tipo || "desconhecido",
        status: "ignorado",
        criado_em: new Date().toISOString()
      };
      writeMpProcessados(processados);
      return res.json({ ok: true, status: "tipo_ignorado" });
    }

    const externalParts = external.split("|");
    let whatsapp = String(pagamento.metadata?.whatsapp || "").trim();

    if (!whatsapp) {
      if (tipo === "saldo_extra" && externalParts[0] === "saldo_extra") {
        whatsapp = String(externalParts[1] || "").trim();
      } else {
        whatsapp = String(externalParts[0] || "").trim();
      }
    }

    const credito = Number(pagamento.metadata?.credito || 0);
    const clienteReferenciaValida = whatsapp &&
      whatsapp !== "saldo" &&
      whatsapp !== "saldo_extra" &&
      !whatsapp.includes("|");

    if (!clienteReferenciaValida || !credito) {
      processados = readMpProcessados();
      processados[paymentId] = {
        tipo,
        whatsapp,
        credito,
        payment_id: String(paymentId),
        external_reference: external,
        status: "erro_sem_whatsapp_ou_credito",
        criado_em: new Date().toISOString()
      };
      writeMpProcessados(processados);
      return res.json({ ok: true, error: "sem whatsapp ou credito" });
    }

    const clientes = readClientes();
    const c = clientes[whatsapp];

    if (!c) {
      console.warn("[mercadopago webhook] cliente_nao_encontrado", {
        paymentId: String(paymentId),
        tipo,
        whatsapp,
        external_reference: external
      });
      processados = readMpProcessados();
      processados[paymentId] = {
        tipo,
        whatsapp,
        credito,
        payment_id: String(paymentId),
        external_reference: external,
        status: "cliente_nao_encontrado",
        criado_em: new Date().toISOString()
      };
      writeMpProcessados(processados);
      return res.json({ ok: true, error: "cliente não encontrado" });
    }

    c.saldo_extra = Number(c.saldo_extra || 0) + credito;
    c.ativo = true;

    if (c.brinde_mascote_ja_liberado !== true) {
      c.brinde_mascote_disponivel = true;
      c.brinde_mascote_ja_liberado = true;
      c.brinde_mascote_liberado_em = new Date().toISOString();
    }

    clientes[whatsapp] = c;
    writeClientes(clientes);

    processados = readMpProcessados();
    processados[paymentId] = {
      tipo,
      whatsapp,
      credito,
      status: pagamento.status,
      criado_em: new Date().toISOString()
    };

    writeMpProcessados(processados);

    registrarEventoServidor("pix_pago", {
      whatsapp,
      produto: "saldo_extra",
      payload: {
        tipo,
        credito,
        status: pagamento.status
      }
    });
    registrarEventoServidor("compra_aprovada", {
      whatsapp,
      produto: "saldo_extra",
      payload: {
        tipo,
        credito
      }
    });
    registrarEventoServidor("saldo_creditado", {
      whatsapp,
      produto: "saldo_extra",
      payload: {
        tipo,
        credito,
        saldo_extra: Number(c.saldo_extra || 0)
      }
    });

    return res.json({ ok: true });

  } catch (e) {
    return res.json({ ok: true });
  }
});

// ===== MATERIAIS GRAFICOS DA EMPRESA =====
app.get("/empresa/materiais-graficos", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const requestedRamo = String(req.query?.ramo || cliente.ramo || cliente.nicho || "").trim();
    const payload = graphicMaterialsService.publicListPayload({
      cliente,
      ramo: requestedRamo,
      baseDir: GRAPHIC_MATERIALS_DIR,
      whatsapp
    });
    const generalCount = payload.materiais.filter((material) => material.scope !== "ramo").length;
    const branchCount = payload.materiais.filter((material) => material.scope === "ramo").length;
    console.log("[materiais-graficos] listagem", {
      whatsapp,
      ramo_recebido: req.query?.ramo || "",
      ramo_usado: requestedRamo,
      ramo_resolvido: graphicMaterialsCatalog.folderForRamo(requestedRamo),
      materiais_gerais: generalCount,
      materiais_ramo: branchCount,
      plano_atual: cliente.plano_atual || cliente.plano || "",
      plano_status: cliente.plano_status || "",
      plano_ativo: billingService.isPlanActive(cliente)
    });
    clientes[whatsapp] = cliente;
    writeClientes(clientes);
    return res.json(payload);
  } catch (error) {
    console.error("[materiais-graficos] erro ao listar", {
      whatsapp,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(500).json({
      ok: false,
      error: "Nao foi possivel listar os materiais graficos agora."
    });
  }
});

app.post(
  "/empresa/materiais-graficos/:materialId/solicitar",
  auth,
  clientUploadConcurrencyLimit,
  secureClientUploadSingle("logo"),
  (req, res) => {
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const cliente = clientes[whatsapp];

    if (!cliente) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
    }

    try {
      const document = graphicMaterialsService.createRequest({
        baseDir: GRAPHIC_MATERIALS_DIR,
        cliente,
        whatsapp,
        materialId: req.params.materialId,
        body: req.body || {},
        logoPath: req.file?.path || ""
      });

      clientes[whatsapp] = cliente;
      writeClientes(clientes);

      return res.json({
        ok: true,
        document_id: document.document_id,
        material_id: document.material_id,
        title: document.title,
        scope: document.scope,
        ciclo: document.ciclo,
        status: "processing",
        status_label: "Em produção"
      });
    } catch (error) {
      console.error("[materiais-graficos] erro ao solicitar", {
        whatsapp,
        materialId: req.params.materialId,
        message: error?.message,
        stack: error?.stack
      });
      return res.status(error?.statusCode || 500).json({
        ok: false,
        code: error?.code || "graphic_material_request_error",
        error: error?.message || "Nao foi possivel solicitar o material grafico agora."
      });
    } finally {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
      }
    }
  }
);

app.get("/empresa/materiais-graficos/:materialId/status", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const payload = graphicMaterialsService.materialStatusPayload({
      cliente,
      ramo: req.query?.ramo || "",
      baseDir: GRAPHIC_MATERIALS_DIR,
      whatsapp,
      materialId: req.params.materialId
    });
    clientes[whatsapp] = cliente;
    writeClientes(clientes);
    return res.json(payload);
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "graphic_material_status_error",
      error: error?.message || "Nao foi possivel consultar o status do material grafico."
    });
  }
});

app.get("/empresa/materiais-graficos/:materialId/download", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const document = graphicMaterialsService.downloadForMaterial({
      baseDir: GRAPHIC_MATERIALS_DIR,
      cliente,
      whatsapp,
      materialId: req.params.materialId
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="${document.filename}"`);
    allowProtectedCrossOriginMedia(res);
    return res.sendFile(document.filePath);
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "graphic_material_download_error",
      error: error?.message || "Material grafico nao encontrado"
    });
  }
});

app.get("/bot/empresa/materiais-graficos/novos", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const limit = Number(req.query?.limit || 5);
  const materiais = graphicMaterialsService.listBotPending({
    baseDir: GRAPHIC_MATERIALS_DIR,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 5
  });

  return res.json({ ok: true, materiais });
});

app.get("/bot/empresa/materiais-graficos/:documentId/zip", botRunnerAuth, async (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const request = graphicMaterialsService.findRequestByDocument({
    baseDir: GRAPHIC_MATERIALS_DIR,
    documentId: req.params.documentId
  });

  if (!request) {
    return res.status(404).json({ ok: false, error: "Solicitacao nao encontrada" });
  }

  return streamDirectoryZip({
    res,
    directory: request.base_path,
    filename: `${req.params.documentId}.zip`
  });
});

app.post("/bot/empresa/materiais-graficos/:documentId/status", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const request = graphicMaterialsService.findRequestByDocument({
    baseDir: GRAPHIC_MATERIALS_DIR,
    documentId: req.params.documentId
  });

  if (!request) {
    return res.status(404).json({ ok: false, error: "Solicitacao nao encontrada" });
  }

  const updated = graphicMaterialsService.updateRequestStatus(
    request,
    String(req.body?.status || "processando"),
    String(req.body?.message || "")
  );

  return res.json({
    ok: true,
    document_id: updated.document_id || updated.id,
    status: updated.status
  });
});

app.post(
  "/bot/empresa/materiais-graficos/:documentId/upload-resultado",
  botRunnerAuth,
  uploadResultado.fields([
    { name: "resultado", maxCount: 1 },
    { name: "preview", maxCount: 1 }
  ]),
  (req, res) => {
    if (!isBotAdmin(req)) {
      cleanupUploadedFiles(req.files);
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const resultadoFile = req.files?.resultado?.[0] || null;
    const previewFile = req.files?.preview?.[0] || null;

    if (!resultadoFile) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ ok: false, error: "Arquivo resultado nao enviado" });
    }

    try {
      const apiInfo = req.body?.api_info ? JSON.parse(req.body.api_info) : {};
      const request = graphicMaterialsService.saveUploadedResult({
        baseDir: GRAPHIC_MATERIALS_DIR,
        documentId: req.params.documentId,
        resultPath: resultadoFile.path,
        previewPath: previewFile?.path || "",
        apiInfo
      });

      const clientes = readClientes();
      const cliente = clientes[request.whatsapp];
      if (cliente) {
        graphicMaterialsService.markClientCreated(cliente, request);
        clientes[request.whatsapp] = cliente;
        writeClientes(clientes);
      }

      return res.json({
        ok: true,
        document_id: request.document_id || request.id,
        material_id: request.material_id,
        status: "created",
        arquivo: "resultado_final.png",
        preview: previewFile ? "preview_ia4tube.jpg" : ""
      });
    } catch (error) {
      cleanupUploadedFiles(req.files);
      console.error("[materiais-graficos] falha ao salvar resultado", {
        documentId: req.params.documentId,
        message: error?.message,
        stack: error?.stack
      });
      return res.status(error?.statusCode || 500).json({
        ok: false,
        error: error?.message || "Falha ao salvar resultado"
      });
    }
  }
);

// ===== CARROSSEIS IA4TUBE =====
app.post(
  "/empresa/carrosseis/solicitar",
  auth,
  clientUploadConcurrencyLimit,
  secureClientUploadFields([
    { name: "logo", maxCount: 1 },
    { name: "fotos", maxCount: 2 }
  ]),
  (req, res) => {
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const cliente = clientes[whatsapp];

    if (!cliente) {
      cleanupUploadedFiles(req.files);
      return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
    }

    try {
      const carrossel = carouselService.createRequest({
        baseDir: CAROUSELS_DIR,
        cliente,
        whatsapp,
        body: req.body || {},
        files: req.files || {}
      });

      clientes[whatsapp] = cliente;
      writeClientes(clientes);

      return res.json({
        ok: true,
        carrossel_id: carrossel.carrossel_id || carrossel.id,
        ciclo: carrossel.ciclo,
        status: "pendente",
        status_label: "Pendente",
        quota: carrossel.quota || null
      });
    } catch (error) {
      cleanupUploadedFiles(req.files);
      console.error("[carrosseis] erro ao solicitar", {
        whatsapp,
        message: error?.message,
        stack: error?.stack
      });
      return res.status(error?.statusCode || 500).json({
        ok: false,
        code: error?.code || "carousel_request_error",
        error: error?.message || "Nao foi possivel solicitar o carrossel agora."
      });
    }
  }
);

app.get("/empresa/carrosseis", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  try {
    const limit = Number(req.query?.limit || 50);
    const carrosseis = carouselService.listClientRequests({
      baseDir: CAROUSELS_DIR,
      whatsapp,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 50
    });

    return res.json({ ok: true, carrosseis });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "carousel_list_error",
      error: error?.message || "Nao foi possivel listar os carrosseis."
    });
  }
});

app.get("/empresa/carrosseis/:carrosselId/status", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  try {
    return res.json(carouselService.publicStatusPayload({
      baseDir: CAROUSELS_DIR,
      whatsapp,
      carrosselId: req.params.carrosselId
    }));
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "carousel_status_error",
      error: error?.message || "Nao foi possivel consultar o status do carrossel."
    });
  }
});

app.get("/empresa/carrosseis/:carrosselId/download", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  try {
    const result = carouselService.downloadForCarousel({
      baseDir: CAROUSELS_DIR,
      whatsapp,
      carrosselId: req.params.carrosselId
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    allowProtectedCrossOriginMedia(res);
    return res.sendFile(result.filePath);
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "carousel_download_error",
      error: error?.message || "Carrossel nao encontrado"
    });
  }
});

app.get("/bot/empresa/carrosseis/novos", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const limit = Number(req.query?.limit || 5);
  const carrosseis = carouselService.listBotPending({
    baseDir: CAROUSELS_DIR,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 5
  });

  return res.json({ ok: true, carrosseis });
});

app.get("/bot/empresa/carrosseis/:carrosselId/zip", botRunnerAuth, async (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const request = carouselService.findRequestById({
    baseDir: CAROUSELS_DIR,
    carrosselId: req.params.carrosselId
  });

  if (!request) {
    return res.status(404).json({ ok: false, error: "Solicitacao nao encontrada" });
  }

  return streamDirectoryZip({
    res,
    directory: request.base_path,
    filename: `${req.params.carrosselId}.zip`
  });
});

app.post("/bot/empresa/carrosseis/:carrosselId/status", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const request = carouselService.findRequestById({
    baseDir: CAROUSELS_DIR,
    carrosselId: req.params.carrosselId
  });

  if (!request) {
    return res.status(404).json({ ok: false, error: "Solicitacao nao encontrada" });
  }

  const updated = carouselService.updateRequestStatus(
    request,
    String(req.body?.status || "processando"),
    String(req.body?.message || "")
  );

  return res.json({
    ok: true,
    carrossel_id: updated.carrossel_id || updated.id,
    status: updated.status
  });
});

app.post(
  "/bot/empresa/carrosseis/:carrosselId/upload-resultado",
  botRunnerAuth,
  uploadResultado.fields([
    { name: "resultado", maxCount: 1 }
  ]),
  (req, res) => {
    if (!isBotAdmin(req)) {
      cleanupUploadedFiles(req.files);
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const resultadoFile = req.files?.resultado?.[0] || null;

    if (!resultadoFile) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ ok: false, error: "Arquivo resultado nao enviado" });
    }

    try {
      const apiInfo = req.body?.api_info ? JSON.parse(req.body.api_info) : {};
      const request = carouselService.saveUploadedResult({
        baseDir: CAROUSELS_DIR,
        carrosselId: req.params.carrosselId,
        resultPath: resultadoFile.path,
        descricaoInstagram: req.body?.descricao_instagram || "",
        apiInfo
      });

      return res.json({
        ok: true,
        carrossel_id: request.carrossel_id || request.id,
        status: "pronto",
        arquivo: "resultado.zip"
      });
    } catch (error) {
      cleanupUploadedFiles(req.files);
      console.error("[carrosseis] falha ao salvar resultado", {
        carrosselId: req.params.carrosselId,
        message: error?.message,
        stack: error?.stack
      });
      return res.status(error?.statusCode || 500).json({
        ok: false,
        error: error?.message || "Falha ao salvar resultado"
      });
    }
  }
);

// ===== PLANEJAMENTO MENSAL =====
app.post(
  "/empresa/planejamento-mensal/descobrir-produtos",
  auth,
  clientUploadConcurrencyLimit,
  productDiscoveryUpload.single("imagem"),
  validateClientImageUploads,
  async (req, res) => {
    const whatsapp = req.user.whatsapp;
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        code: "product_discovery_image_required",
        error: "Envie uma imagem para analisar."
      });
    }
    if (!readClientes()[whatsapp]) {
      cleanupUploadedFiles({ imagem: [req.file] });
      return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
    }
    if (productDiscoveryInFlight.has(whatsapp)) {
      cleanupUploadedFiles({ imagem: [req.file] });
      return res.status(429).json({
        ok: false,
        code: "product_discovery_in_progress",
        error: "Ja existe uma imagem em analise. Aguarde a conclusao."
      });
    }

    productDiscoveryInFlight.add(whatsapp);
    try {
      const result = await productDiscoveryService.discoverProducts({
        filePath: req.file.path,
        mimeType: req.file.mimetype,
        maxItems: MONTHLY_PLANNING_REQUEST_MAX_ITEMS
      });
      return res.json({
        ok: true,
        produtos: result.produtos,
        limite_tecnico_planejamento: MONTHLY_PLANNING_REQUEST_MAX_ITEMS
      });
    } catch (error) {
      console.error("[product-discovery] erro ao analisar imagem", {
        whatsapp,
        code: error?.code,
        message: error?.message
      });
      return res.status(error?.statusCode || 502).json({
        ok: false,
        code: error?.code || "product_discovery_error",
        error: error?.message || "Nao foi possivel analisar a imagem agora."
      });
    } finally {
      productDiscoveryInFlight.delete(whatsapp);
      cleanupUploadedFiles({ imagem: [req.file] });
    }
  }
);

app.post(
  "/empresa/planejamento-mensal/solicitar",
  auth,
  clientUploadConcurrencyLimit,
  secureClientUploadFields(MONTHLY_PLANNING_UPLOAD_FIELDS),
  (req, res) => {
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const cliente = clientes[whatsapp];

    if (!cliente) {
      cleanupUploadedFiles(req.files);
      return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
    }

    let freeArtClaimLockKeys = [];
    let freeArtIpLock = { blocked: false, ipHash: "", ipMasked: "", lock: null };

    try {
      freeArtIpLock = getFreeArtIpLockStatus(req);
      let freeArtBlockedByClaimLock = false;

      if (billingService.hasAvailableFreeCompanyArt(cliente, { freeArtBlocked: freeArtIpLock.blocked })) {
        freeArtClaimLockKeys = acquireFreeArtClaimLocks(whatsapp, freeArtIpLock.ipHash);
        freeArtBlockedByClaimLock = freeArtClaimLockKeys.length === 0;
      }

      if (freeArtIpLock.blocked && billingService.hasAvailableFreeCompanyArt(cliente)) {
        console.info("[free-art-ip] planejamento bloqueado para arte gratis por IP", {
          whatsapp,
          ip_mascarado: freeArtIpLock.ipMasked,
          bloqueado_ate: freeArtIpLock.lock?.bloqueado_ate || ""
        });
        registrarEventoServidor("free_art_ip_blocked", {
          whatsapp,
          produto: "planejamento_mensal",
          payload: {
            contexto: "planejamento_mensal",
            ip_mascarado: freeArtIpLock.ipMasked,
            bloqueado_ate: freeArtIpLock.lock?.bloqueado_ate || ""
          }
        });
      }

      const clienteBefore = JSON.stringify(cliente);
      const planejamento = monthlyPlanningService.createRequest({
        baseDir: MONTHLY_PLANNINGS_DIR,
        cliente,
        whatsapp,
        body: req.body || {},
        files: req.files || {},
        freeArtBlocked: freeArtIpLock.blocked || freeArtBlockedByClaimLock
      });

      if (Number(planejamento?.reserva?.artes_gratis_consumidas || 0) > 0 || planejamento?.cobranca_origem === "arte_gratis") {
        const ipLockRecord = recordFreeArtIpLock(req, {
          whatsapp,
          pedidoId: planejamento.planejamento_id || planejamento.id,
          context: "planejamento_mensal"
        });
        if (ipLockRecord) {
          registrarEventoServidor("free_art_ip_locked", {
            whatsapp,
            pedidoId: planejamento.planejamento_id || planejamento.id,
            produto: "planejamento_mensal",
            payload: {
              contexto: "planejamento_mensal",
              ip_mascarado: ipLockRecord.ip_mascarado,
              bloqueado_ate: ipLockRecord.bloqueado_ate
            }
          });
        }
      }

      if (JSON.stringify(cliente) !== clienteBefore) {
        clientes[whatsapp] = cliente;
        writeClientes(clientes);
      }

      return res.json({
        ok: true,
        planejamento_id: planejamento.planejamento_id || planejamento.id,
        ciclo: planejamento.ciclo,
        status: planejamento.status,
        status_label: "Em analise",
        cobranca_origem: planejamento.cobranca_origem || planejamento.reserva?.cobranca_origem || "",
        tipo_compra: planejamento.tipo_compra || "",
        valor_cobrado: Number(planejamento.valor_cobrado || 0),
        arte_gratis: planejamento.cobranca_origem === "arte_gratis",
        quantidade_reservada: planejamento.quantidade_reservada,
        artes_deste_ciclo: planejamento.artes_deste_ciclo,
        reservadas_no_planejamento: planejamento.reservadas_no_planejamento,
        livres_para_criar_arte: planejamento.livres_para_criar_arte,
        reserva_definitiva: true,
        fase_4_pendente: false
      });
    } catch (error) {
      cleanupUploadedFiles(req.files);
      console.error("[planejamento-mensal] erro ao solicitar", {
        whatsapp,
        message: error?.message,
        stack: error?.stack
      });
      return res.status(error?.statusCode || 500).json({
        ok: false,
        code: error?.code || "monthly_planning_request_error",
        error: error?.message || "Nao foi possivel criar o Planejamento Mensal agora.",
        artes_livres: error?.artes_livres,
        free_art_ip_blocked: freeArtIpLock.blocked,
        free_art_blocked_until: freeArtIpLock.lock?.bloqueado_ate || "",
        free_art_message: freeArtIpLock.blocked
          ? "O limite de testes gratuitos nesta rede foi atingido. Voce ainda pode continuar usando com combo ou arte avulsa."
          : "",
        billing: error?.billing
      });
    } finally {
      cleanupUploadedFiles(req.files);
      releaseFreeArtClaimLocks(freeArtClaimLockKeys);
    }
  }
);

app.get("/empresa/planejamento-mensal", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const payload = monthlyPlanningService.listClientPlannings({
      baseDir: MONTHLY_PLANNINGS_DIR,
      whatsapp,
      pedidosDir: PEDIDOS_DIR
    });
    return res.json(protectOrderMediaPayload(payload, whatsapp));
  } catch (error) {
    console.error("[planejamento-mensal] erro ao listar", {
      whatsapp,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(500).json({
      ok: false,
      code: "monthly_planning_list_error",
      error: "Nao foi possivel listar os Planejamentos Mensais agora."
    });
  }
});

function handleMonthlyPlanningCalendarList(req, res) {
  console.log("[planejamento-mensal][calendario] rota calendario geral", {
    method: req.method,
    path: req.originalUrl || req.path
  });

  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const monthlyCalendar = monthlyPlanningService.listClientPlanningCalendar({
      baseDir: MONTHLY_PLANNINGS_DIR,
      whatsapp,
      pedidosDir: PEDIDOS_DIR
    });

    if (!adminFreeArtsEnabled()) {
      return res.json(protectOrderMediaPayload(
        monthlyCalendar,
        whatsapp
      ));
    }

    const freeArtItems = freeArtCampaignsService.listClientCalendar({
      baseDir: FREE_ART_CAMPAIGNS_DIR,
      whatsapp,
      pedidosDir: PEDIDOS_DIR
    });
    const postagens = [
      ...(monthlyCalendar.postagens || monthlyCalendar.itens || []),
      ...freeArtItems
    ].sort((a, b) => String(a.sort_key || "").localeCompare(String(b.sort_key || "")));

    return res.json(protectOrderMediaPayload({
      ...monthlyCalendar,
      total: postagens.length,
      postagens,
      itens: postagens
    }, whatsapp));
  } catch (error) {
    console.error("[planejamento-mensal][calendario] erro ao listar", {
      whatsapp,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(500).json({
      ok: false,
      code: "monthly_planning_calendar_list_error",
      error: "Nao foi possivel carregar o calendario do Planejamento Mensal agora."
    });
  }
}

function handleMonthlyPlanningCalendarHide(req, res) {
  console.log("[planejamento-mensal][calendario] rota ocultar calendario", {
    method: req.method,
    path: req.originalUrl || req.path
  });

  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    if (adminFreeArtsEnabled()) {
      const freeResult = freeArtCampaignsService.hideCalendarItem({
        baseDir: FREE_ART_CAMPAIGNS_DIR,
        whatsapp,
        itemKey: req.body?.item_key || req.body?.calendar_key || req.body?.key || ""
      });
      if (freeResult) return res.json(freeResult);
    }

    return res.json(monthlyPlanningService.hideClientPlanningCalendarItem({
      baseDir: MONTHLY_PLANNINGS_DIR,
      whatsapp,
      itemKey: req.body?.item_key || req.body?.calendar_key || req.body?.key || "",
      pedidoId: req.body?.pedido_id || "",
      planningId: req.body?.planning_id || req.body?.planejamento_id || "",
      planejamentoItemId: req.body?.planejamento_item_id || ""
    }));
  } catch (error) {
    console.error("[planejamento-mensal][calendario] erro ao ocultar", {
      whatsapp,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_calendar_hide_error",
      error: error?.message || "Nao foi possivel remover este item do calendario."
    });
  }
}

function handleMonthlyPlanningCalendarReschedule(req, res) {
  console.log("[planejamento-mensal][calendario] rota reagendar calendario", {
    method: req.method,
    path: req.originalUrl || req.path
  });

  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const itemKey = req.body?.item_key || req.body?.calendar_key || req.body?.key || "";
    if (adminFreeArtsEnabled() && String(itemKey || "").startsWith("free-art:")) {
      return res.status(400).json({
        ok: false,
        code: "free_art_calendar_reschedule_not_supported",
        error: "A data da Arte Gratis da Semana e definida pela campanha."
      });
    }

    const payload = monthlyPlanningService.rescheduleClientPlanningCalendarItem({
      baseDir: MONTHLY_PLANNINGS_DIR,
      whatsapp,
      pedidosDir: PEDIDOS_DIR,
      itemKey,
      pedidoId: req.body?.pedido_id || "",
      planningId: req.body?.planning_id || req.body?.planejamento_id || "",
      planejamentoItemId: req.body?.planejamento_item_id || "",
      date: req.body?.data || req.body?.date || req.body?.data_sugerida || "",
      time: req.body?.horario || req.body?.time || req.body?.horario_sugerido || ""
    });
    return res.json(protectOrderMediaPayload(payload, whatsapp));
  } catch (error) {
    console.error("[planejamento-mensal][calendario] erro ao reagendar", {
      whatsapp,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_calendar_reschedule_error",
      error: error?.message || "Nao foi possivel reagendar este item do calendario."
    });
  }
}

app.get("/empresa/calendario-planejamento-mensal", auth, handleMonthlyPlanningCalendarList);
app.post("/empresa/calendario-planejamento-mensal/ocultar", auth, handleMonthlyPlanningCalendarHide);
app.post("/empresa/calendario-planejamento-mensal/reagendar", auth, handleMonthlyPlanningCalendarReschedule);

app.get("/empresa/planejamento-mensal/calendario", auth, handleMonthlyPlanningCalendarList);

app.post("/empresa/planejamento-mensal/calendario/ocultar", auth, handleMonthlyPlanningCalendarHide);
app.post("/empresa/planejamento-mensal/calendario/reagendar", auth, handleMonthlyPlanningCalendarReschedule);

app.get("/empresa/planejamento-mensal/:planningId", auth, (req, res, next) => {
  console.log("[planejamento-mensal] rota detalhe planejamento", {
    method: req.method,
    path: req.originalUrl || req.path,
    planningId: req.params.planningId
  });

  if (isMonthlyPlanningReservedRouteSegment(req.params.planningId)) {
    return next("route");
  }

  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const payload = monthlyPlanningService.publicDetailPayload({
      baseDir: MONTHLY_PLANNINGS_DIR,
      whatsapp,
      planningId: req.params.planningId,
      pedidosDir: PEDIDOS_DIR
    });
    return res.json(protectOrderMediaPayload(payload, whatsapp));
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_detail_error",
      error: error?.message || "Nao foi possivel consultar o Planejamento Mensal."
    });
  }
});

app.post("/empresa/planejamento-mensal/:planningId/cancelar", auth, (req, res) => {
  if (isMonthlyPlanningReservedRouteSegment(req.params.planningId)) {
    return res.status(404).json({
      ok: false,
      code: "monthly_planning_reserved_route",
      error: "Rota reservada do Planejamento Mensal."
    });
  }

  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const clienteBefore = JSON.stringify(cliente);
    const planejamento = monthlyPlanningService.cancelPlanning({
      baseDir: MONTHLY_PLANNINGS_DIR,
      whatsapp,
      planningId: req.params.planningId,
      cliente
    });

    if (JSON.stringify(cliente) !== clienteBefore) {
      clientes[whatsapp] = cliente;
      writeClientes(clientes);
    }

    return res.json({
      ok: true,
      planejamento_id: planejamento.planejamento_id || planejamento.id,
      status: planejamento.status,
      status_label: planejamento.status_label || "Cancelado",
      billing_alterado: planejamento.cancelamento?.billing_alterado === true,
      reserva_definitiva: true,
      artes_devolvidas: Number(planejamento.cancelamento?.artes_devolvidas || 0),
      livres_para_criar_arte: Number(planejamento.cancelamento?.livres_para_criar_arte || planejamento.livres_para_criar_arte || 0)
    });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_cancel_error",
      error: error?.message || "Nao foi possivel cancelar o Planejamento Mensal."
    });
  }
});

app.get("/bot/empresa/planejamento-mensal/novos", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    return res.json(monthlyPlanningService.listBotPending({
      baseDir: MONTHLY_PLANNINGS_DIR,
      limit: req.query.limit,
      claim: req.query.claim !== "false"
    }));
  } catch (error) {
    console.error("[planejamento-mensal][bot] erro ao listar novos", {
      message: error?.message,
      stack: error?.stack
    });
    return res.status(500).json({
      ok: false,
      error: "Nao foi possivel listar Planejamentos Mensais pendentes."
    });
  }
});

app.get("/bot/empresa/planejamento-mensal/:planningId/zip", botRunnerAuth, async (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    const planejamento = monthlyPlanningService.findPlanningByIdAny({
      baseDir: MONTHLY_PLANNINGS_DIR,
      planningId: req.params.planningId
    });

    if (!planejamento) {
      return res.status(404).json({ ok: false, error: "Planejamento Mensal nao encontrado" });
    }

    return await streamDirectoryZip({
      res,
      directory: planejamento.base_path,
      filename: `${planejamento.planejamento_id || planejamento.id}.zip`
    });
  } catch (error) {
    console.error("[planejamento-mensal][bot] erro ao gerar zip", {
      planningId: req.params.planningId,
      message: error?.message,
      stack: error?.stack
    });
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: "Falha ao gerar ZIP do Planejamento Mensal" });
    }
  }
});

app.post("/bot/empresa/planejamento-mensal/:planningId/status", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    const planejamento = monthlyPlanningService.updatePlanningStatus({
      baseDir: MONTHLY_PLANNINGS_DIR,
      planningId: req.params.planningId,
      status: String(req.body?.status || "").trim(),
      message: req.body?.message || req.body?.erro || ""
    });

    const statusNormalizado = String(planejamento.status || req.body?.status || "").toLowerCase();
    const runnerEvent = statusNormalizado.includes("timeout")
      ? "runner_timeout"
      : statusNormalizado.includes("erro")
        ? "runner_erro"
        : "";
    if (runnerEvent) {
      registrarEventoServidor(runnerEvent, {
        whatsapp: planejamento.whatsapp,
        produto: "planejamento_mensal",
        payload: {
          tipo: "planejamento_mensal",
          planning_id: planejamento.planejamento_id || planejamento.id || req.params.planningId,
          status: planejamento.status || req.body?.status || "",
          motivo: String(req.body?.message || req.body?.erro || "").trim()
        }
      });
    }

    return res.json({
      ok: true,
      planejamento_id: planejamento.planejamento_id || planejamento.id,
      status: planejamento.status
    });
  } catch (error) {
    console.error("[planejamento-mensal][bot] erro ao atualizar status", {
      planningId: req.params.planningId,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_bot_status_error",
      error: error?.message || "Falha ao atualizar status do Planejamento Mensal"
    });
  }
});

app.post("/bot/empresa/planejamento-mensal/:planningId/upload-plano", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    const planejamentoAtual = monthlyPlanningService.findPlanningByIdAny({
      baseDir: MONTHLY_PLANNINGS_DIR,
      planningId: req.params.planningId
    });
    const clientes = readClientes();
    const cliente = planejamentoAtual?.whatsapp ? clientes[planejamentoAtual.whatsapp] : null;
    const clienteBefore = cliente ? JSON.stringify(cliente) : "";

    const planejamento = monthlyPlanningService.savePlanResult({
      baseDir: MONTHLY_PLANNINGS_DIR,
      pedidosDir: PEDIDOS_DIR,
      planningId: req.params.planningId,
      payload: req.body || {},
      cliente
    });

    if (cliente && JSON.stringify(cliente) !== clienteBefore) {
      clientes[planejamentoAtual.whatsapp] = cliente;
      writeClientes(clientes);
    }

    const planoMensal = planejamento.plano_mensal || {};
    const postagens = Array.isArray(planoMensal.postagens)
      ? planoMensal.postagens
      : Array.isArray(planoMensal.itens)
        ? planoMensal.itens
        : [];

    return res.json({
      ok: true,
      planejamento_id: planejamento.planejamento_id || planejamento.id,
      status: planejamento.status,
      postagens: postagens.length,
      pedidos_filhos_criados: Number(planejamento.pedidos_criados?.total || planejamento.pedidos_filhos_criados || 0)
    });
  } catch (error) {
    console.error("[planejamento-mensal][bot] erro ao receber plano", {
      planningId: req.params.planningId,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_bot_upload_error",
      error: error?.message || "Falha ao salvar plano do Planejamento Mensal"
    });
  }
});

app.get("/bot/empresa/planejamento-mensal/artes/novas", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    return res.json(monthlyPlanningService.listPlanningArtPending({
      pedidosDir: PEDIDOS_DIR,
      limit: req.query.limit
    }));
  } catch (error) {
    console.error("[planejamento-mensal][artes] erro ao listar novas", {
      message: error?.message,
      stack: error?.stack
    });
    return res.status(500).json({
      ok: false,
      error: "Nao foi possivel listar artes do Planejamento Mensal."
    });
  }
});

app.get("/bot/empresa/planejamento-mensal/artes/:pedidoId/zip", botRunnerAuth, async (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    const arte = monthlyPlanningService.findPlanningArtOrder({
      pedidosDir: PEDIDOS_DIR,
      pedidoId: req.params.pedidoId
    });

    if (!arte) {
      return res.status(404).json({ ok: false, error: "Arte do Planejamento Mensal nao encontrada" });
    }

    return await streamDirectoryZip({
      res,
      directory: arte.base,
      filename: `${arte.pedidoId}.zip`
    });
  } catch (error) {
    console.error("[planejamento-mensal][artes] erro ao gerar zip", {
      pedidoId: req.params.pedidoId,
      message: error?.message,
      stack: error?.stack
    });
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: "Falha ao gerar ZIP da arte do Planejamento Mensal" });
    }
  }
});

app.post("/bot/empresa/planejamento-mensal/artes/:pedidoId/status", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    const arte = monthlyPlanningService.updatePlanningArtStatus({
      pedidosDir: PEDIDOS_DIR,
      pedidoId: req.params.pedidoId,
      status: String(req.body?.status || "").trim(),
      message: req.body?.message || req.body?.erro || ""
    });

    const statusNormalizado = String(arte.status || req.body?.status || "").toLowerCase();
    const runnerEvent = statusNormalizado.includes("timeout")
      ? "runner_timeout"
      : statusNormalizado.includes("erro")
        ? "runner_erro"
        : "";
    if (runnerEvent) {
      const basePedido = getPedidoBaseGlobal(req.params.pedidoId);
      const pedidoData = basePedido ? (readPedido(basePedido) || {}) : {};
      registrarEventoServidor(runnerEvent, {
        whatsapp: pedidoData.whatsapp,
        pedidoId: req.params.pedidoId,
        produto: "planejamento_mensal",
        payload: {
          tipo: "planejamento_mensal_arte",
          planning_id: arte.planning_id || arte.planejamento_id || "",
          status: arte.status || req.body?.status || "",
          motivo: String(req.body?.message || req.body?.erro || "").trim()
        }
      });
    }

    return res.json({ ok: true, arte });
  } catch (error) {
    console.error("[planejamento-mensal][artes] erro ao atualizar status", {
      pedidoId: req.params.pedidoId,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_art_status_error",
      error: error?.message || "Falha ao atualizar status da arte do Planejamento Mensal"
    });
  }
});

app.post(
  "/bot/empresa/planejamento-mensal/artes/:pedidoId/upload-resultado",
  botRunnerAuth,
  uploadResultado.fields([
    { name: "resultado", maxCount: 1 },
    { name: "preview", maxCount: 1 }
  ]),
  (req, res) => {
    if (!isBotAdmin(req)) {
      cleanupUploadedFiles(req.files);
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const resultado = req.files?.resultado?.[0];
    const preview = req.files?.preview?.[0];
    if (!resultado?.path) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ ok: false, error: "Arquivo resultado_final.png obrigatorio" });
    }

    try {
      let apiInfo = null;
      if (req.body?.api_info) {
        try {
          apiInfo = JSON.parse(String(req.body.api_info || "{}"));
        } catch {
          apiInfo = null;
        }
      }

      const arte = monthlyPlanningService.savePlanningArtResult({
        pedidosDir: PEDIDOS_DIR,
        pedidoId: req.params.pedidoId,
        resultadoPath: resultado.path,
        previewPath: preview?.path || "",
        descricaoInstagram: req.body?.descricao_instagram || "",
        apiInfo
      });

      const basePedido = getPedidoBaseGlobal(req.params.pedidoId);
      const pedidoData = basePedido ? (readPedido(basePedido) || {}) : {};
      registrarEventoServidor("pedido_pronto", {
        whatsapp: pedidoData.whatsapp,
        pedidoId: req.params.pedidoId,
        produto: "planejamento_mensal",
        payload: {
          tipo: "planejamento_mensal",
          planning_id: arte.planning_id || arte.planejamento_id || "",
          status: arte.status || "pronto"
        }
      });

      return res.json({ ok: true, arte });
    } catch (error) {
      cleanupUploadedFiles(req.files);
      console.error("[planejamento-mensal][artes] erro ao receber resultado", {
        pedidoId: req.params.pedidoId,
        message: error?.message,
        stack: error?.stack
      });
      return res.status(error?.statusCode || 500).json({
        ok: false,
        code: error?.code || "monthly_planning_art_upload_error",
        error: error?.message || "Falha ao salvar resultado da arte do Planejamento Mensal"
      });
    }
  }
);

let monthlyPlanningNotificationsRunning = false;
let freeArtNotificationsRunning = false;

function monthlyPlanningNotificationPayload({ planning, post }) {
  const pedidoId = post.pedido_id || "";
  const owner = planning.whatsapp || "";
  return {
    title: "Hora de postar",
    body: "Sua arte planejada para hoje esta pronta. Toque para ver e copiar a legenda.",
    image_url: pedidoId && owner
      ? signedOrderMediaUrl({
          owner,
          orderId: pedidoId,
          variant: "preview",
          ttlSeconds: ORDER_MEDIA_NOTIFICATION_TTL_SECONDS
        })
      : "",
    data: {
      tipo: "planejamento_mensal",
      route: "monthly_planning_detail",
      planejamento_id: planning.planejamento_id || planning.id || "",
      planejamento_item_id: post.planejamento_item_id || "",
      pedido_id: pedidoId
    }
  };
}

async function runMonthlyPlanningNotifications() {
  if (!fcmService.scheduledNotificationsEnabled()) return;
  if (monthlyPlanningNotificationsRunning) return;

  monthlyPlanningNotificationsRunning = true;
  try {
    const clientes = readClientes();
    const result = await monthlyPlanningService.processDueNotifications({
      baseDir: MONTHLY_PLANNINGS_DIR,
      pedidosDir: PEDIDOS_DIR,
      clientes,
      now: new Date(),
      sendNotification: async ({ cliente, planning, post }) => {
        return fcmService.sendPlanejamentoMensal(
          cliente,
          {
            ...monthlyPlanningNotificationPayload({ planning, post }),
            planejamento_id: planning.planejamento_id || planning.id || "",
            planejamento_item_id: post.planejamento_item_id || "",
            pedido_id: post.pedido_id || ""
          }
        );
      }
    });

    if (result.sent || result.errors || result.mock) {
      console.log("[planejamento-mensal][notificacoes]", result);
    }
  } catch (error) {
    console.error("[planejamento-mensal][notificacoes] erro no agendador", {
      message: error?.message,
      stack: error?.stack
    });
  } finally {
    monthlyPlanningNotificationsRunning = false;
  }
}

async function runFreeArtCampaignNotifications() {
  if (!fcmService.scheduledNotificationsEnabled()) return;
  if (!adminFreeArtsNotificationsEnabled()) return;
  if (freeArtNotificationsRunning) return;

  freeArtNotificationsRunning = true;
  try {
    const clientes = readClientes();
    const result = await freeArtCampaignsScheduler.processDueNotifications({
      baseDir: FREE_ART_CAMPAIGNS_DIR,
      pedidosDir: PEDIDOS_DIR,
      clientes,
      now: new Date(),
      sendNotification: async ({ cliente, campaign, assignment }) => {
        const pedidoId = assignment.pedido_id || assignment.assignment_id || "";
        return fcmService.sendArteGratisSemanal(
          cliente,
          {
            title: campaign.notificacao_titulo || "Arte Gratis da Semana",
            body: campaign.notificacao_mensagem || "Sua arte gratis da semana esta pronta. Toque para ver.",
            pedido_id: pedidoId,
            campaign_id: campaign.id || "",
            assignment_id: assignment.assignment_id || "",
            image_url: pedidoId && assignment.whatsapp
              ? signedOrderMediaUrl({
                  owner: assignment.whatsapp,
                  orderId: pedidoId,
                  variant: "preview",
                  ttlSeconds: ORDER_MEDIA_NOTIFICATION_TTL_SECONDS
                })
              : "",
            data: {
              tipo: "arte_gratis_semanal",
              route: pedidoId ? "order_detail" : "orders",
              campaign_id: campaign.id || "",
              assignment_id: assignment.assignment_id || "",
              pedido_id: pedidoId
            }
          }
        );
      }
    });

    if (result.sent || result.errors || result.mock) {
      console.log("[arte-gratis-semanal][notificacoes]", result);
    }
  } catch (error) {
    console.error("[arte-gratis-semanal][notificacoes] erro no agendador", {
      message: error?.message,
      stack: error?.stack
    });
  } finally {
    freeArtNotificationsRunning = false;
  }
}

function runFreeArtCampaignRecovery() {
  if (!adminFreeArtsEnabled()) return;

  try {
    const result = freeArtCampaignsService.recoverStuckGeneration({
      baseDir: FREE_ART_CAMPAIGNS_DIR,
      timeoutMs: adminFreeArtsGeneratingTimeoutMs(),
      action: adminFreeArtsStuckAction(),
      now: new Date()
    });

    if (result.recovered_count > 0) {
      console.log("[arte-gratis-semanal][recuperacao-geracao]", result);
    }
  } catch (error) {
    console.error("[arte-gratis-semanal][recuperacao-geracao] erro", {
      message: error?.message,
      stack: error?.stack
    });
  }
}

// ===== CRIA PEDIDO =====
function criarPedidoHandler(categoria) {
  return async (req, res) => {
    let freeArtClaimLockKeys = [];

    try {
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const c = clientes[whatsapp];

    if (!c) {
      return res.status(404).json({ ok: false, error: "Cliente não encontrado" });
    }

    const mesAtual = nowYYYYMM();
    billingService.ensureCurrentBillingCycle(c, mesAtual);

    const temBrindeMascote = billingService.hasMascoteUniformeGift(categoria, c);

    const custoPedido = getCustoPedido(categoria, c);
    const isArteEmpresa = categoria === "arte_empresa";
    const custoEfetivoPedido = isArteEmpresa ? EMPRESA_ARTE_AVULSA_VALOR : custoPedido;

    const temSaldoSuficiente = !isArteEmpresa && billingService.hasEnoughBalance(c, custoEfetivoPedido);

    const fields = orderService.normalizeOrderBody(req.body);

    if (!orderService.hasRequiredOrderFields(fields)) {
      return res.status(400).json({
        ok: false,
        error: "rodada e data são obrigatórios"
      });
    }

    const files = req.files || {};
    if (categoria === "arte_empresa" && !orderService.hasCompanyLogoReference(files)) {
      return res.status(400).json({
        ok: false,
        error: "Envie o logo da empresa para criar a arte."
      });
    }

    const visualStyleNormalization = orderService.normalizeCompanyVisualStyleForUploads({ categoria, fields, files });

    const freeArtIpLock = isArteEmpresa
      ? getFreeArtIpLockStatus(req)
      : { blocked: false, ipHash: "", ipMasked: "", lock: null };
    let freeArtBlockedByClaimLock = false;

    if (isArteEmpresa && billingService.hasAvailableFreeCompanyArt(c, { freeArtBlocked: freeArtIpLock.blocked })) {
      freeArtClaimLockKeys = acquireFreeArtClaimLocks(whatsapp, freeArtIpLock.ipHash);
      freeArtBlockedByClaimLock = freeArtClaimLockKeys.length === 0;

      if (freeArtBlockedByClaimLock) {
        console.warn("[free-art-ip] tentativa simultanea bloqueada", {
          whatsapp,
          ip_mascarado: freeArtIpLock.ipMasked
        });
        registrarEventoServidor("free_art_claim_lock_blocked", {
          whatsapp,
          produto: "arte_empresa",
          payload: {
            motivo: "tentativa_simultanea",
            ip_mascarado: freeArtIpLock.ipMasked
          }
        });
      }
    }

    if (isArteEmpresa && freeArtIpLock.blocked && billingService.hasAvailableFreeCompanyArt(c)) {
      console.info("[free-art-ip] arte gratis bloqueada por IP", {
        whatsapp,
        ip_mascarado: freeArtIpLock.ipMasked,
        bloqueado_ate: freeArtIpLock.lock?.bloqueado_ate || ""
      });
      registrarEventoServidor("free_art_ip_blocked", {
        whatsapp,
        produto: "arte_empresa",
        payload: {
          contexto: "arte_empresa",
          ip_mascarado: freeArtIpLock.ipMasked,
          bloqueado_ate: freeArtIpLock.lock?.bloqueado_ate || ""
        }
      });
    }

    let cobrancaEmpresa = null;
    if (isArteEmpresa) {
      cobrancaEmpresa = billingService.resolveCompanyArtCharge(c, {
        custoPedido: custoEfetivoPedido,
        now: new Date(),
        freeArtBlocked: freeArtIpLock.blocked || freeArtBlockedByClaimLock
      });

      if (visualStyleNormalization.converted) {
        console.info("[pedidos] estilo visual arte_empresa ajustado", {
          whatsapp,
          origem_cobranca: cobrancaEmpresa.source || cobrancaEmpresa.code || "indefinida",
          estilo_original: visualStyleNormalization.from,
          estilo_final: visualStyleNormalization.to,
          reason: visualStyleNormalization.reason
        });
      }

      if (cobrancaEmpresa.allowed !== true) {
        clientes[whatsapp] = c;
        writeClientes(clientes);
        return res.status(402).json({
          ok: false,
          code: "billing_required",
          error: "Compre 1 arte avulsa por R$ 5,99 ou escolha um combo para criar sua arte.",
          required_amount: cobrancaEmpresa.required_amount,
          arte_avulsa_valor: EMPRESA_ARTE_AVULSA_VALOR,
          arte_avulsa_cta: "Comprar 1 arte por R$ 5,99",
          arte_avulsa_endpoint: "/billing/arte-avulsa/pix",
          free_art_ip_blocked: freeArtIpLock.blocked,
          free_art_blocked_until: freeArtIpLock.lock?.bloqueado_ate || "",
          free_art_message: freeArtIpLock.blocked
            ? "O limite de testes gratuitos nesta rede foi atingido. Voce ainda pode continuar usando com combo ou arte avulsa."
            : "",
          saldo_extra: cobrancaEmpresa.saldo_extra,
          artes_mensais_restantes: cobrancaEmpresa.artes_mensais_restantes,
          artes_avulsas_restantes: cobrancaEmpresa.artes_avulsas_restantes,
          plano_status: cobrancaEmpresa.plano_status
        });
      }
    }

    const draft = await orderService.createOrderDraft({
      categoria,
      pedidosDir: PEDIDOS_DIR,
      whatsapp,
      mesAtual,
      fields,
      files
    });

    const id = draft.id;

    if (isArteEmpresa) {
      billingService.applyResolvedCompanyArtCharge(c, cobrancaEmpresa, {
        custoPedido: custoEfetivoPedido,
        mesAtual,
        pedidoId: id
      });
      draft.pedido.cobranca_origem = cobrancaEmpresa.source;
      draft.pedido.valor_cobrado = cobrancaEmpresa.source === "saldo_extra" || cobrancaEmpresa.source === "arte_avulsa"
        ? Number(cobrancaEmpresa.amount || custoEfetivoPedido)
        : 0;
      if (cobrancaEmpresa.source === "arte_gratis") {
        const ipLockRecord = recordFreeArtIpLock(req, {
          whatsapp,
          pedidoId: id,
          context: "arte_empresa"
        });
        draft.pedido.tipo_compra = "arte_gratis";
        draft.pedido.origem_promocional = "primeira_arte_gratis";
        draft.pedido.marketing_context = "primeira_arte_gratis";
        draft.pedido.beneficios_plano_aplicados = false;
        if (ipLockRecord) {
          registrarEventoServidor("free_art_ip_locked", {
            whatsapp,
            pedidoId: id,
            produto: "arte_empresa",
            payload: {
              contexto: "arte_empresa",
              ip_mascarado: ipLockRecord.ip_mascarado,
              bloqueado_ate: ipLockRecord.bloqueado_ate
            }
          });
        }
      }
      if (cobrancaEmpresa.source === "arte_avulsa") {
        draft.pedido.tipo_compra = "avulsa";
        draft.pedido.beneficios_plano_aplicados = false;
      }
      draft.pedido.plano_id = cobrancaEmpresa.source === "plano" ? cobrancaEmpresa.planId : "";
      draft.pedido.plano_ciclo = cobrancaEmpresa.source === "plano" ? cobrancaEmpresa.planCycle : "";
      draft.pedido.pagamento_pendente = false;
      draft.pedido.valor_pendente = 0;
      draft.pedido.motivo_pagamento_pendente = "";
      orderService.orderStorage.writeOrder(draft.base, draft.pedido);
    } else if (temSaldoSuficiente) {
      billingService.applyOrderCharge(c, { custoPedido: custoEfetivoPedido, mesAtual, temBrindeMascote });
    } else {
      draft.pedido.pagamento_pendente = true;
      draft.pedido.valor_pendente = custoEfetivoPedido;
      draft.pedido.motivo_pagamento_pendente = "saldo_insuficiente";
      orderService.orderStorage.writeOrder(draft.base, draft.pedido);
    }

    clientes[whatsapp] = c;
    writeClientes(clientes);

    removeOldPedidos(whatsapp, 15);

    return res.json({
      ok: true,
      pedido_id: id,
      cobranca_origem: draft.pedido?.cobranca_origem || "",
      tipo_compra: draft.pedido?.tipo_compra || "",
      arte_gratis: draft.pedido?.cobranca_origem === "arte_gratis"
    });
    } catch (error) {
      cleanupUploadedFiles(req.files);
      console.error("[pedidos] erro ao criar pedido", {
        categoria,
        message: error?.message,
        stack: error?.stack
      });

      if (res.headersSent) return;

      return res.status(error?.statusCode || 500).json({
        ok: false,
        error: "Não foi possível criar o pedido agora. Tente novamente em alguns instantes."
      });
    } finally {
      cleanupUploadedFiles(req.files);
      releaseFreeArtClaimLocks(freeArtClaimLockKeys);
    }
  };
}

// ===== CRIAR PEDIDO =====
app.post(
  "/pedidos",
  auth,
  clientUploadConcurrencyLimit,
  secureClientUploadFields(PEDIDO_UPLOAD_FIELDS),
  (req, res) => {
    const flyer_tipo = (req.body?.flyer_tipo || "").toLowerCase();
    const productFromRegistry = productsRegistry.resolveProductFromRequestBody(req.body);

    if (productFromRegistry) return criarPedidoHandler(productFromRegistry.id)(req, res);

    if (flyer_tipo === "escudo3d") return criarPedidoHandler("escudo3d")(req, res);
    if (flyer_tipo === "zz1fs") return criarPedidoHandler("escalacao")(req, res);
    if (flyer_tipo === "zz1fm") return criarPedidoHandler("contratacao")(req, res);
    if (flyer_tipo === "zz1ft") return criarPedidoHandler("proximo_jogo")(req, res);
    if (flyer_tipo === "treino") return criarPedidoHandler("treino")(req, res);
    if (flyer_tipo === "zz1fj") return criarPedidoHandler("patrocinador")(req, res);
    if (flyer_tipo === "jog_proximo") return criarPedidoHandler("proximo_jogo_jogador")(req, res);
    if (flyer_tipo === "jog_resultado") return criarPedidoHandler("resultado_jogo_jogador")(req, res);
    if (flyer_tipo === "jog_escudo") return criarPedidoHandler("jogador_escudo")(req, res);
    if (flyer_tipo === "mascote_uniforme") return criarPedidoHandler("mascote_uniforme")(req, res);

    return criarPedidoHandler("pedido")(req, res);
  }
);

app.post(
  "/mascotes",
  auth,
  clientUploadConcurrencyLimit,
  secureClientUploadFields(PEDIDO_UPLOAD_FIELDS),
  criarPedidoHandler("mascote")
);

app.post(
  "/resultado_do_jogo",
  auth,
  clientUploadConcurrencyLimit,
  secureClientUploadFields(PEDIDO_UPLOAD_FIELDS),
  criarPedidoHandler("resultado")
);

// ===== BOT ADMIN: LISTAR NOVOS DE TODOS OS CLIENTES =====
app.get("/bot/pedidos/novos", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const pedidos = [];

  if (!fs.existsSync(PEDIDOS_DIR)) {
    return res.json({ ok: true, pedidos: [] });
  }

  const whatsapps = fs.readdirSync(PEDIDOS_DIR);

  for (const whatsapp of whatsapps) {
    for (const item of orderStorage.listPedidoBasesByWhatsapp(PEDIDOS_DIR, whatsapp)) {
      const statusPedido = readOrderStatus(item.base, "");
      if (statusPedido === "novo" || statusPedido === "ajuste_pendente") {
        const pedido = item.pedido || {};
        if (monthlyPlanningService.isPlanningOrder(pedido)) continue;
        if (freeArtCampaignsService.isFreeArtOrder(pedido)) continue;
        pedidos.push({
          id: item.id,
          whatsapp,
          mes: path.basename(path.dirname(item.base)),
          status: statusPedido
        });
      }
    }
  }

  return res.json({ ok: true, pedidos });
});

app.get("/bot/pedidos/:id/zip", botRunnerAuth, async (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const base = getPedidoBaseGlobal(req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedido = safeReadJson(path.join(base, "pedido.json")) || {};
  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }
  if (freeArtCampaignsService.isFreeArtOrder(pedido)) {
    return res.status(403).json({
      ok: false,
      code: "free_art_weekly_zip_blocked",
      error: "A Arte Gratis da Semana nao entra no fluxo normal de ZIP."
    });
  }

  return streamDirectoryZip({
    res,
    directory: base,
    filename: `${req.params.id}.zip`
  });
});

app.post("/bot/pedidos/:id/status", auth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const base = getPedidoBaseGlobal(req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedido = safeReadJson(path.join(base, "pedido.json")) || {};
  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }
  if (freeArtCampaignsService.isFreeArtOrder(pedido)) {
    return res.status(403).json({
      ok: false,
      code: "free_art_weekly_status_blocked",
      error: "A Arte Gratis da Semana nao entra no fluxo normal de status."
    });
  }

  const { status } = req.body || {};

  if (!orderStatus.isValidPublicStatus(status)) {
    return res.status(400).json({ ok: false, error: "status inválido" });
  }

  writeOrderStatus(base, status);
  try {
    const pedido = readPedido(base) || {};
    const statusNormalizado = String(status || "").toLowerCase();
    const runnerEvent = statusNormalizado.includes("timeout")
      ? "runner_timeout"
      : statusNormalizado.includes("erro")
        ? "runner_erro"
        : "";
    if (runnerEvent) {
      registrarEventoServidor(runnerEvent, {
        whatsapp: pedido.whatsapp,
        pedidoId: req.params.id,
        produto: pedido.product_id || pedido.categoria || "pedido",
        payload: {
          tipo: "pedido",
          status,
          motivo: String(req.body?.message || req.body?.erro || "").trim()
        }
      });
    }
  } catch (error) {
    console.warn("[pedidos] nao foi possivel registrar status do runner", {
      pedido_id: req.params.id,
      code: error?.code || "runner_status_event_error"
    });
  }

  return res.json({ ok: true });
});

// ===== LISTAR NOVOS =====
app.get("/pedidos/novos", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const mesAtual = nowYYYYMM();
  const dir = path.join(PEDIDOS_DIR, whatsapp, mesAtual);

  if (!fs.existsSync(dir)) {
    return res.json({ ok: true, pedidos: [] });
  }

  const pedidos = [];

  for (const id of fs.readdirSync(dir)) {
    if (!orderStorage.isSafePathSegment(id)) continue;
    const pdir = orderStorage.resolveContained(dir, id);
    if (!pdir || !orderStorage.orderMetadataMatchesOwner(pdir, whatsapp)) continue;

    if (readOrderStatus(pdir, "") === "novo") {
      pedidos.push({ id });
    }
  }

  return res.json({ ok: true, pedidos });
});

function downloadBloqueadoPorCadastro(cliente) {
  return cliente?.cadastro_automatico === true && cliente?.conta_finalizada !== true;
}

function mensagemDownloadBloqueado(cliente) {
  return downloadBloqueadoPorCadastro(cliente)
    ? "Crie seu login e senha para liberar o download."
    : "";
}

app.get("/meus-pedidos", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "meus_pedidos" });

  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];
  const bloqueioDownload = downloadBloqueadoPorCadastro(cliente);
  const mensagemBloqueioDownload = mensagemDownloadBloqueado(cliente);
  const itens = listPedidoBasesByWhatsapp(whatsapp)
    .filter((item) => {
      const pedido = item.pedido || {};
      if (isAdminFreeArtOrderHidden(pedido)) return false;
      return !(
        pedido.origem === "planejamento_mensal" ||
        pedido.planejamento_id ||
        pedido.planejamento_mensal?.planejamento_id
      );
    })
    .slice(0, 15);
  const planejamentos = monthlyPlanningService.listClientPlanningGroups({
    baseDir: MONTHLY_PLANNINGS_DIR,
    pedidosDir: PEDIDOS_DIR,
    whatsapp,
    limit: 15
  });

  const pedidos = itens.map((item) => {
    const resultadoFinalPath = path.join(item.base, "resultado_final.png");
    const status = readOrderStatus(item.base, item.pedido.status || "novo");
    const imagemPronta = fs.existsSync(resultadoFinalPath);
    const aprovadoCliente = item.pedido.aprovado_cliente === true;
    const pagamentoPendente = item.pedido.pagamento_pendente === true;
    const ajusteUsado = item.pedido.ajuste_automatico_usado === true;
    const isFreeArtWeekly = freeArtCampaignsService.isFreeArtOrder(item.pedido);
    const downloadBloqueado = imagemPronta && !pagamentoPendente && bloqueioDownload;
    const podeBaixar = imagemPronta && !pagamentoPendente && !downloadBloqueado;

    return {
      id: item.id,
      tipo: isFreeArtWeekly ? "Arte Gratis da Semana" : nomeCategoriaPedido(item.pedido.categoria || ""),
      status,
      data: item.pedido.data || item.criado_em,
      criado_em: item.criado_em,
      imagem_url: imagemPronta
        ? signedOrderMediaUrl({
            owner: whatsapp,
            orderId: item.id,
            variant: "preview"
          })
        : null,
      imagem_pronta: imagemPronta,
      descricao_instagram: descricaoPostagemPedido(item.pedido),
      aprovado_cliente: aprovadoCliente,
      pagamento_pendente: pagamentoPendente,
      valor_pendente: Number(item.pedido.valor_pendente || 0),
      motivo_pagamento_pendente: item.pedido.motivo_pagamento_pendente || "",
      cobranca_origem: item.pedido.cobranca_origem || "",
      tipo_compra: item.pedido.tipo_compra || "",
      valor_cobrado: Number(item.pedido.valor_cobrado || 0),
      origem_promocional: item.pedido.origem_promocional || "",
      origem: item.pedido.origem || "",
      gratuita_administrativa: item.pedido.gratuita_administrativa === true,
      bloquear_cobranca: item.pedido.bloquear_cobranca === true,
      bloquear_edicao: item.pedido.bloquear_edicao === true,
      campaign_id: item.pedido.campaign_id || "",
      assignment_id: item.pedido.assignment_id || "",
      marketing_context: item.pedido.marketing_context || "",
      ajuste_automatico_usado: ajusteUsado,
      motivo_ajuste: item.pedido.motivo_ajuste || "",
      pode_baixar: podeBaixar,
      download_bloqueado: downloadBloqueado,
      mensagem_download_bloqueado: downloadBloqueado ? mensagemBloqueioDownload : "",
      pode_pedir_ajuste: !isFreeArtWeekly && imagemPronta && !ajusteUsado && status === "pronto"
    };
  });

  return res.json(protectOrderMediaPayload(
    { ok: true, pedidos, planejamentos },
    whatsapp
  ));
});

app.post("/pedidos/:id/pagar-com-saldo", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido nao encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};
  const isArteEmpresa = pedido.categoria === "arte_empresa" || pedido.product_id === "arte_empresa";

  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  if (freeArtCampaignsService.isFreeArtOrder(pedido)) {
    return res.status(403).json({
      ok: false,
      code: "free_art_weekly_billing_blocked",
      error: "A Arte Gratis da Semana nao possui cobranca."
    });
  }

  if (pedido.pagamento_pendente !== true) {
    return res.json({
      ok: true,
      mensagem: "Pedido ja liberado.",
      pagamento_pendente: false
    });
  }

  const valorPendente = Number(pedido.valor_pendente || 0);

  if (!valorPendente || valorPendente <= 0) {
    return res.status(400).json({ ok: false, error: "Valor pendente invalido." });
  }

  const clientes = readClientes();
  const c = clientes[whatsapp];

  if (!c) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  const mesAtual = nowYYYYMM();
  billingService.ensureCurrentBillingCycle(c, mesAtual);

  if (!billingService.hasEnoughBalance(c, valorPendente)) {
    clientes[whatsapp] = c;
    writeClientes(clientes);
    return res.status(403).json({
      ok: false,
      error: "Saldo insuficiente para desbloquear esta imagem."
    });
  }

  billingService.applyOrderCharge(c, {
    custoPedido: valorPendente,
    mesAtual,
    temBrindeMascote: false
  });

  pedido.pagamento_pendente = false;
  pedido.pagamento_metodo = "saldo_ia4tube";
  pedido.pagamento_confirmado_em = new Date().toISOString();

  clientes[whatsapp] = c;
  writeClientes(clientes);
  fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");

  return res.json({
    ok: true,
    pagamento_pendente: false
  });
});

app.post("/pedidos/:id/gerar-pix", auth, async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ ok: false, error: "MP_ACCESS_TOKEN nao configurado" });
    }

    const whatsapp = req.user.whatsapp;
    const id = req.params.id;
    const base = getPedidoBase(whatsapp, id);

    if (!base) {
      return res.status(404).json({ ok: false, error: "Pedido nao encontrado" });
    }

    const pedidoPath = path.join(base, "pedido.json");
    const pedido = safeReadJson(pedidoPath) || {};

    if (isAdminFreeArtOrderHidden(pedido)) {
      return sendHiddenAdminFreeArtOrder(res);
    }

    if (freeArtCampaignsService.isFreeArtOrder(pedido)) {
      return res.status(403).json({
        ok: false,
        code: "free_art_weekly_billing_blocked",
        error: "A Arte Gratis da Semana nao possui cobranca."
      });
    }

    if (pedido.pagamento_pendente !== true) {
      return res.status(400).json({ ok: false, error: "Pedido ja liberado." });
    }

    const valorPendente = Number(pedido.valor_pendente || 0);

    if (!valorPendente || valorPendente <= 0) {
      return res.status(400).json({ ok: false, error: "Valor pendente invalido." });
    }

    if (
      pedido.mp_payment_id &&
      pedido.pix_copia_cola &&
      String(pedido.mp_payment_status || "").toLowerCase() === "pending"
    ) {
      return res.json({
        ok: true,
        pix_copia_cola: pedido.pix_copia_cola,
        qr_code_base64: pedido.pix_qr_code_base64 || "",
        ticket_url: pedido.pix_ticket_url || "",
        payment_id: pedido.mp_payment_id
      });
    }

    const payerEmail = `${String(whatsapp).replace(/\D/g, "") || "cliente"}@${PAYMENT_PAYER_EMAIL_DOMAIN}`;
    const paymentPayload = {
      transaction_amount: Number(valorPendente.toFixed(2)),
      description: `IA4Tube - Desbloqueio pedido ${id}`,
      payment_method_id: "pix",
      payer: {
        email: payerEmail
      },
      external_reference: `pedido_pix|${whatsapp}|${id}|${Date.now()}`,
      metadata: {
        tipo: "pedido_pix",
        whatsapp,
        pedido_id: id,
        valor_pendente: Number(valorPendente.toFixed(2))
      },
      notification_url: MP_NOTIFICATION_URL
    };

    const r = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": `pedido_pix_${id}_${Date.now()}`
      },
      body: JSON.stringify(paymentPayload)
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(500).json({ ok: false, error: "Erro ao gerar Pix", detalhe: data });
    }

    const transactionData = data.point_of_interaction?.transaction_data || {};
    const pixCopiaCola = transactionData.qr_code || "";
    const qrCodeBase64 = transactionData.qr_code_base64 || "";
    const ticketUrl = transactionData.ticket_url || "";

    if (!pixCopiaCola) {
      return res.status(500).json({ ok: false, error: "Mercado Pago nao retornou codigo Pix", detalhe: data });
    }

    pedido.pagamento_metodo_pendente = "pix";
    pedido.mp_payment_id = String(data.id || "");
    pedido.mp_payment_status = data.status || "pending";
    pedido.pix_copia_cola = pixCopiaCola;
    pedido.pix_qr_code_base64 = qrCodeBase64;
    pedido.pix_ticket_url = ticketUrl;
    pedido.pix_gerado_em = new Date().toISOString();

    fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");

    return res.json({
      ok: true,
      pix_copia_cola: pixCopiaCola,
      qr_code_base64: qrCodeBase64,
      ticket_url: ticketUrl,
      payment_id: pedido.mp_payment_id
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro interno ao gerar Pix" });
  }
});

app.get("/pedidos/:id/pagamento-info", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido nao encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  return res.json({
    ok: true,
    pagamento_pendente: pedido.pagamento_pendente === true,
    valor_pendente: Number(pedido.valor_pendente || 0),
    mp_payment_status: pedido.mp_payment_status || "",
    pix_copia_cola: pedido.pix_copia_cola || "",
    qr_code_base64: pedido.pix_qr_code_base64 || "",
    ticket_url: pedido.pix_ticket_url || "",
    payment_id: pedido.mp_payment_id || ""
  });
});

app.post("/pedidos/:id/aprovar", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  if (freeArtCampaignsService.isFreeArtOrder(pedido)) {
    return res.status(403).json({
      ok: false,
      code: "free_art_weekly_edit_blocked",
      error: "A Arte Gratis da Semana nao entra no fluxo normal de aprovacao."
    });
  }

  pedido.aprovado_cliente = true;
  pedido.baixado_cliente = false;
  pedido.aprovado_em = new Date().toISOString();

  fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");

  const clientes = readClientes();
  const cliente = clientes[whatsapp];
  const imagemPronta = fs.existsSync(path.join(base, "resultado_final.png"));
  const pagamentoPendente = pedido.pagamento_pendente === true;
  const downloadBloqueado = imagemPronta && !pagamentoPendente && downloadBloqueadoPorCadastro(cliente);

  return res.json({
    ok: true,
    aprovado_cliente: true,
    pode_baixar: imagemPronta && !pagamentoPendente && !downloadBloqueado,
    download_bloqueado: downloadBloqueado,
    mensagem_download_bloqueado: downloadBloqueado ? mensagemDownloadBloqueado(cliente) : ""
  });
});

app.post("/pedidos/:id/solicitar-ajuste", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const motivo = String(req.body?.motivo_ajuste || req.body?.motivo || "").trim();

  if (!motivo || motivo.length < 5) {
    return res.status(400).json({ ok: false, error: "Descreva melhor o ajuste." });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  if (freeArtCampaignsService.isFreeArtOrder(pedido)) {
    return res.status(403).json({
      ok: false,
      code: "free_art_weekly_edit_blocked",
      error: "A Arte Gratis da Semana nao entra no fluxo de ajustes nesta versao."
    });
  }

  if (pedido.ajuste_automatico_usado === true) {
    const conversa = salvarMensagemSuporteAberta(
      whatsapp,
      `Pedido ${req.params.id}: ${motivo}`,
      "Esse pedido já usou o ajuste automático. Vou encaminhar para o suporte.",
      "sistema"
    );

    conversa.precisa_humano = true;
    conversa.status = "aguardando_suporte";
    conversa.ultima_atualizacao = new Date().toISOString();

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === conversa.id);
    if (idx >= 0) {
      abertas[idx] = conversa;
      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
    }

    return res.json({
      ok: true,
      modo_humano: true,
      conversa_id: conversa.id
    });
  }

  const resultadoAtual = path.join(base, "resultado_final.png");
  const resultadoBackup = path.join(base, "resultado_final_anterior.png");

  try {
    if (fs.existsSync(resultadoAtual)) {
      fs.copyFileSync(resultadoAtual, resultadoBackup);
    }
  } catch {}

  pedido.ajuste_automatico_usado = true;
  pedido.motivo_ajuste = motivo;
  pedido.aprovado_cliente = false;
  pedido.status = "ajuste_pendente";
  pedido.ajuste_solicitado_em = new Date().toISOString();

  fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");
  writeOrderStatus(base, orderStatus.ORDER_STATUS.AJUSTE_PENDENTE);
  fs.writeFileSync(path.join(base, "ajuste_pendente.txt"), motivo, "utf8");

  return res.json({
    ok: true,
    modo_humano: false,
    status: "ajuste_pendente"
  });
});

app.get("/pedidos/:id/download-resultado", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  if (pedido.pagamento_pendente === true) {
    return res.status(403).json({
      ok: false,
      error: "Pagamento pendente. Desbloqueie esta imagem para baixar em alta qualidade."
    });
  }

  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (cliente?.cadastro_automatico === true && cliente?.conta_finalizada !== true) {
    return res.status(403).json({
      ok: false,
      error: "Crie seu login e senha para liberar o download."
    });
  }

  const arquivo = path.join(base, "resultado_final.png");

  if (!fs.existsSync(arquivo)) {
    return res.status(404).json({ ok: false, error: "Resultado final não encontrado" });
  }

  pedido.baixado_cliente = true;
  pedido.baixado_em = new Date().toISOString();

  try {
    fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");
  } catch {}

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}_resultado.png"`);
  allowProtectedCrossOriginMedia(res);

  return res.sendFile(arquivo);
});

function normalizarLinhaDescricaoInstagram(texto = "") {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[,:.;!?\-\u2013\u2014]+$/g, "")
    .trim();
}

function pedidoEhPatrocinador(pedido = {}) {
  const contexto = [
    pedido.product_id,
    pedido.categoria,
    pedido.objetivo,
    pedido.rodada,
    pedido.tipo_arte
  ].map((valor) => String(valor || "").toLowerCase()).join(" ");

  return contexto.includes("patrocin");
}

function removerHashtagsPatrocinador(linha = "") {
  return String(linha || "")
    .split(/\s+/)
    .filter((parte) => {
      const normalizada = normalizarLinhaDescricaoInstagram(parte);
      return normalizada !== "#patrocinador" && normalizada !== "#patrocinadores";
    })
    .join(" ")
    .trim();
}

function sanitizarDescricaoInstagram(texto = "", pedido = {}) {
  const linhas = String(texto || "")
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .filter(Boolean);

  if (!linhas.length) return "";

  const rotulos = new Set([
    "descricao para instagram",
    "descricao para postagem",
    "legenda para instagram",
    "sugestao de descricao",
    "sugestao de legenda",
    "caption",
    "instagram caption",
    "resultado",
    "proximo jogo",
    "escalacao",
    "contratacao",
    "dia de treino"
  ]);
  const podeUsarPatrocinador = pedidoEhPatrocinador(pedido);
  return linhas.filter((linha) => {
    const normalizada = normalizarLinhaDescricaoInstagram(linha);
    if (rotulos.has(normalizada)) return false;
    if (normalizada === "patrocinador" || normalizada === "patrocinadores") return false;
    return true;
  }).map((linha) => {
    if (podeUsarPatrocinador) return linha;
    return removerHashtagsPatrocinador(linha);
  }).filter(Boolean).join("\n").trim();
}

function descricaoPostagemPedido(pedido = {}) {
  const pronta = sanitizarDescricaoInstagram(pedido.descricao_instagram || "", pedido);
  if (pronta && !descricaoPostagemGenerica(pronta)) return pronta;

  const nome = String(pedido.nome_empresa || pedido.data || "").trim();
  const ramo = String(pedido.ramo || "").trim();
  const tipo = String(pedido.product_id || pedido.categoria || "arte").replace(/_/g, " ").trim();
  const objetivo = String(pedido.objetivo || pedido.rodada || "").trim();
  const frase = String(pedido.frase_foto || pedido.oferta || objetivo || "").trim();
  const cta = String(pedido.cta || "").trim();
  const historia = String(pedido.historia_empresa || "").trim();
  const insta = String(pedido.instagram || "").trim();
  const whatsapp = String(pedido.whatsapp_contato || "").trim();
  const contexto = [ramo, tipo, objetivo, frase].join(" ").toLowerCase();
  const marca = nome || ramo || "sua marca";
  const linhas = [];

  if (contexto.includes("marketing") || contexto.includes("redes") || contexto.includes("divulg")) {
    linhas.push(`${marca}: sua empresa precisa aparecer melhor para vender mais e ser lembrada pelo cliente certo.`);
    linhas.push(frase || "Criamos artes profissionais para divulgar produtos, servicos e promocoes com mais impacto.");
  } else if (contexto.includes("lava") || contexto.includes("automot") || contexto.includes("carro")) {
    linhas.push(`${marca}: carro limpo, cuidado no detalhe e atendimento caprichado para deixar seu veiculo com cara de novo.`);
  } else if (
    contexto.includes("futebol") ||
    contexto.includes("jogo") ||
    contexto.includes("time") ||
    contexto.includes("torcida") ||
    contexto.includes("escala")
  ) {
    linhas.push(`${marca} em campo com energia total. E dia de apoiar, vibrar e mostrar a forca da torcida.`);
  } else if (frase) {
    linhas.push(`${marca} apresenta: ${frase}`);
  } else if (ramo) {
    linhas.push(`${marca} traz uma novidade especial para quem procura ${ramo.toLowerCase()} com qualidade e atendimento de verdade.`);
  } else {
    linhas.push(`${marca} preparou uma novidade especial para voce conhecer hoje.`);
  }

  if (historia) linhas.push(historia.length > 180 ? `${historia.slice(0, 177)}...` : historia);
  linhas.push(cta || "Chame agora e veja como podemos te atender.");
  if (whatsapp) linhas.push(`WhatsApp: ${whatsapp}`);
  if (insta) linhas.push(insta.startsWith("@") ? insta : `@${insta}`);
  linhas.push("#IA4Tube #ArteComIA");

  return sanitizarDescricaoInstagram(linhas.join("\n"), pedido);
}

function descricaoPostagemGenerica(texto = "") {
  const normalizada = normalizarLinhaDescricaoInstagram(String(texto).trim())
    .replace(/\s+/g, " ");
  return !normalizada ||
    normalizada.includes("pedido ia4tube") ||
    normalizada.includes("arte pronta") ||
    normalizada.includes("arte profissional para sua marca") ||
    normalizada.includes("apresentamos novidades") ||
    normalizada.includes("fique de olho nas proximas") ||
    normalizada.includes("acompanhe para saber mais") ||
    normalizada === "#ia4tube #artecomia";
}

// ===== INFO DO PEDIDO =====
app.get("/pedidos/:id/info", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedidoJsonPath = path.join(base, "pedido.json");
  const resultadoFinalPath = path.join(base, "resultado_final.png");

  let pedido = {};
  if (fs.existsSync(pedidoJsonPath)) {
    try {
      pedido = JSON.parse(fs.readFileSync(pedidoJsonPath, "utf8"));
    } catch {}
  }

  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  const status = readOrderStatus(base, "novo");

  const imagem_pronta = fs.existsSync(resultadoFinalPath);
  const clientes = readClientes();
  const cliente = clientes[whatsapp];
  const pagamentoPendente = pedido.pagamento_pendente === true;
  const isFreeArtWeekly = freeArtCampaignsService.isFreeArtOrder(pedido);
  const downloadBloqueado = imagem_pronta && !pagamentoPendente && downloadBloqueadoPorCadastro(cliente);

  return res.json({
    ok: true,
    id: req.params.id,
    status,
    categoria: pedido.categoria || "",
    tipo_arte: pedido.product_id || pedido.categoria || "",
    nome_empresa: pedido.nome_empresa || "",
    ramo: pedido.ramo || "",
    objetivo: pedido.objetivo || pedido.rodada || "",
    frase_foto: pedido.frase_foto || "",
    cta: pedido.cta || "",
    whatsapp_contato: pedido.whatsapp_contato || "",
    instagram: pedido.instagram || "",
    historia_empresa: pedido.historia_empresa || "",
    imagem_pronta,
    preview_url: imagem_pronta
      ? signedOrderMediaUrl({
          owner: whatsapp,
          orderId: req.params.id,
          variant: "preview"
        })
      : null,
    aprovado_cliente: pedido.aprovado_cliente === true,
    pagamento_pendente: pagamentoPendente,
    valor_pendente: Number(pedido.valor_pendente || 0),
    motivo_pagamento_pendente: pedido.motivo_pagamento_pendente || "",
    cobranca_origem: pedido.cobranca_origem || "",
    tipo_compra: pedido.tipo_compra || "",
    valor_cobrado: Number(pedido.valor_cobrado || 0),
    origem_promocional: pedido.origem_promocional || "",
    origem: pedido.origem || "",
    gratuita_administrativa: pedido.gratuita_administrativa === true,
    bloquear_cobranca: pedido.bloquear_cobranca === true,
    bloquear_edicao: pedido.bloquear_edicao === true,
    campaign_id: pedido.campaign_id || "",
    assignment_id: pedido.assignment_id || "",
    marketing_context: pedido.marketing_context || "",
    arte_gratis: pedido.cobranca_origem === "arte_gratis",
    arte_gratis_semanal: isFreeArtWeekly,
    descricao_instagram: descricaoPostagemPedido(pedido),
    ajuste_automatico_usado: pedido.ajuste_automatico_usado === true,
    motivo_ajuste: pedido.motivo_ajuste || "",
    pode_baixar: imagem_pronta && !pagamentoPendente && !downloadBloqueado,
    download_bloqueado: downloadBloqueado,
    mensagem_download_bloqueado: downloadBloqueado ? mensagemDownloadBloqueado(cliente) : "",
    pode_pedir_ajuste: !isFreeArtWeekly && imagem_pronta && pedido.ajuste_automatico_usado !== true && status === "pronto"
  });
});

// ===== ACESSO PROTEGIDO AS IMAGENS DO PEDIDO =====
function optionalUserForOrderMedia(req) {
  const authorization = String(req.headers.authorization || "");
  if (!authorization.startsWith("Bearer ")) return { user: null, invalid: false };

  const token = authorization.slice(7).trim();
  try {
    return { user: verifyUserToken(token), invalid: false };
  } catch {
    return { user: null, invalid: true };
  }
}

function resolveOrderMediaAccess(req, variant) {
  const orderId = req.params.id;
  if (!orderStorage.isSafePathSegment(orderId)) return { status: 404 };

  const authResult = optionalUserForOrderMedia(req);
  if (authResult.invalid) return { status: 401 };

  if (authResult.user?.whatsapp) {
    const client = readClientes()[authResult.user.whatsapp];
    if (!client) return { status: 401 };
    if (client.ativo === false) return { status: 403 };
    const base = getPedidoBase(authResult.user.whatsapp, orderId);
    return base
      ? { status: 200, base, owner: authResult.user.whatsapp }
      : { status: 404 };
  }

  const hasSignedAccessAttempt = ["ctx", "sig", "exp", "nonce"]
    .some((field) => req.query[field] !== undefined);
  if (!hasSignedAccessAttempt) return { status: 401 };

  const owner = orderMediaAccess.openOwnerContext(req.query.ctx);
  const signature = String(req.query.sig || "");
  const expiresAt = Number(req.query.exp);
  if (
    !owner ||
    !signature ||
    !Number.isSafeInteger(expiresAt) ||
    !orderMediaAccess.verify({
      owner,
      orderId,
      variant,
      nonce: req.query.nonce,
      expiresAt,
      signature
    })
  ) {
    return { status: 404 };
  }

  const client = readClientes()[owner];
  if (!client) return { status: 404 };
  if (client.ativo === false) return { status: 403 };
  const base = getPedidoBase(owner, orderId);
  return base ? { status: 200, base, owner } : { status: 404 };
}

function sendOrderMedia(req, res, variant) {
  const access = resolveOrderMediaAccess(req, variant);
  if (access.status !== 200) {
    return res.status(access.status).json({
      ok: false,
      error: access.status === 401
        ? "Autorizacao obrigatoria"
        : access.status === 403
          ? "Acesso negado"
          : "Pedido nao encontrado"
    });
  }

  const pedido = safeReadJson(path.join(access.base, "pedido.json")) || {};
  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  const protectedPreviewPath = path.join(access.base, "preview_ia4tube.jpg");
  const finalResultPath = path.join(access.base, "resultado_final.png");
  const paymentPending = pedido.pagamento_pendente === true;
  const registrationPending = downloadBloqueadoPorCadastro(
    readClientes()[access.owner]
  );
  const protectedPreviewOnly = paymentPending || registrationPending;
  if (protectedPreviewOnly && !fs.existsSync(protectedPreviewPath)) {
    return res.status(404).json({
      ok: false,
      code: "protected_preview_unavailable",
      error: "Preview protegido ainda nao ficou pronto."
    });
  }
  const mediaPath = variant === "thumbnail"
    ? (fs.existsSync(protectedPreviewPath) ? protectedPreviewPath : finalResultPath)
    : protectedPreviewOnly
      ? protectedPreviewPath
      : finalResultPath;

  if (!fs.existsSync(mediaPath)) {
    return res.status(404).json({ ok: false, error: "Imagem ainda nao ficou pronta" });
  }

  res.setHeader("Cache-Control", "private, max-age=60, no-transform");
  res.setHeader("Vary", "Authorization");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.type(mediaPath.endsWith(".jpg") || mediaPath.endsWith(".jpeg") ? "image/jpeg" : "image/png");
  return res.sendFile(mediaPath);
}

app.get("/pedidos/:id/media-url", auth, (req, res) => {
  const variant = orderMediaAccess.normalizeVariant(req.query.variant || "preview");
  if (!variant) {
    return res.status(400).json({ ok: false, error: "Variante de imagem invalida" });
  }
  res.setHeader("Cache-Control", "private, no-store");
  allowProtectedCrossOriginMedia(res);

  const base = getPedidoBase(req.user.whatsapp, req.params.id);
  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido nao encontrado" });
  }

  const pedido = safeReadJson(path.join(base, "pedido.json")) || {};
  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  return res.json({
    ok: true,
    url: signedOrderMediaUrl({
      owner: req.user.whatsapp,
      orderId: req.params.id,
      variant
    }),
    expires_in: ORDER_MEDIA_URL_TTL_SECONDS
  });
});

app.get("/pedidos/:id/preview", (req, res) => sendOrderMedia(req, res, "preview"));
app.get("/pedidos/:id/thumbnail", (req, res) => sendOrderMedia(req, res, "thumbnail"));

// ===== BAIXAR ZIP =====
app.get("/pedidos/:id/zip", auth, async (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedido = safeReadJson(path.join(base, "pedido.json")) || {};
  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }
  if (freeArtCampaignsService.isFreeArtOrder(pedido)) {
    return res.status(403).json({
      ok: false,
      code: "free_art_weekly_zip_blocked",
      error: "A Arte Gratis da Semana nao entra no fluxo normal de ZIP."
    });
  }

  return streamDirectoryZip({
    res,
    directory: base,
    filename: `${req.params.id}.zip`
  });
});

// ===== ATUALIZAR STATUS =====
app.post("/pedidos/:id/status", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, code: "order_not_found", error: "Pedido nao encontrado" });
  }
  return res.status(403).json({
    ok: false,
    code: "client_status_transition_forbidden",
    error: "Atualizacao de status reservada ao processamento autorizado."
  });
});

// ===== UPLOAD DO RESULTADO FINAL =====
app.post(
  "/bot/pedidos/:id/upload-resultado",
  botRunnerAuth,
  uploadResultado.fields([
    { name: "resultado", maxCount: 1 },
    { name: "preview", maxCount: 1 }
  ]),
  async (req, res) => {

    const descricao_instagram = req.body?.descricao_instagram || "";
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const base = getPedidoBaseGlobal(req.params.id);

    if (!base) {
      cleanupUploadedFiles(req.files);
      return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
    }

    const existingPedido = safeReadJson(path.join(base, "pedido.json")) || {};
    if (isAdminFreeArtOrderHidden(existingPedido)) {
      cleanupUploadedFiles(req.files);
      return sendHiddenAdminFreeArtOrder(res);
    }
    if (freeArtCampaignsService.isFreeArtOrder(existingPedido)) {
      cleanupUploadedFiles(req.files);
      return res.status(403).json({
        ok: false,
        code: "free_art_weekly_upload_blocked",
        error: "A Arte Gratis da Semana nao entra no fluxo normal de upload."
      });
    }

    const ownerId = getPedidoOwnerFromBase(base);
    if (
      !ownerId ||
      String(existingPedido.whatsapp || "").trim() !== ownerId
    ) {
      cleanupUploadedFiles(req.files);
      return res.status(409).json({
        ok: false,
        code: "art_ready_owner_mismatch",
        error: "Proprietario do pedido nao pode ser confirmado."
      });
    }

    const previousStatus = readOrderStatus(
      base,
      String(existingPedido.status || "")
    );
    const resultadoFile = req.files?.resultado?.[0] || null;
    const previewFile = req.files?.preview?.[0] || null;

    if (!resultadoFile) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ ok: false, error: "Arquivo resultado não enviado" });
    }

    const dest = path.join(base, "resultado_final.png");
    const previewDest = path.join(base, "preview_ia4tube.jpg");

    try {
      const completionTransition = successfulCompletionTransition({
        previousStatus,
        previousOrderStatus: existingPedido.status,
        existingGenerationId: existingPedido.art_ready_generation_id,
        createGenerationId: artReadyNotificationService.createGenerationId
      });

      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      fs.renameSync(resultadoFile.path, dest);

      if (previewFile) {
        if (fs.existsSync(previewDest)) fs.unlinkSync(previewDest);
        fs.renameSync(previewFile.path, previewDest);
      }

      try {
        const ajustePendentePath = path.join(base, "ajuste_pendente.txt");
        if (fs.existsSync(ajustePendentePath)) fs.unlinkSync(ajustePendentePath);
      } catch {}

      const completedAt = new Date().toISOString();
      const generationId = completionTransition.generationId;
      const pedidoData = {
        ...existingPedido,
        descricao_instagram: descricao_instagram || "",
        status: orderStatus.ORDER_STATUS.PRONTO,
        aprovado_cliente: false,
        baixado_cliente: false,
        resultado_enviado_em: completedAt,
        ...(generationId ? {
          art_ready_generation_id: generationId,
          art_ready_completed_at: !completionTransition.transitioned
            ? existingPedido.art_ready_completed_at || completedAt
            : completedAt
        } : {})
      };
      writePedido(base, pedidoData);
      writeOrderStatus(base, orderStatus.ORDER_STATUS.PRONTO);

      registrarEventoServidor("pedido_pronto", {
        whatsapp: pedidoData.whatsapp,
        pedidoId: req.params.id,
        produto: pedidoData.product_id || pedidoData.categoria || "pedido",
        payload: {
          tipo: "pedido",
          categoria: pedidoData.categoria || "",
          pagamento_pendente: pedidoData.pagamento_pendente === true
        }
      });

      if (
        generationId &&
        !monthlyPlanningService.isPlanningOrder(pedidoData) &&
        !freeArtCampaignsService.isFreeArtOrder(pedidoData)
      ) {
        try {
          const notification = await artReadyNotificationService.handleCompletion({
            generationId,
            ownerId
          });
          console.log("[art-ready-notification]", {
            code: notification.code,
            recipients: notification.recipients,
            sent: notification.sent,
            blocked: notification.blocked,
            failed: notification.failed
          });
        } catch (error) {
          console.warn("[art-ready-notification]", {
            code: error?.code || "art_ready_event_failed"
          });
        }
      }

      return res.json({
        ok: true,
        arquivo: "resultado_final.png",
        preview: previewFile ? "preview_ia4tube.jpg" : ""
      });
    } catch (e) {
      cleanupUploadedFiles(req.files);
      console.error("[uploads] falha ao salvar resultado", {
        pedido_id: req.params.id,
        message: e?.message,
        stack: e?.stack
      });
      return res.status(500).json({
        ok: false,
        error: "Falha ao salvar resultado"
      });
    }
  }
);

// ===== SUPORTE CHAT =====
app.post("/suporte/chat", auth, async (req, res) => {
  try {
    const { mensagem } = req.body || {};
    const whatsapp = req.user.whatsapp;

    const abertasHumanas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const conversaHumana = abertasHumanas.find(c =>
      c.whatsapp === whatsapp &&
      !c.finalizada &&
      (
        c.status === "humano_assumiu" ||
        c.precisa_humano === true
      )
    );

    if (conversaHumana) {
      conversaHumana.mensagens = conversaHumana.mensagens || [];

      conversaHumana.mensagens.push({
        id: `${Date.now()}_cliente`,
        data: new Date().toISOString(),
        autor: "cliente",
        texto: String(mensagem || "").trim()
      });

      conversaHumana.ultima_atualizacao = new Date().toISOString();

      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertasHumanas);

      return res.json({
        ok:true,
        modo_humano:true,
        conversa_id: conversaHumana.id,
        resposta:null
      });
    }

    if (!mensagem || !String(mensagem).trim()) {
      return res.status(400).json({ ok: false, error: "Mensagem vazia" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY não configurada" });
    }

    const msg = String(mensagem || "").toLowerCase();

// ===== RESPOSTAS GRÁTIS (SEM IA) =====
if(msg.includes("resultado do jogo") && msg.includes("entender")){
  return res.json({
    ok:true,
    resposta:`Resultado do jogo mostra placar e escudos.\n\nObrigatório:\n- Times\n- Placar\n- Escudos\n\nOpcional:\n- Frase\n- Artilheiros\n- Foto`
  });
}

if(msg.includes("próximo jogo jogador") || msg.includes("proximo jogo jogador")){
  return res.json({
    ok:true,
    resposta:`Próximo jogo jogador cria uma arte focada em um jogador para divulgar a próxima partida.\n\nObrigatório:\n- Time A e Time B\n- Escudo do time\n- Foto do jogador\n- Data e horário\n- Campeonato/competição\n\nOpcional:\n- Local`
  });
}

if(msg.includes("resultado jogador")){
  return res.json({
    ok:true,
    resposta:`Resultado jogador cria uma arte de resultado com foco no jogador.\n\nObrigatório:\n- Times\n- Placar\n- Escudos\n- Foto do jogador\n\nOpcional:\n- Frase\n- Campeonato/competição`
  });
}

if(msg.includes("jogador + escudo") || msg.includes("jogador e escudo")){
  return res.json({
    ok:true,
    resposta:`Jogador + escudo cria uma arte simples e forte com o jogador e o escudo do time.\n\nObrigatório:\n- Nome do jogador\n- Escudo do time\n- Foto do jogador\n\nOpcional:\n- Nenhum`
  });
}

if(msg.includes("como baixar") || msg.includes("baixar novamente")){
  return res.json({
    ok:true,
    resposta:"Vá em Meus pedidos e clique em Baixar novamente."
  });
}

if(
  msg.includes("combo") ||
  msg.includes("combos") ||
  msg.includes("plano") ||
  msg.includes("planos") ||
  msg.includes("assinatura") ||
  msg.includes("mensalidade") ||
  msg.includes("essencial") ||
  msg.includes("profissional") ||
  msg.includes("empresarial")
){
  return res.json({
    ok:true,
    resposta:"Combos IA4Tube:\n\n- i4 Essencial: R$ 39,90/mês, 8 artes por mês, 3 Materiais Gráficos da Empresa por mês, 1 Carrossel por mês e suporte via WhatsApp.\n\n- i4 Profissional: R$ 79,90/mês, 20 artes por mês, 5 Materiais Gráficos da Empresa por mês, 1 Material Gráfico de Nicho por mês, 2 Carrosséis por mês e suporte via WhatsApp.\n\n- i4 Empresarial: R$ 149,90/mês, 40 artes por mês, todos os Materiais Gráficos Gerais liberados, 3 Materiais Gráficos de Nicho por mês, 4 Carrosséis por mês e suporte via WhatsApp."
  });
}

if(msg.includes("saldo") && msg.includes("como")){
  return res.json({
    ok:true,
    resposta:"Clique em Adicionar saldo no topo da tela."
  });
}

// ===== SUPORTE DIRETO (SEM IA) =====
if(
  msg.includes("erro") ||
  msg.includes("não chegou") ||
  msg.includes("nao chegou") ||
  msg.includes("errado") ||
  msg.includes("alteração") ||
  msg.includes("suporte")
){
  const conversa = salvarMensagemSuporteAberta(whatsapp, mensagem, "Vou encaminhar sua solicitação para o suporte.", "sistema");
  conversa.precisa_humano = true;
  conversa.status = "aguardando_suporte";
  conversa.ultima_atualizacao = new Date().toISOString();

  const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
  const idx = abertas.findIndex(c => c.id === conversa.id);
  if(idx >= 0){
    abertas[idx] = conversa;
    writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
  }

  return res.json({
    ok:true,
    modo_humano:true,
    conversa_id: conversa.id,
    resposta:"Vou encaminhar sua solicitação para o suporte."
  });
}

// ===== SE NÃO CAIU EM NADA → USA IA =====
const pedidos = listPedidoBasesByWhatsapp(whatsapp).slice(0, 5);

    const resumoPedidos = pedidos.map((p) => {
      const resultadoFinalPath = path.join(p.base, "resultado_final.png");

      const status = readOrderStatus(p.base, p.pedido.status || "novo");

      return {
        id: p.id,
        status,
        categoria: p.pedido.categoria || "",
        rodada: p.pedido.rodada || "",
        data: p.pedido.data || "",
        criado_em: p.criado_em,
        imagem_pronta: fs.existsSync(resultadoFinalPath)
      };
    });

    const prompt = `
Você é o suporte automático da IA4Tube.

REGRAS:
- Responda sempre em português do Brasil.
- Responda curto, simples e direto.
- Não invente status, prazo ou informação.
- Use os pedidos reais abaixo somente quando o cliente perguntar sobre pedido.

MENU DO SUPORTE:
1. Dúvida sobre produto
2. Não consigo enviar pedido
3. Meu pedido deu erro / alteração
4. Pedido pronto / download
5. Pagamento / saldo
6. Quero falar com suporte

COMPORTAMENTO:
- Se for cumprimento, responda: "Oi! Escolha uma opção no menu do suporte."
- Se o cliente pedir opções, disser "quais opções", "me dê as opções" ou algo parecido, responda curto: "Use os botões do menu do suporte."
- Se o cliente falar "dúvida sobre produto" ou perguntar "como funciona", responda: "Escolha o produto no menu abaixo."
- Se o cliente perguntar sobre combos, planos, assinatura, mensalidade, Essencial, Profissional ou Empresarial, responda somente: "Combos IA4Tube: i4 Essencial R$ 39,90/mês com 8 artes, 3 Materiais Gráficos da Empresa, 1 Carrossel e suporte via WhatsApp. i4 Profissional R$ 79,90/mês com 20 artes, 5 Materiais Gráficos da Empresa, 1 Material Gráfico de Nicho, 2 Carrosséis e suporte via WhatsApp. i4 Empresarial R$ 149,90/mês com 40 artes, todos os Materiais Gráficos Gerais, 3 Materiais Gráficos de Nicho, 4 Carrosséis e suporte via WhatsApp."

- Se o cliente disser "Quero entender Resultado do jogo", explique somente Resultado do jogo.
- Se o cliente disser "Quero entender Escalação", explique somente Escalação.
- Se o cliente disser "Quero entender Contratação", explique somente Contratação.
- Se o cliente disser "Quero entender Próximo jogo", explique somente Próximo jogo.
- Se o cliente disser "Quero entender Patrocinador", explique somente Patrocinador.
- Se o cliente disser "Quero entender Escudo 3D", responda: "Escudo 3D transforma o escudo do time em uma arte 3D moderna. Obrigatório: enviar o escudo do time. Opcional: nenhuma informação extra."
- Se o cliente disser "Quero entender Próximo jogo jogador", explique somente Próximo jogo jogador.
- Se o cliente disser "Quero entender Resultado jogador", explique somente Resultado jogador.
- Se o cliente disser "Quero entender Jogador + escudo", explique somente Jogador + escudo.

- Ao explicar produto, sempre separe "Obrigatório" e "Opcional".
- Se o cliente disser "Não sei o que preencher", pergunte: "Qual produto você está tentando enviar?"
- Se o cliente disser "Não consigo enviar imagem", responda: "Tente enviar uma imagem em PNG ou JPG. Se continuar dando erro, vou encaminhar para o suporte."
- Se o cliente disser "Botão criar minha arte não funciona", responda exatamente: "Vou encaminhar sua solicitação para o suporte."
- Se o cliente disser "Apareceu erro ao enviar pedido", responda exatamente: "Vou encaminhar sua solicitação para o suporte."
- Se o cliente disser "Não consigo enviar pedido", pergunte: "Qual produto você está tentando enviar?"

- Se o cliente disser imagem com nome errado, texto errado, escudo errado, imagem estranha, pedir alteração, pedido não chegou, problema técnico ou reclamação, responda exatamente: "Vou encaminhar sua solicitação para o suporte."

- Se o cliente perguntar como baixar, responda: "Vá em Meus pedidos e clique em Baixar novamente."
- Se o cliente disser "Não apareceu meu pedido pronto", responda: "Confira em Meus pedidos. Se ainda não apareceu, aguarde alguns minutos. Se continuar, vou encaminhar para o suporte."
- Se o cliente disser "Quero baixar novamente", responda: "Vá em Meus pedidos e clique em Baixar novamente."
- Se o cliente disser "Meu pedido está demorando", responda: "Aguarde alguns minutos e confira em Meus pedidos. Se continuar demorando, vou encaminhar para o suporte."

- Se o cliente perguntar como adicionar saldo, responda: "Clique em Adicionar saldo no topo da tela e escolha um valor."
- Se o cliente disser "Paguei e meu saldo não apareceu", responda exatamente: "Vou encaminhar sua solicitação para o suporte."
- Se o cliente disser "Saldo insuficiente", responda: "Clique em Adicionar saldo no topo da tela e escolha um valor."
- Se o cliente perguntar valores de saldo, responda: "Você pode adicionar R$8, R$18, R$28 ou R$48."

- Se o cliente pedir suporte humano ou disser "Quero falar com suporte", responda exatamente: "Vou encaminhar sua solicitação para o suporte."

PRODUTOS:

Resultado do jogo:
- Mostra o placar da partida, os escudos dos times e uma frase relacionada ao jogo.
- Obrigatório:
  1. Definir quais times estão jogando.
  2. Definir o placar.
  3. Selecionar os escudos.
- Opcional:
  4. Criar uma frase.
  5. Informar campeonato/competição.
  6. Informar artilheiros.
  7. Enviar foto do jogo ou do time.

Escalação:
- Mostra a lista de jogadores do time.
- Obrigatório:
  1. Título da arte.
  2. Escudo do time.
  3. Nome dos jogadores.
- Opcional:
  4. Posição dos jogadores.
  5. Escudo adversário.
  6. Foto do jogador ou do time.

Contratação:
- Anúncio de jogador contratado, renovado ou apresentado.
- Obrigatório:
  1. Título da arte.
  2. Nome do jogador.
  3. Escudo do time.
  4. Foto do jogador.
- Opcional:
  5. Posição ou idade.

Próximo jogo:
- Mostra confronto entre dois times com data e horário.
- Obrigatório:
  1. Definir os dois times.
  2. Selecionar os escudos.
  3. Informar data e horário.
  4. Informar campeonato/competição.
- Opcional:
  5. Informar local.

Patrocinador:
- Mostra o escudo do time junto com logos de patrocinadores/apoiadores.
- Obrigatório:
  1. Título da arte.
  2. Escudo do time.
  3. Enviar logos dos patrocinadores.
- Opcional:
  4. Texto principal.

Próximo jogo jogador:
- Arte de próximo jogo com foco em um jogador.
- Obrigatório:
  1. Definir os dois times.
  2. Escudo do time.
  3. Foto do jogador.
  4. Data e horário.
  5. Campeonato/competição.
- Opcional:
  6. Local.

Resultado jogador:
- Arte de resultado com foco no jogador.
- Obrigatório:
  1. Definir os times.
  2. Definir o placar.
  3. Selecionar os escudos.
  4. Enviar foto do jogador.
- Opcional:
  5. Frase.
  6. Campeonato/competição.

Jogador + escudo:
- Arte simples com jogador e escudo do time.
- Obrigatório:
  1. Nome do jogador.
  2. Escudo do time.
  3. Foto do jogador.
- Opcional:
  Nenhum.

PEDIDOS DO CLIENTE:
${JSON.stringify(resumoPedidos, null, 2)}

MENSAGEM DO CLIENTE:
${String(mensagem).trim()}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Você é o suporte automático da IA4Tube. Responda curto, claro e em português do Brasil." },
          { role: "user", content: prompt }
        ],
        max_tokens: 220,
        temperature: 0.3
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: "Erro ao chamar IA",
        detalhe: data?.error?.message || ""
      });
    }

    const resposta = data.choices?.[0]?.message?.content?.trim();
    const respostaFinal = (resposta || "Não consegui responder agora.").trim()
      + "\n\nQuer continuar conversando com o robô ou prefere falar com humano?";

    const conversa = salvarMensagemSuporteAberta(whatsapp, mensagem, respostaFinal, "ia");

    const respostaLower = respostaFinal.toLowerCase();

    if (
      (respostaLower.includes("encaminhar") && respostaLower.includes("suporte")) ||
      respostaLower.includes("suporte humano") ||
      respostaLower.includes("falar com suporte") ||
      respostaLower.includes("entrar em contato com o suporte") ||
      respostaLower.includes("recomendo que você entre em contato")
    ) {
      conversa.precisa_humano = true;
      conversa.status = "aguardando_suporte";

      const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
      const idx = abertas.findIndex(c => c.id === conversa.id);
      if(idx >= 0){
        abertas[idx] = conversa;
        writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
      }
    }

    return res.json({
      ok: true,
      conversa_id: conversa.id,
      modo_humano: !!conversa.precisa_humano,
      resposta: respostaFinal,
      mostrar_opcoes_pos_ia: true,
      opcoes_pos_ia: [
        { texto: "Continuar com robô", valor: "continuar_robo" },
        { texto: "Falar com humano", valor: "falar_humano" }
      ]
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Erro no suporte"
    });
  }
});

app.get("/suporte/minhas-mensagens", auth, (req, res) => {
  try {
    const chatAberto = String(req.headers["x-ia4-chat"] || "") === "true";

    registrarOnline(req, { chat_aberto: chatAberto, ultima_acao: "suporte_poll" });

    const whatsapp = req.user.whatsapp;
    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const conversa = abertas.find(c => c.whatsapp === whatsapp && !c.finalizada);

    if (!conversa) {
      return res.json({
        ok: true,
        conversa: null,
        mensagens: [],
        tem_mensagem_nova: false
      });
    }

    const temMensagemNova = conversa.cliente_leu === false;

    if (chatAberto) {
      conversa.cliente_leu = true;
      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
    }

    return res.json({
      ok: true,
      conversa_id: conversa.id,
      conversa,
      mensagens: conversa.mensagens || [],
      tem_mensagem_nova: temMensagemNova
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao buscar mensagens" });
  }
});

app.get("/bot/eventos-clientes", botAdminAuth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const limite = Math.min(Number(req.query.limite || 1000), 5000);

    const agora = new Date();
    const yyyy = agora.getFullYear();
    const mm = String(agora.getMonth() + 1).padStart(2, "0");
    const dd = String(agora.getDate()).padStart(2, "0");

    const analyticsDiaFile = path.join(
      ANALYTICS_DIR,
      `${yyyy}-${mm}-${dd}.json`
    );

    const eventos = readJsonArraySafe(analyticsDiaFile)
      .slice(-limite)
      .map(sanitizeAnalyticsEventForResponse);

    return res.json({
      ok: true,
      total: eventos.length,
      eventos
    });
  } catch {
    return res.status(500).json({ ok:false, error:"erro_eventos_clientes" });
  }
});

app.get("/bot/analytics-dia/:data", botAdminAuth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const data = String(req.params.data || "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      return res.status(400).json({
        ok: false,
        error: "Data inválida. Use YYYY-MM-DD."
      });
    }

    const analyticsDiaFile = path.join(ANALYTICS_DIR, `${data}.json`);

    if (!fs.existsSync(analyticsDiaFile)) {
      return res.status(404).json({
        ok: false,
        error: "Arquivo de analytics não encontrado para esta data.",
        data
      });
    }

    const eventos = readJsonArraySafe(analyticsDiaFile)
      .map(sanitizeAnalyticsEventForResponse);

    return res.json({
      ok: true,
      data,
      total: eventos.length,
      eventos
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "erro_analytics_dia"
    });
  }
});

app.get("/bot/eventos-pedido/:id", botAdminAuth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const basePedido = getPedidoBaseGlobal(req.params.id);

    if (!basePedido) {
      return res.status(404).json({ ok:false, error:"Pedido não encontrado" });
    }

    const eventosPedidoFile = path.join(basePedido, "eventos_cliente.json");
    const eventos = readJsonArraySafe(eventosPedidoFile)
      .map(sanitizeAnalyticsEventForResponse);

    return res.json({
      ok:true,
      pedido_id:req.params.id,
      total:eventos.length,
      eventos
    });
  } catch {
    return res.status(500).json({ ok:false, error:"erro_eventos_pedido" });
  }
});

app.get("/bot/online", botAdminAuth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    return res.json({
      ok: true,
      usuarios: listarOnlineRecentes().map(sanitizeOnlineUserForResponse)
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao listar online" });
  }
});

app.post("/bot/suporte/erro-pedido", botRunnerAuth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok:false, error:"Acesso negado" });
    }

    const { pedido_id, whatsapp, motivo } = req.body || {};

    if (!pedido_id || !whatsapp) {
      return res.status(400).json({ ok:false, error:"pedido_id e whatsapp obrigatórios" });
    }

    const basePedido = getPedidoBase(whatsapp, pedido_id);
    if (!basePedido) {
      return res.status(404).json({
        ok: false,
        code: "order_owner_mismatch",
        error: "Pedido nao encontrado para a empresa informada."
      });
    }

    if (basePedido) {
      try {
        writeOrderStatus(basePedido, orderStatus.ORDER_STATUS.ERRO);

        const pedidoPath = path.join(basePedido, "pedido.json");
        const pedidoData = safeReadJson(pedidoPath) || {};

        pedidoData.status = "erro";
        pedidoData.erro_cliente = true;
        pedidoData.motivo_erro = motivo || "erro_pipeline";
        pedidoData.erro_em = new Date().toISOString();

        fs.writeFileSync(
          pedidoPath,
          JSON.stringify(pedidoData, null, 2),
          "utf8"
        );
        registrarEventoServidor("runner_erro", {
          whatsapp,
          pedidoId: pedido_id,
          produto: pedidoData.product_id || pedidoData.categoria || "pedido",
          payload: {
            tipo: "suporte_pipeline",
            motivo: motivo || "erro_pipeline"
          }
        });
      } catch {}
    }

    const conversa = salvarMensagemSuporteAberta(
      whatsapp,
      "",
      `⚠️ Seu pedido ${pedido_id} entrou em análise.\n\nSua imagem não passou na nossa política de privacidade ou ocorreu algum erro no processamento automático.\n\nVeja o SUPORTE abaixo para acompanhar o atendimento.\n\nNossa equipe vai verificar o caso. Se necessário, o valor será devolvido em saldo na sua conta.`,
      "sistema"
    );

    conversa.precisa_humano = true;
    conversa.status = "aguardando_suporte";
    conversa.motivo = motivo || "erro_pipeline";
    conversa.ultima_atualizacao = new Date().toISOString();
    conversa.cliente_leu = false;

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === conversa.id);

    if (idx >= 0) {
      abertas[idx] = conversa;
      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
    }

    return res.json({
      ok:true,
      conversa_id: conversa.id
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"erro_avisar_suporte" });
  }
});

function resolverWhatsappDestinoSuporte(destino) {
  destino = String(destino || "").trim();

  if (!destino) return { whatsapp: "", ambiguous: false };

  const candidatos = new Set();
  const adicionarCandidato = (value) => {
    const candidato = String(value || "").trim();
    if (orderStorage.isSafePathSegment(candidato)) {
      candidatos.add(candidato);
    }
  };

  const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
  for (const conversa of abertas) {
    if (conversa?.id === destino && !conversa.finalizada) {
      adicionarCandidato(conversa.whatsapp);
    }
  }

  const clientes = readClientes();

  const loginNormalizado = normalizarLoginId(destino);
  for (const [tenantKey, cliente] of Object.entries(clientes)) {
    if (!cliente || typeof cliente !== "object") continue;
    const loginPublico = normalizarLoginId(cliente.login_id);
    if (
      (tenantKey === loginNormalizado && (!loginPublico || loginPublico === loginNormalizado)) ||
      loginPublico === loginNormalizado
    ) {
      adicionarCandidato(tenantKey);
    }
  }

  for (const basePedido of orderStorage.findPedidoBasesGlobal(PEDIDOS_DIR, destino)) {
    const pedidoPath = path.join(basePedido, "pedido.json");
    const pedido = safeReadJson(pedidoPath) || {};
    adicionarCandidato(pedido.whatsapp);
  }

  return {
    whatsapp: candidatos.size === 1 ? [...candidatos][0] : "",
    ambiguous: candidatos.size > 1
  };
}

app.post("/bot/suporte/enviar-cliente", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok:false, error:"Acesso negado" });
    }

    const { destino, mensagem } = req.body || {};
    const texto = String(mensagem || "").trim();

    if (!destino || !texto) {
      return res.status(400).json({
        ok:false,
        error:"destino e mensagem obrigatórios"
      });
    }

    const destinoResolvido = resolverWhatsappDestinoSuporte(destino);

    if (destinoResolvido.ambiguous) {
      return res.status(409).json({
        ok:false,
        code:"support_destination_ambiguous",
        error:"Destino de suporte ambiguo."
      });
    }

    if (!destinoResolvido.whatsapp) {
      return res.status(404).json({
        ok:false,
        error:"Cliente não encontrado por esse ID, WhatsApp ou pedido."
      });
    }

    const conversa = salvarMensagemSuporteAberta(
      destinoResolvido.whatsapp,
      "",
      texto,
      "humano"
    );

    conversa.precisa_humano = true;
    conversa.status = "humano_assumiu";
    conversa.ultima_atualizacao = new Date().toISOString();
    conversa.cliente_leu = false;

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === conversa.id);

    if (idx >= 0) {
      abertas[idx] = conversa;
      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
    }

    return res.json({
      ok:true,
      conversa_id: conversa.id,
      whatsapp
    });
  } catch {
    return res.status(500).json({
      ok:false,
      error:"erro_enviar_mensagem_cliente"
    });
  }
});

app.get("/bot/suporte/abertas", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const conversas = readJsonArraySafe(SUPORTE_ABERTAS_FILE)
      .filter(c => !c.finalizada)
      .sort((a, b) => new Date(b.ultima_atualizacao || b.inicio) - new Date(a.ultima_atualizacao || a.inicio));

    return res.json({
      ok: true,
      conversas
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao listar suporte aberto" });
  }
});

app.post("/bot/suporte/:id/assumir", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok:false, error:"Acesso negado" });
    }

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === req.params.id && !c.finalizada);

    if (idx === -1) {
      return res.status(404).json({ ok:false, error:"Conversa não encontrada" });
    }

    abertas[idx].status = "humano_assumiu";
    abertas[idx].precisa_humano = true;
    abertas[idx].cliente_leu = false;
    abertas[idx].ultima_atualizacao = new Date().toISOString();

    writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);

    return res.json({ ok:true });
  } catch {
    return res.status(500).json({ ok:false, error:"erro_assumir" });
  }
});

app.post("/bot/suporte/:id/responder", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const { mensagem } = req.body || {};
    const texto = String(mensagem || "").trim();

    if (!texto) {
      return res.status(400).json({ ok: false, error: "Mensagem vazia" });
    }

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === req.params.id && !c.finalizada);

    if (idx === -1) {
      return res.status(404).json({ ok: false, error: "Conversa não encontrada" });
    }

    abertas[idx].mensagens = abertas[idx].mensagens || [];
    abertas[idx].mensagens.push({
      id: `${Date.now()}_humano`,
      data: new Date().toISOString(),
      autor: "humano",
      texto
    });

    abertas[idx].status = "humano_assumiu";
    abertas[idx].precisa_humano = true;
    abertas[idx].ultima_atualizacao = new Date().toISOString();

    writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);

    return res.json({ ok: true, conversa: abertas[idx] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao responder suporte" });
  }
});

app.post("/suporte/finalizar", auth, (req, res) => {
  try {
    const whatsapp = req.user.whatsapp;
    const { motivo } = req.body || {};

    const finalizou = finalizarConversaSuporte(whatsapp, motivo || "cliente_fechou_chat");

    if (!finalizou) {
      return res.json({ ok: true, sem_conversa_aberta: true });
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao finalizar suporte" });
  }
});

app.get("/bot/suporte/finalizadas", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const finalizadasPath = path.join(DATA_DIR, "suporte_conversas_finalizadas.json");
    const conversas = readJsonArraySafe(finalizadasPath);

    return res.json({
      ok: true,
      conversas
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao listar suporte finalizado" });
  }
});

app.post("/bot/suporte/limpar-finalizadas", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const finalizadasPath = path.join(DATA_DIR, "suporte_conversas_finalizadas.json");
    writeJsonSafe(finalizadasPath, []);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao limpar suporte finalizado" });
  }
});

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function listSeoNicheSlugs() {
  if (!fs.existsSync(SEO_NICHES_DIR)) {
    return [];
  }

  return fs.readdirSync(SEO_NICHES_DIR)
    .filter((fileName) => fileName.endsWith(".json") && !fileName.startsWith("_"))
    .map((fileName) => {
      const expectedSlug = path.basename(fileName, ".json");
      const filePath = path.join(SEO_NICHES_DIR, fileName);

      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const slug = String(data.slug || "").trim().toLowerCase();

        if (slug !== expectedSlug) {
          console.warn("[seo] sitemap ignorou nicho com slug divergente", {
            fileName,
            expectedSlug,
            slug
          });
          return null;
        }

        if (!/^[a-z0-9-]{2,80}$/.test(slug)) {
          console.warn("[seo] sitemap ignorou nicho com slug invalido", {
            fileName,
            slug
          });
          return null;
        }

        return slug;
      } catch (e) {
        console.warn("[seo] sitemap ignorou JSON invalido", {
          fileName,
          message: e?.message
        });
        return null;
      }
    })
    .filter(Boolean)
    .sort();
}

app.get("/sitemap.xml", (req, res) => {
  const baseUrl = PUBLIC_WEB_BASE_URL;
  const urls = [
    { loc: `${baseUrl}/`, changefreq: "daily", priority: "1.0" },
    ...listSeoNicheSlugs().map((slug) => ({
      loc: `${baseUrl}/${slug}`,
      changefreq: "weekly",
      priority: "0.8"
    }))
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((item) => `  <url>
    <loc>${escapeXml(item.loc)}</loc>
    <changefreq>${escapeXml(item.changefreq)}</changefreq>
    <priority>${escapeXml(item.priority)}</priority>
  </url>`).join("\n")}
</urlset>`;

  return res.type("application/xml").send(body);
});

app.get("/robots.txt", (req, res) => {
  return res.type("text/plain").send(`User-agent: *
Allow: /

Disallow: /login
Disallow: /painel
Disallow: /admin
Disallow: /api

Sitemap: ${PUBLIC_WEB_BASE_URL}/sitemap.xml
`);
});

app.get("/:nichoSlug", (req, res, next) => {
  const slug = String(req.params.nichoSlug || "").trim().toLowerCase();

  if (!/^[a-z0-9-]{2,80}$/.test(slug)) {
    return next();
  }

  try {
    const nicheData = seoNichePages.readNichePageData(SEO_NICHES_DIR, slug);

    if (nicheData) {
      return res.type("html").send(seoNichePages.renderNichePage(nicheData, {
        baseUrl: PUBLIC_WEB_BASE_URL
      }));
    }
  } catch (e) {
    console.error("[seo] erro ao renderizar pagina de nicho", {
      slug,
      message: e?.message
    });
    return res.status(500).send("Erro ao carregar pagina de nicho");
  }

  const legacyPagePath = path.join(SEO_NICHES_DIR, `${slug}.html`);

  if (fs.existsSync(legacyPagePath)) {
    return res.sendFile(legacyPagePath);
  }

  return next();
});

app.use((err, req, res, next) => {
  cleanupUploadedFiles(req.files);
  console.error("[api] erro nao tratado", {
    path: req.path,
    method: req.method,
    code: err?.code,
    field: err?.field,
    message: err?.message,
    stack: err?.stack
  });

  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof multer.MulterError) {
    const isProductDiscovery = req.path === "/empresa/planejamento-mensal/descobrir-produtos";
    const limitExceeded = new Set([
      "LIMIT_FILE_SIZE",
      "LIMIT_FILE_COUNT",
      "LIMIT_FIELD_COUNT",
      "LIMIT_FIELD_VALUE",
      "LIMIT_PART_COUNT",
      "LIMIT_TOTAL_FILE_SIZE"
    ]).has(err.code);
    return res.status(limitExceeded ? 413 : 400).json({
      ok: false,
      code: isProductDiscovery
        ? limitExceeded
          ? "product_discovery_image_too_large"
          : "product_discovery_invalid_image"
        : limitExceeded
          ? "upload_limit_exceeded"
          : "invalid_upload",
      error: "Não foi possível enviar a imagem. Verifique o arquivo e tente novamente."
    });
  }

  if (String(err?.message || "").includes("Apenas imagens")) {
    return res.status(400).json({
      ok: false,
      error: err.message
    });
  }

  return res.status(err?.statusCode || 500).json({
    ok: false,
    error: "Não foi possível criar o pedido agora. Tente novamente em alguns instantes."
  });
});

function startBackgroundTasks() {
  cleanupOldTmpUploads();
  setInterval(cleanupOldTmpUploads, TMP_UPLOAD_CLEANUP_INTERVAL_MS);
  setInterval(finalizarConversasSuporteInativas, 60 * 1000);
  if (adminFreeArtsEnabled()) {
    setTimeout(runFreeArtCampaignRecovery, 60 * 1000);
    setInterval(runFreeArtCampaignRecovery, adminFreeArtsRecoveryIntervalMs());
  }
  if (fcmService.scheduledNotificationsEnabled()) {
    setTimeout(runMonthlyPlanningNotifications, 15 * 1000);
    setInterval(runMonthlyPlanningNotifications, MONTHLY_PLANNING_NOTIFICATIONS_INTERVAL_MS);
    if (adminFreeArtsNotificationsEnabled()) {
      setTimeout(runFreeArtCampaignNotifications, 20 * 1000);
      setInterval(runFreeArtCampaignNotifications, adminFreeArtsNotificationsIntervalMs());
    }
  }
}

async function startApiServer() {
  try {
    socialRuntimeState = await initializeSocialServerRuntime({
      env: process.env,
      publicDirectory: PUBLIC_DIR,
      realReviewerEnabled: REAL_REVIEWER_UI_ENABLED,
      realReviewerMedia,
      logger: {
        info(event) {
          const safeScopeEvidence = sanitizeInstagramScopeEvidence(event);
          if (safeScopeEvidence) {
            console.info("[social][oauth-scope-evidence]", safeScopeEvidence);
            return;
          }
          const safeDiscoveryEvidence =
            sanitizeInstagramDiscoveryEvidence(event);
          if (safeDiscoveryEvidence) {
            console.info(
              "[social][oauth-account-discovery]",
              safeDiscoveryEvidence
            );
          }
        },
        error(event) {
          console.error("[social][postgres]", {
            component: "social_postgres",
            code: safeErrorCode(event, "social_postgres_error")
          });
        }
      }
    });
    startBackgroundTasks();
    const httpServer = app.listen(PORT, () => {
      console.log("API rodando na porta", PORT);
      console.log("[fcm][safety]", fcmService.runtimeConfigSummary());
      if (socialRuntimeState.enabled) {
        console.log("[social][persistence]", { enabled: true });
      }
    });
    installSocialRuntimeShutdown({
      runtimeState: socialRuntimeState,
      server: httpServer
    });
  } catch (error) {
    if (socialRuntimeState?.enabled) {
      try {
        await socialRuntimeState.close();
      } catch {
        // The startup remains fail-closed and reports only a safe code.
      }
    }
    throw error;
  }
}

startApiServer().catch((error) => {
  console.error("[social][startup]", {
    ok: false,
    code: safeErrorCode(error, "social_runtime_startup_failed")
  });
  process.exitCode = 1;
});
