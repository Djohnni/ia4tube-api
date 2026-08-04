"use strict";

const crypto = require("node:crypto");
const {
  CONNECTOR_CAPABILITIES
} = require("../../src/social/connectors/contract");
const {
  BLOCKING_CONNECTION_STATES
} = require("../../src/social/connectors/service");
const {
  connectorFail
} = require("../../src/social/connectors/errors");

const FORBIDDEN_SECRET_FIELDS = new Set([
  "accessToken",
  "authorizationHeader",
  "ciphertext",
  "clientSecret",
  "credential",
  "oauthCode",
  "refreshToken",
  "token"
]);
const SAFE_AUTHORIZATION_FIELDS = new Set(["authorizationHandle"]);

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function assertSyntheticInput(value, visited = new Set()) {
  if (!value || typeof value !== "object") return;
  if (visited.has(value)) connectorFail("connector_contract_invalid");
  visited.add(value);
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
    if (
      !SAFE_AUTHORIZATION_FIELDS.has(key) &&
      (
        FORBIDDEN_SECRET_FIELDS.has(key) ||
        /(token|secret|authorization|credential|password|ciphertext|oauthcode|apikey)/
          .test(normalizedKey)
      )
    ) {
      connectorFail("connector_contract_invalid");
    }
    assertSyntheticInput(item, visited);
  }
  visited.delete(value);
}

function requireTestContext(context) {
  if (context?.environment !== "test" || context?.provider !== "instagram") {
    connectorFail("synthetic_connector_forbidden");
  }
}

function take(sequence, fallback) {
  if (!sequence.length) return copy(fallback);
  return copy(sequence.shift());
}

function createFakeSocialConnector(options = {}) {
  const capabilities = options.capabilities || CONNECTOR_CAPABILITIES;
  const authorizationOutcome = options.authorizationOutcome || "approved";
  const accountType = options.accountType || "business";
  const publishSequence = copy(options.publishSequence || [{
    outcome: "published",
    confirmedProviderReference: "synthetic-published-reference-001"
  }]);
  const statusSequence = copy(options.statusSequence || [{
    outcome: "published",
    confirmedProviderReference: "synthetic-published-reference-001"
  }]);
  const disconnectOutcome = options.disconnectOutcome || "disconnected";
  const mintedAuthorizationHandles = new Map();
  const calls = [];
  function record(capability, context, input) {
    requireTestContext(context);
    assertSyntheticInput(input);
    calls.push(Object.freeze({
      capability,
      companyId: context.companyId,
      correlationId: context.correlationId
    }));
  }

  async function beginAuthorization(context, input) {
    record("beginAuthorization", context, input);
    if (options.beginThrows) throw options.beginThrows;
    const handle = crypto.randomUUID();
    mintedAuthorizationHandles.set(handle, Object.freeze({
      companyId: context.companyId,
      connectionId: input.connectionId
    }));
    return {
      state: "authorization_pending",
      authorizationHandle: handle
    };
  }

  async function discoverAccount(context, input) {
    record("discoverAccount", context, input);
    const authorization = mintedAuthorizationHandles.get(
      input.authorizationHandle
    );
    if (
      !authorization ||
      authorization.companyId !== context.companyId ||
      authorization.connectionId !== input.connectionId
    ) {
      connectorFail("authorization_expired");
    }
    if (authorizationOutcome === "cancelled") {
      connectorFail("authorization_cancelled");
    }
    if (authorizationOutcome === "expired") {
      connectorFail("authorization_expired");
    }
    if (options.discoverThrows) throw options.discoverThrows;
    return {
      account: {
        externalId: options.externalId || "synthetic-external-account-001",
        username: options.username || "synthetic_company",
        displayName: options.displayName || "Synthetic Company",
        accountType: authorizationOutcome === "personal"
          ? "personal"
          : accountType
      }
    };
  }

  async function publishImage(context, input) {
    record("publishImage", context, input);
    if (options.publishThrows) throw options.publishThrows;
    return take(publishSequence, {
      outcome: "provider_confirming",
      reconciliationReference: "synthetic-reconciliation-reference-001"
    });
  }

  async function getPublicationStatus(context, input) {
    record("getPublicationStatus", context, input);
    if (options.statusThrows) throw options.statusThrows;
    return take(statusSequence, {
      outcome: "provider_confirming",
      reconciliationReference: input.providerReference
    });
  }

  async function disconnect(context, input) {
    record("disconnect", context, input);
    if (options.disconnectThrows) throw options.disconnectThrows;
    return { outcome: disconnectOutcome };
  }

  return Object.freeze({
    provider: "instagram",
    capabilities: Object.freeze([...capabilities]),
    external: false,
    synthetic: true,
    testOnly: true,
    beginAuthorization,
    discoverAccount,
    publishImage,
    getPublicationStatus,
    disconnect,
    callCount(capability) {
      return calls.filter((item) => item.capability === capability).length;
    },
    calls() {
      return Object.freeze([...calls]);
    }
  });
}

function createSyntheticSocialStore() {
  const tenants = new Map();

  function tenant(companyId) {
    if (!tenants.has(companyId)) {
      tenants.set(companyId, {
        connections: new Map(),
        publications: new Map(),
        idempotency: new Map(),
        history: [],
        exclusiveTail: Promise.resolve()
      });
    }
    return tenants.get(companyId);
  }

  function scope(context) {
    const data = tenant(context.companyId);
    return Object.freeze({
      async getConnection(id) {
        return copy(data.connections.get(id) || null);
      },
      async findBlockingConnection(provider, excludeConnectionId) {
        for (const record of data.connections.values()) {
          if (
            record.provider === provider &&
            record.id !== excludeConnectionId &&
            BLOCKING_CONNECTION_STATES.has(record.state) &&
            (record.state !== "failed" || record.account)
          ) {
            return copy(record);
          }
        }
        return null;
      },
      async saveConnection(record, expectedRevision) {
        const current = data.connections.get(record.id) || null;
        if (
          expectedRevision === null
            ? current !== null
            : !current || current.revision !== expectedRevision
        ) {
          connectorFail("state_transition_invalid");
        }
        data.connections.set(record.id, copy(record));
        data.history.push({ kind: "connection", record: copy(record) });
        return copy(record);
      },
      async activateConnectionFromAuthorization(
        record,
        expectedRevision,
        authorizationHandle
      ) {
        if (typeof authorizationHandle !== "string") {
          connectorFail("connector_contract_invalid");
        }
        const current = data.connections.get(record.id) || null;
        if (
          !current ||
          current.revision !== expectedRevision ||
          current.state !== "authorization_pending" ||
          record.state !== "connected" ||
          !record.account
        ) {
          connectorFail("state_transition_invalid");
        }
        data.connections.set(record.id, copy(record));
        data.history.push({
          kind: "connection_activation",
          record: copy(record)
        });
        return copy(record);
      },
      async ensureDisconnected(id) {
        const current = data.connections.get(id) || null;
        if (!current || current.state !== "disconnected") {
          connectorFail("state_transition_invalid");
        }
        const clean = { ...copy(current), account: null };
        data.connections.set(id, clean);
        data.history.push({ kind: "connection_cleanup", record: copy(clean) });
        return copy(clean);
      },
      async getPublication(id) {
        return copy(data.publications.get(id) || null);
      },
      async savePublication(record, expectedRevision) {
        const current = data.publications.get(record.id) || null;
        if (
          expectedRevision === null
            ? current !== null
            : !current || current.revision !== expectedRevision
        ) {
          connectorFail("state_transition_invalid");
        }
        data.publications.set(record.id, copy(record));
        data.history.push({ kind: "publication", record: copy(record) });
        return copy(record);
      },
      async beginIdempotency(record) {
        const key = `${record.capability}:${record.operationId}`;
        const existing = data.idempotency.get(key);
        if (existing) {
          if (existing.digest !== record.digest) {
            connectorFail("idempotency_conflict");
          }
          return existing.status === "completed"
            ? copy({
              status: "completed",
              result: existing.result,
              errorCode: existing.errorCode
            })
            : { status: "pending" };
        }
        data.idempotency.set(key, {
          ...copy(record),
          status: "pending",
          result: null,
          errorCode: null
        });
        if (
          record.capability === "publishImage" &&
          record.payload &&
          !data.publications.has(record.payload.publicationId)
        ) {
          data.publications.set(record.payload.publicationId, {
            companyId: context.companyId,
            id: record.payload.publicationId,
            connectionId: record.payload.connectionId,
            provider: context.provider,
            state: "ready",
            confirmedProviderReference: null,
            reconciliationReference: null,
            revision: 1
          });
        }
        return { status: "acquired" };
      },
      async completeIdempotency(record) {
        const key = `${record.capability}:${record.operationId}`;
        const existing = data.idempotency.get(key);
        if (
          !existing ||
          existing.status !== "pending" ||
          existing.digest !== record.digest
        ) {
          connectorFail("idempotency_conflict");
        }
        data.idempotency.set(key, {
          ...copy(record),
          status: "completed"
        });
      },
      async runExclusive(operation) {
        if (typeof operation !== "function") {
          connectorFail("connector_contract_invalid");
        }
        const previous = data.exclusiveTail;
        let release;
        data.exclusiveTail = new Promise((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await operation(this);
        } finally {
          release();
        }
      }
    });
  }

  function seedConnection(context, record) {
    tenant(context.companyId).connections.set(record.id, copy(record));
  }

  function seedPublication(context, record) {
    tenant(context.companyId).publications.set(record.id, copy(record));
  }

  function seedIdempotency(context, record) {
    tenant(context.companyId).idempotency.set(
      `${record.capability}:${record.operationId}`,
      copy({ ...record, status: "completed" })
    );
  }

  function snapshot(context) {
    const data = tenant(context.companyId);
    return copy({
      connections: [...data.connections.values()],
      publications: [...data.publications.values()],
      history: data.history,
      idempotencyCount: data.idempotency.size
    });
  }

  return Object.freeze({
    scope,
    seedConnection,
    seedIdempotency,
    seedPublication,
    snapshot
  });
}

function createSyntheticAudit() {
  const events = [];
  return Object.freeze({
    async append(_context, event) {
      events.push(copy(event));
    },
    events() {
      return copy(events);
    }
  });
}

function createSyntheticMediaAuthority() {
  const owned = new Map();
  function key(context, mediaId) {
    return `${context.companyId}:${mediaId}`;
  }
  return Object.freeze({
    authorize(context, mediaId) {
      owned.set(key(context, mediaId), Object.freeze({
        companyId: context.companyId,
        mediaId,
        mimeType: "image/jpeg"
      }));
    },
    async resolveOwnedJpeg(context, mediaId) {
      return copy(owned.get(key(context, mediaId)) || null);
    }
  });
}

module.exports = {
  createFakeSocialConnector,
  createSyntheticAudit,
  createSyntheticMediaAuthority,
  createSyntheticSocialStore
};
