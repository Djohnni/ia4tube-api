package br.com.ia4tube.app.feature.support

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.R
import br.com.ia4tube.app.core.analytics.MobileAnalytics
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.SupportMessage
import br.com.ia4tube.app.domain.usecase.ListSupportMessagesUseCase
import br.com.ia4tube.app.domain.usecase.SendSupportMessageUseCase
import br.com.ia4tube.app.ui.text.UiText
import br.com.ia4tube.app.ui.text.toUiTextOrNull
import br.com.ia4tube.app.ui.text.uiText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SupportUiState(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val sending: Boolean = false,
    val messages: List<SupportMessage> = emptyList(),
    val draft: String = "",
    val error: UiText? = null,
    val scrollVersion: Int = 0
)

class SupportViewModel(
    private val listSupportMessages: ListSupportMessagesUseCase,
    private val sendSupportMessage: SendSupportMessageUseCase
) : ViewModel() {
    private val _uiState = MutableStateFlow(SupportUiState())
    val uiState: StateFlow<SupportUiState> = _uiState.asStateFlow()

    init {
        refresh()
    }

    fun updateDraft(value: String) {
        _uiState.update { it.copy(draft = value, error = null) }
    }

    fun refresh() {
        load(showInitialLoading = _uiState.value.messages.isEmpty())
    }

    fun refreshManual() {
        if (_uiState.value.loading || _uiState.value.refreshing) return
        load(showInitialLoading = false)
    }

    private fun load(showInitialLoading: Boolean) {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    loading = showInitialLoading,
                    refreshing = !showInitialLoading,
                    error = null
                )
            }
            when (val result = listSupportMessages()) {
                is ApiResult.Success -> _uiState.update {
                    it.copy(
                        loading = false,
                        refreshing = false,
                        messages = result.value,
                        error = null,
                        scrollVersion = it.scrollVersion + 1
                    )
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        loading = false,
                        refreshing = false,
                        error = result.message.toUiTextOrNull() ?: uiText(R.string.support_load_error)
                    )
                }
            }
        }
    }

    fun send() {
        val message = _uiState.value.draft.trim()
        if (_uiState.value.sending) return
        if (message.isBlank()) {
            _uiState.update { it.copy(error = uiText(R.string.support_empty_message_error)) }
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(sending = true, error = null) }
            when (val result = sendSupportMessage(message)) {
                is ApiResult.Success -> {
                    MobileAnalytics.track("mobile_suporte_enviou_mensagem", tela = "suporte", flushNow = true)
                    _uiState.update { it.copy(sending = false, draft = "") }
                    load(showInitialLoading = false)
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        sending = false,
                        error = result.message.toUiTextOrNull() ?: uiText(R.string.support_send_error)
                    )
                }
            }
        }
    }
}

class SupportViewModelFactory(
    private val listSupportMessages: ListSupportMessagesUseCase,
    private val sendSupportMessage: SendSupportMessageUseCase
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return SupportViewModel(listSupportMessages, sendSupportMessage) as T
    }
}
