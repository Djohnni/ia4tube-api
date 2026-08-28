"use strict";

const express = require("express");
const { PUBLICATION_STATES } = require("../connectors/states");
const {
  CONTROLLED_GATE4_JPEG_SHA256
} = require("./controlled-gate4-jpeg");
const { canonicalPermalink } = require("./instagram-publication-connector");

const PUBLICATION_ERROR_STATUS = Object.freeze({
  connector_contract_invalid: 503,
  credential_unavailable: 503,
  external_capability_disabled: 503,
  idempotency_conflict: 409,
  permission_missing: 403,
  provider_permanent_failure: 502,
  provider_result_unknown: 502,
  provider_temporary_failure: 503,
  resource_unavailable: 404,
  social_authenticated_principal_invalid: 401,
  social_context_invalid: 403,
  state_transition_invalid: 409
});

function routeFail(code = "connector_contract_invalid") {
  const error = new Error("Publicação Instagram indisponível.");
  error.code = code;
  throw error;
}

function isRecord(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function exactRecord(value, keys) {
  if (!isRecord(value)) routeFail();
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    routeFail();
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) routeFail();
  }
  return value;
}

function emptyRecord(value) {
  return value == null || (isRecord(value) && Object.keys(value).length === 0);
}

function assertEmptyRequest(req) {
  if (
    !emptyRecord(req?.params) ||
    !emptyRecord(req?.query) ||
    !emptyRecord(req?.body)
  ) {
    routeFail("social_context_invalid");
  }
  if (!isRecord(req?.user)) {
    routeFail("social_authenticated_principal_invalid");
  }
  return req.user;
}

function isoDate(value, optional = false) {
  if (optional && value === null) return null;
  if (typeof value !== "string") routeFail();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    routeFail();
  }
  return value;
}

function uuid(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(value)
  ) {
    routeFail();
  }
  return value;
}

function normalizeAttempt(value) {
  const source = exactRecord(value, [
    "attemptNumber",
    "state",
    "errorCode",
    "providerReference",
    "startedAt",
    "finishedAt",
    "durationMs"
  ]);
  if (
    !Number.isSafeInteger(source.attemptNumber) ||
    source.attemptNumber < 1 ||
    !["started", "provider_confirming", "published", "failed_temporary",
      "failed_permanent"].includes(source.state) ||
    !(source.errorCode === null ||
      /^[a-z][a-z0-9_]{0,99}$/.test(source.errorCode)) ||
    !(source.providerReference === null ||
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/.test(source.providerReference)) ||
    !(source.durationMs === null ||
      (Number.isSafeInteger(source.durationMs) && source.durationMs >= 0))
  ) {
    routeFail();
  }
  return Object.freeze({
    attemptNumber: source.attemptNumber,
    state: source.state,
    errorCode: source.errorCode,
    providerReference: source.providerReference,
    startedAt: isoDate(source.startedAt),
    finishedAt: isoDate(source.finishedAt, true),
    durationMs: source.durationMs
  });
}

function normalizePublication(value) {
  if (value === null) return null;
  const source = exactRecord(value, [
    "publicationId",
    "connectionId",
    "internalReference",
    "state",
    "providerMediaId",
    "permalink",
    "publishedAt",
    "createdAt",
    "updatedAt",
    "revision",
    "attempts"
  ]);
  if (
    !PUBLICATION_STATES.includes(source.state) ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 1 ||
    !Array.isArray(source.attempts) ||
    source.attempts.length > 20
  ) {
    routeFail();
  }
  const publicationId = uuid(source.publicationId);
  if (source.internalReference !== publicationId) routeFail();
  const published = source.state === "published";
  if (
    published
      ? !/^[0-9]{5,64}$/.test(source.providerMediaId || "") ||
        canonicalPermalink(source.permalink) !== source.permalink ||
        source.publishedAt === null
      : source.providerMediaId !== null ||
        source.permalink !== null ||
        source.publishedAt !== null
  ) {
    routeFail();
  }
  return Object.freeze({
    publicationId,
    connectionId: uuid(source.connectionId),
    internalReference: publicationId,
    state: source.state,
    providerMediaId: source.providerMediaId,
    permalink: source.permalink,
    publishedAt: isoDate(source.publishedAt, true),
    createdAt: isoDate(source.createdAt),
    updatedAt: isoDate(source.updatedAt),
    revision: source.revision,
    attempts: Object.freeze(source.attempts.map(normalizeAttempt))
  });
}

function normalizeSummary(value) {
  const source = exactRecord(value, [
    "ok",
    "targetUsername",
    "controlledJpegSha256",
    "externalPublicationEnabled",
    "publicationCount",
    "publication"
  ]);
  if (
    source.ok !== true ||
    source.targetUsername !== "@ia4tube_empresas" ||
    source.controlledJpegSha256 !==
      CONTROLLED_GATE4_JPEG_SHA256.toUpperCase() ||
    typeof source.externalPublicationEnabled !== "boolean" ||
    !Number.isSafeInteger(source.publicationCount) ||
    source.publicationCount < 0
  ) {
    routeFail();
  }
  return Object.freeze({
    ok: true,
    targetUsername: "@ia4tube_empresas",
    controlledJpegSha256: source.controlledJpegSha256,
    externalPublicationEnabled: source.externalPublicationEnabled,
    publicationCount: source.publicationCount,
    publication: normalizePublication(source.publication)
  });
}

function noStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  return next();
}

function sendError(res, error) {
  const code = Object.hasOwn(PUBLICATION_ERROR_STATUS, error?.code)
    ? error.code
    : "connector_contract_invalid";
  return res.status(PUBLICATION_ERROR_STATUS[code]).json(Object.freeze({
    ok: false,
    code
  }));
}

function createInstagramPublicationRouter(options = {}) {
  if (
    typeof options.authenticate !== "function" ||
    typeof options.getService !== "function"
  ) {
    routeFail();
  }
  const router = options.router || express.Router();
  if (typeof router.get !== "function" || typeof router.post !== "function") {
    routeFail();
  }

  function service() {
    const value = options.getService();
    if (
      !value ||
      typeof value.arm !== "function" ||
      typeof value.getSummary !== "function" ||
      typeof value.publish !== "function" ||
      typeof value.reconcile !== "function"
    ) {
      routeFail("external_capability_disabled");
    }
    return value;
  }

  router.get(
    "/publications/instagram/gate4",
    noStore,
    options.authenticate,
    async (req, res) => {
      try {
        const result = normalizeSummary(await service().getSummary({
          verifiedClaims: assertEmptyRequest(req)
        }));
        return res.status(200).json(result);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.post(
    "/publications/instagram/gate4/arm",
    noStore,
    options.authenticate,
    async (req, res) => {
      try {
        const result = normalizeSummary(await service().arm({
          verifiedClaims: assertEmptyRequest(req)
        }));
        return res.status(200).json(result);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.post(
    "/publications/instagram/gate4",
    noStore,
    options.authenticate,
    async (req, res) => {
      try {
        const result = normalizeSummary(await service().publish({
          verifiedClaims: assertEmptyRequest(req)
        }));
        return res.status(result.publication?.state === "published" ? 201 : 202)
          .json(result);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.post(
    "/publications/instagram/gate4/reconcile",
    noStore,
    options.authenticate,
    async (req, res) => {
      try {
        const result = normalizeSummary(await service().reconcile({
          verifiedClaims: assertEmptyRequest(req)
        }));
        return res.status(result.publication?.state === "published" ? 200 : 202)
          .json(result);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  return router;
}

module.exports = {
  PUBLICATION_ERROR_STATUS,
  createInstagramPublicationRouter,
  normalizeSummary
};
