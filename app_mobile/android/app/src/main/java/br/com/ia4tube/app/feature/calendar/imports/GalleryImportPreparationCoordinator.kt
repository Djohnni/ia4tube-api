package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

internal interface GalleryImportPreparationTransport {
    suspend fun capabilities(): ImportCapabilities
    suspend fun status(owner: ImportOwner, assetId: String): ImportPreparationRecord
    suspend fun request(owner: ImportOwner, assetId: String, uploadId: String, intent: ImportPreparationIntent,
                        kind: ImportMediaKind, configuration: ImportConfiguration): ImportPreparationRecord
    suspend fun preview(owner: ImportOwner, record: ImportPreparationRecord): ImportPrivatePreview
    suspend fun availability(owner: ImportOwner, record: ImportPreparationRecord): ImportScheduleAvailability = ImportScheduleAvailability()
    suspend fun schedule(owner: ImportOwner, binding: ImportScheduleBinding, intent: ImportScheduleIntent): ImportScheduleReceipt = throw ImportApiFailure("import_scheduling_unavailable")
    suspend fun scheduleStatus(owner: ImportOwner, binding: ImportScheduleBinding, intent: ImportScheduleIntent): ImportScheduleReceipt? = throw ImportApiFailure("import_scheduling_unavailable")
    suspend fun generated(owner: ImportOwner, intent: ImportGeneratedSourceIntent): ImportGeneratedSource = throw ImportApiFailure("import_generated_unavailable")
}
internal class HttpGalleryImportPreparationTransport(private val api: GalleryImportHttpApi) : GalleryImportPreparationTransport {
    override suspend fun capabilities() = api.capabilities()
    override suspend fun status(owner: ImportOwner, assetId: String) = api.preparationStatus(owner, assetId)
    override suspend fun request(owner: ImportOwner, assetId: String, uploadId: String, intent: ImportPreparationIntent,
                                 kind: ImportMediaKind, configuration: ImportConfiguration) = api.prepare(owner, assetId, uploadId, intent, kind, configuration)
    override suspend fun preview(owner: ImportOwner, record: ImportPreparationRecord) = api.preparationPreview(owner, record)
    override suspend fun availability(owner: ImportOwner, record: ImportPreparationRecord) = api.scheduleAvailability(owner, record)
    override suspend fun schedule(owner: ImportOwner, binding: ImportScheduleBinding, intent: ImportScheduleIntent) = api.schedule(owner, binding, intent)
    override suspend fun scheduleStatus(owner: ImportOwner, binding: ImportScheduleBinding, intent: ImportScheduleIntent) = api.scheduleStatus(owner, binding, intent)
    override suspend fun generated(owner: ImportOwner, intent: ImportGeneratedSourceIntent) = api.adoptGenerated(owner, intent)
}

enum class ImportPreparationRunStatus { EMPTY, SOURCE_RECONCILIATION, UPLOAD_REQUIRED, AWAITING_REQUEST, PREPARING, RECONCILIATION_REQUIRED,
    PREVIEW_AVAILABLE, TEST_ONLY_PREVIEW, SCHEDULING, SCHEDULE_RECONCILIATION, SCHEDULED, ATTENTION, SESSION_CHANGED, PAUSED }
enum class ImportPreparationDiagnosticStage { LOCAL_STATE, CAPABILITIES, STATUS, METADATA, PREVIEW, SCHEDULING_AVAILABILITY }
data class ImportPreparationRunView(val status: ImportPreparationRunStatus, val state: GalleryImportState? = null,
    val preparation: ImportPreparationRecord? = null, val preview: ImportPrivatePreview? = null, val errorCode: String? = null,
    val confirmation: ImportPreviewConfirmation? = null, val availability: ImportScheduleAvailability? = null,
    val scheduleReceipt: ImportScheduleReceipt? = null, val generatedSourceIntent: ImportGeneratedSourceIntent? = null,
    val diagnosticStage: ImportPreparationDiagnosticStage? = null) {
    override fun toString() = "ImportPreparationRunView(status=$status, content=redacted)"
}
private class ImportPreparationFailure(val code: String) : Exception("Confira a preparação existente antes de tentar novamente.")
private class ImportPreparationPaused : CancellationException("Preparação pausada.")
private class ImportPreparationSessionChanged : CancellationException("Sessão alterada.")

/** Session-bound explicit preparation/preview/schedule intent. Never publishes or polls automatically. */
class GalleryImportPreparationCoordinator internal constructor(
    private val ownerProvider: () -> ImportOwner?, private val tokenProvider: () -> String,
    private val store: PrivateImportCheckpointStore, private val transportFactory: () -> GalleryImportPreparationTransport,
    authorizedTracks: Collection<AuthorizedImportTrack> = emptyList(), private val io: CoroutineDispatcher = Dispatchers.IO,
    private val onChanged: (ImportPreparationRunView) -> Unit = {}
) {
    constructor(ownerProvider: () -> ImportOwner?, tokenProvider: () -> String, store: PrivateImportCheckpointStore,
                authorizedTracks: Collection<AuthorizedImportTrack> = emptyList(), onChanged: (ImportPreparationRunView) -> Unit = {}) :
        this(ownerProvider, tokenProvider, store, { HttpGalleryImportPreparationTransport(GalleryImportHttpApi(tokenProvider)) },
            authorizedTracks, Dispatchers.IO, onChanged)
    private class Run(val owner: ImportOwner, val token: String, val epoch: Long, val api: GalleryImportPreparationTransport,
                      val machine: GalleryImportMachine, var checkpoint: ImportDurableCheckpoint?, var capability: ImportCapabilities? = null,
                      var generatedIntent: ImportGeneratedSourceIntent? = null,
                      var diagnosticStage: ImportPreparationDiagnosticStage = ImportPreparationDiagnosticStage.LOCAL_STATE)
    private val tracks = authorizedTracks.toList()
    private val mutex = Mutex()
    private val viewLock = Any()
    private val epoch = AtomicLong()
    private val paused = AtomicBoolean()
    private val invalidated = AtomicBoolean()
    @Volatile private var confirmedPreview: ImportPreviewConfirmation? = null
    @Volatile private var active: Job? = null
    @Volatile private var visible = ImportPreparationRunView(ImportPreparationRunStatus.EMPTY)
    @Volatile private var visibleOwner: ImportOwner? = null
    @Volatile private var visibleToken: String? = null
    fun snapshot(): ImportPreparationRunView = synchronized(viewLock) {
        if (invalidated.get() || visibleOwner != null && (ownerProvider() != visibleOwner || tokenProvider() != visibleToken))
            ImportPreparationRunView(ImportPreparationRunStatus.SESSION_CHANGED) else visible
    }
    fun pause() { paused.set(true); confirmedPreview = null; active?.cancel(ImportPreparationPaused()) }
    fun invalidateSession() {
        invalidated.set(true); confirmedPreview = null
        epoch.incrementAndGet(); active?.cancel(ImportPreparationSessionChanged())
        clearSession()
    }
    /** Reopening reads only; a POST with an unacknowledged intent is retried only by explicit reconcile/request. */
    suspend fun restore(): ImportPreparationRunView = operation { run ->
        val checkpoint = run.checkpoint ?: return@operation emit(run, if (run.generatedIntent != null)
            ImportPreparationRunStatus.SOURCE_RECONCILIATION else ImportPreparationRunStatus.EMPTY)
        capabilities(run)
        if (checkpoint.scheduleBinding != null) return@operation reconcileSchedule(run, retry = false)
        if (!uploaded(checkpoint)) return@operation emit(run, ImportPreparationRunStatus.UPLOAD_REQUIRED)
        val intent = checkpoint.preparationIntent
        if (intent == null) return@operation emit(run, ImportPreparationRunStatus.AWAITING_REQUEST)
        if (intent.acceptedMediaRevision == null) return@operation emit(run, ImportPreparationRunStatus.RECONCILIATION_REQUIRED)
        inspect(run, status(run, checkpoint.state.upload!!.ticket.assetId))
    }
    /** First request is explicit. Another revision/client's preparation is never overwritten automatically. */
    suspend fun request(): ImportPreparationRunView = operation { run ->
        var checkpoint = draft(run); capabilities(run)
        requireThat(uploaded(checkpoint), "import_preparation_upload_required")
        requireThat(!checkpoint.cancelRequested, "import_preparation_cancel_pending")
        requireThat(GalleryImportPolicy.validateConfiguration(checkpoint.state.selection.kind, checkpoint.state.configuration, run.capability!!.musicTracks) == null,
            "import_preparation_music_unavailable")
        if (checkpoint.preparationIntent == null) {
            requireThat(checkpoint.state.phase == ImportPhase.UPLOADED, "import_preparation_existing_stage")
            val record = status(run, checkpoint.state.upload!!.ticket.assetId); guard(run)
            requireIdentity(run, record)
            requireThat(record.currentRevision == checkpoint.preparationBaseRevision &&
                (checkpoint.preparationBaseRevision > 0 || record.phase == ImportPreparationPhase.AWAITING_SELECTION),
                "import_preparation_existing_revision")
            applied(run, ImportEvent.PreparationStarted(checkpoint.state.revision, checkpoint.state.upload.ticket.assetId))
            val intent = ImportPreparationIntent(UUID.randomUUID().toString(), checkpoint.state.revision, checkpoint.preparationBaseRevision)
            persist(run, checkpoint.copy(state = run.machine.snapshot()!!, preparationIntent = intent))
            checkpoint = draft(run)
        }
        if (checkpoint.preparationIntent!!.acceptedMediaRevision != null)
            inspect(run, status(run, checkpoint.state.upload!!.ticket.assetId)) else retrySameIntent(run)
    }
    suspend fun reconcileOnce(): ImportPreparationRunView = operation { run ->
        val checkpoint = draft(run); capabilities(run)
        requireThat(checkpoint.preparationIntent != null, "import_preparation_no_intent")
        if (checkpoint.preparationIntent!!.acceptedMediaRevision == null) retrySameIntent(run)
        else inspect(run, status(run, checkpoint.state.upload!!.ticket.assetId))
    }
    /** Resolve a known existing art privately, without a picker, generation order, credit debit or implicit preparation. */
    suspend fun adoptGenerated(artId: String, revision: Long): ImportPreparationRunView = operation { run ->
        capabilities(run)
        run.checkpoint?.let { current ->
            requireThat(current.generatedSource?.calendarItemId == artId && current.generatedSource.revision == revision, "import_generated_existing_draft")
            if (run.generatedIntent != null) {
                withContext(io) { guard(run); store.clearAcceptedGeneratedIntent(run.owner, current.generatedSource!!, current.generation) }
                run.generatedIntent = null
            }
            if (current.scheduleBinding != null) return@operation reconcileSchedule(run, retry = false)
            return@operation emit(run, if (current.preparationIntent == null) ImportPreparationRunStatus.AWAITING_REQUEST else ImportPreparationRunStatus.RECONCILIATION_REQUIRED)
        }
        val intent = withContext(io) { guard(run); store.prepareGeneratedIntent(run.owner, artId, revision) }
        run.generatedIntent = intent
        guard(run)
        val source = run.api.generated(run.owner, intent); guard(run)
        requireThat(source.original == intent && source.upload.phase == ImportServerPhase.UPLOADED && source.upload.kind == ImportMediaKind.IMAGE &&
            source.upload.verifiedSha256 == source.selection.sha256 && source.upload.sizeBytes == source.selection.byteCount &&
            source.upload.mimeType == source.selection.mimeType && GalleryImportPolicy.validateSelection(source.selection) == null,
            "import_generated_response_invalid")
        val state = GalleryImportState(run.owner, UUID.randomUUID().toString(), source.selection,
            ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE), phase = ImportPhase.UPLOADED,
            upload = ImportUploadProgress(ImportUploadTicket(source.upload.uploadId, source.upload.assetId, source.selection.sha256,
                source.selection.byteCount), serverVerified = true))
        persist(run, ImportDurableCheckpoint(1, state, null, intent.idempotencyKey, uploadStartIssued = true, generatedSource = intent))
        requireThat(run.machine.restoreDurable(run.owner, draft(run)) is ImportTransition.Applied, "import_generated_checkpoint_invalid")
        withContext(io) { guard(run); store.clearAcceptedGeneratedIntent(run.owner, intent, draft(run).generation) }
        run.generatedIntent = null
        emit(run, ImportPreparationRunStatus.AWAITING_REQUEST)
    }
    /** After a confirmed receipt, discard only the local draft so a later explicit selection can begin. */
    suspend fun finishScheduledDraft(): ImportPreparationRunView = operation { run ->
        capabilities(run); val checkpoint = draft(run)
        requireThat(checkpoint.state.phase == ImportPhase.SCHEDULED && checkpoint.scheduleBinding != null, "import_schedule_receipt_required")
        val verified = reconcileSchedule(run, retry = false)
        requireThat(verified.scheduleReceipt != null, "import_schedule_receipt_required")
        if (run.generatedIntent != null) {
            val source = checkpoint.generatedSource ?: throw ImportPreparationFailure("import_generated_existing_draft")
            withContext(io) { guard(run); store.clearAcceptedGeneratedIntent(run.owner, source, draft(run).generation) }
            run.generatedIntent = null
        }
        withContext(io) { guard(run); store.clear(run.owner, draft(run).generation, checkpoint.state.draftId) }
        run.checkpoint = null; confirmedPreview = null
        emit(run, ImportPreparationRunStatus.EMPTY)
    }
    /** Configuration changes keep the verified upload and invalidate every old derived preview. */
    suspend fun configure(configuration: ImportConfiguration): ImportPreparationRunView = operation { run ->
        val checkpoint = draft(run); capabilities(run)
        requireThat(checkpoint.scheduleBinding == null && checkpoint.state.scheduleIntent == null, "import_schedule_existing_intent")
        requireThat(uploaded(checkpoint), "import_preparation_upload_required")
        requireThat(GalleryImportPolicy.validateConfiguration(checkpoint.state.selection.kind, configuration,
            run.capability!!.musicTracks) == null, "import_preparation_music_unavailable")
        if (configuration == checkpoint.state.configuration) return@operation when {
            checkpoint.preparationIntent?.acceptedMediaRevision != null -> inspect(run, status(run, checkpoint.state.upload!!.ticket.assetId))
            checkpoint.preparationIntent != null -> emit(run, ImportPreparationRunStatus.RECONCILIATION_REQUIRED)
            else -> emit(run, ImportPreparationRunStatus.AWAITING_REQUEST)
        }
        var base = checkpoint.preparationBaseRevision
        checkpoint.preparationIntent?.let { intent ->
            requireThat(intent.acceptedMediaRevision != null, "import_preparation_reconcile_required")
            val record = status(run, checkpoint.state.upload!!.ticket.assetId); guard(run); requireIdentity(run, record)
            requireThat(record.currentRevision == intent.acceptedMediaRevision && record.jobId == intent.jobId &&
                record.phase in setOf(ImportPreparationPhase.READY, ImportPreparationPhase.ATTENTION), "import_preparation_reconcile_required")
            base = record.currentRevision
        }
        confirmedPreview = null
        applied(run, ImportEvent.EditConfiguration(configuration))
        persist(run, checkpoint.copy(state = run.machine.snapshot()!!, preparationIntent = null, preparationBaseRevision = base))
        emit(run, ImportPreparationRunStatus.AWAITING_REQUEST)
    }
    /** The player supplies the exact variants it verified/displayed; this cannot authorize publication. */
    suspend fun confirmPreview(confirmation: ImportPreviewConfirmation): ImportPreparationRunView = operation { run ->
        capabilities(run); val checkpoint = draft(run)
        requireThat(checkpoint.scheduleBinding == null, "import_schedule_existing_intent")
        val viewed = inspect(run, status(run, checkpoint.state.upload!!.ticket.assetId))
        val preview = viewed.preview ?: throw ImportPreparationFailure("import_preview_unavailable")
        requireThat(matches(confirmation, preview), "import_preview_confirmation_changed")
        confirmedPreview = confirmation.copy(verifiedTargets = confirmation.verifiedTargets.toSet())
        emit(run, viewed.status, viewed.preparation, preview, availability = viewed.availability)
    }
    /** Programar is an explicit action. Its complete intent is committed before the single POST. */
    suspend fun schedule(caption: String, scheduledAtEpochMs: Long, automatic: Boolean): ImportPreparationRunView = operation { run ->
        capabilities(run); var checkpoint = draft(run)
        if (checkpoint.scheduleBinding != null) {
            val intent = checkpoint.state.scheduleIntent!!
            requireThat(intent.caption == caption.trim() && intent.scheduledAtEpochMs == scheduledAtEpochMs && intent.automatic == automatic,
                "import_schedule_conflicting_intent")
            return@operation reconcileSchedule(run, retry = true)
        }
        val viewed = inspect(run, status(run, checkpoint.state.upload!!.ticket.assetId))
        val preview = viewed.preview ?: throw ImportPreparationFailure("import_preview_unavailable")
        requireThat(confirmedPreview?.let { matches(it, preview) } == true, "import_preview_confirmation_required")
        val availability = viewed.availability ?: throw ImportPreparationFailure("import_scheduling_unavailable")
        requireThat(run.capability!!.schedulingEnabled && availability.enabled && (!automatic || availability.automaticAllowed), "import_scheduling_unavailable")
        requireThat(availability.localSimulation == run.capability!!.localSimulation && (!preview.testOnly || availability.localSimulation),
            "import_test_only_schedule_blocked")
        val now = System.currentTimeMillis()
        requireThat(scheduledAtEpochMs > now && scheduledAtEpochMs <= now + 180L * 86400000L &&
            caption.length <= 2200 && caption.none { it.code in 0..8 || it.code in 11..12 || it.code in 14..31 || it.code == 127 }, "import_schedule_invalid")
        checkpoint = draft(run)
        // A synthetic result is converted only inside the explicitly local scheduling transaction.
        // The durable intent below is marked localSimulation and can never be replayed at production.
        if (preview.testOnly && checkpoint.state.phase == ImportPhase.PREPARING) {
            applied(run, ImportEvent.PreparationReady(checkpoint.state.revision, preview.assetId, preparedVariants(viewed.preparation!!)))
        }
        applied(run, ImportEvent.PreviewConfirmed(checkpoint.state.revision))
        applied(run, ImportEvent.AvailabilityObserved(ImportOperationalAvailability(availability.automaticAllowed, true,
            availability.automaticAllowed, availability.automaticAllowed, true)))
        val intent = ImportScheduleIntent(UUID.randomUUID().toString(), checkpoint.state.revision, scheduledAtEpochMs, caption.trim(), automatic)
        val binding = ImportSchedulingProtocol.binding(preview, scheduledAtEpochMs, availability.localSimulation)
        applied(run, ImportEvent.ScheduleRequested(intent, now))
        persist(run, checkpoint.copy(state = run.machine.snapshot()!!, scheduleBinding = binding))
        emit(run, ImportPreparationRunStatus.SCHEDULING)
        finishSchedule(run, run.api.schedule(run.owner, binding, intent))
    }
    suspend fun reconcileScheduleOnce(): ImportPreparationRunView = operation { run ->
        capabilities(run); requireThat(draft(run).scheduleBinding != null, "import_schedule_no_intent")
        reconcileSchedule(run, retry = true)
    }
    private suspend fun reconcileSchedule(run: Run, retry: Boolean): ImportPreparationRunView {
        val checkpoint = draft(run); val binding = checkpoint.scheduleBinding!!; val intent = checkpoint.state.scheduleIntent!!
        requireThat(binding.localSimulation == run.capability!!.localSimulation, "import_schedule_environment_changed")
        val found = run.api.scheduleStatus(run.owner, binding, intent); guard(run)
        if (found != null) return finishSchedule(run, found)
        if (!retry || checkpoint.state.phase == ImportPhase.SCHEDULED) return emit(run, ImportPreparationRunStatus.SCHEDULE_RECONCILIATION)
        requireThat(run.capability!!.schedulingEnabled, "import_scheduling_unavailable")
        persist(run, checkpoint)
        return finishSchedule(run, run.api.schedule(run.owner, binding, intent))
    }
    private suspend fun finishSchedule(run: Run, receipt: ImportScheduleReceipt): ImportPreparationRunView {
        guard(run); val checkpoint = draft(run); val binding = checkpoint.scheduleBinding!!; val intent = checkpoint.state.scheduleIntent!!
        requireThat(receipt.assetId == binding.assetId && receipt.mediaRevision == binding.mediaRevision &&
            receipt.previewDigest == binding.previewDigest && receipt.idempotencyKey == intent.idempotencyKey &&
            receipt.localSimulation == binding.localSimulation && receipt.id.matches(Regex("[a-f0-9]{40}")), "import_schedule_receipt_invalid")
        if (checkpoint.state.phase == ImportPhase.SCHEDULING) {
            applied(run, ImportEvent.ScheduleConfirmed(intent.idempotencyKey, checkpoint.state.revision, receipt.id))
            persist(run, checkpoint.copy(state = run.machine.snapshot()!!))
        } else requireThat(checkpoint.state.phase == ImportPhase.SCHEDULED && checkpoint.state.calendarItemId == receipt.id, "import_schedule_receipt_invalid")
        confirmedPreview = null
        return emit(run, ImportPreparationRunStatus.SCHEDULED, receipt = receipt)
    }
    private fun matches(confirmation: ImportPreviewConfirmation, preview: ImportPrivatePreview) =
        preview.scheduleId == null && confirmation.assetId == preview.assetId && confirmation.mediaRevision == preview.mediaRevision &&
            confirmation.previewDigest == preview.previewDigest && confirmation.verifiedTargets == preview.variants.map { it.target }.toSet()
    private suspend fun retrySameIntent(run: Run): ImportPreparationRunView {
        val checkpoint = draft(run); val intent = checkpoint.preparationIntent!!
        requireThat(intent.sourceRevision == checkpoint.state.revision, "import_preparation_source_revision_changed")
        requireThat(GalleryImportPolicy.validateConfiguration(checkpoint.state.selection.kind, checkpoint.state.configuration, run.capability!!.musicTracks) == null,
            "import_preparation_music_unavailable")
        persist(run, checkpoint) // Durable CAS fence immediately before the one explicit POST.
        guard(run); currentCoroutineContext().ensureActive()
        val record = run.api.request(run.owner, checkpoint.state.upload!!.ticket.assetId, checkpoint.state.upload.ticket.uploadId,
            intent, checkpoint.state.selection.kind, checkpoint.state.configuration)
        guard(run); requireIdentity(run, record)
        requireThat(record.mediaRevision == intent.expectedMediaRevision + 1 && record.jobId != null,
            "import_preparation_revision_invalid")
        persist(run, draft(run).copy(preparationIntent = intent.copy(acceptedMediaRevision = record.mediaRevision, jobId = record.jobId)))
        return inspect(run, record)
    }
    private suspend fun inspect(run: Run, record: ImportPreparationRecord): ImportPreparationRunView {
        run.diagnosticStage = ImportPreparationDiagnosticStage.METADATA
        guard(run); requireIdentity(run, record)
        val checkpoint = draft(run); val intent = checkpoint.preparationIntent ?: throw ImportPreparationFailure("import_preparation_no_intent")
        requireThat(record.mediaRevision == intent.acceptedMediaRevision && record.jobId == intent.jobId &&
            record.currentRevision == record.mediaRevision && record.kind == checkpoint.state.selection.kind &&
            record.configuration == checkpoint.state.configuration, "import_preparation_revision_changed")
        if (record.phase != ImportPreparationPhase.READY) return emit(run, when (record.phase) {
            ImportPreparationPhase.QUEUED, ImportPreparationPhase.DISPATCHING, ImportPreparationPhase.PROCESSING -> ImportPreparationRunStatus.PREPARING
            ImportPreparationPhase.RECONCILIATION -> ImportPreparationRunStatus.RECONCILIATION_REQUIRED
            else -> ImportPreparationRunStatus.ATTENTION
        }, record = record, error = record.errorCode)
        ImportPreparationProtocol.validateVariants(record.kind!!, record.configuration!!, record.variants)
        requireThat(ImportPreparationProtocol.fingerprint(record.kind, record.configuration, record.testOnly, record.variants) == record.previewDigest &&
            record.variants.all { it.sourceSha256 == checkpoint.state.selection.sha256.lowercase() }, "import_preparation_source_changed")
        if (record.kind == ImportMediaKind.VIDEO) requireThat(record.variants.all {
            it.durationMs != null && abs(it.durationMs - checkpoint.state.selection.durationMs!!) <= GalleryImportPolicy.PREPARED_DURATION_TOLERANCE_MS
        }, "import_preparation_duration_changed")
        run.diagnosticStage = ImportPreparationDiagnosticStage.PREVIEW
        val preview = run.api.preview(run.owner, record); guard(run)
        requireThat(preview.assetId == record.assetId && preview.mediaRevision == record.mediaRevision &&
            preview.currentRevision == record.currentRevision && preview.previewDigest == record.previewDigest && preview.testOnly == record.testOnly,
            "import_preparation_preview_invalid")
        requireThat(preview.variants.size == record.variants.size && preview.variants.map { it.target }.toSet() ==
            record.variants.map { it.target.wire }.toSet() && preview.variants.all { part ->
                val expected = record.variants.single { it.target.wire == part.target }
                part.sha256 == expected.sha256 && part.sourceSha256 == expected.sourceSha256 && part.kind == expected.kind &&
                    part.mimeType == expected.mimeType && part.width == expected.width && part.height == expected.height &&
                    part.sizeBytes == expected.sizeBytes && part.durationMs == expected.durationMs &&
                    part.audioMode == expected.audioMode && part.hasAudio == expected.hasAudio
            }, "import_preparation_preview_invalid")
        // Synthetic test tracks can be inspected locally, never promoted into a
        // durable READY state that a future schedule adapter might accept.
        if (confirmedPreview?.let { matches(it, preview) } == false) confirmedPreview = null
        run.diagnosticStage = ImportPreparationDiagnosticStage.SCHEDULING_AVAILABILITY
        val available = if (run.capability?.schedulingEnabled == true) run.api.availability(run.owner, record).also {
            guard(run); requireThat(it.localSimulation == run.capability?.localSimulation && (!record.testOnly || !it.commercialReady), "import_schedule_availability_invalid")
        } else ImportScheduleAvailability()
        if (record.testOnly) return emit(run, ImportPreparationRunStatus.TEST_ONLY_PREVIEW, record, preview, availability = available)
        run.diagnosticStage = ImportPreparationDiagnosticStage.LOCAL_STATE
        val variants = preparedVariants(record)
        if (checkpoint.state.phase == ImportPhase.PREPARING) {
            applied(run, ImportEvent.PreparationReady(checkpoint.state.revision, record.assetId, variants))
            persist(run, draft(run).copy(state = run.machine.snapshot()!!))
        } else requireThat(checkpoint.state.phase == ImportPhase.READY && checkpoint.state.prepared == variants,
            "import_preparation_prepared_changed")
        return emit(run, ImportPreparationRunStatus.PREVIEW_AVAILABLE, record, preview, availability = available)
    }
    private fun preparedVariants(record: ImportPreparationRecord) = record.variants.map { part -> ImportPreparedVariant(part.target, part.kind, part.mimeType,
        record.assetId, part.sha256, part.audioMode, if (part.audioMode == ImportAudioMode.MUSIC) record.configuration!!.musicTrackId else null, part.durationMs) }
    private fun requireIdentity(run: Run, record: ImportPreparationRecord) {
        val ticket = draft(run).state.upload!!.ticket
        requireThat(record.assetId == ticket.assetId && record.uploadId == ticket.uploadId, "import_preparation_identity_invalid")
    }
    private fun uploaded(checkpoint: ImportDurableCheckpoint) = checkpoint.state.upload?.serverVerified == true &&
        checkpoint.state.phase in setOf(ImportPhase.UPLOADED, ImportPhase.PREPARING, ImportPhase.READY)
    private suspend fun capabilities(run: Run) {
        run.diagnosticStage = ImportPreparationDiagnosticStage.CAPABILITIES
        val capability = run.api.capabilities(); guard(run)
        requireThat(capability.enabled && capability.preparationEnabled && capability.identity == run.owner, "import_preparation_unavailable")
        run.capability = capability
        run.diagnosticStage = ImportPreparationDiagnosticStage.LOCAL_STATE
    }
    private suspend fun status(run: Run, assetId: String): ImportPreparationRecord {
        run.diagnosticStage = ImportPreparationDiagnosticStage.STATUS
        return run.api.status(run.owner, assetId)
    }
    private suspend fun persist(run: Run, value: ImportDurableCheckpoint) {
        guard(run)
        val saved = withContext(io) { guard(run); store.write(run.owner, run.checkpoint?.generation ?: 0, value) }
        guard(run); run.checkpoint = saved
    }
    private fun applied(run: Run, event: ImportEvent) {
        requireThat(run.machine.dispatch(run.owner, event) is ImportTransition.Applied, "import_preparation_transition_invalid")
    }
    private fun draft(run: Run) = run.checkpoint ?: throw ImportPreparationFailure("import_preparation_no_draft")
    private fun guard(run: Run, allowPaused: Boolean = false) {
        if (invalidated.get() || run.epoch != epoch.get() || ownerProvider() != run.owner || tokenProvider() != run.token) throw ImportPreparationSessionChanged()
        if (!allowPaused && paused.get()) throw ImportPreparationPaused()
    }
    private fun emit(run: Run, status: ImportPreparationRunStatus, record: ImportPreparationRecord? = null,
                     preview: ImportPrivatePreview? = null, error: String? = null, availability: ImportScheduleAvailability? = null,
                     receipt: ImportScheduleReceipt? = null): ImportPreparationRunView = synchronized(viewLock) {
        guard(run, allowPaused = status == ImportPreparationRunStatus.PAUSED)
        val current = run.checkpoint?.state
        val safeState = if (current?.phase == ImportPhase.READY && status != ImportPreparationRunStatus.PREVIEW_AVAILABLE)
            current.copy(phase = ImportPhase.PREPARING, prepared = emptyList(), previewConfirmedRevision = null) else current
        ImportPreparationRunView(status, safeState, record, preview,
            error?.takeIf { it.matches(Regex("[a-z0-9_]{1,100}")) }, confirmedPreview?.takeIf { preview != null && matches(it, preview) }, availability, receipt,
            run.generatedIntent ?: run.checkpoint?.generatedSource, run.diagnosticStage.takeIf { error != null }).also {
            visibleOwner = run.owner; visibleToken = run.token; visible = it; notify(it)
        }
    }
    private fun notify(value: ImportPreparationRunView) { try { onChanged(value) } catch (_: Exception) { /* Observers cannot authorize work. */ } }
    private fun clearSession(): ImportPreparationRunView = synchronized(viewLock) {
        visibleOwner = null; visibleToken = null
        ImportPreparationRunView(ImportPreparationRunStatus.SESSION_CHANGED).also { visible = it; notify(it) }
    }
    private suspend fun operation(action: suspend (Run) -> ImportPreparationRunView): ImportPreparationRunView {
        if (!mutex.tryLock()) return snapshot().copy(errorCode = "import_preparation_busy")
        var run: Run? = null
        var retainedOwner: ImportOwner? = null
        var ownerGate: OwnerGate? = null
        var ownerLocked = false
        paused.set(false)
        try { return coroutineScope {
            if (invalidated.get()) throw ImportPreparationSessionChanged()
            active = currentCoroutineContext().job
            val owner = ownerProvider() ?: throw ImportPreparationSessionChanged()
            val shared = retainOwner(owner); retainedOwner = owner; ownerGate = shared
            if (!shared.mutex.tryLock()) return@coroutineScope snapshot().copy(errorCode = "import_preparation_busy")
            ownerLocked = true
            val token = tokenProvider(); requireThat(token.isNotBlank(), "import_preparation_session_unavailable")
            val bindingEpoch = epoch.get()
            val saved = withContext(io) { store.read(owner) }
            val sourceIntent = withContext(io) { store.readGeneratedIntent(owner) }
            val machine = GalleryImportMachine(owner, tracks)
            if (saved != null) requireThat(machine.restoreDurable(owner, saved) is ImportTransition.Applied, "import_preparation_checkpoint_invalid")
            Run(owner, token, bindingEpoch, transportFactory(), machine, saved?.copy(state = machine.snapshot()!!), generatedIntent = sourceIntent).also { run = it }.let { guard(it); action(it) }
        } } catch (error: CancellationException) {
            val current = run
            if (current == null || error is ImportPreparationSessionChanged || runCatching { guard(current, allowPaused = true) }.isFailure) return clearSession()
            if (error is ImportPreparationPaused) return emit(current, ImportPreparationRunStatus.PAUSED)
            throw error
        } catch (error: Exception) {
            val current = run ?: return clearSession()
            if (runCatching { guard(current) }.isFailure) return clearSession()
            val code = when (error) { is ImportPreparationFailure -> error.code; is ImportApiFailure -> error.code
                is ImportCheckpointFailure -> error.code; else -> "import_preparation_invalid_result" }
            confirmedPreview = null
            return emit(current, if (current.checkpoint == null && current.generatedIntent != null) ImportPreparationRunStatus.SOURCE_RECONCILIATION
            else if (current.checkpoint?.scheduleBinding != null) ImportPreparationRunStatus.SCHEDULE_RECONCILIATION
            else if (current.checkpoint?.preparationIntent?.acceptedMediaRevision == null && current.checkpoint?.preparationIntent != null)
                ImportPreparationRunStatus.RECONCILIATION_REQUIRED else ImportPreparationRunStatus.ATTENTION, error = code)
        } finally {
            active = null
            ownerGate?.let { gate -> if (ownerLocked) gate.mutex.unlock(); releaseOwner(retainedOwner!!, gate) }
            mutex.unlock()
        }
    }
    private fun requireThat(value: Boolean, code: String) { if (!value) throw ImportPreparationFailure(code) }
    private class OwnerGate(val mutex: Mutex = Mutex(), var references: Int = 0)
    private companion object {
        val registryLock = Any()
        val ownerOperations = HashMap<ImportOwner, OwnerGate>()
        fun retainOwner(owner: ImportOwner): OwnerGate = synchronized(registryLock) {
            ownerOperations.getOrPut(owner) { OwnerGate() }.also { it.references++ }
        }
        fun releaseOwner(owner: ImportOwner, gate: OwnerGate) = synchronized(registryLock) {
            check(gate.references > 0 && ownerOperations[owner] === gate)
            gate.references--; if (gate.references == 0) ownerOperations.remove(owner)
        }
    }
}
