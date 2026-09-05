# Publication binding v2 — checkpoint and candidate integration

The original a619eb42 checkpoint implemented only the pure module. Under the
subsequent 05/09/2026 authorization, the current uncommitted candidate connects
it to the reviewer HTTP contract, connector service, PostgreSQL store and
provider stage claims. The separately owned additive 0007 migration is now
prepared; its application/recovery evidence is tracked in the database plan.
Nothing in this document claims deployment, external publication or Android
artifact approval. See `social-publication-atomic-integration.md` for the current
protocol and the distinction between controlled tests and external readiness.

## Pure-module contract

`src/social/publication/connection-binding.js` has no I/O or dependencies beyond
Node crypto. It exports:

- `normalizeConnectionBinding({connectionId, externalId, connectionRevision})`:
  a detached, frozen binding. UUIDs are canonicalized to lowercase; external ID
  is decimal text of 5–64 digits, matching the Instagram connector; revision is
  a positive JavaScript safe integer, without coercion.
- `assertSameConnectionBinding(expected, actual)`: validates both bindings and
  rejects any change of connection, stable external ID or connection revision.
- `publicationIntentIdentity({companyId, clientRequestId})`: deterministic,
  distinct publication and initial-operation UUIDs. Account, revision, media
  and caption do not participate, so changing them cannot fork an intent.
- `createPublicationIntent({companyId, clientRequestId, mediaId,
  mediaMetadataDigest, caption, binding})`: frozen v2 record and SHA-256 request
  commitment. The hash includes the binding and immutable content snapshot.
- `assertPublicationRequestHash(storedHash, intentInput)`: verifies the exact
  versioned commitment; never adopts another binding or legacy hash.
- `publicationRequestHashFromSnapshot({companyId, publicationId, operationId,
  mediaId, mediaMetadataDigest, caption, binding})`: reconstructs the commitment
  solely from the persisted initial IDs/content and original binding.
- `assertStoredPublicationRequestHash(storedHash, snapshotInput)`: checks that
  reconstructed snapshot without requiring the original client UUID. Its
  `operationId` is the publication's immutable initial `idempotency_key`, not a
  newly generated reconciliation operation. All fields must come from an
  authorized persistence snapshot, with locks acquired by the caller.

The request-hash preimage excludes raw `clientRequestId`; the persisted derived
publication/initial-operation IDs already commit to it. This is necessary for
recovery after loss of the client witness without adding a third column. The
two proposed binding columns recover the original account/revision; the other
snapshot inputs already exist in the publication row. IDs still derive from
company + client request, and a new submission still requires that client UUID.

Only verified server context supplies `companyId`. HTTP request bodies must not
supply tenant/authority fields. The adapter, not this pure module, authenticates
the user and authorizes the company, connection and media. Caption and media
digest must come from the server-validated owned snapshot, not from unverified
client metadata. The helper checks neither JPEG bytes nor ownership.

The implemented HTTP contract retains the same records for web and Android:
expose `connection.connectionRevision` and `connection.externalId`; require
`expectedConnectionId`, `expectedExternalId`, `expectedConnectionRevision` on
publish and reconcile; map those fields explicitly to the internal binding.
Malformed/missing bindings and conflicts fail closed with fixed errors. The
module errors contain no raw input. Adapters still need explicit sanitized HTTP
error mapping. UUID derivation is the module's documented SHA-256-based scheme,
not a claim of standard SHA-1 UUIDv5; do not independently improvise it in clients.

## What the existing 0001–0006 schema can and cannot do

In source reference `c5c37a0b79aa897509283dfe9478a830f812097c`, the operation and
publication `request_hash` columns already hold a SHA-256 commitment. Their
foreign key links the initial operation, and runtime UPDATE grants exclude the
publication hash and identity fields (`0004`, lines 163–264 and 567–590).

Thus a no-DDL variant can verify a full binding presented again under the common
lock. A hash is not a recoverable snapshot: after loss of the client witness or
change of account, it cannot recover the original external ID/revision solely
from the database. Such cases must remain blocked, never guessed from current
connection or username. This limitation is not equivalent to autonomous shared
web/Android recovery and must not be hidden to avoid a schema decision.

`result_payload` must be NULL while pending (`0004`, 209–219). Reconciliation
references only exist in provider-confirming/published states and are mutable;
confirmed references only exist after real confirmation (`0004`, 315–332).
Caption, media reference, UUID and provider references are not alternate storage
containers for the binding.

## Additive extension (prepared as 0007, not part of the original checkpoint)

Two proposed nullable columns on `ia4tube_social.social_publications`:

| Proposed column | Type and meaning |
| --- | --- |
| `bound_external_account_id` | UUID: original internal account-row identity, not username and not a new provider ID |
| `expected_connection_revision` | BIGINT: connection revision accepted with the original intent |

Required constraints and permissions:

1. Both values are present or both NULL; a present revision is positive and
   within the API's safe-integer range. Existing unbound rows remain unbound and
   non-executable; new v2 reservations require both values.
2. Foreign key `(company_id, connection_id, bound_external_account_id)` to the
   already existing unique key `social_external_accounts(company_id,
   connection_id, id)`, with deletion restricted. The existing connection FK
   remains. Do not reference the mutable current connection revision by FK.
3. Runtime may insert the original values and read them, but never UPDATE
   either value. Preserve all existing column-level UPDATE restrictions and
   tenant RLS/FORCE RLS. Update catalog/ACL validation for the exact extension.
4. Resolve original `external_id` through that account row, regardless of its
   later active/revoked status for historical identification. Execution still
   requires current active account/connection/credential/scopes and the expected
   revision. Runtime already cannot UPDATE account `external_id`, `id` or
   `connection_id` (`0002`, 86–119 and 527–536).
5. Insert and check the association atomically under the shared company/provider
   lock and row locks. The FK supplies referential consistency, not proof that
   the captured revision was current. Application integration supplies that
   atomic precondition and must be tested.
6. One separately reviewed additive migration/manifest change, now identified as
   `0007_social_publication_connection_binding`. Do not modify,
   duplicate or blindly reapply migrations 0001–0006. No backfill by username,
   current account, timestamp or caption. Backup/restore and catalog checks
   must recognize the new final profile before runtime activation.

This extension is proposed for recoverability, not a lease table or new engine.
It adds no secret/token storage. Account usernames may change; reading a row's
current username must not be labelled a historical username snapshot.

## Completion requirements (implementation and evidence remain distinct)

- Under one short company/provider lock transaction: verify expected binding,
  state, credential and scopes; reserve immutable intent and initial operation.
- Durable single-winner acquisition before each provider-mutating stage, with
  existing revision/reference CAS. Capture the validated target/material; commit
  before network I/O. Never select a new current account after acquisition.
- All connection/credential writers must use the same guard: connector store,
  OAuth activation/failure/recovery, generic persistence and compliance.
  Compliance prevents later acquisition without being indefinitely blocked by
  uncertain work. It cannot retract a request already acquired/sent. Rotation
  of encryption wrapping is not an account change.
- No automatic takeover by age. Remove mutating stale recovery from GET/history.
  Recovery of uncertain provider work cannot issue another possibly sent POST
  merely because ten minutes elapsed or a client/process timed out.
- Adapt strict connector/provider contracts and Android models/persisted intent,
  conflict UI and epoch/session guards. AAB 31 and its 136 tests remain a separate
  immutable checkpoint; this module produces no AAB and proves no device flow.
- Test real transactional races with controlled local fixtures: two contenders,
  account/revision change at every stage, lost response/crash, paused worker past
  ten minutes, compliance, rotation, tenant isolation, forbidden binding UPDATE,
  legacy unbound rows and GET without writes. Pure-module tests are not these
  physical concurrency tests and are not proof of Meta publication.

External gates remain closed. No live-service configuration, deploy, Play/A55,
Meta operation, schema application or new paid resource is part of this module.
