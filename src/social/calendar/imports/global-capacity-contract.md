# iA4tube — global media admission (local candidate)

This is internal metadata orchestration, disabled by default. It does not run
FFmpeg, provision Render, touch files, perform OAuth or publish anything. A
successful local test is not a verified physical disk limit or a financial cap.

## Integration boundary

`createGlobalMediaCapacity({store, enabled:false, limits, clock})` requires a
durable store with atomic global transactions. The in-memory test fixture is
accepted only with `allowVolatileForTests:true`; do not use it in production.

Every method requires a **trusted server-created** context:
`{authenticated:true, role:"calendar_media_capacity_coordinator"}`. Never accept
that context from an HTTP request or derive it merely from a user-provided role.
The access policy must first authorize the authenticated user/company pair and
the exact asset/job. The global store contains opaque IDs and resource metadata,
not files, passwords, URLs, paths, captions or provider credentials.

1. `reserveStorage({context,jobId,companyId,userId,requestDigest,storageBytes,sourceBytes})`
   is for the disk upload itself, before any bytes are written. It returns
   `purpose:"storage"`, `state:"storage_reserved"`, with zero runtime reservation
   and **no queued task or monthly task admission**. Storage-only IDs must be in a
   namespace distinct from the later inspection/preparation jobs. `sealStorage`
   accepts trusted evidence and remainingBytes to transition to `storage_sealed`;
   after that only immutable reads are allowed. `cancel` changes it to
   `storage_cancel_requested` while retaining all held bytes. Actual verified
   abort cleanup is required before settlement or full storage release.
2. `reserve({context,jobId,companyId,userId,requestDigest,storageBytes,sourceBytes,runtimeBudgetMs})`
   persists a receipt before file creation or external dispatch. `storageBytes`
   is the conservative **peak** including original, multipart temporary space,
   outputs and overhead. `sourceBytes` is descriptive, never an extra allowance.
   A retry with identical binding returns the same receipt; any changed identity,
   digest, peak or runtime budget is rejected. Completed receipts never resurrect.
3. `assertHeld({...binding,context,intent:"write"})` checks owner/job/digest and
   confirms the reservation still allows writes. Cancellation/completion refuses
   new writes. `intent:"read"` is separate for already-held immutable files;
   it does not authorize mutation or replace the tenant authorization check.
   The receipt has original `storageBytes` and current `heldBytes`; a provider
   must compare new allocation requirements with **heldBytes**, not original peak.
4. `acquireNext({context})` atomically claims one runnable job with a unique
   lease token, or returns null. Least-recently-served company ordering and FIFO
   inside each company prevent one company from dominating the queue.
5. `recordCompletion({context,jobId,leaseToken,outcome,actualRuntimeMs,proofId})`
   accepts only the matching lease and trusted authoritative termination result.
   A proof ID is a SHA-256 reference to evidence verified by the adapter, **not**
   proof by itself. The adapter must bind process identity, task digest, company,
   result and elapsed time. A timeout observed by this coordinator is not proof
   the external process stopped. No automatic timeout recycling exists.
6. `settleStorage({context,jobId,remainingBytes,proofId})` releases confirmed
   surplus after a trusted filesystem adapter checks actual temporary cleanup.
   Positive bytes only, downward only, max16 durable settlement receipts/job.
   Count each actual retained immutable object once, even if Story/Reel reference
   it twice. It does not finish a process or free the active execution slot.
7. `recordCleanup({context,jobId,proofId})` releases all storage only for terminal
   tasks or cancelled storage reservations after verified deletion of the objects
   covered by this reservation.
   Unknown files/failures must keep the reservation for reconciliation.
8. `cancel` cancels a never-acquired queued job, returning its runtime reservation
   but keeping disk held. Running jobs become `cancel_requested`, retaining slot,
   budget and storage; this is **not** a process-kill command. `setPaused` stops
   new admission/acquisition, not running processes.

A disk-provider wrapper can derive a stable namespaced UUID from `assetId` and
hash a canonical binding containing owner, asset, source digest and peak. Use
reserveStorage, not task reserve. After confirming abort cleanup, cancel the
storage reservation then settleStorage for any retained metadata/tombstone
margin. Use recordCleanup only when every reserved byte is verified absent.
The real executor bridge
must reserve/acquire globally before any paid attempt; existing per-company
queues are not wired to this new module in this bounded delivery. A capabilities
flag alone must never authorize multi-company execution.

## Pilot defaults and accounting limits

- Disabled; one active job globally; 64 queued globally; 4 queued/company.
- 3 GiB held globally and per company; these are provisional application quotas,
  **not** measured free-space guarantees. A separate physical-disk free-space
  reserve check is still necessary before enabling real uploads.
- 120 admissions/month globally and per company; 180 seconds maximum requested
  runtime/job; 10,800,000 ms (=3 hours) combined monthly runtime reservation globally
  and per company. These new conservative defaults replace no live configuration.
- Usage is conservatively attributed to UTC admission/dispatch/completion months,
  not the provider billing cycle. Queued jobs crossing months reserve that new
  month before dispatch. Unknown running jobs also hold the current month's
  safety budget. Completion charges full reported elapsed runtime; overrun pauses
  admission and is never silently capped in accounting.
- Known completion releases unused runtime reservation. Cancelled admissions
  still count toward monthly admission count. Old active slots/storage do not
  disappear at month rollover. 10,000 job receipts/8 MiB maximum ledger; fail closed
  when full, rather than purge idempotency evidence or auto-delete user media.
- These controls do not cover provider retries not routed through this ledger,
  bandwidth, taxes, all-workspace costs or compromised provider credentials.
  They are **not an absolute US$5 billing hard cap**.

## PostgreSQL candidate

`0003_global_media_capacity.up.sql` is additive and not applied to staging or production. It
requires a separately authorized/provisioned restricted coordinator role
`ia4tube_media_capacity_runtime`, never granted to `ia4tube_social_runtime`.
The adapter uses the established commit/rollback helper, verifies forced RLS,
exact coordinator policy, privileges and tenant denial in both directions
(tenant cannot access singleton; coordinator cannot access tenant data) inside the transaction,
then locks the singleton row with `FOR UPDATE`. No asynchronous or external work
is allowed inside the mutation callback. Uncertain commits are not replayed;
the caller retries only the same reservation identity after reconciliation.

Focused unit tests cover the state machine, simultaneous admission, month
boundaries, fairness, quotas, storage-only upload reservations, unknown
cancellation, cleanup and adapter SQL sequencing with a mocked client: 22 passed.

A separate opt-in physical suite, `calendar-import-global-capacity-postgres-physical.test.js`,
passed 7/7 (6 subtests and the parent harness) against a newly created isolated,
loopback-only PostgreSQL 18.4 cluster. It checked restricted-role persistence,
serialization and both directions of tenant/coordinator isolation, including an
inherited tenant role and a direct tenant-column grant being refused. The cluster
was stopped, its listener confirmed closed and its synthetic directory removed.
This is a **local database proof**, not Render deployment, production migration,
capacity load proof or a remotely functioning processing queue.
