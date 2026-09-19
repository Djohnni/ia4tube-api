package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

enum class ImportUploadRunStatus { EMPTY, PAUSED, TRANSFERRING, RECONCILIATION_REQUIRED, UPLOADED, CANCEL_REQUESTED, CANCELLED, ATTENTION, SESSION_CHANGED }

/** No URI, token, grant, or remote URL is exposed to observers or toString(). */
data class ImportUploadRunView(
    val state: GalleryImportState? = null,
    val status: ImportUploadRunStatus = ImportUploadRunStatus.EMPTY,
    val acknowledgedBytes: Long = 0,
    val transferredPartBytes: Long = 0,
    val totalBytes: Long = 0,
    val errorCode: String? = null,
    val pickerPermissionRetained: Boolean? = null
) { override fun toString() = "ImportUploadRunView(status=$status, content=redacted)" }

private class ImportUploadCoordinatorFailure(val code: String) : Exception("Não foi possível continuar este envio. Confira o envio existente antes de iniciar outro.")
private class ImportUploadPaused : CancellationException("Importação pausada.")
private class ImportUploadSessionChanged : CancellationException("Sessão da importação alterada.")

/**
 * One finite, resumable upload operation at a time. No automatic polling,
 * background task, preparation, scheduling, Instagram action, or file deletion.
 * UI composition must call invalidateSession() on logout/company/token change,
 * and pause() when intentionally leaving its upload work. Reopening uses the
 * encrypted checkpoint and same start key, never a fresh replacement upload.
 */
class GalleryImportUploadCoordinator internal constructor(
    private val ownerProvider: () -> ImportOwner?,
    private val tokenProvider: () -> String,
    private val source: GalleryImportUploadSource,
    private val store: PrivateImportCheckpointStore,
    private val transportFactory: () -> GalleryImportUploadTransport,
    authorizedTracks: Collection<AuthorizedImportTrack> = emptyList(),
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val onChanged: (ImportUploadRunView) -> Unit = {}
) {
    constructor(ownerProvider: () -> ImportOwner?, tokenProvider: () -> String, source: AndroidImportSource,
                store: PrivateImportCheckpointStore, authorizedTracks: Collection<AuthorizedImportTrack> = emptyList(),
                onChanged: (ImportUploadRunView) -> Unit = {}) : this(ownerProvider, tokenProvider,
        AndroidGalleryImportUploadSource(source), store, { HttpGalleryImportUploadTransport(GalleryImportHttpApi(tokenProvider)) },
        authorizedTracks, Dispatchers.IO, onChanged)

    private class Binding(val owner: ImportOwner, val token: String, val epoch: Long) {
        override fun toString() = "ImportUploadBinding(redacted)"
    }
    private class Run(val binding: Binding, val api: GalleryImportUploadTransport, val machine: GalleryImportMachine,
                      var checkpoint: ImportDurableCheckpoint?)
    private val tracks = authorizedTracks.toList()
    private val mutex = Mutex()
    private val publicationLock = Any()
    private val epoch = AtomicLong()
    private val pauseRequested = AtomicBoolean(false)
    @Volatile private var activeJob: Job? = null
    @Volatile private var visibleBinding: Binding? = null
    @Volatile private var visible = ImportUploadRunView()

    fun snapshot(): ImportUploadRunView = synchronized(publicationLock) {
        if (visibleBinding?.let(::matches) != false) visible else ImportUploadRunView(status = ImportUploadRunStatus.SESSION_CHANGED)
    }

    fun pause() { pauseRequested.set(true); activeJob?.cancel(ImportUploadPaused()) }

    /** Does not delete the previous owner's checkpoint or cancel their remote upload. */
    fun invalidateSession() {
        epoch.incrementAndGet(); activeJob?.cancel(ImportUploadSessionChanged())
        synchronized(publicationLock) {
            visibleBinding = null; visible = ImportUploadRunView(status = ImportUploadRunStatus.SESSION_CHANGED)
            notifyChanged(visible)
        }
    }

    suspend fun select(contentUri: String, configuration: ImportConfiguration): ImportUploadRunView = operation { run ->
        requireThat(run.checkpoint == null, "import_existing_draft")
        capabilities(run)
        val retained = withContext(io) { source.retain(contentUri) }
        guard(run)
        val selection = source.inspect(contentUri); guard(run)
        applied(run, ImportEvent.Begin(UUID.randomUUID().toString(), selection, configuration))
        val intent = ImportDurableCheckpoint(1, run.machine.snapshot()!!, contentUri, UUID.randomUUID().toString(),
            uploadStartIssued = false, transferPaused = true)
        persist(run, intent)
        emit(run, ImportUploadRunStatus.PAUSED, retained = retained)
    }

    /** Loads a private draft only; opening a screen does not start or retry POSTs. */
    suspend fun restore(): ImportUploadRunView = operation { run ->
        capabilities(run)
        if (run.checkpoint == null) emit(run, ImportUploadRunStatus.EMPTY)
        else emit(run, if (run.checkpoint!!.state.phase == ImportPhase.CANCELLED) ImportUploadRunStatus.CANCELLED
            else if (run.checkpoint!!.cancelRequested) ImportUploadRunStatus.CANCEL_REQUESTED
            else ImportUploadRunStatus.PAUSED)
    }

    /** Reattaches only the same bytes after a provider permission was lost. */
    suspend fun reselectSource(contentUri: String): ImportUploadRunView = operation { run ->
        val checkpoint = draft(run); requireThat(!checkpoint.cancelRequested, "import_cancel_pending")
        capabilities(run)
        val retained = withContext(io) { source.retain(contentUri) }
        val inspected = source.inspect(contentUri); guard(run)
        requireSameSource(checkpoint.state.selection, inspected)
        persist(run, checkpoint.copy(selectedContentUri = contentUri, transferPaused = true))
        emit(run, ImportUploadRunStatus.PAUSED, retained = retained)
    }

    /** At most 20 sequential parts. No retries hidden inside a loop after uncertain results. */
    suspend fun transfer(maxParts: Int = 20): ImportUploadRunView = operation { run ->
        requireThat(maxParts in 1..20, "import_part_limit_invalid")
        val checkpoint = draft(run); capabilities(run)
        requireUploadStage(checkpoint.state)
        if (checkpoint.cancelRequested) return@operation continueCancellation(run)
        if (checkpoint.state.phase == ImportPhase.CANCELLED) return@operation emit(run, ImportUploadRunStatus.CANCELLED)
        persist(run, checkpoint.copy(transferPaused = false))
        var record = recoverUpload(run)
        if (record.phase == ImportServerPhase.VERIFYING) return@operation finishOnce(run)
        if (record.phase != ImportServerPhase.UPLOADING) return@operation showRecord(run, record)
        if (draft(run).state.upload!!.complete) return@operation finishOnce(run)
        val uri = draft(run).selectedContentUri ?: throw ImportUploadCoordinatorFailure("import_source_unavailable")
        val selected = draft(run).state.selection
        requireSameSource(selected, source.inspect(uri)); guard(run)
        var count = 0
        while (draft(run).state.upload!!.acknowledgedBytes < selected.byteCount && count < maxParts) {
            guard(run); currentCoroutineContext().ensureActive()
            val progress = draft(run).state.upload!!
            val bytes = source.part(uri, selected, progress.nextPart); guard(run)
            try {
                val expected = minOf(GalleryImportPolicy.CHUNK_BYTES.toLong(), selected.byteCount - progress.acknowledgedBytes).toInt()
                requireThat(bytes.size == expected, "import_source_changed")
                val checksums = ImportPartChecksums.calculate(bytes)
                val authorization = mutate(run) { run.api.authorizePart(run.binding.owner, record, progress.nextPart + 1, checksums) }
                val grant = mutate(run) { run.api.resolvePart(run.binding.owner, authorization, checksums) }
                mutate(run) { run.api.putPart(grant, bytes) { transferred, total ->
                    guard(run)
                    requireThat(total == bytes.size.toLong() && transferred in 0..total, "import_progress_invalid")
                    emit(run, ImportUploadRunStatus.TRANSFERRING, transferred = transferred)
                } }
                // PUT success is not acknowledgement. Only the authenticated
                // provider-observed resume response adds a durable receipt.
                record = mutate(run) { run.api.resume(run.binding.owner, progress.ticket.uploadId) }
                observe(run, record, receiptsAuthoritative = true)
                if (record.phase != ImportServerPhase.UPLOADING) return@operation showRecord(run, record)
                val receipt = draft(run).state.upload!!.receipts.getOrNull(progress.nextPart)
                requireThat(receipt?.sha256 == checksums.sha256 && receipt.bytes == bytes.size, "import_part_not_observed")
                count++
            } finally { bytes.fill(0) }
        }
        if (draft(run).state.upload!!.complete) finishOnce(run)
        else { persist(run, draft(run).copy(transferPaused = true)); emit(run, ImportUploadRunStatus.PAUSED) }
    }

    /** One bounded reconciliation initiated by a caller, not a periodic poll. */
    suspend fun reconcileOnce(): ImportUploadRunView = operation { run ->
        val checkpoint = draft(run); capabilities(run); requireUploadStage(checkpoint.state)
        if (checkpoint.cancelRequested) return@operation continueCancellation(run)
        if (checkpoint.state.upload == null && !checkpoint.uploadStartIssued) return@operation emit(run, ImportUploadRunStatus.PAUSED)
        val record = recoverUpload(run)
        if (record.phase == ImportServerPhase.VERIFYING || record.phase == ImportServerPhase.UPLOADING && draft(run).state.upload!!.complete)
            finishOnce(run) else showRecord(run, record)
    }

    /** Waits for this instance's cancelled transfer to stop before issuing cancel. */
    suspend fun requestCancel(): ImportUploadRunView {
        pause()
        return operation(wait = true) { run ->
            val checkpoint = draft(run); requireUploadStage(checkpoint.state)
            if (checkpoint.state.phase == ImportPhase.CANCELLED) return@operation emit(run, ImportUploadRunStatus.CANCELLED)
            requireThat(checkpoint.state.phase in setOf(ImportPhase.EDITING, ImportPhase.INITIALIZING,
                ImportPhase.UPLOADING, ImportPhase.CANCEL_PENDING), "import_upload_not_cancellable")
            if (checkpoint.state.upload == null && !checkpoint.uploadStartIssued) {
                applied(run, ImportEvent.Cancel)
                persist(run, checkpoint.copy(state = run.machine.snapshot()!!, transferPaused = true, cancelRequested = false))
                return@operation emit(run, ImportUploadRunStatus.CANCELLED)
            }
            // Persist even if connectivity is currently unavailable. Reopening
            // cannot interpret a lost cancellation as permission to resume bytes.
            persist(run, checkpoint.copy(transferPaused = true, cancelRequested = true))
            capabilities(run)
            continueCancellation(run)
        }
    }

    /** Explicit local reset only after cancellation is certain. Never deletes phone or remote media. */
    suspend fun discardCancelledDraft(): ImportUploadRunView = operation { run ->
        val checkpoint = draft(run)
        requireThat(checkpoint.state.phase == ImportPhase.CANCELLED, "import_discard_not_cancelled")
        guard(run)
        withContext(io) {
            guard(run)
            store.clear(run.binding.owner, checkpoint.generation, checkpoint.state.draftId)
        }
        guard(run); run.checkpoint = null
        emit(run, ImportUploadRunStatus.EMPTY)
    }

    private suspend fun continueCancellation(run: Run): ImportUploadRunView {
        if (draft(run).state.phase == ImportPhase.CANCELLED) return emit(run, ImportUploadRunStatus.CANCELLED)
        val record = recoverUpload(run)
        if (record.phase == ImportServerPhase.CANCELLED) return emit(run, ImportUploadRunStatus.CANCELLED)
        requireThat(record.phase in setOf(ImportServerPhase.CREATED, ImportServerPhase.UPLOADING, ImportServerPhase.CANCEL_PENDING),
            "import_upload_not_cancellable")
        applied(run, ImportEvent.UploadCancellationRequested(record.uploadId))
        persist(run, draft(run).copy(state = run.machine.snapshot()!!, transferPaused = true, cancelRequested = true))
        val cancelled = mutate(run) { run.api.cancel(run.binding.owner, record.uploadId) }
        requireThat(cancelled.phase in setOf(ImportServerPhase.CANCELLED, ImportServerPhase.CANCEL_PENDING), "import_cancel_result_unconfirmed")
        observe(run, cancelled)
        return showRecord(run, cancelled)
    }

    private suspend fun recoverUpload(run: Run): ImportUploadRecord {
        val checkpoint = draft(run)
        if (checkpoint.state.upload == null) {
            requireThat(checkpoint.state.phase == ImportPhase.EDITING, "import_upload_state_invalid")
            persist(run, checkpoint.copy(uploadStartIssued = true))
            val started = mutate(run) { run.api.start(run.binding.owner, checkpoint.state.selection, checkpoint.uploadStartIdempotencyKey) }
            observe(run, started)
            if (started.phase != ImportServerPhase.UPLOADING) return started
        }
        val record = mutate(run) { run.api.resume(run.binding.owner, draft(run).state.upload!!.ticket.uploadId) }
        observe(run, record, receiptsAuthoritative = true)
        return record
    }

    private suspend fun finishOnce(run: Run): ImportUploadRunView {
        val state = draft(run).state
        if (state.phase == ImportPhase.UPLOADING) applied(run, ImportEvent.UploadCompletionRequested(state.upload!!.ticket.uploadId))
        requireThat(run.machine.snapshot()!!.phase == ImportPhase.VERIFYING, "import_upload_state_invalid")
        persist(run, draft(run).copy(state = run.machine.snapshot()!!))
        val record = mutate(run) { run.api.complete(run.binding.owner, state.upload!!.ticket.uploadId) }
        observe(run, record)
        return showRecord(run, record)
    }

    private suspend fun observe(run: Run, record: ImportUploadRecord, receiptsAuthoritative: Boolean = false) {
        guard(run)
        val checkpoint = draft(run)
        val selected = checkpoint.state.selection
        requireThat(record.kind == selected.kind && record.mimeType == selected.mimeType && record.sizeBytes == selected.byteCount &&
            record.chunkBytes == GalleryImportPolicy.CHUNK_BYTES && record.partCount == ((selected.byteCount + record.chunkBytes - 1) / record.chunkBytes).toInt(),
            "import_response_binding_invalid")
        if (checkpoint.state.upload == null) applied(run, ImportEvent.UploadStarted(checkpoint.state.revision,
            ImportUploadTicket(record.uploadId, record.assetId, selected.sha256, selected.byteCount, record.chunkBytes),
            if (record.phase == ImportServerPhase.UPLOADING) ImportServerPhase.UPLOADING else ImportServerPhase.CREATED))
        val upload = run.machine.snapshot()!!.upload!!
        requireThat(upload.ticket.uploadId == record.uploadId && upload.ticket.assetId == record.assetId, "import_response_binding_invalid")
        if (record.phase == ImportServerPhase.UPLOADED) {
            requireThat(record.verifiedSha256 == selected.sha256.lowercase(), "import_verified_checksum_invalid")
            if (run.machine.snapshot()!!.phase != ImportPhase.UPLOADED) {
                applied(run, ImportEvent.UploadPhaseObserved(record.uploadId, ImportServerPhase.UPLOADED))
                applied(run, ImportEvent.UploadCompleted(record.uploadId, record.verifiedSha256!!, record.sizeBytes, record.mimeType))
            }
        } else if (!(checkpoint.cancelRequested && run.machine.snapshot()!!.phase == ImportPhase.CANCEL_PENDING &&
                record.phase in setOf(ImportServerPhase.CREATED, ImportServerPhase.UPLOADING))) {
            applied(run, ImportEvent.UploadPhaseObserved(record.uploadId, record.phase))
        }
        if (receiptsAuthoritative && record.phase == ImportServerPhase.UPLOADING && run.machine.snapshot()!!.phase == ImportPhase.UPLOADING) {
            val known = run.machine.snapshot()!!.upload!!.receipts
            requireThat(record.completedParts.size >= known.size, "import_receipts_changed")
            record.completedParts.forEachIndexed { index, receipt ->
                requireThat(receipt.part == index, "import_receipts_changed")
                applied(run, ImportEvent.PartAcknowledged(record.uploadId, receipt))
            }
        }
        persist(run, checkpoint.copy(state = run.machine.snapshot()!!, uploadStartIssued = true))
    }

    private suspend fun capabilities(run: Run) {
        guard(run)
        val capabilities = run.api.capabilities(); guard(run)
        requireThat(capabilities.enabled && capabilities.identity == run.binding.owner, "import_owner_unavailable")
        run.checkpoint?.state?.selection?.let { selected ->
            val maximum = if (selected.kind == ImportMediaKind.IMAGE) capabilities.maxImageBytes else capabilities.maxVideoBytes
            requireThat(selected.byteCount <= maximum, "import_current_size_limit")
        }
    }

    private fun requireUploadStage(state: GalleryImportState) = requireThat(state.phase !in setOf(ImportPhase.PREPARING,
        ImportPhase.READY, ImportPhase.SCHEDULING, ImportPhase.SCHEDULED), "import_upload_stage_finished")
    private fun requireSameSource(selected: ImportSelection, inspected: ImportSelection) = requireThat(
        selected.copy(selectionId = inspected.selectionId) == inspected, "import_source_changed")
    private fun applied(run: Run, event: ImportEvent) {
        guard(run)
        val result = run.machine.dispatch(run.binding.owner, event)
        if (result is ImportTransition.Rejected) throw ImportUploadCoordinatorFailure("import_transition_${result.reason.name.lowercase()}")
    }
    private fun draft(run: Run) = run.checkpoint ?: throw ImportUploadCoordinatorFailure("import_no_draft")
    private suspend fun <T> mutate(run: Run, action: suspend () -> T): T {
        persist(run, draft(run)) // CAS fence before every POST/PUT; no secret payload is persisted.
        guard(run); currentCoroutineContext().ensureActive()
        return action().also { guard(run) }
    }
    private suspend fun persist(run: Run, checkpoint: ImportDurableCheckpoint, ignorePause: Boolean = false) {
        guard(run, ignorePause)
        val saved = withContext(io) {
            guard(run, ignorePause)
            store.write(run.binding.owner, run.checkpoint?.generation ?: 0, checkpoint)
        }
        guard(run, ignorePause); run.checkpoint = saved
    }
    private fun showRecord(run: Run, record: ImportUploadRecord): ImportUploadRunView = emit(run, when (record.phase) {
        ImportServerPhase.UPLOADED -> ImportUploadRunStatus.UPLOADED
        ImportServerPhase.CANCELLED -> ImportUploadRunStatus.CANCELLED
        ImportServerPhase.CANCEL_PENDING -> ImportUploadRunStatus.CANCEL_REQUESTED
        ImportServerPhase.CREATED, ImportServerPhase.VERIFYING -> ImportUploadRunStatus.RECONCILIATION_REQUIRED
        ImportServerPhase.UPLOADING -> ImportUploadRunStatus.PAUSED
        else -> ImportUploadRunStatus.ATTENTION
    }, error = record.errorCode)
    private fun emit(run: Run, status: ImportUploadRunStatus, error: String? = null, transferred: Long = 0,
                     retained: Boolean? = null): ImportUploadRunView {
        guard(run, ignorePause = status != ImportUploadRunStatus.TRANSFERRING)
        val state = run.checkpoint?.state
        val value = ImportUploadRunView(state, status, state?.upload?.acknowledgedBytes ?: 0, transferred,
            state?.selection?.byteCount ?: 0, error?.takeIf { it.matches(Regex("[a-z0-9_]{1,100}")) }, retained)
        synchronized(publicationLock) {
            guard(run, ignorePause = status != ImportUploadRunStatus.TRANSFERRING)
            visibleBinding = run.binding; visible = value; notifyChanged(value)
        }
        return value
    }
    private fun notifyChanged(value: ImportUploadRunView) { try { onChanged(value) } catch (_: Exception) { /* UI failures never authorize retries. */ } }
    private fun matches(binding: Binding): Boolean = try {
        binding.epoch == epoch.get() && ownerProvider() == binding.owner && tokenProvider() == binding.token
    } catch (_: Exception) { false }
    private fun guard(run: Run, ignorePause: Boolean = false) {
        if (!matches(run.binding)) throw ImportUploadSessionChanged()
        if (!ignorePause && pauseRequested.get()) throw ImportUploadPaused()
    }
    private fun capture(): Binding {
        val owner = ownerProvider() ?: throw ImportUploadSessionChanged()
        GalleryImportHttpApi.uuid(owner.companyId); GalleryImportHttpApi.uuid(owner.userId)
        val token = tokenProvider()
        requireThat(token.isNotBlank() && token.length <= 16384 && token.none { it == '\r' || it == '\n' }, "import_session_unavailable")
        return Binding(owner, token, epoch.get())
    }

    private suspend fun operation(wait: Boolean = false, action: suspend (Run) -> ImportUploadRunView): ImportUploadRunView {
        if (wait) mutex.lock() else if (!mutex.tryLock()) return snapshot().copy(errorCode = "import_operation_busy")
        var run: Run? = null
        var retainedOwner: ImportOwner? = null
        var ownerGate: OwnerGate? = null
        var ownerLocked = false
        pauseRequested.set(false)
        try {
            return coroutineScope {
                activeJob = currentCoroutineContext().job
                val binding = capture()
                val shared = retainOwnerGate(binding.owner)
                retainedOwner = binding.owner; ownerGate = shared
                if (!shared.mutex.tryLock()) return@coroutineScope snapshot().copy(errorCode = "import_operation_busy")
                ownerLocked = true
                val loaded = withContext(io) { store.read(binding.owner) }
                val machine = GalleryImportMachine(binding.owner, tracks)
                if (loaded != null) requireThat(machine.restoreDurable(binding.owner, loaded) is ImportTransition.Applied, "import_checkpoint_invalid")
                // Publish the restored machine's fail-closed state, never old
                // operational availability or a persisted preview acknowledgement.
                val checkpoint = loaded?.copy(state = machine.snapshot()!!)
                Run(binding, transportFactory(), machine, checkpoint).also { run = it }.let { guard(it); action(it) }
            }
        } catch (error: CancellationException) {
            val current = run
            if (current == null || !matches(current.binding) || error is ImportUploadSessionChanged) {
                return clearVisibleSession()
            }
            withContext(NonCancellable) {
                current.checkpoint?.let { checkpoint ->
                    try { persist(current, checkpoint.copy(transferPaused = true), ignorePause = true) }
                    catch (_: ImportCheckpointFailure) { /* Preserve the newer durable checkpoint. */ }
                }
            }
            val view = emit(current, if (current.checkpoint?.cancelRequested == true) ImportUploadRunStatus.CANCEL_REQUESTED else ImportUploadRunStatus.PAUSED)
            if (error !is ImportUploadPaused && !pauseRequested.get()) throw error
            return view
        } catch (error: Exception) {
            val current = run
            if (current == null || !matches(current.binding)) {
                return clearVisibleSession()
            }
            val code = when (error) {
                is ImportApiFailure -> error.code
                is ImportCheckpointFailure -> error.code
                is ImportUploadCoordinatorFailure -> error.code
                is ImportSourceFailure -> "import_source_unavailable"
                else -> "import_operation_unavailable"
            }
            val uncertain = error is ImportApiFailure || code == "import_part_not_observed" || code == "checkpoint_conflict"
            return emit(current, if (current.checkpoint?.cancelRequested == true) ImportUploadRunStatus.CANCEL_REQUESTED
                else if (uncertain) ImportUploadRunStatus.RECONCILIATION_REQUIRED else ImportUploadRunStatus.ATTENTION, error = code)
        } finally {
            activeJob = null
            ownerGate?.let { gate ->
                if (ownerLocked) gate.mutex.unlock()
                releaseOwnerGate(retainedOwner!!, gate)
            }
            mutex.unlock()
        }
    }
    private fun clearVisibleSession(): ImportUploadRunView = synchronized(publicationLock) {
        visibleBinding = null; visible = ImportUploadRunView(status = ImportUploadRunStatus.SESSION_CHANGED)
        notifyChanged(visible); visible
    }
    private fun requireThat(value: Boolean, code: String) { if (!value) throw ImportUploadCoordinatorFailure(code) }
    private class OwnerGate(val mutex: Mutex = Mutex(), var references: Int = 0)
    private companion object {
        val registryLock = Any()
        val ownerOperations = HashMap<ImportOwner, OwnerGate>()
        fun retainOwnerGate(owner: ImportOwner): OwnerGate = synchronized(registryLock) {
            ownerOperations.getOrPut(owner) { OwnerGate() }.also { it.references++ }
        }
        fun releaseOwnerGate(owner: ImportOwner, gate: OwnerGate) = synchronized(registryLock) {
            check(gate.references > 0 && ownerOperations[owner] === gate)
            gate.references--
            // Every waiter/contender retains its reference before touching the
            // mutex, so an old waiter can never overlap a newly created gate.
            if (gate.references == 0) ownerOperations.remove(owner)
        }
    }
}
