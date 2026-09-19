package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

internal interface GalleryImportUploadControl {
    suspend fun restore(): ImportUploadRunView
    suspend fun select(uri: String, configuration: ImportConfiguration): ImportUploadRunView
    suspend fun reselectSource(uri: String): ImportUploadRunView
    suspend fun transfer(): ImportUploadRunView
    suspend fun reconcileOnce(): ImportUploadRunView
    suspend fun requestCancel(): ImportUploadRunView
    suspend fun discardCancelledDraft(): ImportUploadRunView
    fun pause()
    fun invalidateSession()
}

internal class CoordinatedGalleryImportUpload(private val coordinator: GalleryImportUploadCoordinator) : GalleryImportUploadControl {
    override suspend fun restore() = coordinator.restore()
    override suspend fun select(uri: String, configuration: ImportConfiguration) = coordinator.select(uri, configuration)
    override suspend fun reselectSource(uri: String) = coordinator.reselectSource(uri)
    override suspend fun transfer() = coordinator.transfer()
    override suspend fun reconcileOnce() = coordinator.reconcileOnce()
    override suspend fun requestCancel() = coordinator.requestCancel()
    override suspend fun discardCancelledDraft() = coordinator.discardCancelledDraft()
    override fun pause() = coordinator.pause()
    override fun invalidateSession() = coordinator.invalidateSession()
}

enum class GalleryImportUploadAction { SELECT_PHOTO, SELECT_VIDEO, RESELECT_SOURCE, SEND_FILE, PAUSE, CANCEL, RECONCILE, DISCARD_CANCELLED }

/** Display-only fields: no URI, credential, owner identifiers, remote URLs or checksums. */
data class GalleryImportUploadUiState(
    val title: String,
    val detail: String,
    val selectedSummary: String? = null,
    val confirmedProgress: Float? = null,
    val currentPartProgress: Float? = null,
    val busy: Boolean = false,
    val actions: Set<GalleryImportUploadAction> = emptySet(),
    val error: String? = null
)

internal fun galleryImportUploadPresentation(view: ImportUploadRunView, busy: Boolean, foreground: Boolean,
                                           initialized: Boolean, sessionValid: Boolean): GalleryImportUploadUiState {
    if (!sessionValid || view.status == ImportUploadRunStatus.SESSION_CHANGED) return GalleryImportUploadUiState(
        "Sessão alterada", "Volte e entre na empresa correta para continuar. Nenhum arquivo de outra sessão será exibido.")
    val state = view.state
    val uploaded = state?.phase == ImportPhase.UPLOADED && state.upload?.serverVerified == true
    val finished = state?.phase in setOf(ImportPhase.PREPARING, ImportPhase.READY, ImportPhase.SCHEDULING, ImportPhase.SCHEDULED)
    val cancelled = state?.phase == ImportPhase.CANCELLED
    val cancelling = state?.phase == ImportPhase.CANCEL_PENDING || view.status == ImportUploadRunStatus.CANCEL_REQUESTED
    val uncertain = view.status == ImportUploadRunStatus.RECONCILIATION_REQUIRED || state?.phase == ImportPhase.VERIFYING ||
        state?.phase == ImportPhase.INITIALIZING
    val summary = state?.selection?.let { selected ->
        val type = if (selected.kind == ImportMediaKind.IMAGE) "Foto" else "Vídeo"
        val kib = (selected.byteCount + 1023) / 1024
        "$type · $kib KB · ${selected.width} × ${selected.height}" + (selected.durationMs?.let { " · ${(it + 999) / 1000} s" } ?: "")
    }
    val title = when {
        !initialized -> "Conferindo envio salvo…"
        cancelled -> "Envio cancelado"
        cancelling -> "Cancelamento em conferência"
        uploaded -> "Arquivo enviado — aguardando preparo"
        finished -> "A etapa de envio deste arquivo terminou"
        uncertain -> "Precisamos conferir este envio"
        busy && view.status == ImportUploadRunStatus.TRANSFERRING -> "Enviando arquivo…"
        busy -> "Conferindo arquivo…"
        state != null -> "Arquivo selecionado"
        else -> "Adicionar foto ou vídeo"
    }
    val detail = when {
        !initialized -> "Apenas conferimos o rascunho desta conta. Abrir esta tela não envia arquivos."
        cancelled -> "O envio foi cancelado. Você pode retirar este rascunho local para escolher outro arquivo. O original do celular não será apagado."
        cancelling -> "Confira o resultado antes de escolher outro arquivo. Não retomaremos os bytes enquanto o cancelamento estiver pendente."
        uploaded -> "O servidor confirmou o recebimento. Ainda falta preparar o arquivo e conferir a prévia; ele não está programado nem publicado."
        finished -> "Volte ao calendário para conferir a etapa atual. Esta tela não altera a programação."
        uncertain -> "Use Conferir envio para recuperar o resultado do mesmo arquivo, sem criar um envio substituto."
        busy -> "Você pode pausar. A parte em trânsito só conta como recebida depois da confirmação do servidor."
        state != null -> "Toque em Enviar arquivo para transferir à iA4tube. Isso não publica nem programa no Instagram."
        else -> "Escolha somente o arquivo que deseja importar. Nenhum envio começa automaticamente."
    }
    val actions = linkedSetOf<GalleryImportUploadAction>()
    if (foreground) {
        if (busy) actions.add(GalleryImportUploadAction.PAUSE)
        else if (!initialized) actions.add(GalleryImportUploadAction.RECONCILE)
        else if (cancelled) actions.add(GalleryImportUploadAction.DISCARD_CANCELLED)
        else if (!finished) {
            if (state == null && view.errorCode == null) actions.addAll(listOf(GalleryImportUploadAction.SELECT_PHOTO, GalleryImportUploadAction.SELECT_VIDEO))
            else {
                actions.add(GalleryImportUploadAction.RECONCILE)
                if (!cancelling && !uploaded) {
                    if (!uncertain && state?.phase in setOf(ImportPhase.EDITING, ImportPhase.UPLOADING)) actions.add(GalleryImportUploadAction.SEND_FILE)
                    if (state?.phase in setOf(ImportPhase.EDITING, ImportPhase.INITIALIZING, ImportPhase.UPLOADING)) actions.add(GalleryImportUploadAction.CANCEL)
                    if (state != null && (view.errorCode in setOf("import_source_unavailable", "import_source_changed") ||
                                view.pickerPermissionRetained == false)) actions.add(GalleryImportUploadAction.RESELECT_SOURCE)
                }
            }
        }
    }
    val error = when (view.errorCode) {
        null -> if (view.pickerPermissionRetained == false) "O Android não garantiu acesso duradouro a este arquivo. Talvez seja preciso selecioná-lo novamente para retomar." else null
        "import_source_unavailable" -> "Não conseguimos ler o arquivo. Selecione novamente o mesmo original; o envio existente será preservado."
        "import_source_changed" -> "O arquivo escolhido é diferente. Selecione novamente o original deste envio."
        "import_owner_unavailable" -> "A importação ainda não está disponível para esta conta. Nenhum novo envio foi iniciado."
        "import_upload_not_cancellable" -> "Este envio já avançou e não pode ser cancelado aqui. Confira o estado existente."
        "checkpoint_conflict" -> "O rascunho mudou em outra operação. Confira o envio antes de continuar."
        else -> "Não foi possível concluir esta etapa. Confira o envio existente antes de tentar novamente."
    }
    val progress = if (uploaded) 1f else if (view.totalBytes > 0) (view.acknowledgedBytes.toDouble() / view.totalBytes).coerceIn(0.0, 1.0).toFloat() else null
    val partSize = if (view.totalBytes > 0) minOf(GalleryImportPolicy.CHUNK_BYTES.toLong(), view.totalBytes - view.acknowledgedBytes) else 0
    val partProgress = if (busy && partSize > 0 && view.transferredPartBytes > 0)
        (view.transferredPartBytes.toDouble() / partSize).coerceIn(0.0, 1.0).toFloat() else null
    return GalleryImportUploadUiState(title, detail, summary, progress, partProgress, busy, actions, error)
}

/** One session-bound presenter. StateFlow callbacks are safe from any transport thread. */
internal class GalleryImportUploadPresenter(
    private val owner: ImportOwner,
    private val sessionToken: String,
    private val ownerProvider: () -> ImportOwner?,
    private val tokenProvider: () -> String,
    private val scope: CoroutineScope,
    factory: ((ImportUploadRunView) -> Unit) -> GalleryImportUploadControl
) {
    private val lock = Any()
    private var disposed = false
    private var invalidated = false
    private var foreground = false
    private var restoreAttempted = false
    private var initialized = false
    private var busy = false
    private var active: Job? = null
    private var view = ImportUploadRunView()
    private val mutableState = MutableStateFlow(galleryImportUploadPresentation(view, false, false, false, true))
    val state: StateFlow<GalleryImportUploadUiState> = mutableState.asStateFlow()
    private val control = factory(::observe)

    fun onStart() {
        val needsRestore = synchronized(lock) {
            if (disposed) return
            foreground = true; publishLocked()
            (!restoreAttempted).also { if (it) restoreAttempted = true }
        }
        if (needsRestore) runAction(GalleryImportUploadAction.RECONCILE)
    }
    fun onStop() {
        synchronized(lock) { foreground = false; publishLocked() }
        control.pause()
    }
    fun dispose() {
        synchronized(lock) { disposed = true; foreground = false; busy = false; view = ImportUploadRunView(status = ImportUploadRunStatus.SESSION_CHANGED); publishLocked() }
        control.pause(); control.invalidateSession(); active?.cancel()
    }
    fun invalidateSession() {
        synchronized(lock) { invalidated = true; view = ImportUploadRunView(status = ImportUploadRunStatus.SESSION_CHANGED); publishLocked() }
        control.invalidateSession()
    }

    /** Called only with the current instance's OpenDocument result; never automatically sends. */
    fun select(uri: String, kind: ImportMediaKind) {
        val action = if (kind == ImportMediaKind.IMAGE) GalleryImportUploadAction.SELECT_PHOTO else GalleryImportUploadAction.SELECT_VIDEO
        val config = if (kind == ImportMediaKind.IMAGE) ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE)
            else ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL, shareToFeed = true)
        launchAction(action) { control.select(uri, config) }
    }
    fun reselect(uri: String) = launchAction(GalleryImportUploadAction.RESELECT_SOURCE) { control.reselectSource(uri) }

    fun runAction(action: GalleryImportUploadAction) {
        if (action == GalleryImportUploadAction.PAUSE) {
            if (allowed(action)) control.pause()
            return
        }
        when (action) {
            GalleryImportUploadAction.SEND_FILE -> launchAction(action) { control.transfer() }
            GalleryImportUploadAction.RECONCILE -> launchAction(action) {
                if (synchronized(lock) { view.state == null }) control.restore() else control.reconcileOnce()
            }
            GalleryImportUploadAction.CANCEL -> launchAction(action) { control.requestCancel() }
            GalleryImportUploadAction.DISCARD_CANCELLED -> launchAction(action) { control.discardCancelledDraft() }
            else -> Unit
        }
    }

    private fun currentSession(): Boolean {
        val matches = try { !disposed && !invalidated && ownerProvider() == owner && tokenProvider() == sessionToken && sessionToken.isNotBlank() }
            catch (_: Exception) { false }
        if (!matches) invalidated = true // A later return to the same values cannot revive this instance.
        return matches
    }
    private fun allowed(action: GalleryImportUploadAction): Boolean = synchronized(lock) {
        publishLocked(); currentSession() && action in mutableState.value.actions
    }
    private fun observe(next: ImportUploadRunView) = synchronized(lock) {
        if (currentSession()) { view = next; publishLocked() }
        else { view = ImportUploadRunView(status = ImportUploadRunStatus.SESSION_CHANGED); publishLocked() }
    }
    private fun publishLocked() {
        mutableState.value = galleryImportUploadPresentation(view, busy, foreground, initialized, currentSession())
    }
    private fun launchAction(action: GalleryImportUploadAction, operation: suspend () -> ImportUploadRunView) {
        synchronized(lock) {
            if (!allowed(action)) return
            busy = true; publishLocked()
            active = scope.launch {
                try {
                    if (!synchronized(lock) { currentSession() && foreground }) return@launch
                    val result = operation()
                    synchronized(lock) { if (currentSession()) { view = result; initialized = true } }
                } catch (error: CancellationException) { throw error }
                catch (_: Exception) {
                    synchronized(lock) { if (currentSession()) {
                        initialized = true; view = view.copy(status = ImportUploadRunStatus.ATTENTION, errorCode = "import_operation_unavailable")
                    } }
                } finally { synchronized(lock) { busy = false; publishLocked() } }
            }
        }
    }
}
