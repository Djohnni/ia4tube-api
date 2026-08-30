"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  META_COMPLIANCE_PATHS,
  createInMemoryMetaComplianceRepository,
  createMetaComplianceRouter,
  createMetaComplianceService,
  createMetaSignedRequestVerifier
} = require("../src/social/compliance");

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const ISSUED_AT = Math.floor(NOW / 1000);
const APP_SECRET = "gate5-test-app-secret-32-bytes-minimum";
const COMPANY_A = "10000000-0000-4000-8000-000000000001";
const USER_A = "10000000-0000-4000-8000-000000000002";
const CONNECTION_A = "10000000-0000-4000-8000-000000000004";
const CONNECTION_A_SECOND = "10000000-0000-4000-8000-000000000005";
const COMPANY_B = "20000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const CONNECTION_B = "20000000-0000-4000-8000-000000000004";
const TOKEN_A_ID = "10000000-0000-4000-8000-000000000003";
const TOKEN_A_SECOND_ID = "10000000-0000-4000-8000-000000000006";
const TOKEN_B_ID = "20000000-0000-4000-8000-000000000003";
const META_USER_A = "17841400000000001";
const META_USER_B = "17841400000000002";

function signPayload(payload, secret = APP_SECRET) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64url");
  const signature = crypto.createHmac("sha256", secret)
    .update(encodedPayload, "ascii")
    .digest("base64url");
  return `${signature}.${encodedPayload}`;
}

function validSignedRequest(userId = META_USER_A, overrides = {}) {
  return signPayload({
    algorithm: "HMAC-SHA256",
    issued_at: ISSUED_AT,
    user_id: userId,
    ...overrides
  });
}

function mappings() {
  return [
    {
      provider: "instagram",
      externalUserId: META_USER_A,
      companyId: COMPANY_A,
      userId: USER_A,
      connectionId: CONNECTION_A
    },
    {
      provider: "instagram",
      externalUserId: META_USER_B,
      companyId: COMPANY_B,
      userId: USER_B,
      connectionId: CONNECTION_B
    }
  ];
}

function verifier() {
  return createMetaSignedRequestVerifier({
    appSecret: APP_SECRET,
    clock: () => NOW,
    maxAgeSeconds: 3600,
    futureSkewSeconds: 60
  });
}

function deterministicRandomBytes() {
  let value = 1;
  return (size) => {
    const bytes = Buffer.alloc(size, value);
    value = value === 255 ? 1 : value + 1;
    return bytes;
  };
}

function service(repository) {
  return createMetaComplianceService({
    signedRequestVerifier: verifier(),
    repository,
    publicStatusBaseUrl:
      "https://staging.example.invalid/v1/social/compliance/meta/data-deletion/status",
    clock: () => NOW,
    randomBytes: deterministicRandomBytes()
  });
}

function fakeRouter() {
  const routes = new Map();
  return {
    routes,
    post(path, ...handlers) {
      routes.set(`POST ${path}`, handlers);
      return this;
    },
    get(path, ...handlers) {
      routes.set(`GET ${path}`, handlers);
      return this;
    }
  };
}

function fakeResponse() {
  return {
    statusCode: null,
    payload: null,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
}

async function invoke(handlers, req) {
  const res = fakeResponse();
  let nextCalls = 0;
  handlers[0](req, res, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  await handlers[1](req, res);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers.pragma, "no-cache");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  return res;
}

test("signed_request verifier accepts only current HMAC-SHA256 payloads", () => {
  const instance = verifier();
  const signedRequest = validSignedRequest();
  const result = instance.verify(signedRequest);
  assert.deepEqual(result, {
    provider: "instagram",
    externalUserId: META_USER_A,
    issuedAt: "2026-08-30T12:00:00.000Z",
    requestDigest: result.requestDigest
  });
  assert.match(result.requestDigest, /^[0-9a-f]{64}$/);

  assert.throws(
    () => instance.verify(signPayload({
      algorithm: "HMAC-SHA256",
      issued_at: ISSUED_AT,
      user_id: META_USER_A
    }, "different-app-secret-that-is-long-enough")),
    (error) => error.code === "meta_signed_request_signature_invalid" &&
      error.statusCode === 401
  );
  assert.throws(
    () => instance.verify(validSignedRequest(META_USER_A, {
      algorithm: "HMAC-SHA1"
    })),
    (error) => error.code === "meta_signed_request_invalid"
  );
  assert.throws(
    () => instance.verify(validSignedRequest(META_USER_A, {
      issued_at: ISSUED_AT + 61
    })),
    (error) => error.code === "meta_signed_request_not_yet_valid" &&
      error.statusCode === 401
  );

  const stale = createMetaSignedRequestVerifier({
    appSecret: APP_SECRET,
    clock: () => NOW,
    maxAgeSeconds: 60,
    futureSkewSeconds: 0
  });
  assert.throws(
    () => stale.verify(validSignedRequest(META_USER_A, {
      issued_at: ISSUED_AT - 61
    })),
    (error) => error.code === "meta_signed_request_expired" &&
      error.statusCode === 401
  );
  stale.destroy();
  instance.destroy();
  assert.throws(
    () => instance.verify(signedRequest),
    (error) => error.code === "meta_compliance_configuration_invalid"
  );
});

test("data deletion is replay-safe, tenant-scoped and physically wipes synthetic token bytes", async () => {
  const tokenA = Buffer.from("synthetic-token-material-a", "utf8");
  const tokenB = Buffer.from("synthetic-token-material-b", "utf8");
  const originalB = Buffer.from(tokenB);
  const repository = createInMemoryMetaComplianceRepository({
    subjectMappings: mappings(),
    tokenMaterials: [
      {
        companyId: COMPANY_A,
        connectionId: CONNECTION_A,
        id: TOKEN_A_ID,
        provider: "instagram",
        material: tokenA
      },
      {
        companyId: COMPANY_B,
        connectionId: CONNECTION_B,
        id: TOKEN_B_ID,
        provider: "instagram",
        material: tokenB
      }
    ]
  });
  const api = service(repository);
  const signedRequest = validSignedRequest(META_USER_A);

  const first = await api.handleDataDeletion({ signedRequest });
  assert.equal(first.kind, "data_deletion");
  assert.equal(first.status, "completed");
  assert.equal(first.replayed, false);
  assert.equal(first.tokenMaterialsDeleted, 1);
  assert.match(first.confirmationCode, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(
    first.statusUrl,
    `https://staging.example.invalid/v1/social/compliance/meta/` +
      `data-deletion/status/${first.confirmationCode}`
  );
  assert.equal(tokenA.every((byte) => byte === 0), true);
  assert.deepEqual(tokenB, originalB);

  const snapshot = repository.snapshot();
  assert.equal(snapshot.tokenMaterialCount, 1);
  assert.deepEqual(snapshot.tokensByCompany, { [COMPANY_B]: 1 });
  assert.equal(snapshot.operationCount, 1);
  assert.equal(snapshot.confirmationCount, 1);
  assert.equal(snapshot.audits.length, 1);
  assert.deepEqual(Object.keys(snapshot.audits[0]).sort(), [
    "action",
    "actorUserId",
    "companyId",
    "connectionId",
    "detailsCode",
    "eventId",
    "occurredAt",
    "outcome"
  ]);
  const auditText = JSON.stringify(snapshot.audits[0]);
  assert.doesNotMatch(auditText, new RegExp(META_USER_A));
  assert.doesNotMatch(auditText, new RegExp(first.confirmationCode));
  assert.doesNotMatch(auditText, new RegExp(signedRequest.split(".")[0]));

  const replay = await api.handleDataDeletion({ signedRequest });
  assert.equal(replay.confirmationCode, first.confirmationCode);
  assert.equal(replay.statusUrl, first.statusUrl);
  assert.equal(replay.replayed, true);
  assert.equal(replay.tokenMaterialsDeleted, 0);
  assert.equal(repository.snapshot().audits.length, 1);
  assert.deepEqual(
    await api.getStatus({ confirmationCode: first.confirmationCode }),
    { status: "completed" }
  );
});

test("data deletion preserves another Instagram connection in the same company", async () => {
  const targetedToken = Buffer.from("targeted-connection-token", "utf8");
  const retainedToken = Buffer.from("retained-same-company-token", "utf8");
  const retainedOriginal = Buffer.from(retainedToken);
  const repository = createInMemoryMetaComplianceRepository({
    subjectMappings: mappings(),
    tokenMaterials: [
      {
        companyId: COMPANY_A,
        connectionId: CONNECTION_A,
        id: TOKEN_A_ID,
        provider: "instagram",
        material: targetedToken
      },
      {
        companyId: COMPANY_A,
        connectionId: CONNECTION_A_SECOND,
        id: TOKEN_A_SECOND_ID,
        provider: "instagram",
        material: retainedToken
      }
    ]
  });

  const result = await service(repository).handleDataDeletion({
    signedRequest: validSignedRequest(META_USER_A)
  });

  assert.equal(result.tokenMaterialsDeleted, 1);
  assert.equal(targetedToken.every((byte) => byte === 0), true);
  assert.deepEqual(retainedToken, retainedOriginal);
  const snapshot = repository.snapshot();
  assert.equal(snapshot.tokenMaterialCount, 1);
  assert.deepEqual(snapshot.tokensByCompany, { [COMPANY_A]: 1 });
  assert.equal(snapshot.audits[0].connectionId, CONNECTION_A);
});

test("invalid signatures are rejected before subject mapping or deletion", async () => {
  const tokenA = Buffer.from("leave-this-token-intact", "utf8");
  const originalA = Buffer.from(tokenA);
  const repository = createInMemoryMetaComplianceRepository({
    subjectMappings: mappings(),
    tokenMaterials: [{
      companyId: COMPANY_A,
      connectionId: CONNECTION_A,
      id: TOKEN_A_ID,
      provider: "instagram",
      material: tokenA
    }]
  });
  const api = service(repository);
  const forged = signPayload({
    algorithm: "HMAC-SHA256",
    issued_at: ISSUED_AT,
    user_id: META_USER_A
  }, "forged-secret-that-is-definitely-long-enough");
  await assert.rejects(
    api.handleDataDeletion({ signedRequest: forged }),
    (error) => error.code === "meta_signed_request_signature_invalid" &&
      error.statusCode === 401
  );
  assert.deepEqual(tokenA, originalA);
  assert.equal(repository.snapshot().operationCount, 0);
  assert.equal(repository.snapshot().audits.length, 0);
});

test("unmapped signed subjects fail closed without touching another tenant", async () => {
  const tokenB = Buffer.from("tenant-b-token", "utf8");
  const originalB = Buffer.from(tokenB);
  const repository = createInMemoryMetaComplianceRepository({
    subjectMappings: mappings(),
    tokenMaterials: [{
      companyId: COMPANY_B,
      connectionId: CONNECTION_B,
      id: TOKEN_B_ID,
      provider: "instagram",
      material: tokenB
    }]
  });
  await assert.rejects(
    service(repository).handleDeauthorization({
      signedRequest: validSignedRequest("17841499999999999")
    }),
    (error) => error.code === "meta_subject_unmapped" &&
      error.statusCode === 404
  );
  assert.deepEqual(tokenB, originalB);
  assert.equal(repository.snapshot().audits.length, 0);
});

test("ambiguous external-subject mappings are refused at construction", () => {
  assert.throws(
    () => createInMemoryMetaComplianceRepository({
      subjectMappings: [mappings()[0], {
        ...mappings()[0],
        companyId: COMPANY_B,
        userId: USER_B,
        connectionId: CONNECTION_B
      }]
    }),
    (error) => error.code === "meta_subject_mapping_ambiguous" &&
      error.statusCode === 503
  );
});

test("opaque confirmation collisions fail before another tenant is deleted", async () => {
  const tokenA = Buffer.from("collision-token-a", "utf8");
  const tokenB = Buffer.from("collision-token-b", "utf8");
  const originalB = Buffer.from(tokenB);
  const repository = createInMemoryMetaComplianceRepository({
    subjectMappings: mappings(),
    tokenMaterials: [
      {
        companyId: COMPANY_A,
        connectionId: CONNECTION_A,
        id: TOKEN_A_ID,
        provider: "instagram",
        material: tokenA
      },
      {
        companyId: COMPANY_B,
        connectionId: CONNECTION_B,
        id: TOKEN_B_ID,
        provider: "instagram",
        material: tokenB
      }
    ]
  });
  const api = createMetaComplianceService({
    signedRequestVerifier: verifier(),
    repository,
    publicStatusBaseUrl:
      "https://staging.example.invalid/v1/social/compliance/meta/data-deletion/status",
    clock: () => NOW,
    randomBytes: (size) => Buffer.alloc(size, 7)
  });
  await api.handleDataDeletion({
    signedRequest: validSignedRequest(META_USER_A)
  });
  await assert.rejects(
    api.handleDataDeletion({
      signedRequest: validSignedRequest(META_USER_B)
    }),
    (error) => error.code === "meta_confirmation_collision" &&
      error.statusCode === 503
  );
  assert.equal(tokenA.every((byte) => byte === 0), true);
  assert.deepEqual(tokenB, originalB);
  assert.equal(repository.snapshot().audits.length, 1);
});

test("router exposes closed Meta callbacks and never accepts client company authority", async () => {
  const tokenA = Buffer.from("router-token-a", "utf8");
  const tokenB = Buffer.from("router-token-b", "utf8");
  const originalA = Buffer.from(tokenA);
  const originalB = Buffer.from(tokenB);
  const repository = createInMemoryMetaComplianceRepository({
    subjectMappings: mappings(),
    tokenMaterials: [
      {
        companyId: COMPANY_A,
        connectionId: CONNECTION_A,
        id: TOKEN_A_ID,
        provider: "instagram",
        material: tokenA
      },
      {
        companyId: COMPANY_B,
        connectionId: CONNECTION_B,
        id: TOKEN_B_ID,
        provider: "instagram",
        material: tokenB
      }
    ]
  });
  const router = fakeRouter();
  createMetaComplianceRouter({ service: service(repository), router });
  assert.deepEqual([...router.routes.keys()].sort(), [
    `GET ${META_COMPLIANCE_PATHS.dataDeletionStatus}`,
    `POST ${META_COMPLIANCE_PATHS.dataDeletion}`,
    `POST ${META_COMPLIANCE_PATHS.deauthorization}`
  ]);

  const forgedAuthority = await invoke(
    router.routes.get(`POST ${META_COMPLIANCE_PATHS.dataDeletion}`),
    {
      body: {
        signed_request: validSignedRequest(META_USER_A),
        company_id: COMPANY_B
      }
    }
  );
  assert.equal(forgedAuthority.statusCode, 400);
  assert.deepEqual(forgedAuthority.payload, {
    error: "meta_compliance_request_invalid"
  });
  assert.deepEqual(tokenA, originalA);
  assert.deepEqual(tokenB, originalB);

  const deleted = await invoke(
    router.routes.get(`POST ${META_COMPLIANCE_PATHS.dataDeletion}`),
    { body: { signed_request: validSignedRequest(META_USER_A) } }
  );
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(Object.keys(deleted.payload).sort(), [
    "confirmation_code",
    "url"
  ]);
  assert.equal(tokenA.every((byte) => byte === 0), true);
  assert.deepEqual(tokenB, originalB);

  const status = await invoke(
    router.routes.get(`GET ${META_COMPLIANCE_PATHS.dataDeletionStatus}`),
    {
      params: { confirmationCode: deleted.payload.confirmation_code },
      query: {}
    }
  );
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.payload, { status: "completed" });

  const unknown = await invoke(
    router.routes.get(`GET ${META_COMPLIANCE_PATHS.dataDeletionStatus}`),
    {
      params: { confirmationCode: "A".repeat(32) },
      query: {}
    }
  );
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.payload, {
    error: "meta_confirmation_unavailable"
  });
});

test("deauthorization returns only a generic success response and is idempotent", async () => {
  const tokenB = Buffer.from("deauthorization-token-b", "utf8");
  const repository = createInMemoryMetaComplianceRepository({
    subjectMappings: mappings(),
    tokenMaterials: [{
      companyId: COMPANY_B,
      connectionId: CONNECTION_B,
      id: TOKEN_B_ID,
      provider: "instagram",
      material: tokenB
    }]
  });
  const router = fakeRouter();
  createMetaComplianceRouter({ service: service(repository), router });
  const handlers = router.routes.get(
    `POST ${META_COMPLIANCE_PATHS.deauthorization}`
  );
  const urlencodedBody = Object.create(null);
  urlencodedBody.signed_request = validSignedRequest(META_USER_B);
  const req = { body: urlencodedBody };
  const first = await invoke(handlers, req);
  const replay = await invoke(handlers, req);
  assert.deepEqual(first.payload, { success: true });
  assert.deepEqual(replay.payload, { success: true });
  assert.equal(tokenB.every((byte) => byte === 0), true);
  assert.equal(repository.snapshot().operationCount, 1);
  assert.equal(repository.snapshot().audits.length, 1);
});
