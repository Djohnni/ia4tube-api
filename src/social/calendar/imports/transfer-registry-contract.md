# iA4tube — opaque byte-transfer authorization registry (local candidate)

This module is disabled by default. It is short-lived authorization metadata,
not a byte receiver, tenant authorization service, multipart provider, source
record, idempotency ledger, storage reservation, inspection job or publisher.
No production wiring, remote migration, credential provisioning or gate change
is performed by these new files.

## Trusted integration

`createTransferAuthorizationRegistry({store, enabled:false, clock:Date.now,
maxActiveRecords:4096, allowVolatileForTests:false})` accepts a durable store with
`atomicGrantUpdates` and `boundedRegistryLedger` capabilities. The in-memory
`createMemoryTransferRegistryStore()` is explicitly `volatile-test` and requires
test opt-in. Exposed capabilities include `available`, `testOnly`, `persistence`,
`opaqueAuthorizationLookup`, limits, and the atomic/bounded flags. `verify()`
refuses a disabled registry and checks its store before returning true.

The following are server integration methods, never generic HTTP inputs:

- `register(binding)` persists the exact trusted binding and returns a copy.
  The only accepted fields are `authorizationId`, `companyId`, `userId`,
  `assetId`, `objectKey`, `providerUploadId`, `partNumber`, `sizeBytes`, `sha256`,
  `md5Base64`, and `expiresAt`. The bearer authorization ID must be a canonical
  lowercase UUIDv4 created by the trusted provider. Owner/asset/provider IDs
  use canonical UUIDs; keys/SHA-256 use 64 lowercase hex characters; MD5 is
  canonical base64 for 16 bytes. Parts are 1–20 and at most 5 MiB each, matching
  the current maximum 100 MiB source contract. Expiry must be future and within
  ten minutes. Call this only after authenticated metadata resolution verified
  the exact company/user/upload/asset/part. Never build the binding from client
  company IDs, headers, paths, cookies, arbitrary metadata or a URL alone.
- `resolve(authorizationId)` accepts that one UUID, computes its SHA-256, and
  directly indexes the authorized registry ledger. It returns the full binding
  plus the caller's UUID, or null for unknown, revoked or expired grants. There
  is no company list, tenant-table fallback, arbitrary key search or UUID prefix
  search. Malformed IDs are refused. No raw bearer UUID is stored in this ledger.
- `revoke(authorizationId)` returns true for an existing unexpired record, also
  on repeated revocation, and false for an absent/expired record. It preserves
  the original immutable binding as a tombstone until its original expiry.
  Re-registering that live revoked UUID cannot resurrect it.

Re-registering an unrevoked grant is idempotent only if every binding field is
identical, including expiry. Any change is a conflict. A trusted issuer must
always generate a new UUID for a new grant and must never recycle UUIDs after
expiry; historical registry records are intentionally not permanent receipts.
Returned objects are copies and cannot mutate durable authorization state.

The byte route must use the resolved company/user only as a candidate server
context, then re-read the original tenant upload/part and enforce current
eligibility immediately before writing bytes. Bind provider call arguments to
all the resolved fields. Registry membership alone does not establish tenant
membership, storage admission, current provider-part status or permission to
publish. A registry resolve is not an execution lease; revocation cannot stop
bytes already accepted by another component. The receiving/provider layer must
handle concurrent writes, cancellation and final immutable digest checks.

The URL's UUID is a bearer capability. Exclude it and resolved bindings from
request/access/error logs and telemetry. Responses from this registry use fixed
`media_transfer_*` codes and sanitize unknown storage errors; query text,
connection details, underlying causes and provider payloads are not propagated.

## Bounds, expiry and PostgreSQL scope

The ledger has at most 4,096 records and 8 MiB of serialized JSON. A caller can
configure a lower admission limit, never a higher one. Revoked unexpired grants
still consume a slot, preventing churn from discarding revocation evidence.
Registration atomically prunes expired registry entries, checks quota, compares
existing bindings and persists the result. Resolution/revocation can remove an
expired entry for the exact requested hash. No worker is required for pruning.
Pruning never opens or deletes source files, tenant upload/idempotency records,
inspection state or capacity receipts. Metadata from idle expired grants may
remain until a later register or lookup; expired grants are always unusable.

`createPostgresTransferRegistryStore({pool})` uses the separately provisioned
`ia4tube_media_transfer_runtime` role and one
`ia4tube_calendar.transfer_authorization_registry` singleton. Its forced RLS
policy is **exact singleton scope for a trusted registry coordinator**, not
per-grant RLS or tenant RLS. That coordinator can read this bounded metadata
ledger across companies; it cannot read tenant or global capacity tables.
The HTTP-facing lookup selects one hash in the document. This intentional
boundary avoids tenant scans and introduces no SECURITY DEFINER routines.

The adapter verifies the role, forced RLS, exact singleton policy, required
column privileges, absence of public/unexpected table and column access,
ownership/role hazards, and tenant/capacity denial in both directions inside the
same transaction as `SELECT ... FOR UPDATE`. Runtime can select and update only
the singleton document/revision/timestamp; it cannot insert/delete/truncate rows,
change the key, own the table/database/schema or inherit a tenant/capacity role.
The document's state validator checks the exact schema and binding shapes on
every transaction. Mutation callbacks must be synchronous. External provider
work cannot be part of a callback. Commit completes before resolution; failed
or uncertain commits are never automatically replayed. On uncertainty, reconcile
the same grant identity with the authoritative tenant record before a retry.

`db/calendar-migrations/0004_transfer_authorization_registry.up.sql` is additive
and remains unapplied to staging or production. It creates the bounded table,
singleton and restricted policy/grants, and assumes the dedicated role was
separately provisioned. It creates no roles, credentials, functions or workers.

## Local evidence and limits

Focused tests: `calendar-import-transfer-registry.test.js` and
`calendar-import-transfer-registry-postgres.test.js` cover validation, immutable
bindings, revocation, global admission races, expiry, sanitized errors, callback
restrictions, transaction order, no-op reads and unknown commits.

The opt-in `calendar-import-transfer-registry-postgres-physical.test.js` runs
only with `CALENDAR_TRANSFER_REGISTRY_TEST_PG_BIN`. It creates a new isolated
loopback cluster with synthetic credentials and a minimal tenant/capacity
fixture, applies only the new registry migration, verifies real role isolation,
concurrent admission, pool-reopen persistence, revocation, source-marker
preservation and privilege/RLS drift, then stops the cluster and verifies its
listener and exact new directory are gone. It does not read app credentials or
reuse an existing database. This is local PostgreSQL evidence, not remote
availability, a deployed byte route, Linux filesystem durability, a production
load result or proof of a financial cap.
