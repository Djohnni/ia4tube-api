# iA4tube — private disk free-space guard (local candidate)

This opt-in guard observes available filesystem space before a private upload
reservation or byte write. It is disabled by default and changes no startup,
provider gate, migration, remote service, storage quota or billing setting.
Existing tests/callers retain their behavior until they explicitly require disk
evidence. Any future production startup for private disk uploads must explicitly
require the guard and the separately verified filesystem/durability conditions.

## Integration and evidence

Create one trusted `createDiskSpaceGuard({rootDirectory, enabled:false,
marginBytes:1073741824, maxEvidenceAgeMs:1000})` for the dedicated private root.
The 1 GiB default margin is provisional and configurable; it is not a measurement
of the deployment's needs. A larger or smaller explicit margin requires local
operational judgment. The evidence age may be shortened but cannot exceed one
second. The root must already exist; the guard creates no directories or files.

`sample()` performs asynchronous filesystem reads outside the database
transaction. It checks the root with `lstat`, requires an actual directory with
no symlink/junction, and requires `realpath` to equal the configured canonical
path. It rejects volume roots. On POSIX it also requires ownership by the
current user and mode bits that deny group/other access. On Windows these Node
checks do not prove NTFS ACL privacy; this local evidence does not replace that
operational verification. It checks device/inode identity again after statfs.

The guard calls `statfs(root, {bigint:true})` and calculates available bytes as
`bavail * bsize`, using the blocks available to the current user. It subtracts
the configured margin, floors a negative result at zero, and refuses an unsafe
integer result. Invalid/unsupported stats, missing paths, unsafe directories and
read failures fail closed with fixed `disk_space_*` errors, without paths or
underlying filesystem error payloads escaping.

The returned object is a frozen, opaque token. Its issuer, observation time and
`maximumHeldBytes` stay in module-private WeakMap/WeakSet state. The module's
`assertDiskSpaceEvidence(token, {guard, allowVolatileForTests:false})` checks the
actual branded guard, exact issuer and monotonic observation age before
returning that ceiling synchronously. A copied object, JSON payload, different
guard's token, wall-clock timestamp or capability flag cannot manufacture valid
evidence. Token metadata never enters the durable capacity document. Tokens are
process-local and short-lived, so every request takes a fresh observation rather
than serializing or carrying them between workers.

The separate `createDiskSpaceGuardForTests` accepts `statfsForTests` and an
optional nanosecond BigInt `monotonicClockForTests`, while retaining real root
validation. That factory is always marked test-only. Production construction
does not accept injected statfs/clock functions, and capacity/admission refuse
test guards unless their existing explicit test opt-in is present.

Wire the same guard into both existing components:

1. `createGlobalMediaCapacity({..., requireDiskSpaceEvidence:true,
   diskSpaceGuard})` refuses availability without an actual branded usable
   guard. `reserveStorage({...binding, diskSpaceEvidence})` verifies freshness
   inside its serialized global state mutation and checks
   `heldBytesAcrossAllJobs + incomingReservationBytes <= maximumHeldBytes`.
   Idempotent retries add zero new bytes and still check current held storage.
   `assertHeld({...binding, intent:"write", diskSpaceEvidence})` checks the same
   current aggregate before authorizing a write. `intent:"read"` continues to
   permit already-held immutable data without requesting new disk space.
2. `createRenderDiskAdmission({..., requireDiskSpaceEvidence:true,
   diskSpaceGuard})` requires the same guard accepted by capacity and matching
   its configured private root. It takes fresh samples after checking the tenant
   binding and before calling `reserveStorage` or a write `assertHeld`. It also
   requires evidence when the supplied capacity already requires it. Flags alone
   cannot enable this guarded path. No filesystem I/O is performed inside a
   capacity transaction.

The provider already calls admission before reserving storage and before its
byte writes. A failed fresh observation or insufficient physical ceiling leaves
existing capacity receipts intact; it does not erase source/idempotency records,
cancel uploads automatically, release unknown bytes or stop unrelated processes.
Compute reservation/acquisition is unchanged by this narrow feature. Any future
compute executor must use its own authorized admission/write checks.

Explicit cancellation of an already identified upload uses owner-bound held
storage read authorization before and inside its exclusive cleanup lock. It does
not require headroom for another full upload, so low space cannot by itself block
removal of that upload's verified parts. The existing 64 KiB identity margin stays
charged. Unknown files, sealed/source files and existing locks still stop cleanup;
no original is removed to recover space. An absent identity is different: restoring
it creates new metadata and still requires fresh write evidence before directory
creation and again under the new lock. Actual filesystem errors also keep cleanup
pending and cannot manufacture a quota release.

## Conservative accounting and limits

Comparing all held storage against currently free bytes intentionally counts
already-materialized retained files conservatively twice: once in statfs's used
space and once in the global held ledger. It may refuse an upload that would
physically fit. This choice prevents several concurrent reservations from each
claiming the same free-space observation without requiring per-file allocation
reconciliation. The checks also include held compute-job storage in the same
ledger. This is a single configured private-root accounting scope, not a
multi-volume allocator or a filesystem capacity benchmark.

This is an application admission check, not an operating-system quota, locked
filesystem snapshot, hard disk guarantee or financial hard cap. Other processes,
legacy files, administrators and filesystem changes can consume space or replace
paths after observation. A fresh observation does not stop an in-flight write,
prove Linux fsync behavior, establish privacy of all existing data, or authorize
production enablement. Keep the original storage quotas, authoritative tenant
checks, byte/part bounds, digest checks and cleanup reconciliation.

Local tests use owned temporary directories and synthetic stats. They cover a
real statfs observation, BigInt/margin validation, unforgeable evidence, stale
and backward monotonic time, transaction-queue delay, matching-root guard
requirements, symlink/junction refusal, concurrent global admission and low
space before a real private-provider acceptPart call. The last case proves that
the input stream is not consumed and no part file is created while the original
reservation remains charged. No new PostgreSQL physical run, remote call,
deployment, previous benchmark or existing data directory is involved.
Additional cases verify explicit cancellation under low space and refusal of
missing-identity recovery, unknown/source files and existing locks in that state.
