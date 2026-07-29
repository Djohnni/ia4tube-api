"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  configuredSecrets,
  createConcurrencyLimiter,
  createEssentialSecurityHeaders,
  createHttpsEnforcement,
  createInMemoryRateLimitStore,
  createRateLimiter,
  requestIp,
  requestIsHttps,
  requireSecret,
  timingSafeSecretMatch
} = require("../src/security/runtime-security");
const {
  REDACTED,
  createRedactingLogger,
  installConsoleRedaction,
  redactLogValue,
  redactString
} = require("../src/security/log-redaction");
const {
  MAX_TTL_SECONDS,
  createInMemoryNonceStore,
  createOrderMediaAccess
} = require("../src/security/order-media-access");
const {
  TenantContextError,
  assertResourceTenant,
  createTenantContextMiddleware,
  tenantScopedLookup
} = require("../src/security/tenant-context");

function createResponse() {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headers = new Map();
  response.body = null;
  response.redirectedTo = "";
  response.setHeader = (name, value) => response.headers.set(String(name).toLowerCase(), String(value));
  response.getHeader = (name) => response.headers.get(String(name).toLowerCase());
  response.removeHeader = (name) => response.headers.delete(String(name).toLowerCase());
  response.status = (status) => {
    response.statusCode = status;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  response.redirect = (status, location) => {
    response.statusCode = status;
    response.redirectedTo = location;
    return response;
  };
  return response;
}

function signedMediaClaims(url, owner) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  return {
    owner,
    orderId: decodeURIComponent(segments[1]),
    variant: segments[2],
    expiresAt: Number(parsed.searchParams.get("exp")),
    nonce: parsed.searchParams.get("nonce"),
    signature: parsed.searchParams.get("sig")
  };
}

test("required secrets fail closed without exposing their value", () => {
  const weakValue = "synthetic-weak-value";
  assert.throws(
    () => requireSecret("TEST_SECRET", { env: { TEST_SECRET: weakValue } }),
    (error) => (
      error.code === "invalid_required_secret" &&
      !error.message.includes(weakValue)
    )
  );
  assert.equal(
    requireSecret("TEST_SECRET", { env: { TEST_SECRET: "S".repeat(48) } }),
    "S".repeat(48)
  );
  assert.deepEqual(
    configuredSecrets("FIRST", "SECOND", {
      env: { FIRST: "one", SECOND: "one" }
    }),
    ["one"]
  );
  assert.equal(timingSafeSecretMatch("candidate", ["other", "candidate"]), true);
  assert.equal(timingSafeSecretMatch("", [""]), false);
});

test("proxy headers are trusted only through an explicit trust boundary", () => {
  const request = {
    headers: {
      "x-forwarded-for": "198.51.100.1, 192.0.2.10",
      "x-forwarded-proto": "https"
    },
    socket: { encrypted: false, remoteAddress: "10.0.0.7" }
  };

  assert.equal(requestIsHttps(request), false);
  assert.equal(requestIp(request), "10.0.0.7");
  assert.equal(
    requestIsHttps(request, { trustProxy: (address) => address === "10.0.0.7" }),
    true
  );
  assert.equal(
    requestIp(request, {
      trustProxy: (address) => address === "10.0.0.7",
      trustedProxyHops: 1
    }),
    "192.0.2.10"
  );

  request.ip = "192.0.2.44";
  request.secure = false;
  assert.equal(requestIsHttps(request, { trustProxy: "express" }), false);
  assert.equal(requestIp(request, { trustProxy: "express" }), "192.0.2.44");
  request.secure = true;
  assert.equal(requestIsHttps(request, { trustProxy: "express" }), true);
});

test("HTTPS enforcement never constructs redirects from the Host header", () => {
  const middleware = createHttpsEnforcement({
    canonicalOrigin: "https://safe.example.test"
  });
  const response = createResponse();
  let nextCalls = 0;

  middleware({
    method: "GET",
    originalUrl: "/pedidos?pagina=1",
    headers: { host: "attacker.example.test" },
    socket: { encrypted: false, remoteAddress: "203.0.113.4" }
  }, response, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 0);
  assert.equal(response.statusCode, 308);
  assert.equal(
    response.redirectedTo,
    "https://safe.example.test/pedidos?pagina=1"
  );

  const postResponse = createResponse();
  middleware({
    method: "POST",
    url: "/auth/login",
    headers: {},
    socket: { encrypted: false, remoteAddress: "203.0.113.4" }
  }, postResponse, () => {});
  assert.equal(postResponse.statusCode, 426);
  assert.equal(postResponse.body.code, "https_required");

  assert.throws(
    () => createHttpsEnforcement({ canonicalOrigin: "http://unsafe.example.test" }),
    (error) => error.code === "invalid_https_origin"
  );
});

test("essential headers add HSTS only to requests proven to be HTTPS", () => {
  const middleware = createEssentialSecurityHeaders({
    trustProxy: (address) => address === "10.0.0.7"
  });
  const response = createResponse();
  let nextCalls = 0;

  middleware({
    headers: { "x-forwarded-proto": "https" },
    socket: { encrypted: false, remoteAddress: "10.0.0.7" }
  }, response, () => {
    nextCalls += 1;
  });
  assert.equal(nextCalls, 1);
  assert.equal(response.getHeader("x-content-type-options"), "nosniff");
  assert.equal(response.getHeader("x-frame-options"), "DENY");
  assert.equal(response.getHeader("cross-origin-resource-policy"), "same-origin");
  assert.match(response.getHeader("strict-transport-security"), /^max-age=/);

  const untrustedResponse = createResponse();
  middleware({
    headers: { "x-forwarded-proto": "https" },
    socket: { encrypted: false, remoteAddress: "203.0.113.4" }
  }, untrustedResponse, () => {});
  assert.equal(untrustedResponse.getHeader("strict-transport-security"), undefined);
});

test("rate limiting is bounded, injectable, and fails closed when its store fails", () => {
  let now = 10_000;
  const store = createInMemoryRateLimitStore({
    clock: () => now,
    maxEntries: 100
  });
  const limiter = createRateLimiter({
    max: 2,
    windowMs: 5_000,
    keyGenerator: () => "login:test",
    store,
    clock: () => now
  });

  for (const expectedStatus of [200, 200, 429]) {
    const response = createResponse();
    let nextCalls = 0;
    limiter({}, response, () => {
      nextCalls += 1;
    });
    assert.equal(response.statusCode, expectedStatus);
    assert.equal(nextCalls, expectedStatus === 200 ? 1 : 0);
  }

  now += 5_001;
  const afterWindow = createResponse();
  let nextAfterWindow = 0;
  limiter({}, afterWindow, () => {
    nextAfterWindow += 1;
  });
  assert.equal(nextAfterWindow, 1);

  for (let index = 0; index < 99; index += 1) {
    store.increment(`key:${index}`, { windowMs: 60_000, now });
  }
  assert.equal(store.size(), 100);
  assert.throws(
    () => store.increment("capacity-overflow", { windowMs: 60_000, now }),
    (error) => error.code === "rate_limit_store_capacity"
  );

  const failedResponse = createResponse();
  createRateLimiter({
    store: {
      increment() {
        throw new Error("synthetic store outage");
      }
    }
  })({}, failedResponse, () => assert.fail("must fail closed"));
  assert.equal(failedResponse.statusCode, 503);
  assert.equal(failedResponse.body.code, "rate_limit_unavailable");
});

test("successful requests can be omitted from the rate-limit count", () => {
  const store = createInMemoryRateLimitStore();
  const limiter = createRateLimiter({
    max: 1,
    keyGenerator: () => "synthetic",
    skipSuccessfulRequests: true,
    store
  });
  const response = createResponse();

  limiter({}, response, () => {});
  response.statusCode = 200;
  response.emit("finish");
  assert.equal(store.size(), 0);
});

test("concurrency limiting isolates keys, caps global work and releases exactly once", () => {
  const limiter = createConcurrencyLimiter({
    maxGlobal: 2,
    maxPerKey: 1,
    keyGenerator: (req) => req.owner
  });
  const firstA = createResponse();
  const secondA = createResponse();
  const firstB = createResponse();
  const firstC = createResponse();
  let continued = 0;

  limiter({ owner: "a" }, firstA, () => { continued += 1; });
  limiter({ owner: "a" }, secondA, () => { continued += 1; });
  limiter({ owner: "b" }, firstB, () => { continued += 1; });
  limiter({ owner: "c" }, firstC, () => { continued += 1; });

  assert.equal(continued, 2);
  assert.equal(secondA.statusCode, 429);
  assert.equal(firstC.statusCode, 429);

  firstA.emit("finish");
  firstA.emit("close");
  const retriedA = createResponse();
  limiter({ owner: "a" }, retriedA, () => { continued += 1; });
  assert.equal(continued, 3);
});

test("redaction removes authorization, OAuth, secret, token, and personal fields", () => {
  const source = {
    Authorization: "Bearer synthetic-access-material",
    oauth_code: "synthetic-code",
    state: "synthetic-state-object",
    code_verifier: "synthetic-pkce-verifier",
    code_challenge: "synthetic-public-challenge",
    nested: {
      email: "person@example.test",
      harmless: "visible"
    }
  };
  const redacted = redactLogValue(source);

  assert.equal(redacted.Authorization, REDACTED);
  assert.equal(redacted.oauth_code, REDACTED);
  assert.equal(redacted.state, REDACTED);
  assert.equal(redacted.code_verifier, REDACTED);
  assert.equal(redacted.code_challenge, "synthetic-public-challenge");
  assert.equal(redacted.nested.email, REDACTED);
  assert.equal(redacted.nested.harmless, "visible");
  assert.equal(source.nested.email, "person@example.test");

  const line = redactString(
    "Authorization: Bearer synthetic-access-material " +
    "https://callback.example.test/?code=synthetic-code&state=synthetic-state"
  );
  assert.ok(!line.includes("synthetic-access-material"));
  assert.ok(!line.includes("synthetic-code"));
  assert.ok(!line.includes("synthetic-state"));
});

test("console and structured logger redact before forwarding", () => {
  const calls = [];
  const fakeConsole = {
    log(...args) {
      calls.push(args);
    },
    info() {},
    warn() {},
    error() {},
    debug() {}
  };

  installConsoleRedaction(fakeConsole);
  installConsoleRedaction(fakeConsole);
  fakeConsole.log({ password: "synthetic-password", safe: true });
  createRedactingLogger(fakeConsole).log("token=synthetic-token-value");

  const serialized = JSON.stringify(calls);
  assert.ok(!serialized.includes("synthetic-password"));
  assert.ok(!serialized.includes("synthetic-token-value"));
  assert.match(serialized, /REDACTED/);
});

test("media URLs bind owner, order, variant, nonce, and expiration", () => {
  const now = 1_700_000_000_000;
  const media = createOrderMediaAccess({ secret: "M".repeat(64) });
  const url = media.buildUrl({
    baseUrl: "https://media.example.test",
    owner: "owner-a",
    orderId: "order-100",
    variant: "preview",
    ttlSeconds: 300,
    now
  });
  const claims = signedMediaClaims(url, "owner-a");

  assert.equal(media.verify({ ...claims, now }), true);
  assert.equal(media.verify({ ...claims, owner: "owner-b", now }), false);
  assert.equal(media.verify({ ...claims, orderId: "order-101", now }), false);
  assert.equal(media.verify({ ...claims, variant: "thumbnail", now }), false);
  assert.equal(media.verify({ ...claims, nonce: `${claims.nonce}x`, now }), false);
  assert.equal(media.verify({ ...claims, signature: `${claims.signature}x`, now }), false);
  assert.equal(media.verify({ ...claims, now: claims.expiresAt * 1_000 }), false);
  assert.equal(media.verify({ ...claims, now: now + 301_000 }), false);

  const farFuture = {
    owner: "owner-a",
    orderId: "order-100",
    variant: "preview",
    nonce: "farFutureNonce_123456",
    expiresAt: Math.floor(now / 1_000) + MAX_TTL_SECONDS + 1
  };
  assert.equal(media.verify({
    ...farFuture,
    signature: media.sign(farFuture),
    now
  }), false);
});

test("media URLs are unique, HTTPS-only, and reject unsafe identifiers", () => {
  const media = createOrderMediaAccess({ secret: "U".repeat(64) });
  const options = {
    baseUrl: "https://media.example.test",
    owner: "owner-a",
    orderId: "order-100",
    variant: "thumbnail",
    now: 1_700_000_000_000
  };
  assert.notEqual(media.buildUrl(options), media.buildUrl(options));
  assert.throws(
    () => media.buildUrl({ ...options, baseUrl: "http://media.example.test" }),
    (error) => error.code === "invalid_https_origin"
  );
  assert.throws(
    () => media.buildUrl({ ...options, orderId: "../other-order" }),
    (error) => error.code === "invalid_media_identifier"
  );

  const localMedia = createOrderMediaAccess({
    secret: "L".repeat(64),
    allowLoopbackHttp: true
  });
  assert.match(
    localMedia.buildUrl({ ...options, baseUrl: "http://127.0.0.1:3000" }),
    /^http:\/\/127\.0\.0\.1:3000\/pedidos\//
  );
  assert.throws(
    () => localMedia.buildUrl({ ...options, baseUrl: "http://example.test" }),
    (error) => error.code === "invalid_https_origin"
  );
});

test("media URL carries an authenticated opaque owner context", () => {
  const media = createOrderMediaAccess({ secret: "C".repeat(64) });
  const url = new URL(media.buildUrl({
    baseUrl: "https://media.example.test",
    owner: "owner-private-value",
    orderId: "order-100",
    variant: "preview",
    now: 1_700_000_000_000
  }));
  const context = url.searchParams.get("ctx");

  assert.ok(context);
  assert.ok(!url.toString().includes("owner-private-value"));
  assert.equal(media.openOwnerContext(context), "owner-private-value");

  const tampered = `${context.slice(0, -1)}${context.endsWith("A") ? "B" : "A"}`;
  assert.equal(media.openOwnerContext(tampered), "");
});

test("single-use verification consumes a valid nonce only once when enabled", () => {
  const nonceStore = createInMemoryNonceStore();
  const now = 1_700_000_000_000;
  const media = createOrderMediaAccess({
    secret: "N".repeat(64),
    nonceStore,
    nonceFactory: () => "fixedNonce_123456789"
  });
  const url = media.buildUrl({
    baseUrl: "https://media.example.test",
    owner: "owner-a",
    orderId: "order-100",
    variant: "preview",
    now
  });
  const claims = signedMediaClaims(url, "owner-a");

  assert.equal(media.verifyAndConsume({ ...claims, now }), true);
  assert.equal(media.verifyAndConsume({ ...claims, now }), false);
});

test("payload protection replaces only recognized media routes without mutating input", () => {
  const media = createOrderMediaAccess({ secret: "P".repeat(64) });
  const payload = {
    preview: "/pedidos/order-100/preview",
    nested: [{ thumbnail: "https://old.example.test/pedidos/order-100/thumbnail" }],
    other: "/pedidos/order-100/download"
  };
  const protectedPayload = media.protectPayload(payload, {
    owner: "owner-a",
    baseUrl: "https://media.example.test",
    now: 1_700_000_000_000
  });

  assert.match(protectedPayload.preview, /^https:\/\/media\.example\.test\/pedidos\//);
  assert.match(protectedPayload.nested[0].thumbnail, /nonce=/);
  assert.equal(protectedPayload.other, payload.other);
  assert.equal(payload.preview, "/pedidos/order-100/preview");
});

test("tenant context ignores body and query tenant identifiers", async () => {
  const calls = [];
  const middleware = createTenantContextMiddleware({
    resolveTenant: async (input) => {
      calls.push(["tenant", input]);
      return { id: input.tenantId, active: true };
    },
    resolveMembership: async (input) => {
      calls.push(["membership", input]);
      return {
        tenant_id: input.tenantId,
        principal_id: input.principalId,
        role: "owner",
        active: true
      };
    }
  });
  const request = {
    user: { sub: "user-a", company_id: "tenant-a" },
    body: { company_id: "tenant-b" },
    query: { tenant_id: "tenant-b" }
  };
  const response = createResponse();
  let nextCalls = 0;

  await middleware(request, response, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 1);
  assert.deepEqual(request.tenantContext, {
    principalId: "user-a",
    role: "owner",
    tenantId: "tenant-a"
  });
  assert.equal(Object.isFrozen(request.tenantContext), true);
  assert.equal(calls[0][1].tenantId, "tenant-a");
  assert.equal(calls[1][1].tenantId, "tenant-a");
});

test("legacy signed identity can be mapped explicitly without trusting request input", async () => {
  const middleware = createTenantContextMiddleware({
    resolveLegacyTenant: async ({ auth, principalId }) => {
      assert.equal(auth.whatsapp, principalId);
      return "legacy-tenant-a";
    },
    resolveTenant: async ({ tenantId }) => ({ id: tenantId, active: true }),
    resolveMembership: async ({ tenantId, principalId }) => ({
      tenant_id: tenantId,
      principal_id: principalId,
      role: "member",
      active: true
    })
  });
  const request = {
    user: { whatsapp: "synthetic-owner-100" },
    body: { whatsapp: "attacker-controlled" }
  };
  let nextCalls = 0;

  await middleware(request, createResponse(), () => {
    nextCalls += 1;
  });
  assert.equal(nextCalls, 1);
  assert.equal(request.tenantContext.tenantId, "legacy-tenant-a");
  assert.equal(request.tenantContext.principalId, "synthetic-owner-100");
});

test("tenant context fails closed for missing auth, mismatches, inactive tenants, and resolver errors", async () => {
  const validUser = { sub: "user-a", company_id: "tenant-a" };

  const noAuthResponse = createResponse();
  await createTenantContextMiddleware({
    resolveTenant: async () => ({ id: "tenant-a" }),
    resolveMembership: async () => ({})
  })({}, noAuthResponse, () => assert.fail("must not continue"));
  assert.equal(noAuthResponse.statusCode, 401);

  const mismatchResponse = createResponse();
  await createTenantContextMiddleware({
    resolveTenant: async () => ({ id: "tenant-a", active: true }),
    resolveMembership: async () => ({
      tenant_id: "tenant-b",
      principal_id: "user-a",
      role: "owner"
    })
  })({ user: validUser }, mismatchResponse, () => assert.fail("must not continue"));
  assert.equal(mismatchResponse.statusCode, 403);

  const unspecifiedTenantResponse = createResponse();
  await createTenantContextMiddleware({
    resolveTenant: async () => ({ id: "tenant-a" }),
    resolveMembership: async () => assert.fail("must not resolve membership")
  })({ user: validUser }, unspecifiedTenantResponse, () => assert.fail("must not continue"));
  assert.equal(unspecifiedTenantResponse.statusCode, 403);

  const unspecifiedMembershipResponse = createResponse();
  await createTenantContextMiddleware({
    resolveTenant: async () => ({ id: "tenant-a", active: true }),
    resolveMembership: async () => ({
      tenant_id: "tenant-a",
      principal_id: "user-a",
      role: "owner"
    })
  })({ user: validUser }, unspecifiedMembershipResponse, () => assert.fail("must not continue"));
  assert.equal(unspecifiedMembershipResponse.statusCode, 403);

  const inactiveResponse = createResponse();
  await createTenantContextMiddleware({
    resolveTenant: async () => ({ id: "tenant-a", active: false }),
    resolveMembership: async () => assert.fail("must not resolve membership")
  })({ user: validUser }, inactiveResponse, () => assert.fail("must not continue"));
  assert.equal(inactiveResponse.statusCode, 403);

  const suspendedResponse = createResponse();
  await createTenantContextMiddleware({
    resolveTenant: async () => ({ id: "tenant-a", status: "suspended" }),
    resolveMembership: async () => assert.fail("must not resolve membership")
  })({ user: validUser }, suspendedResponse, () => assert.fail("must not continue"));
  assert.equal(suspendedResponse.statusCode, 403);

  const disabledMembershipResponse = createResponse();
  await createTenantContextMiddleware({
    resolveTenant: async () => ({ id: "tenant-a", status: "active" }),
    resolveMembership: async () => ({
      tenant_id: "tenant-a",
      principal_id: "user-a",
      role: "owner",
      status: "disabled"
    })
  })({ user: validUser }, disabledMembershipResponse, () => assert.fail("must not continue"));
  assert.equal(disabledMembershipResponse.statusCode, 403);

  const failedResponse = createResponse();
  await createTenantContextMiddleware({
    resolveTenant: async () => {
      throw new Error("synthetic internal detail");
    },
    resolveMembership: async () => ({})
  })({ user: validUser }, failedResponse, () => assert.fail("must not continue"));
  assert.equal(failedResponse.statusCode, 503);
  assert.equal(JSON.stringify(failedResponse.body).includes("synthetic internal detail"), false);
});

test("resource authorization hides cross-tenant existence and lookups are tenant-scoped", async () => {
  const context = Object.freeze({
    principalId: "user-a",
    role: "owner",
    tenantId: "tenant-a"
  });
  assert.throws(
    () => assertResourceTenant(context, "tenant-b"),
    (error) => (
      error instanceof TenantContextError &&
      error.status === 404 &&
      error.code === "resource_not_found"
    )
  );

  let lookupInput = null;
  const resource = await tenantScopedLookup({
    context,
    resourceId: "order-100",
    findByTenantAndId: async (input) => {
      lookupInput = input;
      return { id: input.resourceId, tenant_id: input.tenantId };
    }
  });
  assert.deepEqual(lookupInput, {
    tenantId: "tenant-a",
    resourceId: "order-100"
  });
  assert.equal(resource.tenant_id, "tenant-a");

  let unsafeLookupCalled = false;
  await assert.rejects(
    tenantScopedLookup({
      context,
      resourceId: "../order-b",
      findByTenantAndId: async () => {
        unsafeLookupCalled = true;
      }
    }),
    (error) => error instanceof TenantContextError
  );
  assert.equal(unsafeLookupCalled, false);
});
