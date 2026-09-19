package br.com.ia4tube.app.feature.calendar.imports

/** Local foundation only: no HTTP endpoint, file access, persistence or publication is performed. */
data class ImportOwner(val companyId: String, val userId: String) {
    init { require(companyId.isNotBlank() && userId.isNotBlank()) }
    override fun toString() = "ImportOwner(redacted)"
}

enum class ImportMediaKind(val wire: String) { IMAGE("image"), VIDEO("video") }
enum class ImportTarget(val wire: String) { FEED("feed"), STORY("story"), REEL("reel") }
enum class ImportAudioMode(val wire: String) { NONE("none"), MUSIC("music"), ORIGINAL("original"), MUTED("muted") }

/** A picker adapter will keep actual content URIs private; this contract contains no URI or filename. */
data class ImportSelection(
    val selectionId: String,
    val kind: ImportMediaKind,
    val mimeType: String,
    val byteCount: Long,
    val width: Int,
    val height: Int,
    val durationMs: Long?,
    val sha256: String
) {
    override fun toString() = "ImportSelection(kind=$kind, localReference=redacted)"
}

/** Mirrors the proposed server policy; a Reel shown in Feed is not a second Feed publication. */
data class ImportConfiguration(
    val targets: Set<ImportTarget>,
    val audioMode: ImportAudioMode,
    val musicTrackId: String? = null,
    val musicalTargets: Set<ImportTarget> = emptySet(),
    val shareToFeed: Boolean = false
)

/** Populated only from a future verified catalogue, never from an assumed music licence. */
data class AuthorizedImportTrack(
    val id: String,
    val commercialRightsConfirmed: Boolean,
    val testOnly: Boolean = false,
    val displayName: String = id
)

data class ImportVariantExpectation(
    val target: ImportTarget,
    val kind: ImportMediaKind,
    val mimeType: String,
    val audioMode: ImportAudioMode,
    val musicTrackId: String? = null
)

data class ImportUploadTicket(
    val uploadId: String,
    val assetId: String,
    val selectionSha256: String,
    val totalBytes: Long,
    val chunkBytes: Int = GalleryImportPolicy.CHUNK_BYTES
)

/** Local indices are zero-based; the multipart server's partNumber is one-based. */
data class ImportPartReceipt(val part: Int, val bytes: Int, val sha256: String) {
    val serverPartNumber: Int get() {
        require(part >= 0 && part < Int.MAX_VALUE)
        return part + 1
    }
    companion object {
        fun fromServer(partNumber: Int, sizeBytes: Int, sha256: String): ImportPartReceipt {
            require(partNumber > 0)
            return ImportPartReceipt(partNumber - 1, sizeBytes, sha256)
        }
    }
}
data class ImportUploadProgress(val ticket: ImportUploadTicket, val receipts: List<ImportPartReceipt> = emptyList(), val serverVerified: Boolean = false) {
    val nextPart: Int get() = receipts.size
    val acknowledgedBytes: Long get() = receipts.sumOf { it.bytes.toLong() }
    val complete: Boolean get() = serverVerified || acknowledgedBytes == ticket.totalBytes
}

/** The preview adapter must display these exact derived assets, not the unprepared local original. */
data class ImportPreparedVariant(
    val target: ImportTarget,
    val kind: ImportMediaKind,
    val mimeType: String,
    val assetId: String,
    val sha256: String,
    val audioMode: ImportAudioMode = ImportAudioMode.NONE,
    val musicTrackId: String? = null,
    val durationMs: Long? = null
)

enum class ImportPhase { EDITING, INITIALIZING, UPLOADING, VERIFYING, UPLOADED, PREPARING, READY, SCHEDULING, SCHEDULED, FAILED, CANCEL_PENDING, CANCELLED }
enum class ImportServerPhase(val wire: String) {
    CREATED("created"), UPLOADING("uploading"), VERIFYING("verifying"), UPLOADED("uploaded"),
    PREPARING("preparing"), READY("ready"), REJECTED("rejected"), FAILED("failed"),
    CANCEL_PENDING("cancel_pending"), CANCELLED("cancelled");

    companion object {
        fun fromWire(value: String): ImportServerPhase? = entries.firstOrNull { it.wire == value }
    }
}

/** Provider/backend status is reconciled against the existing upload, never treated as a new one. */
data class ImportUploadPhaseMapping(
    val phase: ImportPhase,
    val mayTransferParts: Boolean,
    val requiresReconciliation: Boolean,
    val mayStartReplacementUpload: Boolean = false
)

fun mapImportUploadPhase(server: ImportServerPhase): ImportUploadPhaseMapping? = when (server) {
    ImportServerPhase.CREATED -> ImportUploadPhaseMapping(ImportPhase.INITIALIZING, false, true)
    ImportServerPhase.UPLOADING -> ImportUploadPhaseMapping(ImportPhase.UPLOADING, true, false)
    ImportServerPhase.VERIFYING, ImportServerPhase.UPLOADED -> ImportUploadPhaseMapping(ImportPhase.VERIFYING, false, true)
    ImportServerPhase.REJECTED, ImportServerPhase.FAILED -> ImportUploadPhaseMapping(ImportPhase.FAILED, false, false)
    ImportServerPhase.CANCEL_PENDING -> ImportUploadPhaseMapping(ImportPhase.CANCEL_PENDING, false, true)
    ImportServerPhase.CANCELLED -> ImportUploadPhaseMapping(ImportPhase.CANCELLED, false, false)
    // These require separately validated prepared variants; upload status alone cannot declare Ready.
    ImportServerPhase.PREPARING, ImportServerPhase.READY -> null
}

/** Server-observed conditions, not switches this client may open. Fail closed until observed. */
data class ImportOperationalAvailability(
    val connected: Boolean = false,
    val ownerAllowed: Boolean = false,
    val connectionGateOpen: Boolean = false,
    val publicationGateOpen: Boolean = false,
    val destinationsEligible: Boolean = false
) {
    val allowed: Boolean get() = connected && ownerAllowed && connectionGateOpen && publicationGateOpen && destinationsEligible
}

data class ImportScheduleIntent(
    val idempotencyKey: String,
    val revision: Long,
    val scheduledAtEpochMs: Long,
    val caption: String,
    val automatic: Boolean = true
) {
    override fun toString() = "ImportScheduleIntent(revision=$revision, caption=redacted)"
}

data class GalleryImportState(
    val owner: ImportOwner,
    val draftId: String,
    val selection: ImportSelection,
    val configuration: ImportConfiguration,
    val revision: Long = 1,
    val phase: ImportPhase = ImportPhase.EDITING,
    val upload: ImportUploadProgress? = null,
    val prepared: List<ImportPreparedVariant> = emptyList(),
    val previewConfirmedRevision: Long? = null,
    val availability: ImportOperationalAvailability = ImportOperationalAvailability(),
    val scheduleIntent: ImportScheduleIntent? = null,
    val scheduleResultUncertain: Boolean = false,
    val calendarItemId: String? = null,
    val failure: ImportRejection? = null
) {
    val canDisplayScheduled: Boolean get() = phase == ImportPhase.SCHEDULED && calendarItemId != null && availability.allowed
    override fun toString() = "GalleryImportState(phase=$phase, revision=$revision, content=redacted)"
}

enum class ImportRejection {
    WRONG_OWNER, NO_DRAFT, INVALID_IDENTIFIER, INVALID_FILE, FILE_TOO_LARGE, INVALID_DIMENSIONS,
    INVALID_DURATION, INVALID_CHECKSUM, INVALID_TARGETS, INVALID_AUDIO, MUSIC_NOT_AUTHORIZED,
    INVALID_PHASE, STALE_REVISION, INVALID_TICKET, INVALID_PART, PART_CONFLICT, UPLOAD_INCOMPLETE,
    INVALID_PREPARED_VARIANTS, PREVIEW_NOT_CONFIRMED, OPERATIONS_BLOCKED, INVALID_SCHEDULE,
    INVALID_CONFIRMATION, CONFLICTING_INTENT
}

sealed interface ImportTransition {
    data class Applied(val state: GalleryImportState?) : ImportTransition
    data class Rejected(val reason: ImportRejection) : ImportTransition
}
