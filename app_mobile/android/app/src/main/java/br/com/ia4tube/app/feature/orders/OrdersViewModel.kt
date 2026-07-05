package br.com.ia4tube.app.feature.orders

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.MonthlyPlanningSummaryDto
import br.com.ia4tube.app.data.models.OrderSummary
import br.com.ia4tube.app.domain.usecase.ListMonthlyPlanningsUseCase
import br.com.ia4tube.app.domain.usecase.ListOrdersUseCase
import br.com.ia4tube.app.R
import br.com.ia4tube.app.ui.text.UiText
import br.com.ia4tube.app.ui.text.toUiTextOrNull
import br.com.ia4tube.app.ui.text.uiText
import kotlinx.coroutines.async
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
    private val listOrders: ListOrdersUseCase,
    private val listMonthlyPlannings: ListMonthlyPlanningsUseCase
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
            val ordersDeferred = async { listOrders() }
            val planningsDeferred = async { listMonthlyPlannings() }
            val ordersResult = ordersDeferred.await()
            val planningsResult = planningsDeferred.await()
            val pedidos = mergeOrdersAndPlannings(
                orders = ordersResult.valueOrEmpty(),
                plannings = planningsResult.valueOrEmpty()
            )
            val error = ordersResult.failureMessage()
                ?: planningsResult.failureMessage()

            when {
                pedidos.isNotEmpty() -> _uiState.update {
                    it.copy(
                        loading = false,
                        refreshing = false,
                        pedidos = pedidos,
                        error = error?.toUiTextOrNull()
                    )
                }
                error != null -> _uiState.update {
                    it.copy(
                        loading = false,
                        refreshing = false,
                        error = error.toUiTextOrNull() ?: uiText(R.string.orders_load_error)
                    )
                }
                else -> _uiState.update {
                    it.copy(
                        loading = false,
                        refreshing = false,
                        pedidos = emptyList()
                    )
                }
            }
        }
    }
}

private fun <T> ApiResult<List<T>>.valueOrEmpty(): List<T> {
    return when (this) {
        is ApiResult.Success -> value
        is ApiResult.Failure -> emptyList()
    }
}

private fun ApiResult<*>.failureMessage(): String? {
    return when (this) {
        is ApiResult.Success<*> -> null
        is ApiResult.Failure -> message
    }
}

private fun mergeOrdersAndPlannings(
    orders: List<OrderSummary>,
    plannings: List<MonthlyPlanningSummaryDto>
): List<OrderSummary> {
    val byKey = LinkedHashMap<String, OrderSummary>()
    plannings.map { it.toOrderSummary() }.forEach { planning ->
        byKey[planning.listKey()] = planning
    }
    orders.forEach { order ->
        if (order.isMonthlyPlanning && byKey.containsKey(order.listKey())) return@forEach
        byKey[order.listKey()] = order
    }
    return byKey.values.toList()
}

private fun MonthlyPlanningSummaryDto.toOrderSummary(): OrderSummary {
    return OrderSummary(
        id = id,
        tipo = "Planejamento Mensal",
        status = status,
        imagemPronta = totalPosts > 0 && readyPosts >= totalPosts,
        pagamentoPendente = false,
        createdAt = createdAt,
        isMonthlyPlanning = true,
        planningId = id,
        title = title.ifBlank { "Planejamento Mensal" },
        totalPosts = totalPosts,
        readyPosts = readyPosts,
        productionPosts = productionPosts,
        plannedPosts = plannedPosts,
        errorPosts = errorPosts
    )
}

private fun OrderSummary.listKey(): String {
    return if (isMonthlyPlanning) {
        "planning:${planningId.ifBlank { id }}"
    } else {
        "order:$id"
    }
}

class OrdersViewModelFactory(
    private val listOrders: ListOrdersUseCase,
    private val listMonthlyPlannings: ListMonthlyPlanningsUseCase
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return OrdersViewModel(listOrders, listMonthlyPlannings) as T
    }
}
