"use strict";

(function exposeGate5AReviewerFlow(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.IA4Gate5A = api;
})(typeof globalThis === "object" ? globalThis : this, function gate5AFactory() {
  const REVIEW_QUERY_KEY = "review";
  const REVIEW_QUERY_VALUE = "instagram-publishing";
  const REVIEW_STAGE_KEY = "stage";
  const STAGING_HOSTNAME = "ia4tube-api-staging-checkpoint-a.onrender.com";
  const STAGING_API_ORIGIN = `https://${STAGING_HOSTNAME}`;
  const PRODUCTION_API_ORIGIN = "https://ia4tube-api.onrender.com";
  const LOCAL_API_ORIGIN = "http://localhost:3000";
  const SANDBOX_PREFIX = "/v1/social/reviewer-sandbox";
  const REAL_REVIEWER_PREFIX = "/v1/social/reviewer";
  const REAL_REVIEWER_PATH = "/reviewer";
  const OAUTH_RETURN_PREFIX = "/v1/social/oauth/return";
  const CANONICAL_LOGIN_HANDOFF_KEY = "ia4tube_gate5a_login_handoff_v1";
  const CANONICAL_LOGIN_QUERY_KEY = "gate5a_review_login";
  const CANONICAL_LOGIN_QUERY_VALUE = "1";
  const CANONICAL_LOGIN_PATH =
    `/app.html?${CANONICAL_LOGIN_QUERY_KEY}=${CANONICAL_LOGIN_QUERY_VALUE}`;
  const REVIEWER_RETURN_PATH =
    `/app.html?review=${REVIEW_QUERY_VALUE}&stage=overview`;
  const REAL_REVIEWER_RETURN_PATH = REAL_REVIEWER_PATH;
  const CANONICAL_LOGIN_HANDOFF_TTL_MS = 15 * 60 * 1000;
  const RETURN_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
  const CONNECTION_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SAFE_RETURN_CODE_PATTERN = /^[a-z0-9_]{2,96}$/;
  const CLIENT_REQUEST_ID = "gate5a-reviewer-manual-publish-v1";
  const CONTROLLED_ASSET_ID = "controlled-review-jpeg";
  const REAL_REVIEWER_JPEG_MAX_BYTES = 8 * 1024 * 1024;
  const REAL_REVIEWER_SOURCE_CAPTION_MAX_LENGTH = 2150;
  const CALLBACK_SENSITIVE_KEYS = Object.freeze([
    "code",
    "state",
    "error",
    "error_description",
    "access_token",
    "id_token"
  ]);
  const REVIEW_STAGES = Object.freeze([
    "overview",
    "authorization",
    "oauth-return",
    "connection",
    "media",
    "publication",
    "history",
    "data"
  ]);
  const PROFESSIONAL_ACCOUNT_TYPES = Object.freeze(["BUSINESS", "CREATOR"]);
  const REAL_REVIEWER_CONNECTION_STATES = Object.freeze([
    "authorization_pending",
    "connected",
    "reconnect_required",
    "disconnecting",
    "disconnected",
    "failed"
  ]);
  const ACCOUNT_TYPES = Object.freeze([...PROFESSIONAL_ACCOUNT_TYPES, "PERSONAL"]);
  const PUBLICATION_STATES = Object.freeze([
    "idle",
    "sending",
    "provider_confirming",
    "published"
  ]);
  const VISUAL_RETURN_STATUSES = Object.freeze([
    "authorization_completed",
    "authorization_cancelled",
    "authorization_expired",
    "authorization_failed"
  ]);
  const SYNTHETIC_PUBLICATION_ID =
    "synthetic-publication-00000000-0000-4000-8000-000000000001";
  const SYNTHETIC_PERMALINK =
    `${STAGING_API_ORIGIN}/app.html?review=${REVIEW_QUERY_VALUE}` +
    `&publication=${SYNTHETIC_PUBLICATION_ID}`;
  const MEDIA_PLACEHOLDER_DATA_URL =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' " +
    "viewBox='0 0 1080 1080'%3E%3Crect width='1080' height='1080' " +
    "rx='64' fill='%23eef7f0'/%3E%3Crect x='160' y='170' width='760' " +
    "height='740' rx='42' fill='%23ffffff' stroke='%23b9ddc2' " +
    "stroke-width='16'/%3E%3Cpath d='M270 720l170-190 130 130 105-120 " +
    "145 180' fill='none' stroke='%2316a34a' stroke-width='30' " +
    "stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='390' " +
    "cy='390' r='78' fill='%23dcfce7' stroke='%2316a34a' " +
    "stroke-width='24'/%3E%3Ctext x='540' y='835' text-anchor='middle' " +
    "font-family='Arial,sans-serif' font-size='38' font-weight='700' " +
    "fill='%233b5d45'%3EJPEG controlado da sandbox%3C/text%3E%3C/svg%3E";

  const SYNTHETIC_ACCOUNTS = Object.freeze({
    BUSINESS: Object.freeze({
      id: "synthetic-business-review-account",
      username: "empresa_demo_business",
      displayName: "Empresa Demonstração",
      accountType: "BUSINESS",
      synthetic: true
    }),
    CREATOR: Object.freeze({
      id: "synthetic-creator-review-account",
      username: "criador_demo_profissional",
      displayName: "Criador Demonstração",
      accountType: "CREATOR",
      synthetic: true
    }),
    PERSONAL: Object.freeze({
      id: "synthetic-personal-review-account",
      username: "perfil_demo_pessoal",
      displayName: "Perfil pessoal de demonstração",
      accountType: "PERSONAL",
      synthetic: true
    })
  });

  const SYNTHETIC_MEDIA = Object.freeze({
    id: "synthetic-controlled-review-jpeg",
    fileName: "ia4tube-reviewer-controlled.jpg",
    mimeType: "image/jpeg",
    width: 1080,
    height: 1080,
    assetPath: "",
    caption: "Conteúdo sintético da IA4Tube para demonstrar uma publicação manual segura.",
    synthetic: true
  });

  function isPlainObject(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null)
    );
  }

  function safeString(value, fallback = "", maximum = 500) {
    if (typeof value !== "string") return fallback;
    const normalized = value.trim();
    if (!normalized || normalized.length > maximum) return fallback;
    return normalized;
  }

  function safeIso(value) {
    const normalized = safeString(value, "", 64);
    if (!normalized) return null;
    const parsed = new Date(normalized);
    if (!Number.isFinite(parsed.getTime())) return null;
    return parsed.toISOString();
  }

  function nowIso(now) {
    const parsed = now instanceof Date ? now : new Date(now || Date.now());
    if (!Number.isFinite(parsed.getTime())) return new Date().toISOString();
    return parsed.toISOString();
  }

  function localHostname(hostname) {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      String(hostname || "").toLowerCase()
    );
  }

  function reviewerHostnameAllowed(hostname) {
    const normalized = String(hostname || "").toLowerCase();
    return normalized === STAGING_HOSTNAME || localHostname(normalized);
  }

  function resolveApiBase(hostname) {
    const normalized = String(hostname || "").toLowerCase();
    if (localHostname(normalized)) return LOCAL_API_ORIGIN;
    if (normalized === STAGING_HOSTNAME) return STAGING_API_ORIGIN;
    return PRODUCTION_API_ORIGIN;
  }

  function parseSearch(value) {
    const source = String(value || "");
    if (/^https?:\/\//i.test(source)) {
      try {
        return new URL(source).searchParams;
      } catch (_error) {
        return new URLSearchParams();
      }
    }
    return new URLSearchParams(source.startsWith("?") ? source.slice(1) : source);
  }

  function isReviewerMode(
    search,
    hostname = STAGING_HOSTNAME,
    pathname = "/app.html"
  ) {
    if (!reviewerHostnameAllowed(hostname)) return false;
    if (pathname !== "/app.html") return false;
    const params = parseSearch(search);
    return params.get(REVIEW_QUERY_KEY) === REVIEW_QUERY_VALUE;
  }

  function isRealReviewerMode(pathname, hostname = STAGING_HOSTNAME) {
    return reviewerHostnameAllowed(hostname) && pathname === REAL_REVIEWER_PATH;
  }

  function removeCanonicalLoginHandoff(storage) {
    try {
      storage?.removeItem?.(CANONICAL_LOGIN_HANDOFF_KEY);
    } catch (_error) {
      // A blocked sessionStorage is treated as a closed handoff.
    }
  }

  function recoverReviewerAuthenticationFrom401(options = {}) {
    const closed = Object.freeze({ handled: false, tokenRemoved: false });
    if (
      options.code !== "reviewer_authentication_required" ||
      options.hostname !== STAGING_HOSTNAME ||
      typeof options.expectedToken !== "string" ||
      !options.expectedToken ||
      !options.storage
    ) return closed;
    let currentToken;
    try {
      currentToken = options.storage.getItem("omascote_token");
    } catch (_error) {
      return closed;
    }
    if (currentToken !== options.expectedToken) return closed;
    try {
      options.storage.removeItem("omascote_token");
      return Object.freeze({ handled: true, tokenRemoved: true });
    } catch (_error) {
      return Object.freeze({ handled: true, tokenRemoved: false });
    }
  }

  function reduceReviewerAuthenticationAfterError(current = {}, options = {}) {
    const authenticated = current.authenticated === true;
    const companyVerified = current.companyVerified === true;
    const canonicalToken = typeof current.canonicalToken === "string"
      ? current.canonicalToken
      : "";
    const recovery = recoverReviewerAuthenticationFrom401({
      code: options.code,
      hostname: options.hostname,
      expectedToken: canonicalToken,
      storage: options.storage
    });
    if (!recovery.handled) {
      return Object.freeze({
        handled: false,
        tokenRemoved: false,
        authenticated,
        companyVerified,
        canonicalToken
      });
    }
    return Object.freeze({
      handled: true,
      tokenRemoved: recovery.tokenRemoved,
      authenticated: false,
      companyVerified: false,
      canonicalToken: ""
    });
  }

  function beginCanonicalLoginHandoff(target, now = Date.now()) {
    const realReviewer = isRealReviewerMode(
      target?.location?.pathname,
      target?.location?.hostname
    );
    if (
      !target?.location ||
      !reviewerHostnameAllowed(target.location.hostname) ||
      !(
        realReviewer ||
        isReviewerMode(
          target.location.search,
          target.location.hostname,
          target.location.pathname
        )
      ) ||
      typeof target.location.assign !== "function"
    ) {
      throw Object.assign(new Error("Entrada canônica indisponível nesta rota."), {
        code: "reviewer_canonical_login_unavailable"
      });
    }
    const issuedAt = Number(now);
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      throw Object.assign(new Error("Relógio inválido para o handoff de entrada."), {
        code: "reviewer_canonical_login_clock_invalid"
      });
    }
    const returnPath = realReviewer
      ? REAL_REVIEWER_RETURN_PATH
      : REVIEWER_RETURN_PATH;
    const receipt = JSON.stringify(realReviewer
      ? { version: 2, issuedAt, returnPath }
      : { version: 1, issuedAt });
    try {
      target.sessionStorage.setItem(CANONICAL_LOGIN_HANDOFF_KEY, receipt);
    } catch (_error) {
      throw Object.assign(new Error("Não foi possível reservar o retorno seguro."), {
        code: "reviewer_canonical_login_storage_unavailable"
      });
    }
    target.location.assign(CANONICAL_LOGIN_PATH);
    return Object.freeze({
      active: true,
      loginPath: CANONICAL_LOGIN_PATH,
      returnPath
    });
  }

  function readCanonicalLoginHandoff(target, now = Date.now()) {
    const closed = Object.freeze({ active: false, returnPath: null });
    if (
      !target?.location ||
      !reviewerHostnameAllowed(target.location.hostname) ||
      target.location.pathname !== "/app.html"
    ) return closed;
    let raw;
    try {
      raw = target.sessionStorage.getItem(CANONICAL_LOGIN_HANDOFF_KEY);
    } catch (_error) {
      return closed;
    }
    if (!raw) return closed;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      removeCanonicalLoginHandoff(target.sessionStorage);
      return closed;
    }
    const keys = isPlainObject(parsed) ? Object.keys(parsed).sort() : [];
    const current = Number(now);
    const legacyReceipt = keys.length === 2 && keys[0] === "issuedAt" &&
      keys[1] === "version" && parsed.version === 1;
    const realReceipt = keys.length === 3 && keys[0] === "issuedAt" &&
      keys[1] === "returnPath" && keys[2] === "version" &&
      parsed.version === 2 && parsed.returnPath === REAL_REVIEWER_RETURN_PATH;
    const valid = (legacyReceipt || realReceipt) &&
      Number.isSafeInteger(parsed.issuedAt) &&
      Number.isSafeInteger(current) && current >= parsed.issuedAt &&
      current - parsed.issuedAt <= CANONICAL_LOGIN_HANDOFF_TTL_MS;
    if (!valid) {
      removeCanonicalLoginHandoff(target.sessionStorage);
      return closed;
    }
    return Object.freeze({
      active: true,
      returnPath: realReceipt ? REAL_REVIEWER_RETURN_PATH : REVIEWER_RETURN_PATH
    });
  }

  function sanitizeCanonicalLoginHandoffUrl(target) {
    if (
      !target?.location ||
      !reviewerHostnameAllowed(target.location.hostname) ||
      target.location.pathname !== "/app.html"
    ) return false;
    const params = parseSearch(target.location.search);
    const exactHandoff = params.size === 1 &&
      params.get(CANONICAL_LOGIN_QUERY_KEY) === CANONICAL_LOGIN_QUERY_VALUE;
    if (!exactHandoff) return false;
    target.history?.replaceState?.(
      Object.freeze({ gate5aCanonicalLogin: true }),
      "",
      "/app.html"
    );
    return true;
  }

  function completeCanonicalLoginHandoff(target, now = Date.now()) {
    const handoff = readCanonicalLoginHandoff(target, now);
    if (!handoff.active || typeof target?.location?.assign !== "function") {
      return false;
    }
    removeCanonicalLoginHandoff(target.sessionStorage);
    target.location.assign(handoff.returnPath);
    return true;
  }

  function sanitizeCallbackUrl(value) {
    let parsed;
    try {
      parsed = new URL(String(value || ""), "https://reviewer.invalid/app.html");
    } catch (_error) {
      parsed = new URL("https://reviewer.invalid/app.html");
    }

    const active = parsed.searchParams.get(REVIEW_QUERY_KEY) === REVIEW_QUERY_VALUE;
    if (!active) {
      return Object.freeze({
        active: false,
        callbackObserved: false,
        changed: false,
        returnReference: null,
        stage: "overview",
        path: `${parsed.pathname}${parsed.search}${parsed.hash}`
      });
    }

    const callbackObserved = CALLBACK_SENSITIVE_KEYS.some((key) =>
      parsed.searchParams.has(key)
    ) || parsed.searchParams.has("return_ref") ||
      /(?:^|[#?&])(code|state|error|access_token|id_token)=/i.test(parsed.hash);
    const returnReferenceInput = parsed.searchParams.get("return_ref") || "";
    const returnReference = RETURN_REFERENCE_PATTERN.test(returnReferenceInput)
      ? returnReferenceInput
      : null;
    const requestedStage = parsed.searchParams.get(REVIEW_STAGE_KEY);
    const stage = callbackObserved
      ? "oauth-return"
      : REVIEW_STAGES.includes(requestedStage)
        ? requestedStage
        : "overview";
    const canonical = new URLSearchParams();
    canonical.set(REVIEW_QUERY_KEY, REVIEW_QUERY_VALUE);
    canonical.set(REVIEW_STAGE_KEY, stage);
    const path = `${parsed.pathname}?${canonical.toString()}`;
    const original = `${parsed.pathname}${parsed.search}${parsed.hash}`;

    return Object.freeze({
      active: true,
      callbackObserved,
      changed: path !== original,
      returnReference,
      stage,
      path
    });
  }

  function sanitizeRealReviewerUrl(value) {
    let parsed;
    try {
      parsed = new URL(String(value || ""), "https://reviewer.invalid/reviewer");
    } catch (_error) {
      parsed = new URL("https://reviewer.invalid/reviewer");
    }
    const active = parsed.pathname === REAL_REVIEWER_PATH;
    const referenceInput = parsed.searchParams.get("return_ref") || "";
    const returnReference = RETURN_REFERENCE_PATTERN.test(referenceInput)
      ? referenceInput
      : null;
    const callbackObserved = Boolean(returnReference) ||
      CALLBACK_SENSITIVE_KEYS.some((key) => parsed.searchParams.has(key)) ||
      /(?:^|[#?&])(code|state|error|access_token|id_token)=/i.test(parsed.hash);
    return Object.freeze({
      active,
      callbackObserved,
      changed: active && `${parsed.pathname}${parsed.search}${parsed.hash}` !==
        REAL_REVIEWER_PATH,
      returnReference,
      stage: callbackObserved ? "oauth-return" : "overview",
      path: active ? REAL_REVIEWER_PATH : `${parsed.pathname}${parsed.search}${parsed.hash}`
    });
  }

  function blockedNetworkError() {
    const error = new Error("A superfície de revisão bloqueou uma chamada não autorizada.");
    error.code = "gate5a_reviewer_network_blocked";
    return error;
  }

  function realReviewerRequestAllowed(requestUrl, method) {
    if (requestUrl.search || requestUrl.hash) return false;
    if (
      method === "POST" &&
      requestUrl.pathname === "/v1/social/connections/instagram/authorization"
    ) return true;
    if (
      method === "GET" &&
      requestUrl.pathname === "/v1/social/connections/instagram"
    ) return true;
    if (
      ["GET", "DELETE"].includes(method) &&
      /^\/v1\/social\/connections\/instagram\/[0-9a-f-]{36}(?:\/(?:authorization|health))?$/i
        .test(requestUrl.pathname)
    ) return true;
    if (
      ["GET", "POST"].includes(method) &&
      requestUrl.pathname === `${REAL_REVIEWER_PREFIX}/media`
    ) return true;
    if (
      ["GET", "POST"].includes(method) &&
      requestUrl.pathname === `${REAL_REVIEWER_PREFIX}/publications`
    ) return true;
    if (
      method === "GET" &&
      new RegExp(
        `^${REAL_REVIEWER_PREFIX}/publications/[0-9a-f-]{36}$`,
        "i"
      ).test(requestUrl.pathname)
    ) return true;
    if (
      method === "POST" &&
      new RegExp(
        `^${REAL_REVIEWER_PREFIX}/publications/[0-9a-f-]{36}/reconcile$`,
        "i"
      ).test(requestUrl.pathname)
    ) return true;
    const returnReference = requestUrl.pathname.startsWith(`${OAUTH_RETURN_PREFIX}/`)
      ? requestUrl.pathname.slice(OAUTH_RETURN_PREFIX.length + 1)
      : "";
    return method === "GET" && RETURN_REFERENCE_PATTERN.test(returnReference);
  }

  function installEarlyGuard(target) {
    if (!target || !target.location) {
      return Object.freeze({ active: false, reason: "window_unavailable" });
    }
    const realActive = isRealReviewerMode(
      target.location.pathname,
      target.location.hostname
    );
    const syntheticActive = isReviewerMode(
      target.location.search,
      target.location.hostname,
      target.location.pathname
    );
    const active = realActive || syntheticActive;
    target.IA4_GATE5A_REVIEWER_ACTIVE = active;
    target.IA4_REAL_REVIEWER_ACTIVE = realActive;
    target.IA4_REVIEWER_MODE = realActive
      ? "real"
      : syntheticActive
        ? "sandbox"
        : null;
    if (!active) return Object.freeze({ active: false, reason: "route_inactive" });

    const sanitized = realActive
      ? sanitizeRealReviewerUrl(target.location.href)
      : sanitizeCallbackUrl(target.location.href);
    if (sanitized.changed && target.history?.replaceState) {
      target.history.replaceState(
        Object.freeze({ gate5aReviewer: true }),
        "",
        sanitized.path
      );
    }

    const originalFetch = typeof target.fetch === "function"
      ? target.fetch.bind(target)
      : null;
    const allowedApiOrigin = resolveApiBase(target.location.hostname);
    const guardedFetch = function gate5AReviewerFetch(input, init) {
      let requestUrl;
      try {
        const candidate = typeof input === "string" || input instanceof URL
          ? String(input)
          : String(input?.url || "");
        requestUrl = new URL(candidate, target.location.href);
      } catch (_error) {
        return Promise.reject(blockedNetworkError());
      }
      const method = String(init?.method || input?.method || "GET").toUpperCase();
      const sandboxAllowed = !realActive && (
        requestUrl.pathname === SANDBOX_PREFIX ||
        requestUrl.pathname.startsWith(`${SANDBOX_PREFIX}/`)
      );
      const realAllowed = realActive && realReviewerRequestAllowed(
        requestUrl,
        method
      );
      const returnReference = requestUrl.pathname.startsWith(`${OAUTH_RETURN_PREFIX}/`)
        ? requestUrl.pathname.slice(OAUTH_RETURN_PREFIX.length + 1)
        : "";
      const visualReturnAllowed = !realActive && method === "GET" &&
        RETURN_REFERENCE_PATTERN.test(returnReference) &&
        requestUrl.search === "" && requestUrl.hash === "";
      const allowed = requestUrl.origin === allowedApiOrigin &&
        (sandboxAllowed || visualReturnAllowed || realAllowed);
      if (!allowed || !originalFetch) return Promise.reject(blockedNetworkError());
      return originalFetch(requestUrl.toString(), init);
    };
    Object.defineProperty(guardedFetch, "gate5aGuarded", { value: true });
    target.fetch = guardedFetch;
    target.IA4_GATE5A_CALLBACK_OBSERVED = sanitized.callbackObserved;
    target.IA4_GATE5A_RETURN_REFERENCE = sanitized.returnReference;
    target.IA4_GATE5A_REVIEW_STAGE = sanitized.stage;
    target.IA4_GATE5A_ALLOWED_API_ORIGIN = allowedApiOrigin;

    if (target.navigator && typeof target.navigator.sendBeacon === "function") {
      try {
        target.navigator.sendBeacon = () => false;
      } catch (_error) {
        // The fetch guard remains authoritative for this application.
      }
    }

    return Object.freeze({
      active: true,
      mode: realActive ? "real" : "sandbox",
      callbackObserved: sanitized.callbackObserved,
      returnReference: sanitized.returnReference,
      stage: sanitized.stage,
      sanitizedPath: sanitized.path,
      allowedApiOrigin
    });
  }

  function accountFixture(accountType) {
    const normalized = ACCOUNT_TYPES.includes(accountType) ? accountType : "BUSINESS";
    return { ...SYNTHETIC_ACCOUNTS[normalized] };
  }

  function createInitialState(options = {}) {
    const accountType = ACCOUNT_TYPES.includes(options.accountType)
      ? options.accountType
      : "BUSINESS";
    const stage = REVIEW_STAGES.includes(options.stage) ? options.stage : "overview";
    return {
      stage,
      company: {
        label: safeString(options.companyLabel, "Empresa autenticada", 120),
        controlled: true
      },
      authorization: {
        status: options.callbackObserved ? "authorization_pending" : "not_started",
        accountType,
        callbackSanitized: options.callbackObserved === true
      },
      connection: {
        status: "not_connected",
        account: null,
        error: null,
        connectedAt: null
      },
      media: {
        selected: false,
        item: null
      },
      publication: {
        id: null,
        state: "idle",
        attempts: 0,
        details: null
      },
      publicationOrdinal: 0,
      history: [],
      deletion: {
        status: "not_requested",
        completedAt: null,
        requestStatus: null,
        confirmationCode: null,
        statusUrl: null,
        technicalConnectionDataDeleted: false,
        commercialHistoryPolicy: "owner_decision_pending"
      },
      sandbox: true,
      externalCalls: 0
    };
  }

  function createPublishedDetails(at, publicationId = SYNTHETIC_PUBLICATION_ID) {
    return {
      publicationId,
      mediaId: "G5A-SYNTHETIC-MEDIA-0001",
      publishedAt: at,
      reference: "G5A-SYNTHETIC-REFERENCE-0001",
      permalink: `${STAGING_API_ORIGIN}/app.html?review=${REVIEW_QUERY_VALUE}` +
        `&publication=${encodeURIComponent(publicationId)}`,
      synthetic: true
    };
  }

  function syntheticPublicationIdForOrdinal(value) {
    const ordinal = Number(value);
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 0xffffffffff) {
      return null;
    }
    const suffix = ordinal.toString(16).padStart(12, "0");
    return `synthetic-publication-00000000-0000-4000-8000-${suffix}`;
  }

  function transitionState(current, action, now) {
    const state = isPlainObject(current) ? current : createInitialState();
    const source = isPlainObject(action) ? action : {};
    const at = nowIso(now);
    const type = safeString(source.type, "", 80);

    if (type === "NAVIGATE" && REVIEW_STAGES.includes(source.stage)) {
      return { ...state, stage: source.stage };
    }
    if (type === "CHOOSE_ACCOUNT" && ACCOUNT_TYPES.includes(source.accountType)) {
      return {
        ...state,
        authorization: {
          ...state.authorization,
          accountType: source.accountType
        }
      };
    }
    if (type === "START_AUTHORIZATION") {
      const accountType = ACCOUNT_TYPES.includes(source.accountType)
        ? source.accountType
        : state.authorization.accountType;
      return {
        ...state,
        stage: "oauth-return",
        authorization: {
          status: "authorization_pending",
          accountType,
          callbackSanitized: true
        },
        connection: {
          status: "not_connected",
          account: null,
          error: null,
          connectedAt: null
        }
      };
    }
    if (type === "COMPLETE_AUTHORIZATION") {
      const accountType = state.authorization.accountType;
      if (accountType === "PERSONAL") {
        return {
          ...state,
          stage: "oauth-return",
          authorization: {
            ...state.authorization,
            status: "authorization_completed",
            callbackSanitized: true
          },
          connection: {
            status: "rejected",
            account: null,
            error: {
              code: "professional_account_required",
              message: "Use uma conta profissional Business ou Creator para continuar."
            },
            connectedAt: null
          }
        };
      }
      return {
        ...state,
        stage: "connection",
        authorization: {
          ...state.authorization,
          status: "authorization_completed",
          callbackSanitized: true
        },
        connection: {
          status: "connected",
          account: accountFixture(accountType),
          error: null,
          connectedAt: at
        }
      };
    }
    if (type === "SELECT_MEDIA" && state.connection.status === "connected") {
      return {
        ...state,
        stage: "media",
        media: { selected: true, item: { ...SYNTHETIC_MEDIA } }
      };
    }
    if (type === "START_PUBLISH") {
      if (
        state.connection.status !== "connected" ||
        state.media.selected !== true ||
        state.publication.state !== "idle"
      ) return state;
      const publicationOrdinal = Number.isSafeInteger(state.publicationOrdinal)
        ? state.publicationOrdinal + 1
        : 1;
      const publicationId = syntheticPublicationIdForOrdinal(publicationOrdinal);
      if (!publicationId) return state;
      return {
        ...state,
        stage: "publication",
        publicationOrdinal,
        publication: {
          id: publicationId,
          state: "sending",
          attempts: 1,
          details: null
        }
      };
    }
    if (type === "ADVANCE_PUBLISH") {
      if (
        state.connection.status !== "connected" ||
        !state.publication.id ||
        source.publicationId !== state.publication.id
      ) return state;
      if (state.publication.state === "sending") {
        return {
          ...state,
          stage: "publication",
          publication: { ...state.publication, state: "provider_confirming" }
        };
      }
      if (state.publication.state === "provider_confirming") {
        const details = createPublishedDetails(at, state.publication.id);
        const existing = state.history.some((item) =>
          item?.id === state.publication.id
        );
        const history = existing
          ? state.history
          : [{
              id: state.publication.id,
              state: "published",
              account: state.connection.account?.username || "",
              media: state.media.item?.fileName || "",
              ...details
            }, ...state.history];
        return {
          ...state,
          stage: "publication",
          publication: {
            ...state.publication,
            state: "published",
            details
          },
          history
        };
      }
      return state;
    }
    if (type === "DISCONNECT") {
      if (!state.connection.account) return { ...state, stage: "data" };
      return {
        ...state,
        stage: "data",
        connection: {
          ...state.connection,
          status: "disconnected",
          account: null,
          error: null
        },
        media: { selected: false, item: null },
        publication: { id: null, state: "idle", attempts: 0, details: null }
      };
    }
    if (type === "DELETE_DATA") {
      return {
        ...state,
        stage: "data",
        authorization: {
          status: "not_started",
          accountType: "BUSINESS",
          callbackSanitized: true
        },
        connection: {
          status: "deleted",
          account: null,
          error: null,
          connectedAt: null
        },
        media: { selected: false, item: null },
        publication: { id: null, state: "idle", attempts: 0, details: null },
        deletion: {
          status: "completed",
          completedAt: at,
          requestStatus: null,
          confirmationCode: null,
          statusUrl: null,
          technicalConnectionDataDeleted: true,
          commercialHistoryPolicy: "owner_decision_pending"
        }
      };
    }
    if (type === "RESET") return createInitialState();
    return state;
  }

  function normalizeAccount(value) {
    if (!isPlainObject(value) || value.synthetic !== true) return null;
    if (!PROFESSIONAL_ACCOUNT_TYPES.includes(value.accountType)) return null;
    const username = safeString(value.username, "", 64).replace(/^@/, "");
    if (!/^[a-z0-9._]{1,30}$/i.test(username)) return null;
    return {
      id: safeString(value.id || value.accountId, "synthetic-review-account", 100),
      username,
      displayName: safeString(value.displayName, "Conta de demonstração", 120),
      accountType: value.accountType,
      synthetic: true
    };
  }

  function normalizeMedia(value) {
    if (!isPlainObject(value) || value.synthetic !== true) return null;
    if (value.mimeType !== "image/jpeg") return null;
    const width = Number(value.width);
    const height = Number(value.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      return null;
    }
    const assetPath = safeString(value.assetPath, "", 300);
    const controlledAssetPath = assetPath.startsWith("/") &&
      !assetPath.startsWith("//") &&
      !assetPath.includes("\\") &&
      !assetPath.includes("?") &&
      !assetPath.includes("#")
      ? assetPath
      : "";
    return {
      id: safeString(value.id, "synthetic-controlled-review-jpeg", 120),
      fileName: safeString(value.fileName, SYNTHETIC_MEDIA.fileName, 160),
      mimeType: "image/jpeg",
      width,
      height,
      assetPath: controlledAssetPath,
      caption: safeString(value.caption, SYNTHETIC_MEDIA.caption, 1000),
      synthetic: true
    };
  }

  function isSafeSyntheticPermalink(value) {
    if (typeof value !== "string") return false;
    try {
      const parsed = new URL(value);
      const sandboxPublication = [STAGING_API_ORIGIN, LOCAL_API_ORIGIN].includes(
        parsed.origin
      ) && parsed.pathname === "/app.html" &&
        parsed.searchParams.get(REVIEW_QUERY_KEY) === REVIEW_QUERY_VALUE &&
        /^synthetic-publication-[0-9a-f-]{36}$/i.test(
          parsed.searchParams.get("publication") || ""
        ) && parsed.searchParams.size === 2;
      return sandboxPublication &&
        parsed.hash === "" && parsed.username === "" && parsed.password === "";
    } catch (_error) {
      return false;
    }
  }

  function normalizeDetails(value) {
    if (!isPlainObject(value) || value.synthetic !== true) return null;
    if (!isSafeSyntheticPermalink(value.permalink)) return null;
    const publishedAt = safeIso(value.publishedAt);
    const publicationId = safeString(value.publicationId, "", 120);
    if (
      !publishedAt ||
      !/^synthetic-publication-[0-9a-f-]{36}$/i.test(publicationId) ||
      new URL(value.permalink).searchParams.get("publication") !== publicationId
    ) return null;
    return {
      publicationId,
      mediaId: safeString(value.mediaId, "", 160),
      publishedAt,
      reference: safeString(value.reference, "", 160),
      permalink: value.permalink,
      synthetic: true
    };
  }

  function normalizeDeletionRequest(value, deletionStatus, expectedApiOrigin) {
    if (!isPlainObject(value)) return null;
    const confirmationCode = safeString(value.confirmationCode, "", 128);
    const statusUrl = safeString(value.statusUrl, "", 500);
    const requestStatus = safeString(value.requestStatus, "", 40);
    if (!confirmationCode && !statusUrl && !requestStatus) return null;
    if (
      deletionStatus !== "completed" ||
      requestStatus !== "completed" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(confirmationCode)
    ) {
      throw Object.assign(new Error("Protocolo de exclusão inválido."), {
        code: "reviewer_deletion_protocol_invalid"
      });
    }
    let parsed;
    try {
      parsed = new URL(statusUrl);
    } catch (_error) {
      throw Object.assign(new Error("URL de status inválida."), {
        code: "reviewer_deletion_status_url_invalid"
      });
    }
    const expectedPath = "/v1/social/compliance/meta/data-deletion/status/" +
      encodeURIComponent(confirmationCode);
    const acceptedOrigins = expectedApiOrigin
      ? [expectedApiOrigin]
      : [STAGING_API_ORIGIN, LOCAL_API_ORIGIN];
    if (
      !acceptedOrigins.includes(parsed.origin) ||
      parsed.pathname !== expectedPath ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw Object.assign(new Error("URL de status fora da rota canônica."), {
        code: "reviewer_deletion_status_url_invalid"
      });
    }
    return {
      confirmationCode,
      requestStatus: "completed",
      statusUrl: parsed.toString()
    };
  }

  function normalizeState(value, expectedApiOrigin) {
    if (!isPlainObject(value)) throw Object.assign(
      new Error("Estado inválido da sandbox de revisão."),
      { code: "reviewer_sandbox_state_invalid" }
    );
    if (value.sandbox !== true || value.externalCalls !== 0) {
      throw Object.assign(new Error("Estado fora do perímetro sintético."), {
        code: "reviewer_sandbox_state_boundary_invalid"
      });
    }
    const companySource = isPlainObject(value.company) ? value.company : null;
    const companyKeys = companySource ? Object.keys(companySource).sort() : [];
    const companyLabel = safeString(companySource?.label, "", 120);
    if (
      !companySource ||
      companyKeys.length !== 2 ||
      companyKeys[0] !== "controlled" ||
      companyKeys[1] !== "label" ||
      companySource.controlled !== true ||
      !companyLabel
    ) {
      throw Object.assign(new Error("Empresa autenticada da sandbox inválida."), {
        code: "reviewer_sandbox_company_invalid"
      });
    }
    const stageMap = {
      welcome: "overview",
      oauth_authorization: "oauth-return",
      oauth_return: "oauth-return",
      connection_connected: "connection",
      media_review: "media",
      publication_sending: "publication",
      publication_confirming: "publication",
      publication_published: "publication",
      connection_disconnected: "data",
      data_deletion_completed: "data"
    };
    const stage = REVIEW_STAGES.includes(value.stage)
      ? value.stage
      : stageMap[value.stage] || "overview";
    const authorizationSource = isPlainObject(value.authorization)
      ? value.authorization
      : {};
    const accountType = ACCOUNT_TYPES.includes(authorizationSource.accountType)
      ? authorizationSource.accountType
      : "BUSINESS";
    const authorizationStatuses = [
      "not_started",
      "authorization_pending",
      "authorization_completed",
      "authorization_cancelled",
      "authorization_expired",
      "authorization_failed"
    ];
    const authorizationStatus = authorizationStatuses.includes(authorizationSource.status)
      ? authorizationSource.status
      : "not_started";
    const connectionSource = isPlainObject(value.connection) ? value.connection : {};
    const connectionStatuses = [
      "not_connected",
      "connected",
      "rejected",
      "disconnected",
      "deleted"
    ];
    const connectionStatus = connectionStatuses.includes(connectionSource.status)
      ? connectionSource.status
      : "not_connected";
    const connectionAccount = normalizeAccount(connectionSource.account);
    if (connectionStatus === "connected" && !connectionAccount) {
      throw Object.assign(new Error("Conta sintética inválida."), {
        code: "reviewer_sandbox_account_invalid"
      });
    }
    const mediaSource = isPlainObject(value.media) ? value.media : {};
    const mediaItem = normalizeMedia(mediaSource.item);
    const mediaSelected = mediaSource.selected === true && Boolean(mediaItem);
    const publicationSource = isPlainObject(value.publication) ? value.publication : {};
    const publicationState = PUBLICATION_STATES.includes(publicationSource.state)
      ? publicationSource.state
      : "idle";
    const pendingPublicationDetails = isPlainObject(publicationSource.details) &&
      publicationSource.details.synthetic === true
      ? publicationSource.details
      : null;
    const publicationDetails = normalizeDetails(publicationSource.details);
    if (publicationState === "published" && !publicationDetails) {
      throw Object.assign(new Error("Prova sintética inválida."), {
        code: "reviewer_sandbox_publication_invalid"
      });
    }
    const historySource = Array.isArray(value.history) ? value.history : [];
    const history = historySource.slice(0, 20).map((item) => {
      const details = normalizeDetails(item);
      if (!details) return null;
      return {
        id: safeString(
          item.id || item.publicationId,
          "synthetic-review-publication",
          120
        ),
        state: "published",
        account: safeString(item.account, "conta_sintetica", 64),
        media: safeString(item.media, SYNTHETIC_MEDIA.fileName, 160),
        ...details
      };
    }).filter(Boolean);
    const deletionSource = isPlainObject(value.deletion) ? value.deletion : {};
    const deletionStatus = ["not_requested", "pending", "completed"].includes(
      deletionSource.status
    ) ? deletionSource.status : "not_requested";
    const deletionRequest = normalizeDeletionRequest(
      deletionSource,
      deletionStatus,
      expectedApiOrigin
    );

    return {
      stage,
      company: {
        label: companyLabel,
        controlled: true
      },
      authorization: {
        status: authorizationStatus,
        accountType,
        callbackSanitized: authorizationSource.callbackSanitized === true
      },
      connection: {
        status: connectionStatus,
        account: connectionAccount,
        error: isPlainObject(connectionSource.error)
          ? {
              code: safeString(connectionSource.error.code, "reviewer_connection_rejected", 100),
              message: safeString(
                connectionSource.error.message,
                "A conexão sintética foi recusada.",
                300
              )
            }
          : null,
        connectedAt: safeIso(connectionSource.connectedAt)
      },
      media: { selected: mediaSelected, item: mediaSelected ? mediaItem : null },
      publication: {
        id: safeString(
          publicationSource.id || pendingPublicationDetails?.publicationId,
          "",
          120
        ) || null,
        state: publicationState,
        attempts: Number.isInteger(publicationSource.attempts)
          ? Math.max(0, Math.min(publicationSource.attempts, 1))
          : 0,
        details: publicationDetails
      },
      publicationOrdinal: Number.isSafeInteger(value.publicationOrdinal)
        ? Math.max(0, Math.min(value.publicationOrdinal, 0xffffffffff))
        : 0,
      history,
      deletion: {
        status: deletionStatus,
        completedAt: safeIso(deletionSource.completedAt),
        requestStatus: deletionRequest?.requestStatus || null,
        confirmationCode: deletionRequest?.confirmationCode || null,
        statusUrl: deletionRequest?.statusUrl || null,
        technicalConnectionDataDeleted:
          deletionSource.technicalConnectionDataDeleted === true,
        commercialHistoryPolicy: "owner_decision_pending"
      },
      sandbox: true,
      externalCalls: 0
    };
  }

  function createInMemorySandbox(options = {}) {
    let state = createInitialState(options);
    const update = (action) => {
      state = transitionState(state, action, options.now || Date.now());
      return Promise.resolve(normalizeState(state));
    };
    return Object.freeze({
      getState: () => Promise.resolve(normalizeState(state)),
      authorize: (accountType) => update({
        type: "START_AUTHORIZATION",
        accountType
      }),
      completeAuthorization: () => update({ type: "COMPLETE_AUTHORIZATION" }),
      selectMedia: () => update({ type: "SELECT_MEDIA" }),
      publish: () => update({ type: "START_PUBLISH" }),
      advancePublication: (publicationId) => update({
        type: "ADVANCE_PUBLISH",
        publicationId
      }),
      disconnect: () => update({ type: "DISCONNECT" }),
      deleteData: () => update({ type: "DELETE_DATA" }),
      reset: () => update({ type: "RESET" })
    });
  }

  function createHttpSandboxClient(options = {}) {
    const apiBase = safeString(options.apiBase, "", 300);
    const fetchImpl = options.fetchImpl;
    const tokenProvider = typeof options.tokenProvider === "function"
      ? options.tokenProvider
      : () => "";
    if (![LOCAL_API_ORIGIN, STAGING_API_ORIGIN].includes(apiBase)) {
      throw Object.assign(new Error("Origin da sandbox recusado."), {
        code: "reviewer_sandbox_origin_forbidden"
      });
    }
    if (typeof fetchImpl !== "function") {
      throw Object.assign(new Error("Transporte da sandbox indisponível."), {
        code: "reviewer_sandbox_transport_unavailable"
      });
    }

    async function request(route, method = "GET", body) {
      const suffix = String(route || "");
      if (!/^\/[a-z0-9\-/:]*$/i.test(suffix) || suffix.includes("..")) {
        throw Object.assign(new Error("Rota da sandbox recusada."), {
          code: "reviewer_sandbox_route_forbidden"
        });
      }
      const token = safeString(tokenProvider(), "", 8192);
      if (!token) {
        throw Object.assign(new Error("Entre com a conta de revisão para continuar."), {
          code: "reviewer_authentication_required"
        });
      }
      const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      };
      const init = { method, headers, cache: "no-store" };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const response = await fetchImpl(`${apiBase}${SANDBOX_PREFIX}${suffix}`, init);
      if (response.status === 401) {
        throw Object.assign(new Error("Entre com a conta de revisão para continuar."), {
          code: "reviewer_authentication_required"
        });
      }
      const payload = await response.json().catch(() => null);
      const envelopeValid = isPlainObject(payload) &&
        payload.sandbox === true &&
        payload.externalCalls === 0;
      if (!envelopeValid) {
        throw Object.assign(new Error("Resposta inválida da sandbox de revisão."), {
          code: "reviewer_sandbox_response_invalid"
        });
      }
      let normalizedState = null;
      if (payload.state !== undefined) {
        normalizedState = normalizeState(payload.state, apiBase);
      }
      if (!response.ok || payload.ok !== true) {
        const error = Object.assign(new Error(
          safeString(payload.error?.message, "A operação demonstrativa foi recusada.", 300)
        ), {
          code: safeString(payload.error?.code, "reviewer_sandbox_request_failed", 100),
          state: normalizedState
        });
        throw error;
      }
      if (!normalizedState) {
        throw Object.assign(new Error("Snapshot ausente da sandbox de revisão."), {
          code: "reviewer_sandbox_state_missing"
        });
      }
      return normalizedState;
    }

    return Object.freeze({
      getState: () => request("/state"),
      authorize: (accountType) => request("/authorization", "POST", {
        accountType,
        purpose: "app_review"
      }),
      completeAuthorization: () => request("/authorization/callback", "POST", {}),
      selectMedia: () => request("/media", "POST", {
        asset: CONTROLLED_ASSET_ID
      }),
      publish: () => request("/publications", "POST", {
        clientRequestId: CLIENT_REQUEST_ID
      }),
      advancePublication: (publicationId) => {
        const id = safeString(publicationId, "", 120);
        if (!/^[a-z0-9-]{8,120}$/i.test(id)) {
          return Promise.reject(Object.assign(new Error("Publicação sintética inválida."), {
            code: "reviewer_publication_id_invalid"
          }));
        }
        return request(`/publications/${id}/advance`, "POST", {});
      },
      disconnect: () => request("/connection", "DELETE"),
      deleteData: () => request("/data-deletion", "POST", { confirm: true }),
      reset: () => request("/reset", "POST", { confirm: true })
    });
  }

  function createOAuthReturnClient(options = {}) {
    const apiBase = safeString(options.apiBase, "", 300);
    const fetchImpl = options.fetchImpl;
    if (![LOCAL_API_ORIGIN, STAGING_API_ORIGIN].includes(apiBase)) {
      throw Object.assign(new Error("Origin do retorno OAuth recusado."), {
        code: "reviewer_oauth_return_origin_forbidden"
      });
    }
    if (typeof fetchImpl !== "function") {
      throw Object.assign(new Error("Transporte do retorno OAuth indisponível."), {
        code: "reviewer_oauth_return_transport_unavailable"
      });
    }

    async function getStatus(referenceInput) {
      const reference = safeString(referenceInput, "", 64);
      if (!RETURN_REFERENCE_PATTERN.test(reference)) {
        throw Object.assign(new Error("Referência do retorno OAuth inválida."), {
          code: "reviewer_oauth_return_reference_invalid"
        });
      }
      const response = await fetchImpl(
        `${apiBase}${OAUTH_RETURN_PREFIX}/${reference}`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer"
        }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw Object.assign(new Error("O retorno seguro não está mais disponível."), {
          code: "reviewer_oauth_return_unavailable"
        });
      }
      const keys = isPlainObject(payload) ? Object.keys(payload).sort() : [];
      const exactKeys = [
        "callbackSanitized",
        "code",
        "connectionId",
        "ok",
        "provider",
        "status"
      ];
      const exactShape = keys.length === exactKeys.length &&
        keys.every((key, index) => key === exactKeys[index]);
      const completed = payload?.status === "authorization_completed";
      const completedShape = completed && payload?.ok === true &&
        CONNECTION_ID_PATTERN.test(payload?.connectionId || "") &&
        payload?.code === null;
      const failureShape = !completed && payload?.ok === false &&
        payload?.connectionId === null &&
        SAFE_RETURN_CODE_PATTERN.test(payload?.code || "");
      if (
        !exactShape ||
        payload.provider !== "instagram" ||
        payload.callbackSanitized !== true ||
        !VISUAL_RETURN_STATUSES.includes(payload.status) ||
        (!completedShape && !failureShape)
      ) {
        throw Object.assign(new Error("Resposta inválida do retorno OAuth."), {
          code: "reviewer_oauth_return_response_invalid"
        });
      }
      return Object.freeze({
        ok: payload.ok,
        status: payload.status,
        callbackSanitized: true
      });
    }

    return Object.freeze({ getStatus });
  }

  function isOfficialInstagramAuthorizationUrl(value) {
    let parsed;
    try {
      parsed = new URL(String(value || ""));
    } catch (_error) {
      return false;
    }
    const rawKeys = [...parsed.searchParams.keys()];
    const keys = [...rawKeys].sort();
    const scopes = String(parsed.searchParams.get("scope") || "")
      .split(",")
      .sort();
    return parsed.protocol === "https:" &&
      parsed.hostname === "www.instagram.com" &&
      parsed.pathname === "/oauth/authorize" &&
      !parsed.port && !parsed.username && !parsed.password && !parsed.hash &&
      rawKeys.length === 6 &&
      keys.join(",") ===
        "client_id,enable_fb_login,redirect_uri,response_type,scope,state" &&
      /^[0-9]{5,32}$/.test(parsed.searchParams.get("client_id") || "") &&
      parsed.searchParams.get("enable_fb_login") === "0" &&
      parsed.searchParams.get("redirect_uri") ===
        `${STAGING_API_ORIGIN}/v1/social/oauth/callback` &&
      parsed.searchParams.get("response_type") === "code" &&
      scopes.join(",") ===
        "instagram_business_basic,instagram_business_content_publish" &&
      /^[A-Za-z0-9._~-]{32,2048}$/.test(
        parsed.searchParams.get("state") || ""
      );
  }

  function createHttpRealReviewerClient(options = {}) {
    const apiBase = safeString(options.apiBase, "", 300);
    const fetchImpl = options.fetchImpl;
    const tokenProvider = typeof options.tokenProvider === "function"
      ? options.tokenProvider
      : () => "";
    if (![LOCAL_API_ORIGIN, STAGING_API_ORIGIN].includes(apiBase)) {
      throw Object.assign(new Error("Origem do revisor real recusada."), {
        code: "real_reviewer_origin_forbidden"
      });
    }
    if (typeof fetchImpl !== "function") {
      throw Object.assign(new Error("Transporte do revisor real indisponível."), {
        code: "real_reviewer_transport_unavailable"
      });
    }

    async function request(route, method = "GET", body, requestOptions = {}) {
      const suffix = String(route || "");
      if (
        !suffix.startsWith("/") ||
        suffix.includes("..") ||
        /[?#\u0000-\u001f\u007f]/.test(suffix)
      ) {
        throw Object.assign(new Error("Rota do revisor real recusada."), {
          code: "real_reviewer_route_forbidden"
        });
      }
      const token = safeString(tokenProvider(), "", 8192);
      if (!token) {
        throw Object.assign(new Error("Entre pela IA4Tube para continuar."), {
          code: "reviewer_authentication_required"
        });
      }
      const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      };
      const init = { method, headers, cache: "no-store" };
      if (body !== undefined) {
        if (requestOptions.multipart === true) {
          init.body = body;
        } else {
          headers["Content-Type"] = "application/json";
          init.body = JSON.stringify(body);
        }
      }
      const response = await fetchImpl(`${apiBase}${suffix}`, init);
      const payload = await response.json().catch(() => null);
      if (response.status === 401) {
        throw Object.assign(new Error("Sua sessão expirou. Entre novamente."), {
          code: "reviewer_authentication_required"
        });
      }
      if (!response.ok || !isPlainObject(payload) || payload.ok !== true) {
        throw Object.assign(new Error(
          response.status === 503
            ? "Esta ação real permanece bloqueada pelo gate de segurança."
            : "A operação real foi recusada com segurança."
        ), {
          code: safeString(payload?.code, "real_reviewer_request_failed", 100)
        });
      }
      return payload;
    }

    function requireConnectionPayload(payload, optional) {
      const connection = payload?.connection;
      const validState = isPlainObject(connection) &&
        CONNECTION_ID_PATTERN.test(connection.connectionId) &&
        connection.provider === "instagram" &&
        REAL_REVIEWER_CONNECTION_STATES.includes(connection.state) &&
        (
          connection.state === "connected"
            ? ["healthy", "reconnect_required"].includes(connection.health)
            : connection.health === connection.state
        );
      if (
        !Object.hasOwn(payload, "connection") ||
        !(optional && connection === null) && !validState
      ) {
        throw Object.assign(new Error("Estado da conexão recusado."), {
          code: "real_reviewer_connection_response_invalid"
        });
      }
      return payload;
    }

    async function connection() {
      return requireConnectionPayload(
        await request("/v1/social/connections/instagram"),
        true
      );
    }

    function authorize(purpose) {
      if (purpose !== "connect" && purpose !== "reconnect") {
        throw Object.assign(new Error("Finalidade de autorização recusada."), {
          code: "real_reviewer_authorization_purpose_forbidden"
        });
      }
      return request(
        "/v1/social/connections/instagram/authorization",
        "POST",
        { purpose }
      );
    }

    return Object.freeze({
      connection,
      authorize,
      visualReturn: (reference) => request(
        `${OAUTH_RETURN_PREFIX}/${encodeURIComponent(reference)}`
      ),
      media: () => request(`${REAL_REVIEWER_PREFIX}/media`),
      uploadMedia: (jpeg, caption) => {
        const FormDataImpl = options.FormDataImpl ||
          (typeof FormData === "function" ? FormData : null);
        if (!FormDataImpl) {
          throw Object.assign(new Error("Envio de JPEG indisponível neste navegador."), {
            code: "real_reviewer_upload_unavailable"
          });
        }
        const form = new FormDataImpl();
        form.append("jpeg", jpeg, jpeg?.name || "ia4tube-reviewer.jpg");
        form.append("caption", caption);
        return request(
          `${REAL_REVIEWER_PREFIX}/media`,
          "POST",
          form,
          { multipart: true }
        );
      },
      publish: (mediaId, requestId) => request(
        `${REAL_REVIEWER_PREFIX}/publications`,
        "POST",
        { mediaId, clientRequestId: requestId }
      ),
      publications: () => request(`${REAL_REVIEWER_PREFIX}/publications`),
      publication: (publicationId) => request(
        `${REAL_REVIEWER_PREFIX}/publications/${encodeURIComponent(publicationId)}`
      ),
      reconcile: (publicationId) => request(
        `${REAL_REVIEWER_PREFIX}/publications/${encodeURIComponent(publicationId)}/reconcile`,
        "POST",
        {}
      ),
      async disconnect(connectionId) {
        const payload = requireConnectionPayload(await request(
          `/v1/social/connections/instagram/${encodeURIComponent(connectionId)}`,
          "DELETE"
        ), false);
        if (
          String(payload.connection.connectionId).toLowerCase() !==
          String(connectionId).toLowerCase()
        ) {
          throw Object.assign(new Error("Conexão desconectada recusada."), {
            code: "real_reviewer_connection_response_invalid"
          });
        }
        return payload;
      }
    });
  }

  function realReviewerConnectionView(connection, loaded = true) {
    if (!loaded) {
      return Object.freeze({
        purpose: null,
        connected: false,
        status: "Verificando conexão",
        badge: "Verificando",
        nav: "2. Verificando conexão",
        title: "Verificando conexão",
        message: "Aguarde a confirmação segura do estado da empresa.",
        button: null
      });
    }
    if (!connection) {
      return Object.freeze({
        purpose: "connect",
        connected: false,
        status: "Não conectada",
        badge: "Aguardando",
        nav: "2. Conectar Instagram",
        title: "Conectar Instagram",
        message: "A autorização começa somente após seu clique.",
        button: "Conectar Instagram"
      });
    }
    if (connection.state === "connected" && connection.health === "healthy") {
      return Object.freeze({
        purpose: null,
        connected: true,
        status: "Instagram conectado",
        badge: "Conectada",
        nav: "2. Instagram conectado",
        title: "Instagram conectado",
        message: "A conta profissional já está conectada a esta empresa.",
        button: null
      });
    }
    if (
      connection.state === "connected" &&
      connection.health === "reconnect_required"
    ) {
      return Object.freeze({
        purpose: null,
        connected: false,
        status: "Nova autorização necessária",
        badge: "Desconectar primeiro",
        nav: "2. Nova autorização necessária",
        title: "Nova autorização necessária",
        message: "Desconecte a conta antes de iniciar a reconexão segura.",
        button: null
      });
    }
    if (
      connection.state === "disconnected" ||
      connection.state === "reconnect_required"
    ) {
      return Object.freeze({
        purpose: "reconnect",
        connected: false,
        status: "Reconexão necessária",
        badge: "Reconectar",
        nav: "2. Conectar novamente",
        title: "Conectar novamente",
        message: "Uma nova autorização reutilizará a conexão desta empresa.",
        button: "Conectar novamente"
      });
    }
    return Object.freeze({
      purpose: null,
      connected: false,
      status: connection.state === "authorization_pending"
        ? "Autorização em andamento"
        : "Conexão indisponível",
      badge: "Aguardando",
      nav: "2. Estado da conexão",
      title: "Estado da conexão",
      message: "Atualize a página antes de iniciar uma nova autorização.",
      button: null
    });
  }

  function realReviewerAuthorizationResultAllowed(
    purpose,
    connection,
    result
  ) {
    if (purpose !== "reconnect") return purpose === "connect";
    const expected = String(connection?.connectionId || "").toLowerCase();
    const received = String(result?.connectionId || "").toLowerCase();
    return CONNECTION_ID_PATTERN.test(expected) && received === expected;
  }

  function realReviewerTemplate() {
    return `
      <div class="gate5aReviewerShell">
        <header class="gate5aReviewerHeader">
          <div class="gate5aReviewerBrand"><div class="gate5aBrandMark" aria-hidden="true"><svg viewBox="0 0 64 64" focusable="false"><circle cx="32" cy="32" r="28"></circle><path d="M15 40h36M34 18v35M15 40l19-22"></path><circle class="gate5aBrandDot" cx="34" cy="10" r="3.5"></circle></svg></div><div><div class="gate5aEyebrow">IA4Tube · Revisão oficial do Instagram</div><h1>Publique com segurança</h1><p>Escolha a imagem, confira a legenda e publique manualmente pela IA4Tube.</p></div></div>
          <div class="gate5aEnvironmentBadge"><span></span> Staging · integração real</div>
        </header>
        <div class="gate5aSafetyNotice" role="note"><strong>Conexão segura:</strong> sua senha é digitada somente no ambiente oficial do Instagram. A IA4Tube nunca recebe sua senha, código OAuth ou token no navegador. Conectar não publica nada.</div>
        <div class="gate5aError" data-real-error role="alert" hidden></div>
        <div class="gate5aAuthGate" data-real-auth-gate hidden><span class="gate5aStepNumber">↗</span><div><h2>Entre para iniciar a revisão</h2><p>Use o login normal da IA4Tube. Depois do acesso, você voltará automaticamente a esta mesma superfície real.</p></div><button type="button" class="gate5aPrimary" data-real-action="login">Entrar pela IA4Tube</button></div>
        <div class="gate5aReviewerLayout" data-real-layout>
          <aside class="gate5aReviewerNav" aria-label="Etapas da revisão real">
            <button type="button" data-real-nav="overview">1. Visão geral</button>
            <button type="button" data-real-nav="authorization" data-real-field="authorizationNav">2. Conectar Instagram</button>
            <button type="button" data-real-nav="oauth-return">3. Retorno seguro</button>
            <button type="button" data-real-nav="connection">4. Conta conectada</button>
            <button type="button" data-real-nav="media">5. Selecionar JPEG</button>
            <button type="button" data-real-nav="publication">6. Publicar e confirmar</button>
            <button type="button" data-real-nav="history">7. Histórico e detalhes</button>
            <button type="button" data-real-nav="data">8. Desconectar</button>
            <div class="gate5aMiniStatus"><span>Estado da conexão</span><strong data-real-field="connectionStatus">Não conectada</strong><small>Modo manual · sem agendamento</small></div>
          </aside>
          <div class="gate5aReviewerContent" aria-live="polite">
            <section data-real-screen="overview"><div class="gate5aScreenHeading"><span class="gate5aStepNumber">01</span><div><h2>Fluxo real do revisor</h2><p>Conexão oficial, JPEG da empresa, publicação explícita e prova canônica.</p></div></div><div class="gate5aCompanyConfirmation"><span>✓ Empresa derivada da sessão</span><strong data-real-field="companyLabel">Empresa autenticada</strong><small>Nenhum company_id é aceito do navegador.</small></div><div class="gate5aFeatureGrid"><article><span>🔐</span><h3>OAuth oficial</h3><p>Somente as permissões básica e de publicação aprovadas.</p></article><article><span>🖼️</span><h3>JPEG próprio</h3><p>Conteúdo validado novamente no servidor antes do envio.</p></article><article><span>✅</span><h3>Prova real</h3><p>Publicado somente após Media ID, referência, horário e permalink.</p></article></div><div class="gate5aActions"><button type="button" class="gate5aPrimary" data-real-action="go-connect">Começar revisão</button></div></section>
            <section data-real-screen="authorization" hidden><div class="gate5aScreenHeading"><span class="gate5aStepNumber">02</span><div><h2 data-real-field="authorizationTitle">Conectar Instagram</h2><p data-real-field="authorizationMessage">A autorização começa somente após seu clique.</p></div></div><div class="gate5aSecurityCopy"><strong>Antes de continuar</strong><ul><li>A senha permanece no ambiente oficial do Instagram.</li><li>Serão solicitadas apenas instagram_business_basic e instagram_business_content_publish.</li><li>Nada é publicado durante a conexão.</li></ul></div><div class="gate5aActions"><button type="button" class="gate5aPrimary" data-real-action="authorize" data-real-authorize>Conectar Instagram</button><strong data-real-connected-note hidden>Instagram conectado</strong></div></section>
            <section data-real-screen="oauth-return" hidden><div class="gate5aScreenHeading"><span class="gate5aStepNumber">03</span><div><h2>Confirmando sua conta</h2><p>O retorno visual usa apenas uma referência opaca e remove os parâmetros da URL.</p></div></div><ol class="gate5aProgressList"><li class="done"><span>1</span><div><strong>Retorno recebido</strong><small>Código e state não ficam nesta página.</small></div></li><li class="done"><span>2</span><div><strong>URL higienizada</strong><small>Nenhum token é devolvido ao navegador.</small></div></li><li><span>3</span><div><strong data-real-field="returnStatus">Confirmando sua conta</strong><small data-real-field="returnMessage">Aguarde a leitura do estado seguro.</small></div></li></ol><div class="gate5aActions"><button type="button" class="gate5aPrimary" data-real-action="refresh">Continuar</button></div></section>
            <section data-real-screen="connection" hidden><div class="gate5aScreenHeading"><span class="gate5aStepNumber">04</span><div><h2>Conta profissional</h2><p>Business ou Creator, vinculada à empresa autenticada.</p></div></div><div class="gate5aConnectionCard"><div class="gate5aAvatar">IG</div><div><span>Conta conectada</span><h3 data-real-field="username">—</h3><p data-real-field="accountType">—</p></div><strong class="gate5aStatusGood" data-real-field="connectionBadge">Aguardando</strong></div><div class="gate5aScopeGrid"><div><span>instagram_business_basic</span><strong>Necessária</strong></div><div><span>instagram_business_content_publish</span><strong>Necessária</strong></div></div><div class="gate5aActions"><button type="button" class="gate5aPrimary" data-real-action="go-media">Selecionar JPEG</button></div></section>
            <section data-real-screen="media" hidden>
              <div class="gate5aScreenHeading"><span class="gate5aStepNumber">05</span><div><h2>Imagem e legenda</h2><p>Prepare o conteúdo aqui. Esta etapa não publica no Instagram.</p></div></div>
              <div class="gate5aUploadPanel">
                <div class="gate5aUploadIntro">
                  <div class="gate5aUploadIcon" aria-hidden="true">＋</div>
                  <div><h3>Adicionar uma imagem</h3><p>Escolha um JPEG do seu dispositivo para conferir antes da publicação.</p></div>
                  <label class="gate5aSecondary gate5aFilePicker" for="gate5aRealJpegInput">Escolher JPEG</label>
                  <input id="gate5aRealJpegInput" type="file" accept=".jpg,.jpeg,image/jpeg" aria-describedby="gate5aRealJpegHelp" data-real-upload-input hidden>
                  <small id="gate5aRealJpegHelp">Somente JPEG 1080 × 1080 · máximo de 8 MB</small>
                </div>
                <div class="gate5aUploadDraft" data-real-upload-draft hidden>
                  <img data-real-upload-preview alt="Prévia do JPEG selecionado">
                  <div class="gate5aUploadFields">
                    <div class="gate5aUploadFileMeta"><span>Imagem selecionada</span><strong data-real-upload-name>—</strong><small data-real-upload-size>—</small><small data-real-upload-dimensions>Dimensões ainda não verificadas</small></div>
                    <label class="gate5aTextField"><span>Legenda</span><textarea rows="5" maxlength="${REAL_REVIEWER_SOURCE_CAPTION_MAX_LENGTH}" data-real-upload-caption placeholder="Escreva a legenda que acompanhará a publicação"></textarea><small><span data-real-caption-count>0</span> de ${REAL_REVIEWER_SOURCE_CAPTION_MAX_LENGTH} caracteres</small></label>
                    <div class="gate5aActions"><button type="button" class="gate5aPrimary" data-real-action="upload-media" disabled>Adicionar à revisão</button><button type="button" class="gate5aSecondary" data-real-action="cancel-upload">Cancelar</button></div>
                  </div>
                </div>
                <div class="gate5aUploadSuccess" data-real-upload-success role="status" hidden>JPEG adicionado. Confira abaixo antes de publicar.</div>
              </div>
              <div class="gate5aSectionDivider"><span>Conteúdo pronto para revisão</span></div>
              <label class="gate5aSelectField"><span>JPEG autorizado</span><select data-real-media-select><option value="">Selecione um JPEG</option></select></label>
              <div class="gate5aMediaReview" data-real-media-review hidden><img data-real-field-src="mediaAsset" alt="Prévia do JPEG autorizado"><div><span class="gate5aSyntheticTag">Conteúdo real da empresa</span><h3 data-real-field="mediaFile">preview_ia4tube.jpg</h3><p><strong>Formato:</strong> image/jpeg · <span data-real-field="mediaDimensions">—</span></p><div class="gate5aCaption"><span>Legenda final com marcador único de confirmação</span><p data-real-field="caption">—</p></div><ul><li>Proprietário: empresa autenticada</li><li>Modo: publicação manual</li><li>Envio: somente após confirmação explícita</li></ul></div></div>
              <p class="gate5aEmpty" data-real-no-media hidden>Nenhum JPEG foi adicionado ainda.</p>
              <div class="gate5aActions"><button type="button" class="gate5aPrimary" data-real-action="publish" disabled>Publicar no Instagram</button></div>
            </section>
            <section data-real-screen="publication" hidden><div class="gate5aScreenHeading"><span class="gate5aStepNumber">06</span><div><h2>Publicação manual</h2><p>Enviando e Confirmando ainda não significam Publicado.</p></div></div><div class="gate5aPublicationState"><span>Estado atual</span><strong data-real-field="publicationState">Aguardando envio</strong><small data-real-field="publicationHint">Um clique explícito inicia a operação.</small></div><ol class="gate5aPublishTimeline"><li data-real-publish-step="sending"><span></span><div><strong>Enviando</strong><small>Uma única submissão idempotente.</small></div></li><li data-real-publish-step="provider_confirming"><span></span><div><strong>Confirmando</strong><small>Ainda não tratado como publicado.</small></div></li><li data-real-publish-step="published"><span></span><div><strong>Publicado</strong><small>Somente com prova persistida do provider.</small></div></li></ol><div class="gate5aPublishedProof" data-real-proof hidden><h3>Publicado no Instagram</h3><div class="gate5aProofGrid"><div><span>Media ID</span><strong data-real-field="mediaId">—</strong></div><div><span>Horário</span><strong data-real-field="publishedAt">—</strong></div><div><span>Referência interna</span><strong data-real-field="reference">—</strong></div><div><span>Permalink</span><strong data-real-field="permalink">—</strong></div></div></div><div class="gate5aActions"><button type="button" class="gate5aPrimary" data-real-action="reconcile" hidden>Confirmar estado no Instagram</button><button type="button" class="gate5aSecondary" data-real-action="history">Ver histórico</button></div></section>
            <section data-real-screen="history" hidden><div class="gate5aScreenHeading"><span class="gate5aStepNumber">07</span><div><h2>Histórico canônico</h2><p>O registro social persiste após recarregar a página ou reiniciar o serviço.</p></div></div><div class="gate5aHistoryList" data-real-history></div><div class="gate5aPublishedProof" data-real-detail hidden></div><div class="gate5aActions"><button type="button" class="gate5aPrimary" data-real-action="disconnect-screen">Revisar desconexão</button></div></section>
            <section data-real-screen="data" hidden><div class="gate5aScreenHeading"><span class="gate5aStepNumber">08</span><div><h2>Desconectar Instagram</h2><p>A desconexão é separada da publicação e exige confirmação humana.</p></div></div><div class="gate5aDataGrid"><article><h3>Conta atual</h3><p data-real-field="disconnectAccount">Nenhuma conta conectada.</p><button type="button" class="gate5aDanger" data-real-action="disconnect">Desconectar conta</button></article><article><h3>O que permanece</h3><p>O histórico canônico da publicação continua disponível conforme a política aplicável.</p></article></div></section>
          </div>
        </div>
        <div class="gate5aBusy" data-real-busy hidden><span></span><strong data-real-busy-label>Atualizando revisão real…</strong></div>
      </div>`;
  }

  function mountRealReviewerApp(root, options = {}) {
    const targetWindow = options.window || (typeof window === "object" ? window : null);
    if (!root || !targetWindow || targetWindow.IA4_REAL_REVIEWER_ACTIVE !== true) {
      return null;
    }
    targetWindow.document.body.classList.add(
      "gate5a-reviewer-active",
      "gate5a-reviewer-real"
    );
    root.hidden = false;
    root.innerHTML = realReviewerTemplate();
    let token = "";
    try {
      token = safeString(targetWindow.localStorage?.getItem("omascote_token"), "", 8192);
    } catch (_error) {
      token = "";
    }
    const apiBase = resolveApiBase(targetWindow.location.hostname);
    const client = options.client || createHttpRealReviewerClient({
      apiBase,
      fetchImpl: targetWindow.fetch.bind(targetWindow),
      tokenProvider: () => token,
      FormDataImpl: targetWindow.FormData
    });
    let state = {
      stage: targetWindow.IA4_GATE5A_REVIEW_STAGE || "overview",
      companyLabel: "Empresa autenticada",
      connection: null,
      connectionLoaded: false,
      media: [],
      selectedMediaId: null,
      publication: null,
      history: [],
      detail: null,
      returnStatus: null,
      uploadSucceeded: false,
      busy: false,
      error: ""
    };
    let pendingUpload = null;
    let pendingCaption = "";
    const returnReference = RETURN_REFERENCE_PATTERN.test(
      String(targetWindow.IA4_GATE5A_RETURN_REFERENCE || "")
    ) ? targetWindow.IA4_GATE5A_RETURN_REFERENCE : null;
    targetWindow.IA4_GATE5A_RETURN_REFERENCE = null;

    function one(selector) {
      return root.querySelector(selector);
    }
    function all(selector) {
      return [...root.querySelectorAll(selector)];
    }
    function textField(name, value) {
      all(`[data-real-field="${name}"]`).forEach((node) => {
        node.textContent = value == null || value === "" ? "—" : String(value);
      });
    }
    function selectedMedia() {
      return state.media.find((item) => item.id === state.selectedMediaId) || null;
    }
    function formatFileSize(value) {
      const bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes < 0) return "—";
      if (bytes < 1024) return `${bytes} bytes`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    function clearPendingUpload() {
      if (pendingUpload?.previewUrl && targetWindow.URL?.revokeObjectURL) {
        targetWindow.URL.revokeObjectURL(pendingUpload.previewUrl);
      }
      pendingUpload = null;
      pendingCaption = "";
      const input = one("[data-real-upload-input]");
      if (input) input.value = "";
    }
    function renderPendingUpload() {
      const draft = one("[data-real-upload-draft]");
      if (!draft) return;
      draft.hidden = !pendingUpload;
      const preview = one("[data-real-upload-preview]");
      if (preview) {
        if (pendingUpload?.previewUrl) preview.src = pendingUpload.previewUrl;
        else preview.removeAttribute("src");
      }
      const name = one("[data-real-upload-name]");
      if (name) name.textContent = pendingUpload?.file?.name || "—";
      const size = one("[data-real-upload-size]");
      if (size) size.textContent = pendingUpload
        ? `${formatFileSize(pendingUpload.file.size)} · image/jpeg`
        : "—";
      const dimensions = one("[data-real-upload-dimensions]");
      if (dimensions) dimensions.textContent = pendingUpload?.dimensionsValid
        ? "1080 × 1080 confirmado"
        : pendingUpload
          ? "Verificando dimensões…"
          : "Dimensões ainda não verificadas";
      const caption = one("[data-real-upload-caption]");
      if (caption && caption.value !== pendingCaption) caption.value = pendingCaption;
      const count = one("[data-real-caption-count]");
      if (count) count.textContent = String(pendingCaption.length);
      const upload = one("[data-real-action=\"upload-media\"]");
      if (upload) {
        upload.disabled = !pendingUpload || pendingUpload.dimensionsValid !== true ||
          !pendingCaption.trim() ||
          pendingCaption.length > REAL_REVIEWER_SOURCE_CAPTION_MAX_LENGTH ||
          state.busy;
      }
    }
    function publicationLabel(value) {
      return {
        sending: "Enviando",
        provider_confirming: "Confirmando",
        published: "Publicado",
        failed_temporary: "Falha temporária",
        failed_permanent: "Falha permanente"
      }[value] || "Aguardando envio";
    }
    function renderHistory() {
      const container = one("[data-real-history]");
      if (!container) return;
      container.replaceChildren();
      if (!state.history.length) {
        const empty = targetWindow.document.createElement("p");
        empty.textContent = "Nenhuma publicação real registrada para esta empresa.";
        container.appendChild(empty);
        return;
      }
      for (const item of state.history) {
        const article = targetWindow.document.createElement("article");
        article.className = "gate5aHistoryItem";
        const heading = targetWindow.document.createElement("h3");
        heading.textContent = `${publicationLabel(item.state)} · ${item.media?.fileName || "JPEG"}`;
        const summary = targetWindow.document.createElement("p");
        summary.textContent = `Conta: ${item.account?.username || "conta vinculada"} · ${formatDateTime(item.updatedAt)}`;
        const button = targetWindow.document.createElement("button");
        button.type = "button";
        button.className = "gate5aSecondary";
        button.dataset.realDetailId = item.publicationId;
        button.textContent = "Abrir detalhes";
        article.append(heading, summary, button);
        container.appendChild(article);
      }
    }
    function renderDetail() {
      const container = one("[data-real-detail]");
      if (!container) return;
      container.hidden = !state.detail;
      if (!state.detail) {
        container.replaceChildren();
        return;
      }
      const item = state.detail;
      const heading = targetWindow.document.createElement("h3");
      heading.textContent = "Detalhes da publicação";
      const body = targetWindow.document.createElement("p");
      body.textContent = [
        `Estado: ${publicationLabel(item.state)}`,
        `Conta: ${item.account?.username || "conta vinculada"}`,
        `JPEG: ${item.media?.fileName || "preview_ia4tube.jpg"}`,
        `Referência: ${item.internalReference}`,
        `Horário: ${formatDateTime(item.publishedAt || item.updatedAt)}`,
        `Media ID: ${item.providerMediaId || "aguardando confirmação"}`,
        `Permalink: ${item.permalink || "aguardando confirmação"}`,
        `Legenda: ${item.caption || "sem legenda"}`
      ].join("\n");
      body.style.whiteSpace = "pre-wrap";
      container.replaceChildren(heading, body);
    }
    function render() {
      const authenticated = Boolean(token);
      one("[data-real-auth-gate]").hidden = authenticated;
      one("[data-real-layout]").hidden = !authenticated;
      one("[data-real-busy]").hidden = !state.busy;
      one("[data-real-upload-success]").hidden = !state.uploadSucceeded;
      const error = one("[data-real-error]");
      error.hidden = !state.error;
      error.textContent = state.error;
      all("[data-real-screen]").forEach((section) => {
        section.hidden = section.dataset.realScreen !== state.stage;
      });
      all("[data-real-nav]").forEach((button) => {
        button.classList.toggle("active", button.dataset.realNav === state.stage);
      });
      textField("companyLabel", state.companyLabel);
      const connection = state.connection;
      const connectionView = realReviewerConnectionView(
        connection,
        state.connectionLoaded
      );
      const connected = connectionView.connected;
      textField("connectionStatus", connectionView.status);
      textField("authorizationNav", connectionView.nav);
      textField("authorizationTitle", connectionView.title);
      textField("authorizationMessage", connectionView.message);
      const authorizeButton = one("[data-real-authorize]");
      authorizeButton.hidden = connectionView.button === null;
      authorizeButton.disabled = connectionView.button === null || state.busy;
      authorizeButton.textContent = connectionView.button || "Conectar Instagram";
      one("[data-real-connected-note]").hidden = !connectionView.connected;
      textField("username", connection?.username || "—");
      textField("accountType", connection?.accountType
        ? connection.accountType.toUpperCase()
        : "—");
      textField("connectionBadge", connectionView.badge);
      textField("disconnectAccount", connected
        ? `${connection.username} (${connection.accountType})`
        : "Nenhuma conta conectada.");
      const selector = one("[data-real-media-select]");
      const currentSelection = state.selectedMediaId || "";
      selector.replaceChildren();
      const placeholder = targetWindow.document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Selecione um JPEG";
      selector.appendChild(placeholder);
      state.media.forEach((item, index) => {
        const option = targetWindow.document.createElement("option");
        option.value = item.id;
        option.textContent = `${index + 1}. ${item.fileName} · ${item.width} × ${item.height}`;
        selector.appendChild(option);
      });
      selector.value = currentSelection;
      const media = selectedMedia();
      one("[data-real-media-review]").hidden = !media;
      one("[data-real-no-media]").hidden = state.media.length > 0;
      one("[data-real-action=\"publish\"]").disabled = !(
        connected && media && !state.busy && (
          !state.publication || state.publication.state === "failed_temporary"
        )
      );
      one("[data-real-action=\"disconnect\"]").disabled = !(
        connection?.state === "connected" && !state.busy
      );
      if (media) {
        one("[data-real-field-src=\"mediaAsset\"]").src = media.thumbnailUrl;
        textField("mediaFile", media.fileName);
        textField("mediaDimensions", `${media.width} × ${media.height}`);
        textField("caption", media.caption || "Sem legenda");
      }
      const publication = state.publication;
      textField("publicationState", publicationLabel(publication?.state));
      textField("publicationHint", publication?.state === "provider_confirming"
        ? "A confirmação ainda precisa ser consultada; não reenvie."
        : publication?.state === "published"
          ? "Confirmação do provider persistida no histórico."
          : "Um clique explícito inicia a operação.");
      all("[data-real-publish-step]").forEach((node) => {
        const order = ["sending", "provider_confirming", "published"];
        const current = order.indexOf(publication?.state);
        node.classList.toggle("done", current >= order.indexOf(node.dataset.realPublishStep));
      });
      const published = publication?.state === "published" &&
        publication.providerMediaId && publication.permalink &&
        publication.internalReference && publication.publishedAt;
      one("[data-real-proof]").hidden = !published;
      textField("mediaId", published ? publication.providerMediaId : "—");
      textField("publishedAt", published ? formatDateTime(publication.publishedAt) : "—");
      textField("reference", published ? publication.internalReference : "—");
      textField("permalink", published ? publication.permalink : "—");
      one("[data-real-action=\"reconcile\"]").hidden =
        publication?.state !== "provider_confirming";
      textField("returnStatus", state.returnStatus?.ok
        ? "Conta confirmada"
        : state.returnStatus
          ? "Autorização não concluída"
          : "Confirmando sua conta");
      textField("returnMessage", state.returnStatus?.ok
        ? "A conta profissional foi vinculada com segurança."
        : state.returnStatus
          ? "Confira o estado e tente a autorização novamente."
           : "Aguarde a leitura do estado seguro.");
      renderPendingUpload();
      renderHistory();
      renderDetail();
    }
    function update(values) {
      state = { ...state, ...values };
      render();
    }
    async function run(operation, stage = null) {
      update({ busy: true, error: "", ...(stage ? { stage } : {}) });
      try {
        return await operation();
      } catch (error) {
        if (error?.code === "reviewer_authentication_required") {
          try {
            targetWindow.localStorage?.removeItem("omascote_token");
          } catch (_error) {}
          token = "";
        }
        update({ error: safeString(error?.message, "Operação recusada.", 300) });
        return null;
      } finally {
        update({ busy: false });
      }
    }
    async function refresh() {
      update({ connectionLoaded: false });
      const connection = await client.connection();
      update({
        connection: connection.connection,
        connectionLoaded: true
      });
      const results = await Promise.all([
        client.media(),
        client.publications()
      ]);
      const [media, history] = results;
      update({
        media: Array.isArray(media.media) ? media.media : [],
        history: Array.isArray(history.publications) ? history.publications : [],
        publication: history.publications?.[0] || state.publication
      });
    }

    root.addEventListener("change", (event) => {
      if (event.target?.matches?.("[data-real-media-select]")) {
        update({ selectedMediaId: event.target.value || null });
        return;
      }
      if (event.target?.matches?.("[data-real-upload-input]")) {
        const file = event.target.files?.[0] || null;
        if (!file) return;
        const validName = /\.jpe?g$/i.test(String(file.name || ""));
        if (
          file.type !== "image/jpeg" ||
          !validName ||
          file.size < 1 ||
          file.size > REAL_REVIEWER_JPEG_MAX_BYTES
        ) {
          clearPendingUpload();
          update({
            uploadSucceeded: false,
            error: file.size > REAL_REVIEWER_JPEG_MAX_BYTES
              ? "O JPEG deve ter no máximo 8 MB."
              : "Selecione um arquivo JPEG válido (.jpg ou .jpeg)."
          });
          return;
        }
        if (pendingUpload?.previewUrl && targetWindow.URL?.revokeObjectURL) {
          targetWindow.URL.revokeObjectURL(pendingUpload.previewUrl);
        }
        let previewUrl = "";
        try {
          previewUrl = targetWindow.URL?.createObjectURL?.(file) || "";
        } catch (_error) {
          previewUrl = "";
        }
        if (!previewUrl) {
          clearPendingUpload();
          update({
            uploadSucceeded: false,
            error: "Não foi possível abrir a prévia deste JPEG."
          });
          return;
        }
        pendingUpload = { file, previewUrl, dimensionsValid: false };
        update({ uploadSucceeded: false, error: "" });
        const ImageImpl = targetWindow.Image;
        if (typeof ImageImpl !== "function") {
          clearPendingUpload();
          update({
            uploadSucceeded: false,
            error: "Não foi possível verificar as dimensões deste JPEG."
          });
          return;
        }
        const probe = new ImageImpl();
        probe.onload = () => {
          if (pendingUpload?.previewUrl !== previewUrl) return;
          if (probe.naturalWidth !== 1080 || probe.naturalHeight !== 1080) {
            clearPendingUpload();
            update({
              uploadSucceeded: false,
              error: "O JPEG deve ter exatamente 1080 × 1080 pixels."
            });
            return;
          }
          pendingUpload.dimensionsValid = true;
          renderPendingUpload();
        };
        probe.onerror = () => {
          if (pendingUpload?.previewUrl !== previewUrl) return;
          clearPendingUpload();
          update({
            uploadSucceeded: false,
            error: "Não foi possível verificar as dimensões deste JPEG."
          });
        };
        probe.src = previewUrl;
      }
    });
    root.addEventListener("input", (event) => {
      if (!event.target?.matches?.("[data-real-upload-caption]")) return;
      pendingCaption = String(event.target.value || "").slice(
        0,
        REAL_REVIEWER_SOURCE_CAPTION_MAX_LENGTH
      );
      renderPendingUpload();
    });
    root.addEventListener("click", (event) => {
      const detailButton = event.target?.closest?.("[data-real-detail-id]");
      if (detailButton) {
        run(async () => {
          const result = await client.publication(detailButton.dataset.realDetailId);
          update({ detail: result.publication });
        }, "history");
        return;
      }
      const nav = event.target?.closest?.("[data-real-nav]");
      if (nav) {
        update({ stage: nav.dataset.realNav, error: "" });
        return;
      }
      const action = event.target?.closest?.("[data-real-action]")?.dataset.realAction;
      if (!action || state.busy) return;
      if (action === "login") {
        try {
          beginCanonicalLoginHandoff(targetWindow);
        } catch (error) {
          update({ error: safeString(error?.message, "Login indisponível.", 300) });
        }
      } else if (action === "go-connect") {
        update({ stage: "authorization", error: "" });
      } else if (action === "authorize") {
        const purpose = realReviewerConnectionView(
          state.connection,
          state.connectionLoaded
        ).purpose;
        if (!purpose) return;
        const expectedConnection = state.connection;
        run(async () => {
          const result = await client.authorize(purpose);
          if (!realReviewerAuthorizationResultAllowed(
            purpose,
            expectedConnection,
            result
          )) {
            throw new Error("A conexão devolvida pela autorização foi recusada.");
          }
          if (!isOfficialInstagramAuthorizationUrl(result.authorizationUrl)) {
            throw new Error("A URL oficial de autorização foi recusada.");
          }
          targetWindow.location.assign(result.authorizationUrl);
        }, "authorization");
      } else if (action === "refresh") {
        run(refresh, "connection");
      } else if (action === "go-media") {
        update({ stage: "media", error: "" });
      } else if (action === "cancel-upload") {
        clearPendingUpload();
        update({ uploadSucceeded: false, error: "" });
      } else if (action === "upload-media") {
        const file = pendingUpload?.file || null;
        const caption = pendingCaption.trim();
        if (!file || !caption) return;
        run(async () => {
          const result = await client.uploadMedia(file, caption);
          const uploaded = result?.media;
          if (
            !isPlainObject(uploaded) ||
            typeof uploaded.id !== "string" ||
            uploaded.mimeType !== "image/jpeg" ||
            typeof uploaded.thumbnailUrl !== "string"
          ) {
            throw new Error("A confirmação do JPEG enviado foi recusada.");
          }
          const nextMedia = [
            uploaded,
            ...state.media.filter((item) => item.id !== uploaded.id)
          ].slice(0, 20);
          clearPendingUpload();
          update({
            media: nextMedia,
            selectedMediaId: uploaded.id,
            uploadSucceeded: true,
            error: ""
          });
        }, "media");
      } else if (action === "publish") {
        const media = selectedMedia();
        if (!media || typeof targetWindow.crypto?.randomUUID !== "function") return;
        const requestId = targetWindow.crypto.randomUUID();
        update({
          stage: "publication",
          publication: { state: "sending" },
          busy: true,
          error: ""
        });
        client.publish(media.id, requestId).then((result) => {
          update({ publication: result.publication, busy: false });
        }).catch((error) => {
          update({
            publication: null,
            busy: false,
            error: safeString(error?.message, "Publicação recusada.", 300)
          });
        });
      } else if (action === "reconcile" && state.publication?.publicationId) {
        run(async () => {
          const result = await client.reconcile(state.publication.publicationId);
          update({ publication: result.publication });
        }, "publication");
      } else if (action === "history") {
        run(async () => {
          const result = await client.publications();
          update({ history: result.publications });
        }, "history");
      } else if (action === "disconnect-screen") {
        update({ stage: "data", error: "" });
      } else if (action === "disconnect" && state.connection?.connectionId) {
        if (!targetWindow.confirm("Deseja desconectar esta conta do Instagram?")) return;
        run(async () => {
          const result = await client.disconnect(state.connection.connectionId);
          update({
            connection: result.connection,
            connectionLoaded: true,
            stage: "authorization"
          });
        }, "data");
      }
    });

    render();
    if (token) {
      run(async () => {
        if (returnReference) {
          state.returnStatus = await client.visualReturn(returnReference);
        }
        await refresh();
      }, returnReference ? "oauth-return" : state.stage);
    }
    return Object.freeze({
      client,
      getState: () => ({ ...state }),
      refresh
    });
  }

  function reviewerTemplate() {
    return `
      <div class="gate5aReviewerShell">
        <header class="gate5aReviewerHeader">
          <div>
            <div class="gate5aEyebrow">Revisão do Instagram · ambiente controlado</div>
            <h1>Publicação manual com a IA4Tube</h1>
            <p>Confira conexão, mídia, envio, confirmação e exclusão sem usar contas, tokens ou publicações reais.</p>
          </div>
          <div class="gate5aEnvironmentBadge"><span></span> Staging · provedor simulado</div>
        </header>

        <div class="gate5aSafetyNotice" role="note">
          <strong>Demonstração segura:</strong> a senha permanece no ambiente oficial. Conectar não publica nada e esta rota aceita somente dados sintéticos da sandbox de revisão.
        </div>
        <div class="gate5aError" data-g5a-error role="alert" hidden></div>
        <div class="gate5aAuthGate" data-g5a-auth-gate hidden>
          <span class="gate5aStepNumber">↗</span>
          <div><h2>Entre para iniciar a revisão</h2><p>Você será levado ao login normal da IA4Tube e voltará automaticamente para esta tela. Nenhuma credencial é solicitada pela sandbox.</p></div>
          <button type="button" class="gate5aPrimary" data-g5a-action="canonical-login">Entrar pela IA4Tube</button>
        </div>

        <div class="gate5aReviewerLayout" data-g5a-reviewer-layout>
          <aside class="gate5aReviewerNav" aria-label="Etapas da revisão">
            <button type="button" data-g5a-nav="overview">1. Visão geral</button>
            <button type="button" data-g5a-nav="authorization">2. Conectar Instagram</button>
            <button type="button" data-g5a-nav="oauth-return">3. Retorno seguro</button>
            <button type="button" data-g5a-nav="connection">4. Conta conectada</button>
            <button type="button" data-g5a-nav="media">5. Revisar JPEG</button>
            <button type="button" data-g5a-nav="publication">6. Publicar e confirmar</button>
            <button type="button" data-g5a-nav="history">7. Histórico</button>
            <button type="button" data-g5a-nav="data">8. Acesso e dados</button>
            <div class="gate5aMiniStatus">
              <span>Estado da conexão</span>
              <strong data-g5a-field="connectionStatus">Não conectada</strong>
              <small>Chamadas externas: 0</small>
            </div>
          </aside>

          <div class="gate5aReviewerContent" aria-live="polite">
            <section data-g5a-screen="overview">
              <div class="gate5aScreenHeading">
                <span class="gate5aStepNumber">01</span>
                <div><h2>O que será demonstrado</h2><p>Uma jornada completa e controlada, sem terminal.</p></div>
              </div>
              <div class="gate5aCompanyConfirmation" data-g5a-company-confirmation hidden>
                <span>✓ Empresa autenticada e controlada</span><strong data-g5a-field="companyLabel">—</strong><small>Contexto confirmado pela sessão; nenhum identificador técnico é exibido.</small>
              </div>
              <div class="gate5aFeatureGrid">
                <article><span>🔐</span><h3>Autorização segura</h3><p>O retorno visual remove imediatamente código e state da URL.</p></article>
                <article><span>🖼️</span><h3>JPEG controlado</h3><p>Arquivo, dimensões e legenda sintéticos revisados antes do envio.</p></article>
                <article><span>✅</span><h3>Confirmação legível</h3><p>Estados sending, provider_confirming e published com prova segura.</p></article>
              </div>
              <div class="gate5aActions"><button type="button" class="gate5aPrimary" data-g5a-action="start-review">Começar revisão</button></div>
            </section>

            <section data-g5a-screen="authorization" hidden>
              <div class="gate5aScreenHeading">
                <span class="gate5aStepNumber">02</span>
                <div><h2>Conectar Instagram</h2><p>Escolha um tipo de conta sintética para revisar o comportamento.</p></div>
              </div>
              <div class="gate5aCompanyConfirmation" data-g5a-company-confirmation hidden>
                <span>✓ Empresa autenticada e controlada</span><strong data-g5a-field="companyLabel">—</strong><small>A autorização ficará vinculada somente a este contexto autenticado.</small>
              </div>
              <div class="gate5aSecurityCopy">
                <strong>Antes de continuar</strong>
                <ul><li>A IA4Tube nunca recebe a senha do Instagram.</li><li>Nada será publicado durante a conexão.</li><li>É possível desconectar e solicitar exclusão depois.</li></ul>
              </div>
              <fieldset class="gate5aAccountChoices">
                <legend>Tipo de conta demonstrativa</legend>
                <label><input type="radio" name="gate5aAccountType" value="BUSINESS" checked><span><strong>Business</strong><small>Conta profissional aceita</small></span></label>
                <label><input type="radio" name="gate5aAccountType" value="CREATOR"><span><strong>Creator</strong><small>Conta profissional aceita</small></span></label>
                <label><input type="radio" name="gate5aAccountType" value="PERSONAL"><span><strong>Pessoal</strong><small>Deve ser recusada com segurança</small></span></label>
              </fieldset>
              <div class="gate5aActions"><button type="button" class="gate5aPrimary" data-g5a-action="authorize">Continuar para autorização segura</button></div>
            </section>

            <section data-g5a-screen="oauth-return" hidden>
              <div class="gate5aScreenHeading">
                <span class="gate5aStepNumber">03</span>
                <div><h2>Retorno seguro à IA4Tube</h2><p>A rota visual confirma o callback sem expor credenciais.</p></div>
              </div>
              <ol class="gate5aProgressList">
                <li class="done"><span>1</span><div><strong>Autorização preparada</strong><small>Somente a sandbox recebeu a intenção.</small></div></li>
                <li class="done"><span>2</span><div><strong>Retorno recebido</strong><small>Somente o status sanitizado é exibido nesta tela.</small></div></li>
                <li class="done"><span>3</span><div><strong>URL higienizada</strong><small>code, state e parâmetros sensíveis não permanecem no navegador.</small></div></li>
                <li><span>4</span><div><strong>Estamos confirmando sua conta (sandbox)</strong><small>Business e Creator continuam; conta pessoal é recusada.</small></div></li>
              </ol>
              <div class="gate5aSafetyNotice" data-g5a-visual-return role="status" hidden>
                <strong data-g5a-visual-return-title>Verificando retorno seguro…</strong>
                <span data-g5a-visual-return-message> Aguarde um instante.</span>
              </div>
              <div class="gate5aPersonalRejection" data-g5a-personal-rejection hidden>
                <strong>Conta pessoal não aceita</strong><p>Converta a conta em Business ou Creator e tente novamente. Nenhuma conexão foi criada.</p>
              </div>
              <div class="gate5aActions" data-g5a-sandbox-return-actions><button type="button" class="gate5aPrimary" data-g5a-action="complete-authorization">Confirmar conta demonstrativa</button><button type="button" class="gate5aSecondary" data-g5a-action="back-authorization">Escolher outro tipo</button></div>
              <div class="gate5aActions" data-g5a-visual-return-actions hidden><button type="button" class="gate5aPrimary" data-g5a-action="return-overview">Voltar ao roteiro seguro</button></div>
            </section>

            <section data-g5a-screen="connection" hidden>
              <div class="gate5aScreenHeading">
                <span class="gate5aStepNumber">04</span>
                <div><h2>Instagram conectado</h2><p>A conta profissional sintética está pronta para uma publicação manual.</p></div>
              </div>
              <div class="gate5aConnectionCard">
                <div class="gate5aAvatar">IG</div>
                <div><span>Conta de demonstração</span><h3>@<span data-g5a-field="username">—</span></h3><p><span data-g5a-field="accountType">—</span> · conexão controlada</p></div>
                <strong class="gate5aStatusGood">Conectada</strong>
              </div>
              <div class="gate5aScopeGrid"><div><span>Permissão básica</span><strong>Concedida na sandbox</strong></div><div><span>Publicação de conteúdo</span><strong>Concedida na sandbox</strong></div></div>
              <div class="gate5aActions"><button type="button" class="gate5aPrimary" data-g5a-action="select-media">Escolher JPEG controlado</button></div>
            </section>

            <section data-g5a-screen="media" hidden>
              <div class="gate5aScreenHeading">
                <span class="gate5aStepNumber">05</span>
                <div><h2>Revisar imagem e legenda</h2><p>O conteúdo precisa estar claro antes de uma tentativa de publicação.</p></div>
              </div>
              <div class="gate5aMediaReview">
                <img data-g5a-field-src="mediaAsset" src="${MEDIA_PLACEHOLDER_DATA_URL}" alt="Prévia neutra do JPEG controlado para revisão">
                <div><span class="gate5aSyntheticTag">Conteúdo sintético</span><h3 data-g5a-field="mediaFile">ia4tube-reviewer-controlled.jpg</h3><p><strong>Formato:</strong> image/jpeg · <span data-g5a-field="mediaDimensions">1080 × 1080</span></p><div class="gate5aCaption"><span>Legenda</span><p data-g5a-field="caption">—</p></div><ul><li>Destino: @<span data-g5a-field="username">—</span></li><li>Modo: publicação manual</li><li>Tentativas permitidas: uma</li></ul></div>
              </div>
              <div class="gate5aActions"><button type="button" class="gate5aPrimary" data-g5a-action="publish">Publicar uma vez na sandbox</button></div>
            </section>

            <section data-g5a-screen="publication" hidden>
              <div class="gate5aScreenHeading">
                <span class="gate5aStepNumber">06</span>
                <div><h2>Publicação manual</h2><p>Cada avanço é visível, idempotente e limitado ao provedor simulado.</p></div>
              </div>
              <div class="gate5aPublicationState"><span>Estado atual</span><strong data-g5a-field="publicationState">Aguardando envio</strong><small>Tentativas: <span data-g5a-field="attempts">0</span> de 1</small></div>
              <ol class="gate5aPublishTimeline">
                <li data-g5a-publish-step="sending"><span></span><div><strong>sending</strong><small>Envio reservado uma única vez.</small></div></li>
                <li data-g5a-publish-step="provider_confirming"><span></span><div><strong>provider_confirming</strong><small>Aguardando confirmação do provedor fake.</small></div></li>
                <li data-g5a-publish-step="published"><span></span><div><strong>published</strong><small>Prova sintética confirmada e registrada.</small></div></li>
              </ol>
              <div class="gate5aPublishedProof" data-g5a-published-proof hidden>
                <h3>Publicado no Instagram (simulado)</h3>
                <div class="gate5aProofGrid"><div><span>Media ID</span><strong data-g5a-field="mediaId">—</strong></div><div><span>Horário</span><strong data-g5a-field="publishedAt">—</strong></div><div><span>Referência</span><strong data-g5a-field="reference">—</strong></div><div><span>Permalink seguro</span><strong data-g5a-field="permalink">—</strong><small>Exibido como texto; não abre publicação externa.</small></div></div>
              </div>
              <div class="gate5aActions"><button type="button" class="gate5aPrimary" data-g5a-action="advance-publication">Avançar confirmação simulada</button><button type="button" class="gate5aSecondary" data-g5a-action="history">Ver histórico e detalhes</button></div>
            </section>

            <section data-g5a-screen="history" hidden>
              <div class="gate5aScreenHeading">
                <span class="gate5aStepNumber">07</span>
                <div><h2>Histórico de publicações</h2><p>Uma única tentativa gera um único registro detalhado.</p></div>
              </div>
              <div class="gate5aHistoryList" data-g5a-history></div>
              <div class="gate5aActions"><button type="button" class="gate5aPrimary" data-g5a-action="data">Revisar acesso e dados</button></div>
            </section>

            <section data-g5a-screen="data" hidden>
              <div class="gate5aScreenHeading">
                <span class="gate5aStepNumber">08</span>
                <div><h2>Acesso e dados da conexão</h2><p>Desconectar e excluir são ações diferentes, claras e confirmadas.</p></div>
              </div>
              <div class="gate5aDataGrid">
                <article><h3>Desconectar Instagram</h3><p>Encerra a conexão demonstrativa. O histórico sintético permanece visível até a exclusão.</p><button type="button" class="gate5aSecondary" data-g5a-action="disconnect">Desconectar conta sintética</button></article>
                <article><h3>Excluir dados da conexão</h3><p>Exclui a credencial de acesso e os dados técnicos elegíveis da conexão. A conexão permanece revogada; artes, imagens, legendas e histórico continuam salvos.</p><button type="button" class="gate5aDanger" data-g5a-action="delete-data">Confirmar exclusão demonstrativa</button></article>
              </div>
              <div class="gate5aDeletionResult" data-g5a-deletion-result hidden><strong>Dados técnicos elegíveis excluídos</strong><p>A credencial de acesso e os dados técnicos elegíveis da conexão foram excluídos. A conexão permaneceu revogada. Suas artes, imagens, legendas e histórico continuam salvos.</p><div class="gate5aProofGrid" data-g5a-deletion-protocol hidden><div><span>Protocolo</span><strong data-g5a-field="deletionConfirmationCode">—</strong></div><div><span>Estado atual do pedido</span><strong data-g5a-field="deletionRequestStatus">—</strong></div></div><a class="gate5aSecondary" data-g5a-deletion-status-link href="" target="_blank" rel="noopener noreferrer" hidden>Acompanhar status do pedido</a></div>
              <div class="gate5aActions"><button type="button" class="gate5aSecondary" data-g5a-action="reset">Reiniciar demonstração</button></div>
            </section>
          </div>
        </div>
        <div class="gate5aBusy" data-g5a-busy hidden><span></span><strong>Atualizando demonstração segura…</strong></div>
      </div>`;
  }

  function stageRoute(targetWindow, stage, replace = false) {
    if (!REVIEW_STAGES.includes(stage)) return;
    const current = new URL(targetWindow.location.href);
    const params = new URLSearchParams();
    params.set(REVIEW_QUERY_KEY, REVIEW_QUERY_VALUE);
    params.set(REVIEW_STAGE_KEY, stage);
    const path = `${current.pathname}?${params.toString()}`;
    const method = replace ? "replaceState" : "pushState";
    targetWindow.history?.[method]?.(
      Object.freeze({ gate5aReviewer: true, stage }),
      "",
      path
    );
  }

  function formatDateTime(value) {
    const normalized = safeIso(value);
    if (!normalized) return "—";
    try {
      return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "medium",
        timeZone: "America/Sao_Paulo"
      }).format(new Date(normalized));
    } catch (_error) {
      return normalized;
    }
  }

  function mountReviewerApp(root, options = {}) {
    const targetWindow = options.window || (typeof window === "object" ? window : null);
    if (targetWindow?.IA4_REAL_REVIEWER_ACTIVE === true) {
      return mountRealReviewerApp(root, options);
    }
    if (!root || !targetWindow || targetWindow.IA4_GATE5A_REVIEWER_ACTIVE !== true) {
      return null;
    }
    targetWindow.document.body.classList.add("gate5a-reviewer-active");
    root.hidden = false;
    root.innerHTML = reviewerTemplate();

    const initialStage = REVIEW_STAGES.includes(targetWindow.IA4_GATE5A_REVIEW_STAGE)
      ? targetWindow.IA4_GATE5A_REVIEW_STAGE
      : "overview";
    let accountType = "BUSINESS";
    let state = createInitialState({
      stage: initialStage,
      callbackObserved: targetWindow.IA4_GATE5A_CALLBACK_OBSERVED === true
    });
    let busy = false;
    const returnReference = RETURN_REFERENCE_PATTERN.test(
      String(targetWindow.IA4_GATE5A_RETURN_REFERENCE || "")
    ) ? targetWindow.IA4_GATE5A_RETURN_REFERENCE : null;
    targetWindow.IA4_GATE5A_RETURN_REFERENCE = null;
    let visualReturn = returnReference
      ? { phase: "loading", status: null }
      : { phase: "not_requested", status: null };
    const apiBase = resolveApiBase(targetWindow.location.hostname);
    const canonicalAuthenticationRequired =
      targetWindow.location.hostname === STAGING_HOSTNAME;
    let canonicalToken = "";
    let canonicalStorage = null;
    try {
      canonicalStorage = targetWindow.localStorage;
      canonicalToken = safeString(
        canonicalStorage?.getItem("omascote_token"),
        "",
        8192
      );
    } catch (_error) {
      canonicalToken = "";
    }
    let authenticated = !canonicalAuthenticationRequired || Boolean(
      canonicalToken
    );
    let companyVerified = localHostname(targetWindow.location.hostname);
    const client = options.client || (
      localHostname(targetWindow.location.hostname)
        ? createInMemorySandbox({
            stage: initialStage,
            callbackObserved: targetWindow.IA4_GATE5A_CALLBACK_OBSERVED === true
          })
        : createHttpSandboxClient({
            apiBase,
            fetchImpl: targetWindow.fetch.bind(targetWindow),
            tokenProvider: () => canonicalToken
          })
    );
    const oauthReturnClient = returnReference
      ? options.oauthReturnClient || createOAuthReturnClient({
          apiBase,
          fetchImpl: targetWindow.fetch.bind(targetWindow)
        })
      : null;

    const errorBox = root.querySelector("[data-g5a-error]");
    const busyBox = root.querySelector("[data-g5a-busy]");
    const authGate = root.querySelector("[data-g5a-auth-gate]");
    const reviewerLayout = root.querySelector("[data-g5a-reviewer-layout]");

    function setText(name, value) {
      root.querySelectorAll(`[data-g5a-field="${name}"]`).forEach((element) => {
        element.textContent = String(value ?? "—");
      });
    }

    function renderHistory() {
      const container = root.querySelector("[data-g5a-history]");
      if (!container) return;
      container.replaceChildren();
      if (state.history.length === 0) {
        const empty = targetWindow.document.createElement("div");
        empty.className = "gate5aEmpty";
        empty.textContent = "Nenhuma publicação demonstrativa registrada ainda.";
        container.appendChild(empty);
        return;
      }
      for (const item of state.history) {
        const article = targetWindow.document.createElement("article");
        article.className = "gate5aHistoryItem";
        const title = targetWindow.document.createElement("h3");
        title.textContent = "Publicação manual confirmada";
        const summary = targetWindow.document.createElement("p");
        summary.textContent = `@${item.account} · ${item.media}`;
        const details = targetWindow.document.createElement("dl");
        for (const [label, value] of [
          ["Estado", "published"],
          ["Media ID", item.mediaId],
          ["Horário", formatDateTime(item.publishedAt)],
          ["Referência", item.reference],
          ["Permalink seguro", item.permalink]
        ]) {
          const dt = targetWindow.document.createElement("dt");
          const dd = targetWindow.document.createElement("dd");
          dt.textContent = label;
          dd.textContent = value;
          details.append(dt, dd);
        }
        article.append(title, summary, details);
        container.appendChild(article);
      }
    }

    function render() {
      const activeStage = REVIEW_STAGES.includes(state.stage) ? state.stage : "overview";
      if (authGate) authGate.hidden = authenticated;
      if (reviewerLayout) reviewerLayout.hidden = !authenticated;
      root.querySelectorAll("[data-g5a-screen]").forEach((screen) => {
        screen.hidden = screen.getAttribute("data-g5a-screen") !== activeStage;
      });
      root.querySelectorAll("[data-g5a-nav]").forEach((button) => {
        const active = button.getAttribute("data-g5a-nav") === activeStage;
        button.classList.toggle("active", active);
        if (active) button.setAttribute("aria-current", "step");
        else button.removeAttribute("aria-current");
      });

      const statusLabels = {
        not_connected: "Não conectada",
        connected: "Conectada",
        rejected: "Conta pessoal recusada",
        disconnected: "Desconectada",
        deleted: "Dados excluídos"
      };
      const publicationLabels = {
        idle: "Aguardando envio",
        sending: "sending · enviando",
        provider_confirming: "provider_confirming · confirmando",
        published: "Publicado no Instagram (simulado)"
      };
      setText("connectionStatus", statusLabels[state.connection.status] || "Não conectada");
      setText("companyLabel", state.company.label);
      setText("username", state.connection.account?.username || "conta_sintetica");
      setText("accountType", state.connection.account?.accountType || accountType);
      setText("mediaFile", state.media.item?.fileName || SYNTHETIC_MEDIA.fileName);
      setText("mediaDimensions", state.media.item
        ? `${state.media.item.width} × ${state.media.item.height}`
        : `${SYNTHETIC_MEDIA.width} × ${SYNTHETIC_MEDIA.height}`);
      setText("caption", state.media.item?.caption || SYNTHETIC_MEDIA.caption);
      setText("publicationState", publicationLabels[state.publication.state]);
      setText("attempts", state.publication.attempts);
      setText("mediaId", state.publication.details?.mediaId || "—");
      setText("publishedAt", formatDateTime(state.publication.details?.publishedAt));
      setText("reference", state.publication.details?.reference || "—");
      setText("permalink", state.publication.details?.permalink || "—");
      setText(
        "deletionConfirmationCode",
        state.deletion.confirmationCode || "—"
      );
      setText(
        "deletionRequestStatus",
        state.deletion.requestStatus === "completed"
          ? "completed · concluído"
          : "—"
      );

      const mediaImage = root.querySelector("[data-g5a-field-src='mediaAsset']");
      if (mediaImage) {
        mediaImage.src = state.media.item?.assetPath || MEDIA_PLACEHOLDER_DATA_URL;
      }
      const rejection = root.querySelector("[data-g5a-personal-rejection]");
      if (rejection) rejection.hidden = state.connection.status !== "rejected";
      const proof = root.querySelector("[data-g5a-published-proof]");
      if (proof) proof.hidden = state.publication.state !== "published";
      const deletion = root.querySelector("[data-g5a-deletion-result]");
      if (deletion) deletion.hidden = state.deletion.status !== "completed";
      const deletionProtocol = root.querySelector(
        "[data-g5a-deletion-protocol]"
      );
      if (deletionProtocol) {
        deletionProtocol.hidden = !state.deletion.confirmationCode;
      }
      const deletionStatusLink = root.querySelector(
        "[data-g5a-deletion-status-link]"
      );
      if (deletionStatusLink) {
        deletionStatusLink.hidden = !state.deletion.statusUrl;
        deletionStatusLink.href = state.deletion.statusUrl || "";
      }
      root.querySelectorAll("[data-g5a-company-confirmation]").forEach((element) => {
        element.hidden = !companyVerified || state.company.controlled !== true;
      });

      const visualReturnBox = root.querySelector("[data-g5a-visual-return]");
      const visualReturnTitle = root.querySelector("[data-g5a-visual-return-title]");
      const visualReturnMessage = root.querySelector("[data-g5a-visual-return-message]");
      const sandboxReturnActions = root.querySelector("[data-g5a-sandbox-return-actions]");
      const visualReturnActions = root.querySelector("[data-g5a-visual-return-actions]");
      const visualCopy = {
        authorization_completed: [
          "Autorização concluída com segurança.",
          " O código e o state já foram removidos da URL."
        ],
        authorization_cancelled: [
          "Autorização cancelada.",
          " Nenhuma nova conexão foi confirmada."
        ],
        authorization_expired: [
          "Autorização expirada.",
          " Inicie uma nova autorização quando quiser tentar novamente."
        ],
        authorization_failed: [
          "Autorização não concluída.",
          " A conexão não foi criada; você pode voltar e tentar novamente."
        ]
      };
      if (visualReturnBox) {
        visualReturnBox.hidden = visualReturn.phase === "not_requested";
        visualReturnBox.setAttribute("data-status", visualReturn.status || visualReturn.phase);
      }
      if (visualReturnTitle && visualReturnMessage) {
        const copy = visualCopy[visualReturn.status] || (
          visualReturn.phase === "loading"
            ? ["Verificando retorno seguro…", " Aguarde um instante."]
            : ["Retorno seguro indisponível.", " O link pode ter expirado; nenhum dado sensível foi mantido."]
        );
        visualReturnTitle.textContent = copy[0];
        visualReturnMessage.textContent = copy[1];
      }
      if (sandboxReturnActions) sandboxReturnActions.hidden = Boolean(returnReference);
      if (visualReturnActions) {
        visualReturnActions.hidden = !returnReference || visualReturn.phase === "loading";
      }

      const order = ["sending", "provider_confirming", "published"];
      const currentIndex = order.indexOf(state.publication.state);
      root.querySelectorAll("[data-g5a-publish-step]").forEach((step) => {
        const index = order.indexOf(step.getAttribute("data-g5a-publish-step"));
        step.classList.toggle("done", currentIndex >= index && currentIndex >= 0);
        step.classList.toggle("current", currentIndex === index);
      });

      const advance = root.querySelector("[data-g5a-action='advance-publication']");
      if (advance) {
        advance.disabled = !["sending", "provider_confirming"].includes(
          state.publication.state
        );
        advance.textContent = state.publication.state === "sending"
          ? "Consultar provedor simulado"
          : state.publication.state === "provider_confirming"
            ? "Confirmar publicação simulada"
            : "Publicação confirmada";
      }
      const publish = root.querySelector("[data-g5a-action='publish']");
      if (publish) publish.disabled = !state.media.selected || state.publication.state !== "idle";
      const startReview = root.querySelector("[data-g5a-action='start-review']");
      if (startReview) startReview.disabled = !companyVerified;
      const authorize = root.querySelector("[data-g5a-action='authorize']");
      if (authorize) authorize.disabled = !companyVerified;
      const disconnect = root.querySelector("[data-g5a-action='disconnect']");
      if (disconnect) disconnect.disabled = !["connected"].includes(state.connection.status);
      renderHistory();
      if (busyBox) busyBox.hidden = !busy;
      root.setAttribute("data-gate5a-stage", activeStage);
    }

    function showError(error) {
      if (!errorBox) return;
      const messages = {
        reviewer_authentication_required: "Entre com a conta de revisão da IA4Tube antes de abrir este roteiro.",
        professional_account_required: "Conta pessoal recusada: escolha Business ou Creator.",
        reviewer_sandbox_response_invalid: "A sandbox respondeu fora do contrato seguro.",
        gate5a_reviewer_network_blocked: "A tentativa saiu do perímetro permitido e foi bloqueada.",
        reviewer_canonical_login_storage_unavailable: "O navegador bloqueou o retorno seguro. Habilite o armazenamento da sessão e tente novamente."
      };
      errorBox.textContent = messages[error?.code] ||
        safeString(error?.message, "Não foi possível atualizar a demonstração.", 300);
      errorBox.hidden = false;
    }

    function clearError() {
      if (!errorBox) return;
      errorBox.hidden = true;
      errorBox.textContent = "";
    }

    function navigate(stage, replace = false) {
      if (!REVIEW_STAGES.includes(stage)) return;
      state = { ...state, stage };
      stageRoute(targetWindow, stage, replace);
      render();
      root.querySelector(".gate5aReviewerContent")?.scrollTo?.({ top: 0 });
    }

    async function run(operation, successStage) {
      if (busy) return;
      busy = true;
      clearError();
      render();
      try {
        state = normalizeState(await operation());
        companyVerified = true;
        if (successStage) state = { ...state, stage: successStage };
        stageRoute(targetWindow, state.stage, true);
      } catch (error) {
        const authenticationRecovery = reduceReviewerAuthenticationAfterError(
          { authenticated, companyVerified, canonicalToken },
          {
            code: error?.code,
            hostname: targetWindow.location.hostname,
            storage: canonicalStorage
          }
        );
        if (authenticationRecovery.handled) {
          authenticated = authenticationRecovery.authenticated;
          companyVerified = authenticationRecovery.companyVerified;
          canonicalToken = authenticationRecovery.canonicalToken;
        } else if (error?.state) {
          state = normalizeState(error.state);
          companyVerified = true;
        }
        showError(error);
      } finally {
        busy = false;
        render();
      }
    }

    async function loadVisualReturn() {
      if (!returnReference || !oauthReturnClient) return;
      visualReturn = { phase: "loading", status: null };
      render();
      try {
        const result = await oauthReturnClient.getStatus(returnReference);
        visualReturn = { phase: "resolved", status: result.status };
      } catch (_error) {
        visualReturn = { phase: "unavailable", status: null };
      } finally {
        render();
      }
    }

    root.addEventListener("change", (event) => {
      const input = event.target.closest?.("input[name='gate5aAccountType']");
      if (!input || !ACCOUNT_TYPES.includes(input.value)) return;
      accountType = input.value;
    });

    root.addEventListener("click", (event) => {
      const nav = event.target.closest?.("[data-g5a-nav]");
      if (nav) {
        navigate(nav.getAttribute("data-g5a-nav"));
        return;
      }
      const button = event.target.closest?.("[data-g5a-action]");
      if (!button || button.disabled) return;
      const action = button.getAttribute("data-g5a-action");
      if (action === "start-review" || action === "back-authorization") {
        navigate("authorization");
      } else if (action === "canonical-login") {
        try {
          beginCanonicalLoginHandoff(targetWindow);
        } catch (error) {
          showError(error);
        }
      } else if (action === "return-overview") {
        navigate("overview");
      } else if (action === "authorize") {
        run(() => client.authorize(accountType), "oauth-return");
      } else if (action === "complete-authorization") {
        run(() => client.completeAuthorization());
      } else if (action === "select-media") {
        run(() => client.selectMedia(), "media");
      } else if (action === "publish") {
        run(() => client.publish(), "publication");
      } else if (action === "advance-publication") {
        run(() => client.advancePublication(state.publication.id), "publication");
      } else if (action === "history") {
        navigate("history");
      } else if (action === "data") {
        navigate("data");
      } else if (action === "disconnect") {
        run(() => client.disconnect(), "data");
      } else if (action === "delete-data") {
        run(() => client.deleteData(), "data");
      } else if (action === "reset") {
        run(() => client.reset(), "overview");
      }
    });

    targetWindow.addEventListener?.("popstate", () => {
      const sanitized = sanitizeCallbackUrl(targetWindow.location.href);
      if (sanitized.active) {
        state = { ...state, stage: sanitized.stage };
        if (sanitized.changed) stageRoute(targetWindow, sanitized.stage, true);
        render();
      }
    });

    render();
    if (authenticated) {
      run(() => client.getState(), initialStage);
    }
    loadVisualReturn();
    return Object.freeze({
      getState: () => normalizeState(state),
      navigate,
      client
    });
  }

  return Object.freeze({
    ACCOUNT_TYPES,
    CALLBACK_SENSITIVE_KEYS,
    CANONICAL_LOGIN_HANDOFF_KEY,
    CANONICAL_LOGIN_HANDOFF_TTL_MS,
    CANONICAL_LOGIN_PATH,
    CLIENT_REQUEST_ID,
    CONTROLLED_ASSET_ID,
    LOCAL_API_ORIGIN,
    MEDIA_PLACEHOLDER_DATA_URL,
    OAUTH_RETURN_PREFIX,
    PROFESSIONAL_ACCOUNT_TYPES,
    REAL_REVIEWER_CONNECTION_STATES,
    PRODUCTION_API_ORIGIN,
    PUBLICATION_STATES,
    REAL_REVIEWER_PATH,
    REAL_REVIEWER_PREFIX,
    REAL_REVIEWER_RETURN_PATH,
    REVIEW_QUERY_KEY,
    REVIEW_QUERY_VALUE,
    REVIEWER_RETURN_PATH,
    REVIEW_STAGES,
    SANDBOX_PREFIX,
    STAGING_API_ORIGIN,
    STAGING_HOSTNAME,
    SYNTHETIC_MEDIA,
    SYNTHETIC_PERMALINK,
    SYNTHETIC_PUBLICATION_ID,
    VISUAL_RETURN_STATUSES,
    accountFixture,
    beginCanonicalLoginHandoff,
    completeCanonicalLoginHandoff,
    createHttpRealReviewerClient,
    createHttpSandboxClient,
    createInMemorySandbox,
    createInitialState,
    createOAuthReturnClient,
    installEarlyGuard,
    isOfficialInstagramAuthorizationUrl,
    isRealReviewerMode,
    isReviewerMode,
    isSafeSyntheticPermalink,
    localHostname,
    mountReviewerApp,
    mountRealReviewerApp,
    normalizeState,
    readCanonicalLoginHandoff,
    realReviewerTemplate,
    realReviewerRequestAllowed,
    realReviewerConnectionView,
    realReviewerAuthorizationResultAllowed,
    recoverReviewerAuthenticationFrom401,
    reduceReviewerAuthenticationAfterError,
    resolveApiBase,
    reviewerHostnameAllowed,
    sanitizeCanonicalLoginHandoffUrl,
    sanitizeCallbackUrl,
    sanitizeRealReviewerUrl,
    transitionState
  });
});
