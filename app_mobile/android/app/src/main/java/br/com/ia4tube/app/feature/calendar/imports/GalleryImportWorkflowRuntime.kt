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
    val error: String? = null, val sessionValid: Boolean = true) {
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

internal class GalleryImportWorkflowRuntime(context: Context, private val owner: ImportOwner, private val token: String,
    private val tokenProvider: () -> String, capabilities: ImportCapabilities, store: PrivateImportCheckpointStore,
    private val scope: CoroutineScope) : GalleryImportWorkflowActions {
    private val lock = Any()
    private var disposed = false
    private var invalidated = false
    private var operation: Job? = null
    private val mutable = MutableStateFlow(ImportWorkflowView(owner, capabilities))
    val state = mutable.asStateFlow()
    private fun ownerProvider(): ImportOwner? = if (valid()) owner else null
    private val upload = GalleryImportUploadCoordinator(::ownerProvider, tokenProvider, AndroidImportSource(context), store,
        capabilities.musicTracks, onChanged = { view -> synchronized(lock) {
            if (valid()) mutable.value = mutable.value.copy(upload = view)
        } })
    private val preparation = GalleryImportPreparationCoordinator(::ownerProvider, tokenProvider, store,
        capabilities.musicTracks, onChanged = { view -> synchronized(lock) {
            if (valid()) mutable.value = mutable.value.copy(preparation = view)
        } })
    private fun valid(): Boolean {
        if (disposed || invalidated || token.isBlank() || !runCatching { tokenProvider() == token }.getOrDefault(false)) invalidated = true
        return !invalidated
    }
    fun start() {
        synchronized(lock) {
            if (!valid()) { invalidate(); return }
            mutable.value = mutable.value.copy(foreground = true)
        }
        restore()
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
            mutable.value = mutable.value.copy(upload = ImportUploadRunView(status = ImportUploadRunStatus.SESSION_CHANGED),
                preparation = null, busy = false, foreground = false, sessionValid = false, error = "A sessão mudou. Reabra na empresa correta.")
        }
        upload.invalidateSession(); preparation.invalidateSession()
    }
    override fun restore() = launch {
        upload.restore()
        preparation.restore()
    }
    fun select(uri: String, kind: ImportMediaKind) = launch {
        mutable.value = mutable.value.copy(preparation = null)
        upload.select(uri, if (kind == ImportMediaKind.IMAGE) ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE)
            else ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL, shareToFeed = true))
    }
    fun reselect(uri: String) = launch { upload.reselectSource(uri) }
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
