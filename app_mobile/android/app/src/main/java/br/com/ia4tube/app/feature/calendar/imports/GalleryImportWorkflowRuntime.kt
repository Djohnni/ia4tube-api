package br.com.ia4tube.app.feature.calendar.imports

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

internal data class ImportWorkflowView(val owner: ImportOwner, val capabilities: ImportCapabilities,
    val upload: ImportUploadRunView = ImportUploadRunView(), val preparation: ImportPreparationRunView? = null,
    val busy: Boolean = false, val foreground: Boolean = false, val initialized: Boolean = false,
    val pickerResultPending: Boolean = false, val error: String? = null, val sessionValid: Boolean = true) {
    val draft: GalleryImportState? get() = preparation?.state ?: upload.state
    override fun toString() = "ImportWorkflowView(busy=$busy, content=redacted)"
}

/** The screen owns this one session-bound runtime. Entering/restoring is read-only; every mutation is a named user action. */
internal interface GalleryImportWorkflowActions {
    fun restore()
    fun transfer()
    fun reconcileUpload()
    fun cancelUpload()
    fun discardCancelled()
    fun configure(value: ImportConfiguration)
    fun prepare()
    fun refreshPreparation()
    fun adoptGenerated(id: String, revision: Long)
    fun confirm(value: ImportPreviewConfirmation)
    fun schedule(caption: String, at: Long, automatic: Boolean)
    fun reconcileSchedule()
    fun pauseTransfer()
    fun finishScheduledDraft()
}

internal interface GalleryImportPreparationControl {
    suspend fun restore(): ImportPreparationRunView
    suspend fun configure(value: ImportConfiguration): ImportPreparationRunView
    suspend fun request(): ImportPreparationRunView
    suspend fun reconcileOnce(): ImportPreparationRunView
    suspend fun adoptGenerated(id: String, revision: Long): ImportPreparationRunView
    suspend fun confirmPreview(value: ImportPreviewConfirmation): ImportPreparationRunView
    suspend fun schedule(caption: String, at: Long, automatic: Boolean): ImportPreparationRunView
    suspend fun reconcileScheduleOnce(): ImportPreparationRunView
    suspend fun finishScheduledDraft(): ImportPreparationRunView
    fun pause()
    fun invalidateSession()
}

private class CoordinatedGalleryImportPreparation(private val coordinator: GalleryImportPreparationCoordinator) :
    GalleryImportPreparationControl {
    override suspend fun restore() = coordinator.restore()
    override suspend fun configure(value: ImportConfiguration) = coordinator.configure(value)
    override suspend fun request() = coordinator.request()
    override suspend fun reconcileOnce() = coordinator.reconcileOnce()
    override suspend fun adoptGenerated(id: String, revision: Long) = coordinator.adoptGenerated(id, revision)
    override suspend fun confirmPreview(value: ImportPreviewConfirmation) = coordinator.confirmPreview(value)
    override suspend fun schedule(caption: String, at: Long, automatic: Boolean) = coordinator.schedule(caption, at, automatic)
    override suspend fun reconcileScheduleOnce() = coordinator.reconcileScheduleOnce()
    override suspend fun finishScheduledDraft() = coordinator.finishScheduledDraft()
    override fun pause() = coordinator.pause()
    override fun invalidateSession() = coordinator.invalidateSession()
}

internal class GalleryImportWorkflowRuntime internal constructor(private val owner: ImportOwner, private val token: String,
    private val tokenProvider: () -> String, capabilities: ImportCapabilities, private val scope: CoroutineScope,
    uploadFactory: (() -> ImportOwner?, (ImportUploadRunView) -> Unit) -> GalleryImportUploadControl,
    preparationFactory: (() -> ImportOwner?, (ImportPreparationRunView) -> Unit) -> GalleryImportPreparationControl) :
    GalleryImportWorkflowActions {
    constructor(context: Context, owner: ImportOwner, token: String, tokenProvider: () -> String,
                capabilities: ImportCapabilities, store: PrivateImportCheckpointStore, scope: CoroutineScope) : this(
        owner, token, tokenProvider, capabilities, scope,
        { ownerGate, changed -> CoordinatedGalleryImportUpload(GalleryImportUploadCoordinator(ownerGate,
            tokenProvider, AndroidImportSource(context), store, capabilities.musicTracks, onChanged = changed)) },
        { ownerGate, changed -> CoordinatedGalleryImportPreparation(GalleryImportPreparationCoordinator(
            ownerGate, tokenProvider, store, capabilities.musicTracks, onChanged = changed)) })

    private data class PendingPickerResult(val owner: ImportOwner, val token: String, val requestId: Long, val uri: String,
                                           val kind: ImportMediaKind?, val reselect: Boolean) {
        override fun toString() = "PendingPickerResult(content=redacted)"
    }
    private enum class RestoreDisposition { READY, RETAIN, REJECT }

    private val lock = Any()
    private var disposed = false
    private var invalidated = false
    private var operation: Job? = null
    private var restoring = false
    private var pickerResultRunning = false
    private var pendingPickerResult: PendingPickerResult? = null
    private var lastPickerRequestId = 0L
    private val mutable = MutableStateFlow(ImportWorkflowView(owner, capabilities))
    val state = mutable.asStateFlow()
    private fun ownerProvider(): ImportOwner? = if (valid()) owner else null
    private val upload = uploadFactory(::ownerProvider) { view -> synchronized(lock) {
            if (valid()) mutable.value = mutable.value.copy(upload = view)
        } }
    private val preparation = preparationFactory(::ownerProvider) { view -> synchronized(lock) {
            if (valid()) mutable.value = mutable.value.copy(preparation = view)
        } }
    private fun valid(): Boolean {
        if (disposed || invalidated || token.isBlank() || !runCatching { tokenProvider() == token }.getOrDefault(false)) invalidated = true
        return !invalidated
    }
    fun start() {
        synchronized(lock) {
            if (!valid()) { invalidate(); return }
            mutable.value = mutable.value.copy(foreground = true)
            startRestoreLocked()
        }
    }
    fun pause() {
        synchronized(lock) { mutable.value = mutable.value.copy(foreground = false) }
        upload.pause(); preparation.pause()
    }
    override fun pauseTransfer() { upload.pause() }
    fun dispose() {
        synchronized(lock) { disposed = true }
        invalidate(); operation?.cancel()
    }
    private fun invalidate() {
        synchronized(lock) {
            invalidated = true
            pendingPickerResult = null
            restoring = false
            pickerResultRunning = false
            mutable.value = mutable.value.copy(upload = ImportUploadRunView(status = ImportUploadRunStatus.SESSION_CHANGED),
                preparation = null, busy = false, foreground = false, pickerResultPending = false, sessionValid = false,
                error = "A sessão mudou. Reabra na empresa correta.")
        }
        upload.invalidateSession(); preparation.invalidateSession()
    }
    override fun restore() = synchronized(lock) {
        if (!valid()) { invalidate(); return@synchronized }
        startRestoreLocked()
    }
    fun select(requestId: Long, uri: String, kind: ImportMediaKind) =
        acceptPickerResult(PendingPickerResult(owner, token, requestId, uri, kind, false))
    fun reselect(requestId: Long, uri: String) =
        acceptPickerResult(PendingPickerResult(owner, token, requestId, uri, null, true))
    override fun transfer() = launch { upload.transfer(); preparation.restore() }
    override fun reconcileUpload() = launch { upload.reconcileOnce(); preparation.restore() }
    override fun cancelUpload() = launch { upload.requestCancel() }
    override fun discardCancelled() = launch { upload.discardCancelledDraft(); mutable.value = mutable.value.copy(preparation = null) }
    override fun configure(value: ImportConfiguration) = launch { preparation.configure(value) }
    override fun prepare() = launch { preparation.request() }
    override fun refreshPreparation() = launch { preparation.reconcileOnce() }
    override fun adoptGenerated(id: String, revision: Long) = launch { preparation.adoptGenerated(id, revision) }
    override fun confirm(value: ImportPreviewConfirmation) = launch { preparation.confirmPreview(value) }
    override fun schedule(caption: String, at: Long, automatic: Boolean) = launch { preparation.schedule(caption, at, automatic) }
    override fun reconcileSchedule() = launch { preparation.reconcileScheduleOnce() }
    override fun finishScheduledDraft() = launch { preparation.finishScheduledDraft(); upload.restore() }

    /**
     * ActivityResult can be delivered in the same lifecycle turn that calls [start]. The restore owns `busy`
     * in that interval, so a picker result must be held by this exact runtime/session instead of being dropped.
     * Only the first result is retained, in memory, and it never transfers bytes by itself.
     */
    private fun acceptPickerResult(result: PendingPickerResult) {
        synchronized(lock) {
            if (!valid() || result.owner != owner || result.token != token || result.requestId <= 0L || result.uri.isBlank()) {
                if (!valid()) invalidate()
                return
            }
            if (result.requestId <= lastPickerRequestId) return
            lastPickerRequestId = result.requestId
            if (pendingPickerResult != null || pickerResultRunning) return
            if (restoring || !mutable.value.foreground) {
                pendingPickerResult = result
                mutable.value = mutable.value.copy(pickerResultPending = true)
                return
            }
            // A picker was launched only from an idle view. A different busy operation means the result no
            // longer has an unambiguous target, so fail closed instead of replacing or duplicating a draft.
            if (mutable.value.busy) return
            startPickerResultLocked(result)
        }
    }

    private fun startRestoreLocked() {
        if (mutable.value.busy) return
        restoring = true
        mutable.value = mutable.value.copy(busy = true, error = null)
        operation = scope.launch {
            var completed = false
            var restoredUpload: ImportUploadRunView? = null
            var restoredPreparation: ImportPreparationRunView? = null
            try {
                if (!valid()) { invalidate(); return@launch }
                restoredUpload = upload.restore()
                if (!valid()) { invalidate(); return@launch }
                restoredPreparation = preparation.restore()
                completed = valid()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                synchronized(lock) { if (valid()) mutable.value = mutable.value.copy(error =
                    "Esta etapa foi interrompida. Confira o resultado existente antes de continuar.") }
            } finally {
                var deferred: PendingPickerResult? = null
                synchronized(lock) {
                    restoring = false
                    if (valid()) {
                        val disposition = if (completed && mutable.value.foreground) pendingPickerResult?.let {
                            pickerRestoreDisposition(it, restoredUpload, restoredPreparation)
                        } else null
                        val waitingForAuthoritativeRestore = pendingPickerResult != null &&
                            (!completed || disposition == RestoreDisposition.RETAIN)
                        mutable.value = mutable.value.copy(busy = false,
                            initialized = !waitingForAuthoritativeRestore)
                        when (disposition) {
                            RestoreDisposition.READY -> {
                                deferred = pendingPickerResult
                                pendingPickerResult = null
                                mutable.value = mutable.value.copy(pickerResultPending = false)
                            }
                            RestoreDisposition.REJECT -> {
                                pendingPickerResult = null
                                mutable.value = mutable.value.copy(pickerResultPending = false, error =
                                    "Já existe um trabalho desta conta. Confira-o antes de escolher outro arquivo.")
                            }
                            RestoreDisposition.RETAIN, null -> Unit
                        }
                    } else invalidate()
                }
                // This request was already authenticated and de-duplicated when ActivityResult delivered it.
                // Do not route it through acceptPickerResult again or its one-shot request id would reject itself.
                deferred?.let { synchronized(lock) { startPickerResultLocked(it) } }
            }
        }
    }

    private fun pickerRestoreDisposition(result: PendingPickerResult, upload: ImportUploadRunView?,
                                         preparation: ImportPreparationRunView?): RestoreDisposition {
        if (upload == null || preparation == null || upload.status in setOf(ImportUploadRunStatus.ATTENTION,
                ImportUploadRunStatus.SESSION_CHANGED) || upload.errorCode != null ||
            preparation.status in setOf(ImportPreparationRunStatus.ATTENTION, ImportPreparationRunStatus.SESSION_CHANGED,
                ImportPreparationRunStatus.PAUSED) || preparation.errorCode != null) return RestoreDisposition.RETAIN
        return if (result.reselect) {
            when {
                upload.status == ImportUploadRunStatus.PAUSED && upload.state != null &&
                    preparation.status == ImportPreparationRunStatus.UPLOAD_REQUIRED -> RestoreDisposition.READY
                upload.status == ImportUploadRunStatus.EMPTY && upload.state == null &&
                    preparation.status == ImportPreparationRunStatus.EMPTY && preparation.state == null &&
                    preparation.generatedSourceIntent == null -> RestoreDisposition.REJECT
                upload.state != null || preparation.state != null || preparation.generatedSourceIntent != null ->
                    RestoreDisposition.REJECT
                else -> RestoreDisposition.RETAIN
            }
        } else {
            when {
                upload.status == ImportUploadRunStatus.EMPTY && upload.state == null &&
                    preparation.status == ImportPreparationRunStatus.EMPTY && preparation.state == null &&
                    preparation.generatedSourceIntent == null -> RestoreDisposition.READY
                upload.state != null || preparation.state != null || preparation.generatedSourceIntent != null ->
                    RestoreDisposition.REJECT
                else -> RestoreDisposition.RETAIN
            }
        }
    }

    private fun startPickerResultLocked(result: PendingPickerResult) {
        if (!valid() || !mutable.value.foreground || mutable.value.busy || result.owner != owner || result.token != token) {
            if (valid() && (!mutable.value.foreground || mutable.value.busy) && pendingPickerResult == null) {
                pendingPickerResult = result
                mutable.value = mutable.value.copy(pickerResultPending = true)
            }
            return
        }
        pickerResultRunning = true
        mutable.value = mutable.value.copy(busy = true, pickerResultPending = false, error = null)
        operation = scope.launch {
            try {
                if (!valid() || !synchronized(lock) { mutable.value.foreground }) {
                    synchronized(lock) { if (valid() && pendingPickerResult == null) {
                        pendingPickerResult = result
                        mutable.value = mutable.value.copy(pickerResultPending = true)
                    } }
                    return@launch
                }
                if (result.reselect) upload.reselectSource(result.uri)
                else {
                    synchronized(lock) { if (valid()) mutable.value = mutable.value.copy(preparation = null) }
                    val kind = result.kind ?: return@launch
                    upload.select(result.uri, if (kind == ImportMediaKind.IMAGE)
                        ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE)
                    else ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL, shareToFeed = true))
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                synchronized(lock) { if (valid()) mutable.value = mutable.value.copy(error =
                    "Esta etapa foi interrompida. Confira o resultado existente antes de continuar.") }
            } finally { synchronized(lock) {
                pickerResultRunning = false
                if (valid()) mutable.value = mutable.value.copy(busy = false, initialized = true) else invalidate()
            } }
        }
    }

    private fun launch(action: suspend () -> Unit) {
        synchronized(lock) {
            if (!valid()) { invalidate(); return }
            if (mutable.value.busy || !mutable.value.foreground) return
            mutable.value = mutable.value.copy(busy = true, error = null)
            operation = scope.launch {
                try {
                    if (!valid()) { invalidate(); return@launch }
                    action()
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) {
                    synchronized(lock) { if (valid()) mutable.value = mutable.value.copy(error =
                        "Esta etapa foi interrompida. Confira o resultado existente antes de continuar.") }
                } finally { synchronized(lock) {
                    if (valid()) mutable.value = mutable.value.copy(busy = false, initialized = true) else invalidate()
                } }
            }
        }
    }
}
