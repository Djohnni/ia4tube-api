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
  const OAUTH_RETURN_PREFIX = "/v1/social/oauth/return";
  const CANONICAL_LOGIN_HANDOFF_KEY = "ia4tube_gate5a_login_handoff_v1";
  const CANONICAL_LOGIN_QUERY_KEY = "gate5a_review_login";
  const CANONICAL_LOGIN_QUERY_VALUE = "1";
  const CANONICAL_LOGIN_PATH =
    `/app.html?${CANONICAL_LOGIN_QUERY_KEY}=${CANONICAL_LOGIN_QUERY_VALUE}`;
  const REVIEWER_RETURN_PATH =
    `/app.html?review=${REVIEW_QUERY_VALUE}&stage=overview`;
  const CANONICAL_LOGIN_HANDOFF_TTL_MS = 15 * 60 * 1000;
  const RETURN_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
  const CONNECTION_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SAFE_RETURN_CODE_PATTERN = /^[a-z0-9_]{2,96}$/;
  const CLIENT_REQUEST_ID = "gate5a-reviewer-manual-publish-v1";
  const CONTROLLED_ASSET_ID = "controlled-review-jpeg";
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

  function isReviewerMode(search, hostname = STAGING_HOSTNAME) {
    if (!reviewerHostnameAllowed(hostname)) return false;
    const params = parseSearch(search);
    return params.get(REVIEW_QUERY_KEY) === REVIEW_QUERY_VALUE;
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
    if (
      !target?.location ||
      !reviewerHostnameAllowed(target.location.hostname) ||
      !isReviewerMode(target.location.search, target.location.hostname) ||
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
    const receipt = JSON.stringify({ version: 1, issuedAt });
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
      returnPath: REVIEWER_RETURN_PATH
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
    const valid = keys.length === 2 && keys[0] === "issuedAt" &&
      keys[1] === "version" && parsed.version === 1 &&
      Number.isSafeInteger(parsed.issuedAt) &&
      Number.isSafeInteger(current) && current >= parsed.issuedAt &&
      current - parsed.issuedAt <= CANONICAL_LOGIN_HANDOFF_TTL_MS;
    if (!valid) {
      removeCanonicalLoginHandoff(target.sessionStorage);
      return closed;
    }
    return Object.freeze({ active: true, returnPath: REVIEWER_RETURN_PATH });
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
    target.location.assign(REVIEWER_RETURN_PATH);
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

  function blockedNetworkError() {
    const error = new Error("A revisão Gate 5A bloqueou uma chamada fora da sandbox.");
    error.code = "gate5a_reviewer_network_blocked";
    return error;
  }

  function installEarlyGuard(target) {
    if (!target || !target.location) {
      return Object.freeze({ active: false, reason: "window_unavailable" });
    }
    const active = isReviewerMode(target.location.search, target.location.hostname);
    target.IA4_GATE5A_REVIEWER_ACTIVE = active;
    if (!active) return Object.freeze({ active: false, reason: "route_inactive" });

    const sanitized = sanitizeCallbackUrl(target.location.href);
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
      const sandboxAllowed = requestUrl.pathname === SANDBOX_PREFIX ||
        requestUrl.pathname.startsWith(`${SANDBOX_PREFIX}/`);
      const returnReference = requestUrl.pathname.startsWith(`${OAUTH_RETURN_PREFIX}/`)
        ? requestUrl.pathname.slice(OAUTH_RETURN_PREFIX.length + 1)
        : "";
      const visualReturnAllowed = method === "GET" &&
        RETURN_REFERENCE_PATTERN.test(returnReference) &&
        requestUrl.search === "" &&
        requestUrl.hash === "";
      const allowed = requestUrl.origin === allowedApiOrigin &&
        (sandboxAllowed || visualReturnAllowed);
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

  function normalizeState(value) {
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
      if (payload.state !== undefined) normalizedState = normalizeState(payload.state);
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
                <article><h3>Excluir dados da conexão</h3><p>Descarta credencial sintética, conta e mídia técnicas. O histórico demonstrativo permanece separado enquanto a política de retenção aguarda decisão.</p><button type="button" class="gate5aDanger" data-g5a-action="delete-data">Confirmar exclusão demonstrativa</button></article>
              </div>
              <div class="gate5aDeletionResult" data-g5a-deletion-result hidden><strong>Dados técnicos sintéticos descartados</strong><p>Conta, credencial e mídia foram removidas. O histórico demonstrativo permanece separado, sem habilitar novas operações, até uma decisão formal de retenção.</p></div>
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
    PRODUCTION_API_ORIGIN,
    PUBLICATION_STATES,
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
    createHttpSandboxClient,
    createInMemorySandbox,
    createInitialState,
    createOAuthReturnClient,
    installEarlyGuard,
    isReviewerMode,
    isSafeSyntheticPermalink,
    localHostname,
    mountReviewerApp,
    normalizeState,
    readCanonicalLoginHandoff,
    recoverReviewerAuthenticationFrom401,
    reduceReviewerAuthenticationAfterError,
    resolveApiBase,
    reviewerHostnameAllowed,
    sanitizeCanonicalLoginHandoffUrl,
    sanitizeCallbackUrl,
    transitionState
  });
});
