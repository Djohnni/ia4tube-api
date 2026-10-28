package br.com.ia4tube.app.feature.calendar

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException

data class CalendarUiState(val data: CalendarSnapshot = CalendarSnapshot(), val busy: Boolean = false,
    val fresh: Boolean = false, val error: String? = null, val imageRefresh: Long = 0)

internal fun ScheduledArt.awaitsImportedMediaReturn(): Boolean = sourceKind == "upload" && preparationPending &&
    submissionState in setOf("accepted", "preparing") && status == "waiting_media" && media == null && generatedVideo == null

class CalendarViewModel(private val tokenProvider: () -> String, private val token: String,
    private val gateway: CalendarGateway = CalendarApi(token)) : ViewModel() {
    private val state = MutableStateFlow(CalendarUiState())
    val uiState = state.asStateFlow()
    private var sequence = 0L
    private fun valid(): Boolean = token.isNotBlank() && tokenProvider() == token
    private fun run(mutation: Boolean = false, onSuccess: () -> Unit = {}, operation: suspend () -> CalendarSnapshot) {
        if (!valid()) { invalidateSession(); return }
        if (state.value.busy || (mutation && !state.value.fresh)) return
        val ticket = ++sequence
        state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val result = operation()
                if (valid() && sequence == ticket) {
                    state.value = CalendarUiState(result, fresh = true, imageRefresh = ticket)
                    onSuccess()
                }
                else if (!valid()) invalidateSession()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (!valid()) invalidateSession()
                else if (sequence == ticket) state.update { old -> old.copy(busy = false, fresh = false,
                    data = if (error is CalendarFailure && error.status in setOf(401,403)) CalendarSnapshot() else old.data,
                    error = if (error is CalendarFailure && error.status == 409)
                        "A programação mudou. Atualize antes de editar novamente."
                    else if (mutation)
                        "Não foi possível confirmar a alteração. Ela pode ter sido salva. Volte à galeria e toque em Atualizar; não salve novamente antes de conferir."
                    else "Não conseguimos atualizar o status agora. Isso não confirma falha na publicação. Toque em Atualizar para conferir.") }
            }
        }
    }
    fun refresh() = run { gateway.list() }
    /** The visible pending card owns this read-only loop. Leaving it cancels the observation, not server work. */
    internal suspend fun observePendingImportReturn(itemId: String) {
        withTimeoutOrNull(600_000L) {
            while (pendingImportReturn(itemId)) {
                delay(10_000L)
                if (!pendingImportReturn(itemId)) return@withTimeoutOrNull
                if (state.value.busy) continue
                val ticket = ++sequence
                state.update { it.copy(busy = true, error = null) }
                try {
                    var failures = 0
                    var result: CalendarSnapshot? = null
                    while (result == null) {
                        try { result = gateway.list() }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (error: Exception) {
                            val transient = error is IOException || error is CalendarFailure &&
                                error.status in setOf(408, 429, 500, 502, 503, 504)
                            if (!transient || ++failures >= 3) throw error
                            // This is still the same read: keep mutations disabled and the original budget.
                            delay(10_000L)
                            if (!pendingImportReturn(itemId) || sequence != ticket) return@withTimeoutOrNull
                        }
                    }
                    if (!valid()) { invalidateSession(); return@withTimeoutOrNull }
                    if (sequence != ticket) return@withTimeoutOrNull
                    state.value = CalendarUiState(result, fresh = true, imageRefresh = ticket)
                } catch (cancelled: CancellationException) {
                    if (valid() && sequence == ticket) state.update { it.copy(busy = false) }
                    throw cancelled
                } catch (error: Exception) {
                    if (!valid()) invalidateSession()
                    else if (sequence == ticket) state.update { old -> old.copy(busy = false, fresh = false,
                        data = if (error is CalendarFailure && error.status in setOf(401, 403)) CalendarSnapshot() else old.data,
                        error = "Não conseguimos atualizar o status agora. Toque em Atualizar para conferir.") }
                    return@withTimeoutOrNull
                }
            }
        }
    }
    private fun pendingImportReturn(itemId: String): Boolean {
        if (!valid()) { invalidateSession(); return false }
        val current = state.value
        return current.fresh && current.error == null && current.data.enabled &&
            current.data.items.any { it.id == itemId && it.awaitsImportedMediaReturn() }
    }
    fun destination(item: ScheduledArt, destination: String, onSuccess: () -> Unit) {
        if (!item.editable || state.value.data.items.none { it.id == item.id && it.revision == item.revision }) return
        run(true, onSuccess) { gateway.destination(item, destination) }
    }
    fun automatic(item: ScheduledArt, enabled: Boolean, onSuccess: () -> Unit) {
        if (!item.editable || state.value.data.items.none { it.id == item.id && it.revision == item.revision }) return
        if (enabled && !state.value.data.automaticAuthorized) return
        run(true, onSuccess) { gateway.automatic(item, enabled) }
    }
    fun preferences(enabled: Boolean) { val revision = state.value.data.preferenceRevision
        // Enabling always needs a captured, explicit account-bound confirmation.
        if (enabled) return
        run(true) { gateway.preferences(enabled, revision) } }
    fun confirmAutomatic(target: CalendarAutomaticConfirmation) {
        if (!valid()) { invalidateSession(); return }
        val current = state.value
        if (current.busy || !current.fresh) return
        if (current.data.automaticConfirmationTarget() != target) {
            state.update { it.copy(fresh = false,
                error = "A conta ou a programação mudou. Atualize e confirme novamente.") }
            return
        }
        run(true) {
            val result = gateway.preferences(true, target.preferenceRevision)
            // A successful HTTP response alone is not proof of consent for the account displayed.
            if (!result.automaticAuthorized || result.connectionBinding != target.binding ||
                result.identity != target.identity || result.username != target.username ||
                result.preferenceRevision != target.preferenceRevision + 1) throw CalendarFailure(409)
            result
        }
    }
    fun invalidateConsent() {
        onPause()
        refresh()
    }
    fun edit(item: ScheduledArt, action: String, caption: String = "", date: String = "", time: String = "", onSuccess: () -> Unit = {}) {
        if (!item.editable || state.value.data.items.none { it.id == item.id && it.revision == item.revision }) return
        run(true, onSuccess) { gateway.edit(item, action, caption, date, time) }
    }
    fun onPause() { sequence++; state.update { it.copy(busy = false, fresh = false) } }
    fun invalidateSession() { sequence++; state.value = CalendarUiState() }
    fun dispose() { invalidateSession(); viewModelScope.cancel() }
}
