# iA4tube — committed preparation results and private preview (local candidate)

`createPreparedDiskResultStore({rootDirectory, preparationRoot, tenantStore,
admission, outputInspector, accessPolicy, enabled:false,
allowVolatileForTests:false, clock:Date.now})` is a private result adapter for the
existing preparation queue. It creates no HTTP route, scheduler, remote resource,
credential, migration, production enablement or publishing permission.

The two configured absolute roots must be distinct and already exist. Prepared
inputs are addressed only as `preparationRoot/companyId/assetId/sha256.jpg|mp4`,
using the validated descriptors returned by the trusted preparer. Committed
outputs live under `rootDirectory/companyId/assetId/dispatchKey`. Every component
directory is checked for canonical realpath, links and directory type; POSIX
also requires private permissions and process ownership. File reads reject
symlinks, hardlinks, changed inode/device/size/timestamps, wrong lengths and
wrong SHA-256. No end-user path, URL, source file name or arbitrary object key can
select preview bytes. Windows checks do not establish NTFS ACL privacy or Linux
directory-fsync durability.

The store requires an actual branded `PreparedDiskAdmission` bound to the same
private root, the real tenant store, a branded access policy and a branded output
inspector. Capability flags and copied adapter objects cannot enable it. Its own
`isPreparedDiskResultStore(value,{allowVolatileForTests})` checks private instance
state and availability. The default factory is disabled. Test storage requires
explicit test opt-in; `readyForProduction` remains false.

## Commit, idempotence and inspection

`commit({task, prepared, resultRef, finishedAt, elapsedMs})` is server/worker only.
`task` is the original immutable queue execution envelope, including its owner,
upload, source version/hash, selection/plan, media revision, execution digest,
dispatch key, fence, execution lease token, deadline and output reservation.
Execution lease tokens are internal opaque capabilities; never log the task or
manifest. The store re-reads the exact tenant asset/revision/job/upload, and its
admission adapter requires the matching running global reservation before writes.
This result-store code does not reserve/acquire/start a task itself.

The store checks the original uploaded source's trusted ownership/inspection
metadata against the task, then validates output descriptors against the explicit
delivery plan. Source metadata is not re-decoded by this adapter. Actual output
bytes are copied separately from the trusted preparer's output directory and
decoded at commit. The original upload cannot be selected as a derived file by
passing its path or URL. Identical source/output hashes are allowed when a valid
completed preparation produces identical bytes; path provenance, the task/plan,
geometry and the real decoder establish the output boundary.

Before copying any derived byte, a filesystem-exclusive operation lock protects
an immutable `intent.json` binding the complete task, canonical prepared result,
resultRef and initial timing. One dispatch key therefore cannot accumulate copies
under new resultRefs or changed output hashes after partial failure. Exact
uncommitted retries must match that entire intent. Unknown files and leftover
pending files fail closed and remain charged. No stale lock or unknown file is
automatically removed. Only the current call's newly created temporary files and
lock are removed during its normal cleanup; already retained outputs stay put.

Content-addressed files are copied and hashed in 64 KiB chunks, synchronized,
installed without replacement and made read-only. Each final file has a single
link; the atomic install briefly links the call's own temporary inode before
unlinking that temporary name. Existing objects are verified rather than
overwritten. Identical Story/Reel bytes share one physical file and one private
object/version reference. Logical delivery-byte accounting remains compatible
with the existing queue; the global admission still charges its conservative
peak including staging and committed copies.

`createPreparedDiskOutputInspector({ffmpegPath})` performs real Sharp JPEG decode
and, when configured, bounded local FFmpeg MP4 probe/full decode. It accepts
1080×1350 Feed JPEGs and 1080×1920 vertical JPEG/MP4 outputs, checks actual
metadata against the descriptor, and checks the H.264/AAC, SDR bt709, 30 fps and
audio policy expected from the preparer. Prepared MP4 duration allows up to
60.25 seconds with 250 ms comparison tolerance for encoder rounding. Original
source inspection retains the separate strict 60-second input limit; source
inspection comparisons allow at most 250 ms of measurement rounding.
Metadata and checksum claims alone
cannot complete commit. There is no user-supplied decoder, forged capability
fallback or silent video acceptance when FFmpeg is unavailable. Sharp's input
buffer is bounded to 8 MiB; video hash/copy/preview uses 64 KiB buffers, never a
100 MiB whole-video buffer. Commit checks a shared budget during every hash/copy
chunk: the minimum of 30 seconds for commit, the remaining original wall-clock
deadline, and remaining execution runtime after worker and commit monotonic
elapsed time. Each decoder receives only that remaining budget; process execution
inherits no app secrets.

The full-decode certificate and canonical output references are saved only
after those checks, along with the original task, in an immutable manifest.
`intent.json` and `manifest.json` are each at most 32 KiB. The store adds its own
monotonic copy/inspection elapsed time to the worker-provided elapsed value and
captures the final clock time before installing the manifest; it checks the
shared task deadline before and after installation. The execution coordinator
remains responsible for actual whole-process completion/accounting. A committed
retry with the same task/prepared/ref ignores newer input timing and returns the
original immutable result using read admission, including after the job is ready.

`inspectCommitted({companyId,userId,assetId,mediaRevision,resultRef,dispatchKey,
executionDigest})` returns the existing queue's actual-result shape:
`complete`, `immutable`, `actualInspection`, exact binding, `finishedAt`,
`elapsedMs`, canonical `prepared`, owner/revision-bound `objects`, and optional
`thumbnailObject`. It re-reads the private manifest, original intent and every
actual immutable file, re-hashes bytes, validates the saved full-decode
certificate and checks current tenant/global held ownership. It does not execute
Sharp or FFmpeg again after the executor releases its compute slot.
`actualInspection` refers to the real commit inspection certified for those
unchanged hashes; read-time reinspection means hash/certificate verification.
Private filesystem integrity remains an operational requirement, not a claim
that the manifest is a cryptographically signed statement.

## Authenticated preview

`inspectPreview({context,assetId,mediaRevision,resultRef,target,sha256,signal?,
timeoutMs?})` requires the authenticated owner and current access-policy decision.
It resolves the exact ready tenant revision/result, requires the target/hash to
match both that queue record and the committed manifest, checks held read
admission and verifies actual bytes. It returns public-safe metadata only:
MIME, SHA-256, size, dimensions, duration, audio flag/mode, target and result/revision
identifiers. It returns no filesystem path, source stream or public URL.

`streamPreview({...sameBinding,range?,signal?,timeoutMs?,consume})` repeats those
checks before any bytes, opens the same verified immutable file identity and
streams at most 64 KiB per awaited `consume` call. It supports the full bounded
file or one explicit inclusive `{start,end}` range, at most 100 MiB, with normal
backpressure. HTTP range parsing/status/header decisions belong to the host route.
Default timeout is 30 seconds, configurable up to 60 seconds. Aborts, expired
deadlines, bad ranges and stalled consumers fail closed; access eligibility is
rechecked before each chunk. A route must still authenticate the HTTP session,
enforce origin/transport policy, avoid private request logging and destroy its
response on stream failure. Stream cancellation cannot revoke bytes already sent
or stop side effects already started inside a caller-provided consume callback.

Only committed prepared targets `feed`, `story`, `reel` and the genuine prepared
`thumbnail` are available. Preview performs hashing, not paid work, re-encoding,
video decoding, source fallback, scheduling or publication. Read checks do not
claim an operating-system quota or filesystem snapshot; an administrator or
compromised process with write access to the private root remains outside this
application integrity boundary.

## Local evidence

`calendar-import-prepared-disk-store.test.js` uses new owned temporary directories,
the real preparer, Sharp and the existing local FFmpeg binary, actual branded
admission/global capacity with explicit test stores, and the existing preparation
queue callback. It covers durable file reopening, exact ready-preview hashes and
ranges, role/target/ref isolation, mutation detection, hardlinks and a real Windows
junction/POSIX symlink directory, partial intent conflicts, unknown-file retention,
null image thumbnails, committed retry timing, certificate corruption,
abort/backpressure timeout, an exhausted execution budget, derivative duration
tolerance without loosening the source parser, and real MP4/thumbnail decode with shared Story/Reel
objects. These tests do not prove a deployed route, source-inspector production
isolation, Linux durability, remote availability, billing caps or publishing.
