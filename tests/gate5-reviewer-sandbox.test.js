"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ReviewerSandboxError,
  createReviewerSandboxService
} = require("../src/social/reviewer-sandbox/reviewer-sandbox");

function fixture() {
  let uuidCounter = 1;
  let clock = Date.parse("2026-08-30T12:00:00.000Z");
  const service = createReviewerSandboxService({
    publicOrigin: "https://ia4tube-api-staging-checkpoint-a.onrender.com",
    controlledAssetPath: "/social/gate4/controlled-review.jpg",
    clock: () => clock,
    randomUUID() {
      const suffix = (uuidCounter++).toString(16).padStart(12, "0");
      return `00000000-0000-4000-8000-${suffix}`;
    }
  });
  return {
    service,
    advanceClock(milliseconds = 1000) {
      clock += milliseconds;
    }
  };
}

const companyA = Object.freeze({
  tenantId: "synthetic-company-a",
  principalId: "synthetic-reviewer-a",
  role: "owner"
});
const companyB = Object.freeze({
  tenantId: "synthetic-company-b",
  principalId: "synthetic-reviewer-b",
  role: "owner"
});

function connect(service, context, accountType = "BUSINESS") {
  service.authorize(context, { accountType, purpose: "app_review" });
  return service.callback(context, {});
}

test("reviewer sandbox accepts Business and Creator without external calls", () => {
  for (const accountType of ["BUSINESS", "CREATOR"]) {
    const { service } = fixture();
    const result = connect(service, companyA, accountType);
    assert.equal(result.ok, true);
    assert.equal(result.sandbox, true);
    assert.equal(result.externalCalls, 0);
    assert.equal(result.state.connection.status, "connected");
    assert.equal(result.state.connection.account.accountType, accountType);
    assert.equal(result.state.connection.account.synthetic, true);
    assert.equal(JSON.stringify(result).includes("ia4tube_empresas"), false);
    assert.equal(JSON.stringify(result).includes("17893918281670766"), false);
  }
});

test("reviewer sandbox rejects a personal account with a plain-language state", () => {
  const { service } = fixture();
  service.authorize(companyA, {
    accountType: "PERSONAL",
    purpose: "app_review"
  });
  assert.throws(
    () => service.callback(companyA, {}),
    (error) => (
      error instanceof ReviewerSandboxError &&
      error.code === "professional_account_required" &&
      error.status === 422
    )
  );
  const state = service.read(companyA).state;
  assert.equal(state.authorization.callbackSanitized, true);
  assert.equal(state.connection.status, "rejected");
  assert.equal(state.connection.error.code, "professional_account_required");
});

test("manual synthetic publication is idempotent and advances deterministically", () => {
  const { service, advanceClock } = fixture();
  connect(service, companyA);
  const selected = service.selectMedia(companyA, {
    asset: "controlled-review-jpeg"
  });
  assert.equal(selected.state.media.item.mimeType, "image/jpeg");
  assert.equal(selected.state.media.item.width, 1080);

  const first = service.publish(companyA, {
    clientRequestId: "gate5a-reviewer-manual-publish-v1"
  });
  const replay = service.publish(companyA, {
    clientRequestId: "gate5a-reviewer-manual-publish-v1"
  });
  assert.equal(first.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.state.publication.attempts, 1);
  assert.equal(
    replay.state.publication.details.publicationId,
    first.state.publication.details.publicationId
  );

  const publicationId = first.state.publication.details.publicationId;
  const confirming = service.advance(companyA, publicationId, {});
  assert.equal(confirming.state.publication.state, "provider_confirming");
  advanceClock();
  const published = service.advance(companyA, publicationId, {});
  assert.equal(published.state.publication.state, "published");
  assert.equal(published.state.publication.attempts, 1);
  assert.match(
    published.state.publication.details.mediaId,
    /^synthetic-media-/
  );
  assert.match(
    published.state.publication.details.permalink,
    /^https:\/\/ia4tube-api-staging-checkpoint-a\.onrender\.com\/app\.html\?/
  );
  assert.equal(published.state.history.length, 1);

  const repeatedAdvance = service.advance(companyA, publicationId, {});
  assert.deepEqual(repeatedAdvance.state.publication, published.state.publication);
  assert.equal(repeatedAdvance.state.history.length, 1);
});

test("sandbox state and publication history are isolated by authenticated tenant", () => {
  const { service } = fixture();
  connect(service, companyA, "BUSINESS");
  service.selectMedia(companyA, { asset: "controlled-review-jpeg" });
  service.publish(companyA, {
    clientRequestId: "gate5a-reviewer-company-a-publication"
  });

  const stateA = service.read(companyA).state;
  const stateB = service.read(companyB).state;
  assert.equal(stateA.connection.status, "connected");
  assert.equal(stateA.history.length, 1);
  assert.equal(stateB.connection.status, "not_connected");
  assert.equal(stateB.history.length, 0);
});

test("disconnect permanently invalidates an active delayed publication", () => {
  const { service } = fixture();
  connect(service, companyA);
  service.selectMedia(companyA, { asset: "controlled-review-jpeg" });
  const pending = service.publish(companyA, {
    clientRequestId: "gate5a-reviewer-disconnect-proof"
  });
  const oldPublicationId = pending.state.publication.details.publicationId;
  const disconnected = service.disconnect(companyA);
  assert.equal(disconnected.state.connection.status, "disconnected");
  assert.equal(disconnected.state.connection.account, null);
  assert.equal(disconnected.state.connection.tokenPhysicallyDeleted, true);
  assert.equal(disconnected.state.delayedContentBlocked, true);
  assert.deepEqual(disconnected.state.media, { selected: false, item: null });
  assert.deepEqual(disconnected.state.publication, {
    state: "idle",
    attempts: 0,
    details: null
  });
  assert.deepEqual(disconnected.state.history, []);
  assert.throws(
    () => service.advance(companyA, oldPublicationId, {}),
    (error) => error.code === "reviewer_publication_not_found" &&
      error.status === 404
  );

  connect(service, companyA);
  assert.throws(
    () => service.advance(companyA, oldPublicationId, {}),
    (error) => error.code === "reviewer_publication_not_found" &&
      error.status === 404
  );
  assert.throws(
    () => service.publish(companyA, {
      clientRequestId: "gate5a-reviewer-publication-before-reselection"
    }),
    (error) => error.code === "reviewer_media_required"
  );

  service.selectMedia(companyA, { asset: "controlled-review-jpeg" });
  const created = service.publish(companyA, {
    clientRequestId: "gate5a-reviewer-new-publication"
  });
  const replay = service.publish(companyA, {
    clientRequestId: "gate5a-reviewer-new-publication"
  });
  assert.notEqual(
    created.state.publication.details.publicationId,
    oldPublicationId
  );
  assert.equal(created.state.publication.attempts, 1);
  assert.equal(created.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.state.publication.attempts, 1);
  assert.throws(
    () => service.advance(companyA, oldPublicationId, {}),
    (error) => error.code === "reviewer_publication_not_found" &&
      error.status === 404
  );
});

test("disconnect preserves published history while clearing the active publication", () => {
  const { service } = fixture();
  connect(service, companyA);
  service.selectMedia(companyA, { asset: "controlled-review-jpeg" });
  const created = service.publish(companyA, {
    clientRequestId: "gate5a-reviewer-published-history"
  });
  const publicationId = created.state.publication.details.publicationId;
  service.advance(companyA, publicationId, {});
  service.advance(companyA, publicationId, {});

  const disconnected = service.disconnect(companyA);
  assert.deepEqual(disconnected.state.publication, {
    state: "idle",
    attempts: 0,
    details: null
  });
  assert.equal(disconnected.state.history.length, 1);
  assert.equal(disconnected.state.history[0].publicationId, publicationId);
  assert.equal(disconnected.state.history[0].state, "published");
  assert.equal(
    service.getPublication(companyA, publicationId).publication.state,
    "published"
  );
});

test("disconnect also invalidates a provider-confirming publication", () => {
  const { service } = fixture();
  connect(service, companyA);
  service.selectMedia(companyA, { asset: "controlled-review-jpeg" });
  const created = service.publish(companyA, {
    clientRequestId: "gate5a-reviewer-confirming-disconnect"
  });
  const publicationId = created.state.publication.details.publicationId;
  const confirming = service.advance(companyA, publicationId, {});
  assert.equal(confirming.state.publication.state, "provider_confirming");

  const disconnected = service.disconnect(companyA);
  assert.deepEqual(disconnected.state.history, []);
  assert.equal(disconnected.state.publication.state, "idle");
  assert.throws(
    () => service.advance(companyA, publicationId, {}),
    (error) => error.code === "reviewer_publication_not_found" &&
      error.status === 404
  );
  connect(service, companyA);
  assert.throws(
    () => service.advance(companyA, publicationId, {}),
    (error) => error.code === "reviewer_publication_not_found" &&
      error.status === 404
  );
});

test("connection-data deletion removes technical state but marks commercial policy pending", () => {
  const { service } = fixture();
  connect(service, companyA);
  service.selectMedia(companyA, { asset: "controlled-review-jpeg" });
  const created = service.publish(companyA, {
    clientRequestId: "gate5a-reviewer-deletion-proof"
  });
  const deleted = service.deleteConnectionData(companyA, { confirm: true });
  assert.equal(deleted.state.deletion.status, "completed");
  assert.equal(deleted.state.deletion.technicalConnectionDataDeleted, true);
  assert.equal(
    deleted.state.deletion.commercialHistoryPolicy,
    "owner_decision_pending"
  );
  assert.equal(deleted.state.connection.account, null);
  assert.equal(deleted.state.connection.tokenPhysicallyDeleted, true);
  assert.equal(deleted.state.media.item, null);
  assert.equal(deleted.state.publication.details, null);
  assert.equal(
    deleted.state.history[0].publicationId,
    created.state.publication.details.publicationId
  );
});

test("sandbox rejects a client-supplied company identifier", () => {
  const { service } = fixture();
  assert.throws(
    () => service.authorize(companyA, {
      accountType: "BUSINESS",
      purpose: "app_review",
      company_id: "synthetic-company-b"
    }),
    (error) => error.code === "reviewer_request_invalid"
  );
});
