# iA4tube — private Render disk storage foundation

## Status and scope

Local implementation only. No real DATA_DIR, Render service, storage volume,
database, task, credential or application route was accessed or changed. The
provider explicitly reports `readyForProduction:false` and
`transferRouteMounted:false`. This file does not authorize activation.

`createRenderDiskPrivateUploadProvider` reuses the existing upload-service method
contract without an S3 bucket, ETag or `upload.r2` state. Its metadata is additive
`upload.disk`. `validateDiskUploadRecord` is called on each provider read/mutation
and at the PostgreSQL document boundary whenever the disk field is present.
The validation binds complete manifests to their grants and rejects impossible
initialization, cleanup and inspection markers.

## Required injected boundaries

- A pre-created, dedicated, private root directory, never the workspace root or
  an implicitly discovered DATA_DIR. All generated names are opaque hashes or
  fixed validated names. POSIX roots must belong to the current user and deny
  group/other access; Windows ACL verification is still a deployment check.
- The serializable company-state store, durable in production.
- A durable global admission wrapper, not the tenant's HTTP identity acting as
  a coordinator. Its capabilities must state `persistence:"durable"` and
  `atomicGlobalReservations:true`. Test-only memory substitutes require the
  explicit `allowVolatileForTests` option on both provider and upload service.
- An isolated, bounded metadata-only inspection dispatcher. No image/video
  decoding, FFmpeg, Sharp, child process or external publication is performed
  in this provider.
- An HTTPS transfer origin validated by the final facade. For the pilot the
  Android grant is restricted to the existing official production origin.

### Admission wrapper API

The provider calls `reserve(binding)`, `assertHeld(binding,{intent})`,
`sealStorage(binding)` and `releaseAfterAbort(binding)`. The immutable binding is:

```js
{
  reservationKey: "disk:" + assetId,
  companyId, userId, assetId,
  sourceSha256,
  sourceBytes,
  peakBytes: 2 * sourceBytes + 65536
}
```

The implemented `createRenderDiskAdmission` wrapper derives a canonical digest from the whole binding and a deterministic namespaced UUIDv5 distinct from the asset ID, injects its
restricted coordinator context privately, and reserves before any filesystem
write. The peak covers simultaneous parts + assembled source + bounded metadata;
it does **not** include future prepared variants, which need their own reservation.
`assertHeld` must return `{held:true,binding:<exact copy>}` only after validating
the durable global reservation and sufficient **currently held** bytes. Default
intent is write; inspection and immutable streaming use read. A completed job
must not regain write permission merely because retained storage is still held.

The wrapper uses **only `reserveStorage`**, never compute `reserve`, so an upload
does not become an FFmpeg job or consume a monthly task/runtime slot. It requires
the tenant store and checks the complete owner/asset/source binding on each call.
After verified assembly, `sealStorage` independently checks the identity, seal
receipt and actual source SHA-256 before making the global reservation read-only.
It retains the full peak allocation because the parts and original are retained.

`releaseAfterAbort` is idempotent after a lost reply: it independently checks the
actual directory contains only identity metadata and the current operation lock,
plus the tenant's cleanup state, then cancels the storage-only reservation and
settles it to a **still-charged 64 KiB identity tombstone margin**. It does not
call `recordCleanup` or claim zero storage while metadata remains. No cleanup
proof comes from an HTTP body. Rejected, sealed or uncertain content retains its
reservation. No source retention/deletion policy for sealed objects is implemented.

## Upload and transfer

Metadata methods: `beginMultipart`, `authorizePart`, `resolveAuthorization`,
`listParts`, `finalizeMultipart`, `inspectObject`, `abortMultipart`.

`resolveAuthorization` returns the existing upload-service grant shape:

```text
PUT https://ia4tube-api.onrender.com/v1/social/calendar/imports/bytes/<authorization-UUID>
content-length: exact part size
content-md5: exact part MD5 in base64
x-amz-checksum-sha256: exact part SHA-256 in base64
```

The checksum header name preserves the existing client contract; it does not
mean the bytes go to AWS. No provider path, company ID, source key, JWT, cookie,
redirect, query string or public object URL is in this grant.

The **unimplemented HTTP facade** must resolve the opaque authorization UUID
through a bounded durable lookup to the original owner/upload/part. It must not
trust owner IDs from a client body. It then calls `acceptPart` with reconstructed
authenticated context, objectKey, provider uploadId, partNumber, authorizationId,
contentLength and a raw readable stream. The provider repeats owner, expiry,
current-grant, reservation, exact byte count, SHA-256 and MD5 checks.

The server can also provide a synchronous `assertWriteEligible` closure that
returns exactly `true` only while its trusted access policy still permits this
owner. The provider checks it before reception, under the object lock, immediately
before installing a part or its receipt, and before reporting success. It is an
internal callback, never an HTTP body field or a client claim of eligibility.

The byte endpoint must precede JSON parsing, reject content encoding, query
parameters, invalid headers and unsupported methods, redact grants from all
request/access logs, limit concurrent ingress globally and per tenant, and never
load an entire video into memory. No automatic retry may create a new object.

Part size is at most 5 MiB, source at most 100 MiB, filesystem reads 64 KiB.
Reception has a 30-second default whole-stream deadline, configurable only up to
60 seconds. Interrupted/stalled receptions remove their own partial file and
release their operation lock. Parts become immutable after size/hash validation.
Replays are bounded and must contain identical bytes; they cannot overwrite a
committed part. Final assembly recomputes the complete source SHA-256 and checks
an immutable seal receipt before inspection or source streaming.

`streamSealedObject({...owner,objectVersion,consume})` is for a future authorized
worker transfer. The facade must enforce a short, owner/job/version-bound grant,
same-region private transport, global concurrency and a bounded outgoing request
deadline/cancellation. It does not grant a worker access to arbitrary directories
or make a source publicly downloadable. Each invocation verifies identity/seal
and full source hash before releasing bytes and rechecks the hash while streaming.

## Durability and fail-closed recovery

Metadata uses the existing durable company store. File receipts are exclusively
created, flushed, installed by no-overwrite links and checked against persisted
bindings. Sources and parts are regular single-link files; junctions, symlinks,
hardlinks and invalid paths fail closed. An exclusive object lock prevents two
processes from changing the same upload simultaneously. Runtime errors expose
only newly constructed safe code-only exceptions, never injected path/secret
messages or error causes.

The lock is deliberately **not** taken over based on an age or a PID. A process
crash leaving `operation.lock` stops that object's mutation until a separate
stopped-runtime reconciliation verifies no writer remains. No automatic stale
lock removal exists. A crash during no-overwrite installation can leave a link
or pending file; it also fails closed and requires reconciliation. This is a
concrete remaining readiness gate, not evidence of completed crash recovery.

One narrower crash window is recoverable through the existing initialization and
cancellation methods. If global storage was reserved but its reply was lost
before `identity.json` was installed, a retry reuses the same persisted provider
upload ID, object version and capacity reservation. It creates the missing object
directory if needed, acquires a new exclusive object lock, and restores identity
only when the persisted phase is still `created`, no grant/provider response,
manifest, inspection or cleanup state exists, and the directory contains only
that invocation's lock. The tenant must still be `created` for initialization or
`cancel_pending` for cancellation. No stopped-runtime flag is accepted from a
caller, and no separate recovery endpoint is added.

An existing lock, pending receipt, part, source or unknown file prevents this
restoration. A missing identity in an already open or later phase is also refused.
Those cases retain their files and reservation. Initialization rechecks the
tenant state under its lock before returning success, so a cancellation that
supersedes its tenant lease cannot reopen the upload. After safe cancellation,
the actual retained identity is independently checked by admission and its
64 KiB margin remains charged; recovery never claims that the disk is empty or
that all quota was released. Absence of a matching held global reservation
prevents recovery file creation and requires separate reconciliation.

Node lacks a complete portable openat-style path walk. The filesystem boundary
therefore assumes a trusted OS owner and a private directory that untrusted users
cannot modify. It is not a defense against a compromised host account. Linux
directory-fsync/link behavior and Windows ACLs must be validated for the actual
runtime before activation; current focused tests ran locally on Windows.

## Local proof and remaining integration

The focused `tests/calendar-import-render-disk.test.js` suite uses only synthetic
temporary files and simulated admission/inspection. Nineteen tests cover bounded
multipart reception, restart/resume, exact manifests/hash, tenant/user isolation,
grant renewal/expiry, interruptions/timeouts, immutable replay, quota denial,
whole-source mismatch, path/link rejection, stale locks, cancellation and retained
unknown files, pending inspection, sanitized injected errors and corrupt seals.
It does not prove an actual isolated decoder, actual Render performance or price.

The dedicated `tests/calendar-import-disk-recovery.test.js` suite adds 17 focused
cases/subtests using physical synthetic temporary files and the actual global
capacity/admission state machine. It covers lost reservation/initialization
responses, absent and empty directories, exact reservation reuse, retained
tombstone accounting, competing initialization/cancellation leases, lock
preservation, unknown/pending/source refusal and another owner's denial. The
tenant/global stores in this suite are explicitly volatile test fixtures, not
evidence of production database or volume durability.

Still required: durable admission wiring and worker adapters, HTTP byte/grant routing,
Linux crash reconciliation, startup/readiness verification, disk free-space
reserve and quotas, owner pilot allowlist, raw-source retention policy, typed
calendar publication integration, and remote synthetic proof under its own
authorization. No paid provider cap is implied by logical reservations.

## Integrated storage/global-capacity proof

The local `tests/calendar-import-disk-admission-integration.test.js` suite joins
the actual provider, actual admission wrapper and actual global-capacity module
using only synthetic files and serialized volatile stores. Ten additional tests
passed: twenty concurrent companies competing for two reservations create only
two byte directories; exact retries consume one allocation; owner/hash changes
fail; completed uploads are read-only **storage** reservations and never queue an
FFmpeg task; cancelled uploads retain their charged metadata margin; premature or
forged cleanup with a remaining part is refused; lost seal/settlement responses
resume idempotently; and no fallback to the compute reservation API is possible.

The wrapper is now implemented and integrated locally. Remaining admission work
is startup verification and wiring of actual durable stores/roles, OS disk-space
reserve and permitted HTTP/worker boundaries, not another replacement wrapper.
