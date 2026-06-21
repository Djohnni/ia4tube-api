package br.com.ia4tube.app.feature.orders

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.OrderSummary
import br.com.ia4tube.app.domain.usecase.ListOrdersUseCase
import br.com.ia4tube.app.R
import br.com.ia4tube.app.ui.text.UiText
import br.com.ia4tube.app.ui.text.toUiTextOrNull
import br.com.ia4tube.app.ui.text.uiText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class OrdersUiState(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val pedidos: List<OrderSummary> = emptyList(),
    val error: UiText? = null
)

class OrdersViewModel(
    private val listOrders: ListOrdersUseCase
) : ViewModel() {
    private val _uiState = MutableStateFlow(OrdersUiState())
    val uiState: StateFlow<OrdersUiState> = _uiState.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        load(showInitialLoading = _uiState.value.pedidos.isEmpty())
    }

    fun refreshManual() {
        if (_uiState.value.refreshing || _uiState.value.loading) return
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
            when (val result = listOrders()) {
                is ApiResult.Success -> _uiState.update {
                    it.copy(
                        loading = false,
                        refreshing = false,
                        pedidos = result.value
                    )
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        loading = false,
                        refreshing = false,
                        error = result.message.toUiTextOrNull() ?: uiText(R.string.orders_load_error)
                    )
                }
            }
        }
    }
}

class OrdersViewModelFactory(
    private val listOrders: ListOrdersUseCase
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return OrdersViewModel(listOrders) as T
    }
}
