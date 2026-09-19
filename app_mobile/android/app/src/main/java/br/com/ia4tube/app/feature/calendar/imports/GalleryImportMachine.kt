package br.com.ia4tube.app.feature.calendar.imports

sealed interface ImportEvent {
    data class Begin(val draftId: String, val selection: ImportSelection, val configuration: ImportConfiguration) : ImportEvent
    data class EditMedia(val selection: ImportSelection) : ImportEvent
    data class EditConfiguration(val configuration: ImportConfiguration) : ImportEvent
    data class UploadStarted(val revision: Long, val ticket: ImportUploadTicket,
                             val serverPhase: ImportServerPhase = ImportServerPhase.UPLOADING) : ImportEvent
    data class UploadPhaseObserved(val uploadId: String, val serverPhase: ImportServerPhase) : ImportEvent
    /** Persisted intent before the corresponding remote mutation, not a server receipt. */
    data class UploadCompletionRequested(val uploadId: String) : ImportEvent
    data class UploadCancellationRequested(val uploadId: String) : ImportEvent
    data class PartAcknowledged(val uploadId: String, val receipt: ImportPartReceipt) : ImportEvent
    /** Verified server/provider response, NOT a client-supplied finalization manifest. */
    data class UploadCompleted(val uploadId: String, val sha256: String, val verifiedSizeBytes: Long? = null,
                               val verifiedMimeType: String? = null) : ImportEvent
    data class PreparationStarted(val revision: Long, val assetId: String) : ImportEvent
    data class PreparationReady(val revision: Long, val assetId: String, val variants: List<ImportPreparedVariant>) : ImportEvent
    data class PreviewConfirmed(val revision: Long) : ImportEvent
    data class AvailabilityObserved(val availability: ImportOperationalAvailability) : ImportEvent
    data class ScheduleRequested(val intent: ImportScheduleIntent, val nowEpochMs: Long) : ImportEvent
    data class ScheduleResponseUncertain(val idempotencyKey: String) : ImportEvent
    data class ScheduleConfirmed(val idempotencyKey: String, val revision: Long, val calendarItemId: String) : ImportEvent
    data class Failed(val revision: Long, val reason: ImportRejection) : ImportEvent
    data object Cancel : ImportEvent
}

/** Portable data for a future private, owner-scoped persistence adapter. It never stores a signed URL. */
data class ImportUploadCheckpoint(
    val owner: ImportOwner,
    val draftId: String,
    val selection: ImportSelection,
    val configuration: ImportConfiguration,
    val revision: Long,
    val progress: ImportUploadProgress
)

/**
 * Deterministic local contract. No action here uploads, debits art credits, opens gates or publishes.
 * The adapter must retain/read picker access, persist checkpoints and reconcile uncertain scheduling.
 * Passing the callback's original owner is mandatory; never substitute the current session identity.
 */
class GalleryImportMachine(
    owner: ImportOwner?,
    authorizedTracks: Collection<AuthorizedImportTrack> = emptyList()
) {
    private var activeOwner = owner
    private val tracks = authorizedTracks.toList()
    private var current: GalleryImportState? = null

    @Synchronized fun snapshot(): GalleryImportState? = current

    /** Restore ownership/intention, not a stale green status or preview acknowledgement. */
    @Synchronized fun restoreDurable(owner: ImportOwner, checkpoint: ImportDurableCheckpoint): ImportTransition {
        if (owner != activeOwner || checkpoint.state.owner != owner) return reject(ImportRejection.WRONG_OWNER)
        if (current != null) return reject(ImportRejection.INVALID_PHASE)
        try { ImportCheckpointCodec.validate(checkpoint) } catch (_: Exception) { return reject(ImportRejection.INVALID_CONFIRMATION) }
        val state = checkpoint.state
        return apply(state.copy(configuration = freeze(state.configuration),
            upload = state.upload?.let { it.copy(receipts = immutable(it.receipts)) }, prepared = immutable(state.prepared),
            availability = ImportOperationalAvailability(), previewConfirmedRevision = null,
            scheduleResultUncertain = state.phase == ImportPhase.SCHEDULING))
    }

    /** A normal logout/company change invalidates the visible state and every old-owner callback. */
    @Synchronized fun changeSession(owner: ImportOwner?) {
        if (activeOwner != owner) current = null
        activeOwner = owner
    }

    @Synchronized fun uploadCheckpoint(): ImportUploadCheckpoint? {
        val state = current ?: return null
        val progress = state.upload ?: return null
        if (state.phase !in setOf(ImportPhase.UPLOADING, ImportPhase.UPLOADED)) return null
        return ImportUploadCheckpoint(state.owner, state.draftId, state.selection, state.configuration, state.revision, progress)
    }

    /** Resume validates bytes/parts again. Upload finalization must be reconfirmed by the server. */
    @Synchronized fun restoreUpload(owner: ImportOwner, checkpoint: ImportUploadCheckpoint): ImportTransition {
        if (owner != activeOwner || checkpoint.owner != owner) return reject(ImportRejection.WRONG_OWNER)
        if (current != null) return reject(ImportRejection.INVALID_PHASE)
        if (checkpoint.revision < 1) return reject(ImportRejection.STALE_REVISION)
        val replay = GalleryImportMachine(owner, tracks)
        val begin = replay.dispatch(owner, ImportEvent.Begin(checkpoint.draftId, checkpoint.selection, checkpoint.configuration))
        if (begin is ImportTransition.Rejected) return begin
        replay.current = replay.current!!.copy(revision = checkpoint.revision)
        val start = replay.dispatch(owner, ImportEvent.UploadStarted(checkpoint.revision, checkpoint.progress.ticket))
        if (start is ImportTransition.Rejected) return start
        checkpoint.progress.receipts.forEachIndexed { index, receipt ->
            if (receipt.part != index) return reject(ImportRejection.INVALID_PART)
            val result = replay.dispatch(owner, ImportEvent.PartAcknowledged(checkpoint.progress.ticket.uploadId, receipt))
            if (result is ImportTransition.Rejected) return result
        }
        current = replay.current
        return ImportTransition.Applied(current)
    }

    @Synchronized fun dispatch(owner: ImportOwner, event: ImportEvent): ImportTransition {
        if (owner != activeOwner) return reject(ImportRejection.WRONG_OWNER)
        if (event is ImportEvent.Begin) {
            if (current != null) return reject(ImportRejection.INVALID_PHASE)
            if (!GalleryImportPolicy.validId(event.draftId)) return reject(ImportRejection.INVALID_IDENTIFIER)
            GalleryImportPolicy.validateSelection(event.selection)?.let { return reject(it) }
            GalleryImportPolicy.validateConfiguration(event.selection.kind, event.configuration, tracks)?.let { return reject(it) }
            return apply(GalleryImportState(owner, event.draftId, event.selection, freeze(event.configuration)))
        }
        val state = current ?: return reject(ImportRejection.NO_DRAFT)
        if (state.owner != owner) return reject(ImportRejection.WRONG_OWNER)
        if (event is ImportEvent.AvailabilityObserved) return apply(state.copy(availability = event.availability))

        return when (event) {
            is ImportEvent.EditMedia -> {
                if (!editable(state)) return reject(ImportRejection.INVALID_PHASE)
                GalleryImportPolicy.validateSelection(event.selection)?.let { return reject(it) }
                GalleryImportPolicy.validateConfiguration(event.selection.kind, state.configuration, tracks)?.let { return reject(it) }
                apply(state.copy(selection = event.selection, revision = state.revision + 1, phase = ImportPhase.EDITING,
                    upload = null, prepared = emptyList(), previewConfirmedRevision = null, failure = null))
            }
            is ImportEvent.EditConfiguration -> {
                if (!editable(state)) return reject(ImportRejection.INVALID_PHASE)
                GalleryImportPolicy.validateConfiguration(state.selection.kind, event.configuration, tracks)?.let { return reject(it) }
                val phase = when {
                    state.phase == ImportPhase.UPLOADING -> ImportPhase.UPLOADING
                    state.upload?.complete == true && state.phase != ImportPhase.FAILED -> ImportPhase.UPLOADED
                    else -> ImportPhase.EDITING
                }
                apply(state.copy(configuration = freeze(event.configuration), revision = state.revision + 1, phase = phase,
                    prepared = emptyList(), previewConfirmedRevision = null, failure = null))
            }
            is ImportEvent.UploadStarted -> {
                if (event.revision != state.revision) return reject(ImportRejection.STALE_REVISION)
                if (state.phase != ImportPhase.EDITING) return reject(ImportRejection.INVALID_PHASE)
                val ticket = event.ticket
                if (!GalleryImportPolicy.validId(ticket.uploadId) || !GalleryImportPolicy.validId(ticket.assetId) ||
                    ticket.totalBytes != state.selection.byteCount || ticket.chunkBytes != GalleryImportPolicy.CHUNK_BYTES ||
                    !ticket.selectionSha256.equals(state.selection.sha256, true)) return reject(ImportRejection.INVALID_TICKET)
                if (event.serverPhase !in setOf(ImportServerPhase.CREATED, ImportServerPhase.UPLOADING))
                    return reject(ImportRejection.INVALID_CONFIRMATION)
                apply(state.copy(phase = mapImportUploadPhase(event.serverPhase)!!.phase, upload = ImportUploadProgress(ticket)))
            }
            is ImportEvent.UploadCompletionRequested -> {
                val upload = state.upload ?: return reject(ImportRejection.INVALID_TICKET)
                if (event.uploadId != upload.ticket.uploadId) return reject(ImportRejection.INVALID_TICKET)
                if (state.phase != ImportPhase.UPLOADING || !upload.complete) return reject(ImportRejection.UPLOAD_INCOMPLETE)
                apply(state.copy(phase = ImportPhase.VERIFYING))
            }
            is ImportEvent.UploadCancellationRequested -> {
                val upload = state.upload ?: return reject(ImportRejection.INVALID_TICKET)
                if (event.uploadId != upload.ticket.uploadId) return reject(ImportRejection.INVALID_TICKET)
                if (state.phase !in setOf(ImportPhase.INITIALIZING, ImportPhase.UPLOADING, ImportPhase.CANCEL_PENDING))
                    return reject(ImportRejection.INVALID_PHASE)
                apply(state.copy(phase = ImportPhase.CANCEL_PENDING, prepared = emptyList(), previewConfirmedRevision = null))
            }
            is ImportEvent.UploadPhaseObserved -> {
                val upload = state.upload ?: return reject(ImportRejection.INVALID_TICKET)
                if (event.uploadId != upload.ticket.uploadId) return reject(ImportRejection.INVALID_TICKET)
                val mapped = mapImportUploadPhase(event.serverPhase) ?: return reject(ImportRejection.INVALID_CONFIRMATION)
                if (state.phase !in setOf(ImportPhase.INITIALIZING, ImportPhase.UPLOADING, ImportPhase.VERIFYING, ImportPhase.CANCEL_PENDING))
                    return reject(ImportRejection.INVALID_PHASE)
                if (state.phase == ImportPhase.CANCEL_PENDING && event.serverPhase !in setOf(ImportServerPhase.CANCEL_PENDING, ImportServerPhase.CANCELLED))
                    return reject(ImportRejection.INVALID_PHASE)
                if (state.phase != ImportPhase.INITIALIZING && event.serverPhase == ImportServerPhase.CREATED)
                    return reject(ImportRejection.INVALID_PHASE)
                // Keep ticket/parts and wait for verified completion; never restart the asset implicitly.
                apply(state.copy(phase = mapped.phase, prepared = emptyList(), previewConfirmedRevision = null))
            }
            is ImportEvent.PartAcknowledged -> {
                if (state.phase != ImportPhase.UPLOADING) return reject(ImportRejection.INVALID_PHASE)
                val upload = state.upload ?: return reject(ImportRejection.INVALID_TICKET)
                if (event.uploadId != upload.ticket.uploadId) return reject(ImportRejection.INVALID_TICKET)
                val receipt = event.receipt
                if (!GalleryImportPolicy.validSha256(receipt.sha256)) return reject(ImportRejection.INVALID_CHECKSUM)
                if (receipt.part < 0 || receipt.part > upload.nextPart) return reject(ImportRejection.INVALID_PART)
                if (receipt.part < upload.nextPart) {
                    val previous = upload.receipts[receipt.part]
                    return if (previous.bytes == receipt.bytes && previous.sha256.equals(receipt.sha256, true))
                        ImportTransition.Applied(state) else reject(ImportRejection.PART_CONFLICT)
                }
                val remaining = upload.ticket.totalBytes - upload.acknowledgedBytes
                if (remaining <= 0 || receipt.bytes.toLong() != minOf(remaining, upload.ticket.chunkBytes.toLong()))
                    return reject(ImportRejection.INVALID_PART)
                apply(state.copy(upload = upload.copy(receipts = immutable(upload.receipts + receipt))))
            }
            is ImportEvent.UploadCompleted -> {
                if (state.phase !in setOf(ImportPhase.UPLOADING, ImportPhase.VERIFYING)) return reject(ImportRejection.INVALID_PHASE)
                val upload = state.upload ?: return reject(ImportRejection.INVALID_TICKET)
                if (event.uploadId != upload.ticket.uploadId) return reject(ImportRejection.INVALID_TICKET)
                if (event.verifiedSizeBytes != null && event.verifiedSizeBytes != state.selection.byteCount)
                    return reject(ImportRejection.INVALID_CONFIRMATION)
                if (event.verifiedMimeType != null && event.verifiedMimeType != state.selection.mimeType)
                    return reject(ImportRejection.INVALID_CONFIRMATION)
                if (!upload.complete && (event.verifiedSizeBytes != state.selection.byteCount || event.verifiedMimeType != state.selection.mimeType))
                    return reject(ImportRejection.UPLOAD_INCOMPLETE)
                if (!event.sha256.equals(state.selection.sha256, true)) return reject(ImportRejection.INVALID_CHECKSUM)
                apply(state.copy(phase = ImportPhase.UPLOADED, upload = upload.copy(serverVerified = true)))
            }
            is ImportEvent.PreparationStarted -> {
                if (event.revision != state.revision) return reject(ImportRejection.STALE_REVISION)
                if (state.phase != ImportPhase.UPLOADED) return reject(ImportRejection.INVALID_PHASE)
                if (event.assetId != state.upload?.ticket?.assetId) return reject(ImportRejection.INVALID_TICKET)
                apply(state.copy(phase = ImportPhase.PREPARING, prepared = emptyList(), previewConfirmedRevision = null))
            }
            is ImportEvent.PreparationReady -> {
                if (event.revision != state.revision) return reject(ImportRejection.STALE_REVISION)
                if (state.phase != ImportPhase.PREPARING) return reject(ImportRejection.INVALID_PHASE)
                if (event.assetId != state.upload?.ticket?.assetId) return reject(ImportRejection.INVALID_TICKET)
                val expected = GalleryImportPolicy.variants(state.selection.kind, state.configuration)
                if (event.variants.size != expected.size || event.variants.map { it.target }.toSet().size != expected.size ||
                    expected.any { wanted -> event.variants.none { actual -> actual.target == wanted.target && actual.kind == wanted.kind &&
                        actual.mimeType == wanted.mimeType && actual.audioMode == wanted.audioMode && actual.musicTrackId == wanted.musicTrackId &&
                        validPreparedDuration(state.selection, actual) && GalleryImportPolicy.validId(actual.assetId) && GalleryImportPolicy.validSha256(actual.sha256) } })
                    return reject(ImportRejection.INVALID_PREPARED_VARIANTS)
                apply(state.copy(phase = ImportPhase.READY, prepared = immutable(event.variants), previewConfirmedRevision = null))
            }
            is ImportEvent.PreviewConfirmed -> {
                if (event.revision != state.revision) return reject(ImportRejection.STALE_REVISION)
                if (state.phase != ImportPhase.READY) return reject(ImportRejection.INVALID_PHASE)
                apply(state.copy(previewConfirmedRevision = state.revision))
            }
            is ImportEvent.ScheduleRequested -> {
                if (state.phase == ImportPhase.SCHEDULING) return if (state.scheduleIntent == event.intent)
                    ImportTransition.Applied(state) else reject(ImportRejection.CONFLICTING_INTENT)
                if (state.phase != ImportPhase.READY) return reject(ImportRejection.INVALID_PHASE)
                if (event.intent.revision != state.revision) return reject(ImportRejection.STALE_REVISION)
                if (state.previewConfirmedRevision != state.revision) return reject(ImportRejection.PREVIEW_NOT_CONFIRMED)
                if (event.intent.automatic && !state.availability.allowed || !event.intent.automatic &&
                    (!state.availability.ownerAllowed || !state.availability.destinationsEligible)) return reject(ImportRejection.OPERATIONS_BLOCKED)
                if (!GalleryImportPolicy.validId(event.intent.idempotencyKey) || event.intent.scheduledAtEpochMs <= event.nowEpochMs ||
                    event.nowEpochMs <= 0 || event.intent.caption.length > 2200 ||
                    (state.configuration.targets.any { it != ImportTarget.STORY } && event.intent.caption.isBlank()))
                    return reject(ImportRejection.INVALID_SCHEDULE)
                apply(state.copy(phase = ImportPhase.SCHEDULING, scheduleIntent = event.intent, scheduleResultUncertain = false))
            }
            is ImportEvent.ScheduleResponseUncertain -> {
                if (state.phase != ImportPhase.SCHEDULING || state.scheduleIntent?.idempotencyKey != event.idempotencyKey)
                    return reject(ImportRejection.INVALID_CONFIRMATION)
                apply(state.copy(scheduleResultUncertain = true))
            }
            is ImportEvent.ScheduleConfirmed -> {
                if (state.phase != ImportPhase.SCHEDULING || state.scheduleIntent?.idempotencyKey != event.idempotencyKey ||
                    event.revision != state.revision || !GalleryImportPolicy.validId(event.calendarItemId))
                    return reject(ImportRejection.INVALID_CONFIRMATION)
                apply(state.copy(phase = ImportPhase.SCHEDULED, calendarItemId = event.calendarItemId, scheduleResultUncertain = false))
            }
            is ImportEvent.Failed -> {
                if (event.revision != state.revision) return reject(ImportRejection.STALE_REVISION)
                // A transport error is not evidence an uncertain scheduling POST failed. Reconcile instead.
                if (state.phase in setOf(ImportPhase.INITIALIZING, ImportPhase.VERIFYING, ImportPhase.CANCEL_PENDING,
                        ImportPhase.SCHEDULING, ImportPhase.SCHEDULED, ImportPhase.CANCELLED))
                    return reject(ImportRejection.INVALID_PHASE)
                apply(state.copy(phase = ImportPhase.FAILED, failure = event.reason, prepared = emptyList(), previewConfirmedRevision = null))
            }
            ImportEvent.Cancel -> {
                if (!editable(state)) return reject(ImportRejection.INVALID_PHASE)
                // Local cancel only: no deletion of phone media, uploaded objects or existing calendar items.
                apply(state.copy(phase = ImportPhase.CANCELLED, prepared = emptyList(), previewConfirmedRevision = null))
            }
            else -> reject(ImportRejection.INVALID_PHASE)
        }
    }

    private fun editable(state: GalleryImportState) = state.phase !in setOf(ImportPhase.INITIALIZING, ImportPhase.VERIFYING,
        ImportPhase.CANCEL_PENDING, ImportPhase.SCHEDULING, ImportPhase.SCHEDULED, ImportPhase.CANCELLED)
    private fun validPreparedDuration(source: ImportSelection, variant: ImportPreparedVariant): Boolean = when {
        variant.kind == ImportMediaKind.IMAGE -> variant.durationMs == null
        source.kind == ImportMediaKind.IMAGE -> variant.durationMs != null && variant.durationMs in
            (GalleryImportPolicy.MUSICAL_PHOTO_DURATION_MS - GalleryImportPolicy.PREPARED_DURATION_TOLERANCE_MS)..
            (GalleryImportPolicy.MUSICAL_PHOTO_DURATION_MS + GalleryImportPolicy.PREPARED_DURATION_TOLERANCE_MS)
        else -> variant.durationMs != null && variant.durationMs in 1..GalleryImportPolicy.PREPARED_VIDEO_MAX_DURATION_MS &&
            source.durationMs != null && kotlin.math.abs(variant.durationMs - source.durationMs) <= GalleryImportPolicy.PREPARED_DURATION_TOLERANCE_MS
    }
    private fun reject(reason: ImportRejection) = ImportTransition.Rejected(reason)
    private fun apply(state: GalleryImportState): ImportTransition { current = state; return ImportTransition.Applied(state) }
    private fun freeze(config: ImportConfiguration) = config.copy(
        targets = java.util.Collections.unmodifiableSet(config.targets.toSet()),
        musicalTargets = java.util.Collections.unmodifiableSet(config.musicalTargets.toSet())
    )
    private fun <T> immutable(items: List<T>): List<T> = java.util.Collections.unmodifiableList(items.toList())
}
