package br.com.ia4tube.app.feature.plans

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.BillingPixResult
import br.com.ia4tube.app.data.repository.AuthRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job

data class PlansUiState(
    val loadingAction: String = "",
    val errorMessage: String = "",
    val pix: BillingPixResult? = null,
    val storiesRemaining: Int? = null,
    val storyBalanceLoading: Boolean = true
)

class PlansViewModel(
    private val repository: AuthRepository
) : ViewModel() {
    private val _uiState = MutableStateFlow(PlansUiState())
    val uiState: StateFlow<PlansUiState> = _uiState.asStateFlow()
    private var balanceJob: Job? = null

    /** Observation only. Opening or resuming Combo never starts a purchase. */
    fun refreshStoryBalance() {
        balanceJob?.cancel()
        val expectedToken = repository.getSavedToken()
        if (expectedToken.isBlank()) {
            _uiState.update { it.copy(storiesRemaining = null, storyBalanceLoading = false) }
            return
        }
        _uiState.update { it.copy(storyBalanceLoading = true) }
        balanceJob = viewModelScope.launch {
            val result = repository.me()
            if (repository.getSavedToken() != expectedToken) return@launch
            _uiState.update { it.copy(storyBalanceLoading = false,
                storiesRemaining = (result as? ApiResult.Success<br.com.ia4tube.app.data.models.MeResponse>)?.value?.storiesAvulsosRestantes?.coerceAtLeast(0)) }
        }
    }

    fun comprarSaldo(pacote: String = "saldo_990") {
        startPixAction("saldo") {
            repository.criarSaldoPix(pacote)
        }
    }

    fun comprarArteAvulsa() {
        startPixAction("arte_avulsa") {
            repository.criarArteAvulsaPix()
        }
    }

    fun comprarStories() {
        startPixAction("stories_avulsos") { repository.criarStoriesPix() }
    }

    fun assinarPlano(planId: String) {
        startPixAction(planId) {
            repository.criarPlanoPix(planId)
        }
    }

    fun clearPix() {
        _uiState.update { it.copy(pix = null) }
    }

    fun clearError() {
        _uiState.update { it.copy(errorMessage = "") }
    }

    private fun startPixAction(action: String, block: suspend () -> ApiResult<BillingPixResult>) {
        if (_uiState.value.loadingAction.isNotBlank()) return

        viewModelScope.launch {
            _uiState.update { it.copy(loadingAction = action, errorMessage = "", pix = null) }
            when (val result = block()) {
                is ApiResult.Success -> _uiState.update {
                    it.copy(loadingAction = "", pix = result.value)
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(loadingAction = "", errorMessage = result.message)
                }
            }
        }
    }
}

class PlansViewModelFactory(
    private val repository: AuthRepository
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return PlansViewModel(repository) as T
    }
}
