"use strict";

const crypto = require("node:crypto");
const express = require("express");

const { requireTenantContext } = require("../../security/tenant-context");

const PROFESSIONAL_ACCOUNT_TYPES = new Set(["BUSINESS", "CREATOR"]);
const REVIEWER_PURPOSE = "app_review";
const REVIEWER_ASSET = "controlled-review-jpeg";
const GATE5A_REVIEWER_CLIENT_REQUEST_ID =
  "gate5a-reviewer-manual-publish-v1";
const CLIENT_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
const PUBLICATION_ID_PATTERN = /^synthetic-publication-[0-9a-f-]{36}$/;
const CONFIRMATION_CODE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const REVIEWER_CONTENT_REFERENCE_PATTERN =
  /^gate5a-content:[0-9a-f]{64}:[0-9a-f]{32}$/;

class ReviewerSandboxError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "ReviewerSandboxError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status = 400, message = "Operacao de demonstracao recusada.") {
  throw new ReviewerSandboxError(code, status, message);
}

function exactRecord(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail("reviewer_request_invalid");
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail("reviewer_request_invalid");
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeNow(clock) {
  const value = new Date(clock());
  if (Number.isNaN(value.getTime())) {
    fail("reviewer_clock_invalid", 503);
  }
  return value.toISOString();
}

function safeUuid(randomUUID) {
  const value = String(randomUUID());
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail("reviewer_identifier_invalid", 503);
  }
  return value.toLowerCase();
}

function tenantKey(context) {
  return `${context.tenantId}\u0000${context.principalId}`;
}

function initialState() {
  return {
    sandbox: true,
    externalCalls: 0,
    tenantBound: true,
    company: {
      label: "Empresa autenticada",
      controlled: true
    },
    stage: "welcome",
    authorization: {
      status: "not_started",
      callbackSanitized: false
    },
    connection: {
      status: "not_connected",
      account: null,
      error: null,
      tokenPhysicallyDeleted: false
    },
    media: {
      selected: false,
      item: null
    },
    publication: {
      state: "idle",
      attempts: 0,
      details: null
    },
    history: [],
    deletion: {
      status: "not_requested",
      requestStatus: null,
      confirmationCode: null,
      statusUrl: null,
      technicalConnectionDataDeleted: false,
      commercialHistoryPolicy: "owner_decision_pending"
    },
    delayedContentBlocked: true
  };
}

function publicState(record) {
  const result = clone(record.state);
  result.sandbox = true;
  result.externalCalls = 0;
  return result;
}

function response(record, extra = {}) {
  return Object.freeze({
    ok: true,
    sandbox: true,
    externalCalls: 0,
    ...extra,
    state: publicState(record)
  });
}

function createReviewerSandboxService(options = {}) {
  const clock = options.clock || Date.now;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const publicOrigin = String(options.publicOrigin || "").replace(/\/$/, "");
  const controlledAssetPath = String(options.controlledAssetPath || "");
  const persistentConnection = options.persistentConnection || null;
  const persistentHistory = Boolean(
    persistentConnection &&
    typeof persistentConnection.readPublicationHistory === "function" &&
    typeof persistentConnection.publishPublication === "function" &&
    typeof persistentConnection.advancePublication === "function"
  );
  if (
    typeof clock !== "function" ||
    typeof randomUUID !== "function" ||
    !/^https?:\/\//.test(publicOrigin) ||
    !controlledAssetPath.startsWith("/") ||
    controlledAssetPath.includes("?") ||
    controlledAssetPath.includes("#") ||
    (
      persistentConnection !== null &&
      (
        typeof persistentConnection !== "object" ||
        typeof persistentConnection.read !== "function" ||
        typeof persistentConnection.disconnect !== "function" ||
        typeof persistentConnection.deleteConnectionData !== "function" ||
        ([
          persistentConnection.readPublicationHistory,
          persistentConnection.publishPublication,
          persistentConnection.advancePublication
        ].some((method) => typeof method === "function") &&
          !persistentHistory)
      )
    )
  ) {
    fail("reviewer_configuration_invalid", 503);
  }

  const records = new Map();

  function getRecord(context) {
    const key = tenantKey(context);
    let record = records.get(key);
    if (!record) {
      record = {
        state: initialState(),
        pendingAccountType: null,
        syntheticToken: null,
        clientRequestId: null
      };
      records.set(key, record);
    }
    return record;
  }

  function destroyToken(record) {
    if (Buffer.isBuffer(record.syntheticToken)) {
      record.syntheticToken.fill(0);
      record.syntheticToken = null;
      record.state.connection.tokenPhysicallyDeleted = true;
      return true;
    }
    record.state.connection.tokenPhysicallyDeleted = true;
    return false;
  }

  function updateHistory(record) {
    const details = record.state.publication.details;
    if (!details) return;
    const summary = {
      publicationId: details.publicationId,
      state: record.state.publication.state,
      attempts: record.state.publication.attempts,
      mediaId: details.mediaId,
      publishedAt: details.publishedAt,
      reference: details.reference,
      permalink: details.permalink,
      synthetic: true
    };
    const index = record.state.history.findIndex(
      (item) => item.publicationId === details.publicationId
    );
    if (index === -1) record.state.history.unshift(summary);
    else record.state.history[index] = summary;
  }

  function invalidateActivePublication(record) {
    const publication = record.state.publication;
    const details = publication.details;
    if (
      details &&
      ["sending", "provider_confirming"].includes(publication.state)
    ) {
      record.state.history = record.state.history.filter(
        (item) => item.publicationId !== details.publicationId
      );
    }
    record.clientRequestId = null;
    record.state.media = { selected: false, item: null };
    record.state.publication = { state: "idle", attempts: 0, details: null };
  }

  function read(context) {
    return response(getRecord(context));
  }

  function authorize(context, input) {
    const body = exactRecord(input, ["accountType", "purpose"]);
    if (
      !["BUSINESS", "CREATOR", "PERSONAL"].includes(body.accountType) ||
      body.purpose !== REVIEWER_PURPOSE
    ) {
      fail("reviewer_authorization_invalid");
    }
    const record = getRecord(context);
    if (record.state.authorization.status === "authorization_pending") {
      return response(record);
    }
    if (record.state.connection.status === "connected") {
      fail("reviewer_connection_already_active", 409);
    }
    record.pendingAccountType = body.accountType;
    record.state.stage = "oauth_authorization";
    record.state.authorization = {
      status: "authorization_pending",
      callbackSanitized: false
    };
    record.state.connection.error = null;
    record.state.deletion.status = "not_requested";
    return response(record);
  }

  function callback(context, input) {
    exactRecord(input, []);
    const record = getRecord(context);
    if (record.state.authorization.status !== "authorization_pending") {
      fail("reviewer_authorization_not_pending", 409);
    }
    const accountType = record.pendingAccountType;
    record.pendingAccountType = null;
    record.state.authorization.callbackSanitized = true;
    record.state.stage = "oauth_return";
    if (!PROFESSIONAL_ACCOUNT_TYPES.has(accountType)) {
      record.state.authorization.status = "authorization_failed";
      record.state.connection = {
        status: "rejected",
        account: null,
        error: {
          code: "professional_account_required",
          message: "Use uma conta profissional Business ou Creator."
        },
        tokenPhysicallyDeleted: true
      };
      fail(
        "professional_account_required",
        422,
        "Use uma conta profissional Business ou Creator."
      );
    }
    const accountId = safeUuid(randomUUID);
    destroyToken(record);
    record.syntheticToken = Buffer.from(
      `synthetic-review-token:${safeUuid(randomUUID)}`,
      "utf8"
    );
    record.state.authorization.status = "authorization_completed";
    record.state.connection = {
      status: "connected",
      account: {
        accountId: `synthetic-account-${accountId}`,
        username: accountType === "BUSINESS"
          ? "@empresa_sintetica"
          : "@creator_sintetico",
        accountType,
        professional: true,
        synthetic: true
      },
      error: null,
      tokenPhysicallyDeleted: false
    };
    return response(record);
  }

  function selectMedia(context, input) {
    const body = exactRecord(input, ["asset"]);
    if (body.asset !== REVIEWER_ASSET) fail("reviewer_media_invalid");
    const record = getRecord(context);
    if (record.state.connection.status !== "connected") {
      fail("reviewer_connection_required", 409);
    }
    record.state.stage = "media_review";
    record.state.media = {
      selected: true,
      item: {
        asset: REVIEWER_ASSET,
        fileName: "ia4tube-review-controlado.jpg",
        mimeType: "image/jpeg",
        width: 1080,
        height: 1080,
        assetPath: controlledAssetPath,
        caption: "Publicacao de demonstracao controlada da IA4Tube.",
        synthetic: true
      }
    };
    return response(record);
  }

  function publish(context, input) {
    const body = exactRecord(input, ["clientRequestId"]);
    if (
      typeof body.clientRequestId !== "string" ||
      !CLIENT_REQUEST_ID_PATTERN.test(body.clientRequestId)
    ) {
      fail("reviewer_idempotency_key_invalid");
    }
    const record = getRecord(context);
    if (record.state.connection.status !== "connected") {
      fail("reviewer_connection_required", 409);
    }
    if (!record.state.media.selected) fail("reviewer_media_required", 409);
    if (record.clientRequestId !== null) {
      if (record.clientRequestId !== body.clientRequestId) {
        fail("reviewer_idempotency_conflict", 409);
      }
      return response(record, { idempotentReplay: true });
    }
    const publicationId = `synthetic-publication-${safeUuid(randomUUID)}`;
    record.clientRequestId = body.clientRequestId;
    record.state.stage = "publication_sending";
    record.state.publication = {
      state: "sending",
      attempts: 1,
      details: {
        publicationId,
        mediaId: null,
        publishedAt: null,
        reference: null,
        permalink: null,
        synthetic: true
      }
    };
    updateHistory(record);
    return response(record, { idempotentReplay: false });
  }

  function advance(context, publicationId, input) {
    exactRecord(input, []);
    if (!PUBLICATION_ID_PATTERN.test(String(publicationId || ""))) {
      fail("reviewer_publication_not_found", 404);
    }
    const record = getRecord(context);
    const details = record.state.publication.details;
    if (!details || details.publicationId !== publicationId) {
      fail("reviewer_publication_not_found", 404);
    }
    if (record.state.connection.status !== "connected") {
      fail("reviewer_connection_required", 409);
    }
    if (record.state.publication.state === "sending") {
      record.state.publication.state = "provider_confirming";
      record.state.stage = "publication_confirming";
    } else if (record.state.publication.state === "provider_confirming") {
      const publishedAt = safeNow(clock);
      const mediaUuid = safeUuid(randomUUID);
      record.state.publication.state = "published";
      record.state.stage = "publication_published";
      record.state.publication.details = {
        ...details,
        mediaId: `synthetic-media-${mediaUuid}`,
        publishedAt,
        reference: `synthetic-review:${mediaUuid}`,
        permalink: `${publicOrigin}/app.html?review=instagram-publishing&publication=${encodeURIComponent(publicationId)}`,
        synthetic: true
      };
    }
    updateHistory(record);
    return response(record);
  }

  function listPublications(context) {
    const record = getRecord(context);
    return response(record, { publications: clone(record.state.history) });
  }

  function getPublication(context, publicationId) {
    if (!PUBLICATION_ID_PATTERN.test(String(publicationId || ""))) {
      fail("reviewer_publication_not_found", 404);
    }
    const record = getRecord(context);
    const publication = record.state.history.find(
      (item) => item.publicationId === publicationId
    );
    if (!publication) fail("reviewer_publication_not_found", 404);
    return response(record, { publication: clone(publication) });
  }

  function disconnect(context) {
    const record = getRecord(context);
    destroyToken(record);
    invalidateActivePublication(record);
    record.pendingAccountType = null;
    record.state.stage = "connection_disconnected";
    record.state.authorization.status = "not_started";
    record.state.connection.status = "disconnected";
    record.state.connection.account = null;
    record.state.connection.error = null;
    record.state.delayedContentBlocked = true;
    return response(record);
  }

  function deleteConnectionData(context, input) {
    const body = exactRecord(input, ["confirm"]);
    if (body.confirm !== true) fail("reviewer_deletion_confirmation_required");
    const record = getRecord(context);
    destroyToken(record);
    record.pendingAccountType = null;
    record.clientRequestId = null;
    record.state.stage = "data_deletion_completed";
    record.state.authorization = {
      status: "not_started",
      callbackSanitized: true
    };
    record.state.connection.status = "deleted";
    record.state.connection.account = null;
    record.state.connection.error = null;
    record.state.media = { selected: false, item: null };
    record.state.publication = { state: "idle", attempts: 0, details: null };
    record.state.deletion = {
      status: "completed",
      requestStatus: null,
      confirmationCode: null,
      statusUrl: null,
      technicalConnectionDataDeleted: true,
      commercialHistoryPolicy: "owner_decision_pending"
    };
    return response(record);
  }

  function reset(context, input) {
    const body = exactRecord(input, ["confirm"]);
    if (body.confirm !== true) fail("reviewer_reset_confirmation_required");
    const key = tenantKey(context);
    const previous = records.get(key);
    if (previous) destroyToken(previous);
    records.delete(key);
    return response(getRecord(context));
  }

  const memoryService = Object.freeze({
    advance,
    authorize,
    callback,
    deleteConnectionData,
    disconnect,
    getPublication,
    listPublications,
    publish,
    read,
    reset,
    selectMedia
  });
  if (!persistentConnection) return memoryService;

  function persistentState(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !["connected", "disconnected", "deleted"].includes(value.status) ||
      typeof value.tokenPhysicallyDeleted !== "boolean"
    ) {
      fail("reviewer_persistent_connection_invalid", 503);
    }
    if (value.status === "connected") {
      const account = value.account;
      if (
        value.tokenPhysicallyDeleted !== false ||
        !account ||
        typeof account !== "object" ||
        account.synthetic !== true ||
        account.professional !== true ||
        !PROFESSIONAL_ACCOUNT_TYPES.has(account.accountType) ||
        typeof account.accountId !== "string" ||
        !account.accountId.startsWith("synthetic-") ||
        typeof account.username !== "string" ||
        !/^@[a-z0-9_](?:[a-z0-9_.]{0,28}[a-z0-9_])?$/.test(
          account.username
        )
      ) {
        fail("reviewer_persistent_connection_invalid", 503);
      }
      return Object.freeze({
        status: "connected",
        account: Object.freeze({
          accountId: account.accountId,
          username: account.username,
          accountType: account.accountType,
          professional: true,
          synthetic: true
        }),
        tokenPhysicallyDeleted: false
      });
    }
    if (
      value.account !== null ||
      value.tokenPhysicallyDeleted !== (value.status === "deleted")
    ) {
      fail("reviewer_persistent_connection_invalid", 503);
    }
    let deletion = null;
    if (value.status === "deleted" && value.deletion !== undefined) {
      const source = value.deletion;
      if (
        !source ||
        typeof source !== "object" ||
        Array.isArray(source) ||
        Object.getPrototypeOf(source) !== Object.prototype ||
        Object.keys(source).sort().join(",") !==
          "confirmationCode,status,statusUrl" ||
        source.status !== "completed" ||
        !CONFIRMATION_CODE_PATTERN.test(
          String(source.confirmationCode || "")
        )
      ) {
        fail("reviewer_persistent_connection_invalid", 503);
      }
      const canonicalStatusUrl = `${publicOrigin}/v1/social/compliance/meta/` +
        `data-deletion/status/${encodeURIComponent(source.confirmationCode)}`;
      if (source.statusUrl !== canonicalStatusUrl) {
        fail("reviewer_persistent_connection_invalid", 503);
      }
      deletion = Object.freeze({
        confirmationCode: source.confirmationCode,
        status: "completed",
        statusUrl: canonicalStatusUrl
      });
    } else if (value.status === "deleted" && persistentHistory) {
      fail("reviewer_persistent_connection_invalid", 503);
    } else if (value.deletion !== undefined) {
      fail("reviewer_persistent_connection_invalid", 503);
    }
    return Object.freeze({
      status: value.status,
      account: null,
      tokenPhysicallyDeleted: value.tokenPhysicallyDeleted,
      deletion
    });
  }

  function applyPersistentState(record, value) {
    if (record.syntheticToken !== null) {
      fail("reviewer_memory_fallback_forbidden", 503);
    }
    const state = persistentState(value);
    record.pendingAccountType = null;
    record.state.connection = {
      status: state.status,
      account: state.account,
      error: null,
      tokenPhysicallyDeleted: state.tokenPhysicallyDeleted
    };
    if (state.status === "connected") {
      record.state.deletion = {
        status: "not_requested",
        requestStatus: null,
        confirmationCode: null,
        statusUrl: null,
        technicalConnectionDataDeleted: false,
        commercialHistoryPolicy: "owner_decision_pending"
      };
      return record;
    }
    invalidateActivePublication(record);
    record.state.authorization = {
      status: "not_started",
      callbackSanitized: true
    };
    record.state.delayedContentBlocked = true;
    if (state.status === "deleted") {
      record.state.stage = "data_deletion_completed";
      record.state.deletion = {
        status: "completed",
        requestStatus: state.deletion?.status || null,
        confirmationCode: state.deletion?.confirmationCode || null,
        statusUrl: state.deletion?.statusUrl || null,
        technicalConnectionDataDeleted: true,
        commercialHistoryPolicy: "owner_decision_pending"
      };
    } else {
      record.state.stage = "connection_disconnected";
      record.state.deletion = {
        status: "not_requested",
        requestStatus: null,
        confirmationCode: null,
        statusUrl: null,
        technicalConnectionDataDeleted: false,
        commercialHistoryPolicy: "owner_decision_pending"
      };
    }
    return record;
  }

  function persistentPublication(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(",") !== [
        "attempts",
        "mediaId",
        "permalink",
        "publicationId",
        "publishedAt",
        "reference",
        "state",
        "synthetic"
      ].join(",") ||
      value.synthetic !== true ||
      !PUBLICATION_ID_PATTERN.test(String(value.publicationId || "")) ||
      !["sending", "provider_confirming", "published"].includes(
        value.state
      ) ||
      !Number.isInteger(value.attempts) ||
      value.attempts < 0 ||
      value.attempts > 1
    ) {
      fail("reviewer_persistent_history_invalid", 503);
    }
    if (value.state !== "published") {
      if (
        value.mediaId !== null ||
        value.publishedAt !== null ||
        value.reference !== null ||
        value.permalink !== null
      ) {
        fail("reviewer_persistent_history_invalid", 503);
      }
      return Object.freeze({ ...value });
    }
    const publishedTime = typeof value.publishedAt === "string"
      ? Date.parse(value.publishedAt)
      : Number.NaN;
    if (
      value.attempts !== 1 ||
      !/^synthetic-media-[0-9a-f-]{36}$/.test(String(value.mediaId || "")) ||
      !/^synthetic-review:[0-9a-f-]{36}$/.test(
        String(value.reference || "")
      ) ||
      !Number.isFinite(publishedTime) ||
      new Date(value.publishedAt).toISOString() !== value.publishedAt
    ) {
      fail("reviewer_persistent_history_invalid", 503);
    }
    const canonicalPermalink = `${publicOrigin}/app.html?` +
      "review=instagram-publishing&publication=" +
      encodeURIComponent(value.publicationId);
    if (value.permalink !== canonicalPermalink) {
      fail("reviewer_persistent_history_invalid", 503);
    }
    return Object.freeze({ ...value });
  }

  function persistentPublicationContent(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(",") !== "caption,mediaReference" ||
      !REVIEWER_CONTENT_REFERENCE_PATTERN.test(
        String(value.mediaReference || "")
      ) ||
      typeof value.caption !== "string" ||
      value.caption.length < 1 ||
      value.caption.length > 2200 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.caption)
    ) {
      fail("reviewer_persistent_history_content_invalid", 503);
    }
    return Object.freeze({
      caption: value.caption,
      mediaReference: value.mediaReference
    });
  }

  function applyPersistentHistory(record, value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.hasOwn(value, "publication") ||
      !Array.isArray(value.publications) ||
      value.publications.length > 1
    ) {
      fail("reviewer_persistent_history_invalid", 503);
    }
    const active = value.publication === null
      ? null
      : persistentPublication(value.publication);
    const publications = value.publications.map(persistentPublication);
    if (
      publications.some((item) => item.state !== "published") ||
      (publications.length === 1 &&
        active?.publicationId !== publications[0].publicationId)
    ) {
      fail("reviewer_persistent_history_invalid", 503);
    }
    record.state.history = publications.map((item) => ({ ...item }));
    record.clientRequestId = active ? GATE5A_REVIEWER_CLIENT_REQUEST_ID : null;
    if (record.state.connection.status === "connected" && active) {
      record.state.publication = {
        state: active.state,
        attempts: active.attempts,
        details: {
          publicationId: active.publicationId,
          mediaId: active.mediaId,
          publishedAt: active.publishedAt,
          reference: active.reference,
          permalink: active.permalink,
          synthetic: true
        }
      };
      record.state.stage = active.state === "sending"
        ? "publication_sending"
        : active.state === "provider_confirming"
          ? "publication_confirming"
          : "publication_published";
    } else {
      record.state.publication = { state: "idle", attempts: 0, details: null };
    }
    return record;
  }

  async function synchronize(context) {
    const resolved = await persistentConnection.read(context);
    const record = applyPersistentState(getRecord(context), resolved);
    if (persistentHistory) {
      applyPersistentHistory(
        record,
        await persistentConnection.readPublicationHistory(context)
      );
    }
    return record;
  }

  async function requireConnectedRecord(context) {
    const record = await synchronize(context);
    if (record.state.connection.status !== "connected") {
      fail("reviewer_connection_required", 409);
    }
    return record;
  }

  async function requireReviewReadyRecord(context) {
    const record = await requireConnectedRecord(context);
    if (record.state.authorization.status !== "authorization_completed") {
      fail("reviewer_authorization_not_completed", 409);
    }
    return record;
  }

  return Object.freeze({
    async read(context) {
      return response(await synchronize(context));
    },
    async authorize(context, input) {
      const body = exactRecord(input, ["accountType", "purpose"]);
      if (
        !["BUSINESS", "CREATOR", "PERSONAL"].includes(body.accountType) ||
        body.purpose !== REVIEWER_PURPOSE
      ) {
        fail("reviewer_authorization_invalid");
      }
      const record = await requireConnectedRecord(context);
      if (body.accountType !== record.state.connection.account.accountType) {
        fail("reviewer_authorization_invalid");
      }
      if (record.state.authorization.status === "authorization_pending") {
        return response(record);
      }
      record.state.stage = "oauth_authorization";
      record.state.authorization = {
        status: "authorization_pending",
        callbackSanitized: false
      };
      return response(record);
    },
    async callback(context, input) {
      exactRecord(input, []);
      const record = await requireConnectedRecord(context);
      if (record.state.authorization.status !== "authorization_pending") {
        fail("reviewer_authorization_not_pending", 409);
      }
      record.state.stage = "oauth_return";
      record.state.authorization = {
        status: "authorization_completed",
        callbackSanitized: true
      };
      return response(record);
    },
    async selectMedia(context, input) {
      await requireReviewReadyRecord(context);
      return memoryService.selectMedia(context, input);
    },
    async publish(context, input, trustedContent) {
      const record = await requireReviewReadyRecord(context);
      const memoryResult = memoryService.publish(context, input);
      if (!persistentHistory) return memoryResult;
      const content = persistentPublicationContent(trustedContent);
      const persisted = await persistentConnection.publishPublication(
        context,
        { clientRequestId: input.clientRequestId },
        content
      );
      applyPersistentHistory(record, persisted);
      if (typeof persisted.idempotentReplay !== "boolean") {
        fail("reviewer_persistent_history_invalid", 503);
      }
      return response(record, {
        idempotentReplay: persisted.idempotentReplay
      });
    },
    async advance(context, publicationId, input) {
      exactRecord(input, []);
      const record = await requireReviewReadyRecord(context);
      if (!persistentHistory) {
        return memoryService.advance(context, publicationId, input);
      }
      applyPersistentHistory(
        record,
        await persistentConnection.advancePublication(context, publicationId)
      );
      return response(record);
    },
    async listPublications(context) {
      const record = await synchronize(context);
      if (!persistentHistory) return memoryService.listPublications(context);
      return response(record, { publications: clone(record.state.history) });
    },
    async getPublication(context, publicationId) {
      if (!PUBLICATION_ID_PATTERN.test(String(publicationId || ""))) {
        fail("reviewer_publication_not_found", 404);
      }
      const record = await synchronize(context);
      if (!persistentHistory) {
        return memoryService.getPublication(context, publicationId);
      }
      const publication = record.state.history.find(
        (item) => item.publicationId === publicationId
      ) || (
        record.state.publication.details?.publicationId === publicationId
          ? {
              ...record.state.publication.details,
              state: record.state.publication.state,
              attempts: record.state.publication.attempts
            }
          : null
      );
      if (!publication) fail("reviewer_publication_not_found", 404);
      return response(record, { publication: clone(publication) });
    },
    async disconnect(context) {
      await requireConnectedRecord(context);
      const resolved = await persistentConnection.disconnect(context);
      const record = applyPersistentState(getRecord(context), resolved);
      if (
        record.state.connection.status !== "disconnected" ||
        record.state.connection.tokenPhysicallyDeleted !== false
      ) {
        fail("reviewer_persistent_disconnect_unconfirmed", 503);
      }
      return response(record);
    },
    async deleteConnectionData(context, input) {
      const body = exactRecord(input, ["confirm"]);
      if (body.confirm !== true) {
        fail("reviewer_deletion_confirmation_required");
      }
      await synchronize(context);
      const resolved = await persistentConnection.deleteConnectionData(
        context
      );
      const record = applyPersistentState(getRecord(context), resolved);
      if (
        record.state.connection.status !== "deleted" ||
        record.state.connection.tokenPhysicallyDeleted !== true ||
        record.state.deletion.technicalConnectionDataDeleted !== true
      ) {
        fail("reviewer_persistent_deletion_unconfirmed", 503);
      }
      return response(record);
    },
    async reset(context, input) {
      const body = exactRecord(input, ["confirm"]);
      if (body.confirm !== true) {
        fail("reviewer_reset_confirmation_required");
      }
      await synchronize(context);
      fail("reviewer_persistent_reset_forbidden", 409);
    }
  });
}

function sendError(res, error, state = null) {
  const known = error instanceof ReviewerSandboxError;
  return res.status(known ? error.status : 503).json({
    ok: false,
    sandbox: true,
    externalCalls: 0,
    error: {
      code: known ? error.code : "reviewer_sandbox_unavailable",
      message: known ? error.message : "Demonstracao temporariamente indisponivel."
    },
    ...(state ? { state } : {})
  });
}

function createReviewerSandboxRouter(options = {}) {
  if (
    typeof options.authenticate !== "function" ||
    !options.service ||
    typeof options.service.read !== "function"
  ) {
    fail("reviewer_configuration_invalid", 503);
  }
  const router = options.router || express.Router();
  const enabled = options.enabled === true;
  const contextFromRequest = options.contextFromRequest || requireTenantContext;
  if (typeof contextFromRequest !== "function") {
    fail("reviewer_configuration_invalid", 503);
  }

  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    if (!enabled) return res.status(404).end();
    return next();
  });
  router.use(options.authenticate);

  function context(req) {
    return contextFromRequest(req);
  }

  function route(handler) {
    return async (req, res) => {
      let current = null;
      try {
        const result = await handler(context(req), req);
        return res.status(200).json(result);
      } catch (error) {
        try {
          current = (await options.service.read(context(req))).state;
        } catch {
          current = null;
        }
        return sendError(res, error, current);
      }
    };
  }

  router.get("/state", route((ctx) => options.service.read(ctx)));
  router.post("/authorization", route((ctx, req) => options.service.authorize(ctx, req.body)));
  router.post("/authorization/callback", route((ctx, req) => options.service.callback(ctx, req.body)));
  router.post("/media", route((ctx, req) => options.service.selectMedia(ctx, req.body)));
  router.post("/publications", route((ctx, req) => options.service.publish(ctx, req.body)));
  router.post("/publications/:publicationId/advance", route((ctx, req) => (
    options.service.advance(ctx, req.params.publicationId, req.body)
  )));
  router.get("/publications", route((ctx) => options.service.listPublications(ctx)));
  router.get("/publications/:publicationId", route((ctx, req) => (
    options.service.getPublication(ctx, req.params.publicationId)
  )));
  router.delete("/connection", route((ctx) => options.service.disconnect(ctx)));
  router.post("/data-deletion", route((ctx, req) => options.service.deleteConnectionData(ctx, req.body)));
  router.post("/reset", route((ctx, req) => options.service.reset(ctx, req.body)));

  return router;
}

module.exports = {
  REVIEWER_ASSET,
  REVIEWER_PURPOSE,
  ReviewerSandboxError,
  createReviewerSandboxRouter,
  createReviewerSandboxService
};
