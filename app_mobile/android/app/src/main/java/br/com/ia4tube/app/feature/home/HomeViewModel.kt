package br.com.ia4tube.app.feature.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.OrderSummary
import br.com.ia4tube.app.data.repository.AuthRepository
import br.com.ia4tube.app.domain.usecase.ListOrdersUseCase
import br.com.ia4tube.app.domain.usecase.LoadMeUseCase
import br.com.ia4tube.app.R
import br.com.ia4tube.app.ui.text.UiText
import br.com.ia4tube.app.ui.text.toUiTextOrNull
import br.com.ia4tube.app.ui.text.uiText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class HomeUiState(
    val loading: Boolean = true,
    val summaryLoading: Boolean = true,
    val nome: String = "",
    val saldo: Double = 0.0,
    val saldoExtra: Double = 0.0,
    val planoStatus: String = "none",
    val planoNome: String = "",
    val planoAtual: String = "",
    val planoRenovaEm: String = "",
    val artesMensaisTotal: Int = 0,
    val artesMensaisRestantes: Int = 0,
    val artesAvulsasRestantes: Int = 0,
    val artesAvulsasUsadas: Int = 0,
    val artesAvulsasTotalCompradas: Int = 0,
    val arteAvulsaValor: Double = 5.99,
    val carrosseisLimite: Int? = null,
    val carrosseisUsados: Int? = null,
    val carrosseisRestantes: Int? = null,
    val carrosseisCiclo: String? = null,
    val firstFreeArtActive: Boolean = false,
    val firstFreeArtAvailable: Boolean = false,
    val firstFreeArtUsed: Boolean = true,
    val emProducao: Int = 0,
    val artesProntas: Int = 0,
    val pagamentosPendentes: Int = 0,
    val recentOrders: List<OrderSummary> = emptyList(),
    val summaryError: UiText? = null,
    val error: UiText? = null
) {
    val shouldFocusFirstFreeArt: Boolean
        get() = firstFreeArtActive && firstFreeArtAvailable && !firstFreeArtUsed
}

class HomeViewModel(
    private val repository: AuthRepository,
    private val loadMe: LoadMeUseCase,
    private val listOrders: ListOrdersUseCase
) : ViewModel() {
    private val _uiState = MutableStateFlow(HomeUiState())
    val uiState: StateFlow<HomeUiState> = _uiState.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, summaryLoading = true, error = null, summaryError = null) }
            if (repository.getSavedToken().isBlank()) {
                _uiState.update { visitorState() }
                return@launch
            }

            when (val result = loadMe()) {
                is ApiResult.Success -> _uiState.update {
                    it.copy(
                        loading = false,
                        nome = result.value.nomeTime,
                        saldo = result.value.saldo,
                        saldoExtra = result.value.saldoExtra,
                        planoStatus = result.value.planoStatus,
                        planoNome = result.value.planoNome,
                        planoAtual = result.value.planoAtual,
                        planoRenovaEm = result.value.planoRenovaEm,
                        artesMensaisTotal = result.value.artesMensaisTotal,
                        artesMensaisRestantes = result.value.artesMensaisRestantes,
                        artesAvulsasRestantes = result.value.artesAvulsasRestantes,
                        artesAvulsasUsadas = result.value.artesAvulsasUsadas,
                        artesAvulsasTotalCompradas = result.value.artesAvulsasTotalCompradas,
                        arteAvulsaValor = result.value.arteAvulsaValor,
                        carrosseisLimite = result.value.carrosseisLimite,
                        carrosseisUsados = result.value.carrosseisUsados,
                        carrosseisRestantes = result.value.carrosseisRestantes,
                        carrosseisCiclo = result.value.carrosseisCiclo
                    )
                }
                is ApiResult.Failure -> {
                    if (result.statusCode == 401 || result.statusCode == 404) {
                        repository.logout()
                        _uiState.update { visitorState() }
                        return@launch
                    }
                    _uiState.update {
                        it.copy(loading = false, error = result.message.toUiTextOrNull())
                    }
                }
            }

            when (val freeArt = repository.freeArtStatus()) {
                is ApiResult.Success -> _uiState.update {
                    it.copy(
                        firstFreeArtActive = freeArt.value.active,
                        firstFreeArtAvailable = freeArt.value.available,
                        firstFreeArtUsed = freeArt.value.used
                    )
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        firstFreeArtActive = false,
                        firstFreeArtAvailable = false,
                        firstFreeArtUsed = true
                    )
                }
            }

            when (val result = listOrders()) {
                is ApiResult.Success -> {
                    val summary = OrdersSummary.from(result.value)
                    _uiState.update {
                        it.copy(
                            summaryLoading = false,
                            emProducao = summary.emProducao,
                            artesProntas = summary.artesProntas,
                            pagamentosPendentes = summary.pagamentosPendentes,
                            recentOrders = result.value.take(3)
                        )
                    }
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        summaryLoading = false,
                        summaryError = result.message.toUiTextOrNull() ?: uiText(R.string.home_summary_load_error)
                    )
                }
            }
        }
    }

    fun logout() {
        repository.logout()
    }

    private fun visitorState(): HomeUiState {
        return HomeUiState(
            loading = false,
            summaryLoading = false
        )
    }
}

class HomeViewModelFactory(
    private val repository: AuthRepository,
    private val loadMe: LoadMeUseCase,
    private val listOrders: ListOrdersUseCase
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return HomeViewModel(repository, loadMe, listOrders) as T
    }
}

private data class OrdersSummary(
    val emProducao: Int,
    val artesProntas: Int,
    val pagamentosPendentes: Int
) {
    companion object {
        fun from(orders: List<OrderSummary>): OrdersSummary {
            return OrdersSummary(
                emProducao = orders.count { !it.imagemPronta && !it.status.equals("erro", ignoreCase = true) },
                artesProntas = orders.count { it.imagemPronta },
                pagamentosPendentes = orders.count { it.pagamentoPendente }
            )
        }
    }
}
