# Atomic publication binding — local candidate protocol

This describes the candidate implementation, not live activation. Original
checkpoint tests, current Node tests, physical PostgreSQL fixtures and Android
artifacts are separate evidence sets. No Meta calls or live service changes are
performed by these tests.

## Shared web/Android contract

- Authenticated connection adds top-level `externalId` (decimal string or null)
  and `connectionRevision` (positive JavaScript-safe integer).
- POST publication retains `mediaId`/`clientRequestId` and requires
  `expectedConnectionId`, `expectedExternalId`, `expectedConnectionRevision` in
  production. Reconcile requires the same binding.
- Publication returns `binding:{connectionId,externalId,connectionRevision}` or
  null for legacy. A current username never supplies a missing original binding.
- GET `/v1/social/reviewer/publication-intents/:clientRequestId` derives the v2
  publication ID from verified company + client UUID and reads that record.
  It returns `publication:null` if absent. Absence is not cancellation: an older
  HTTP request may still be before its reservation. Clients preserve the same
  intent witness and must not release another UUID based on that observation.
- All company/user authority comes from the authenticated server context. No
  company, token, current username or client-supplied content digest is trusted
  as authority. The backend-owned JPEG supplies its immutable `metadataDigest`.

## Short transaction protocol

The common advisory lock key is `${companyId}:${provider}`. The lock is held
only within a database transaction and never over provider I/O.

| Stage | Durable transition before external action |
| --- | --- |
| Reserve intent | Validate current account/revision, health, credential and exactly two scopes; insert initial idempotency operation and publication `ready` together |
| Claim container creation | `publishing` with no reference → `provider_confirming` + `igo:<publicationId>` |
| Record container response | Matching `igo` → `igc:created:<containerId>`; no external action |
| Claim media publish | Matching `igc:created` or `igc:armed` → `igc:submitted:<containerId>` |
| Reconcile | GET provider evidence, or one explicitly confirmed claim of an armed stage; no repeat of submitted/unknown POST |

Each claim takes the same company/provider lock, row locks the publication and
connection, verifies the original persisted v2 hash and full account/revision
tuple, and captures the validated credential identity. State/reference revision
CAS provides one winner across independent processes. No lease expiry or age
rule can recreate a consumed stage. Delayed GET results cannot regress a
submitted reference to armed/created. Publication success still requires the
provider's actual media ID, canonical permalink and timestamp evidence.

The two additive fields are the original account-row UUID and accepted
connection revision. The account row's immutable external ID is loaded even if
its current status changes. Existing media/caption/hash/initial-operation fields
complete the recoverable snapshot. There is no third column or separate engine.

## Writers and uncertain outcomes

Ordinary connector activation/save/disconnect, OAuth connection/credential
writers and generic credential insertion use the shared lock and refuse any
ready/publishing/provider-confirming publication. Generic insertion into a
connection also advances its revision. OAuth cancellation recovery remains
available, under the guarded authorization creation path.

Wrapping-key rotation shares ordering with compliance but remains re-encryption
of the same plaintext, not an account generation change. This exception is for
the existing vault rotation flow, not permission to replace a token through a
rotation API. Compliance acquires the common lock and revokes without waiting
indefinitely for a publication. It prevents the next claim; it cannot retract
an already claimed/sent request. Recording its response remains safe.

History and intent lookup perform no recovery mutations. The old ten-minute
takeover helpers have no callers. An unknown container with no recoverable
provider ID may remain unresolved; absence in a finite provider search does not
prove failure. A crash before the first claim may leave a ready/publishing
reservation blocked. No timeout, client retry or new UUID silently releases it.
These fail-closed liveness limits must be displayed honestly.

## Evidence and remaining review

`tests/social-publication-atomic-integration.test.js` uses the real reviewer,
service, store and provider code with explicit synthetic SQL/provider doubles.
It covers transaction-before-I/O ordering, duplicate intent races, independent
reconcile contenders, lost responses, metadata/scope/binding conflicts, tenant
isolation, revocation between stages, exact HTTP fields and read-only lookup.
The double is not PostgreSQL/RLS proof. The independent local PostgreSQL 18.4
laboratory separately exercises real schema 0007, two runtime sessions,
one-winner claims and preservation/restoration; its timestamped source hashes
identify the tested snapshot. Physical results and final aggregate tests must
be reviewed before promoting any candidate. External gates remain closed.
