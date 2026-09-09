package br.com.ia4tube.app.feature.calendar

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class CalendarUiState(val data: CalendarSnapshot = CalendarSnapshot(), val busy: Boolean = false,
    val fresh: Boolean = false, val error: String? = null, val imageRefresh: Long = 0)

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
                    else "Não foi possível confirmar a programação. Atualize para conferir; não repita o envio.") }
            }
        }
    }
    fun refresh() = run { gateway.list() }
    fun preferences(enabled: Boolean) { val revision = state.value.data.preferenceRevision
        run(true) { gateway.preferences(enabled, revision) } }
    fun edit(item: ScheduledArt, action: String, caption: String = "", date: String = "", time: String = "", onSuccess: () -> Unit = {}) {
        if (!item.editable || state.value.data.items.none { it.id == item.id && it.revision == item.revision }) return
        run(true, onSuccess) { gateway.edit(item, action, caption, date, time) }
    }
    fun onPause() { sequence++; state.update { it.copy(busy = false, fresh = false) } }
    fun invalidateSession() { sequence++; state.value = CalendarUiState() }
    fun dispose() { invalidateSession(); viewModelScope.cancel() }
}
