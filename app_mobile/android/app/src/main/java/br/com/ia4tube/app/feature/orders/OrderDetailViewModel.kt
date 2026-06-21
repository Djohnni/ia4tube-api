package br.com.ia4tube.app.feature.orders

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.core.analytics.MobileAnalytics
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.DownloadedImage
import br.com.ia4tube.app.data.models.OrderInfo
import br.com.ia4tube.app.data.models.PaymentInfo
import br.com.ia4tube.app.domain.usecase.ApproveOrderUseCase
import br.com.ia4tube.app.domain.usecase.DownloadOrderResultUseCase
import br.com.ia4tube.app.domain.usecase.GeneratePixUseCase
import br.com.ia4tube.app.domain.usecase.LoadPaymentInfoUseCase
import br.com.ia4tube.app.domain.usecase.LoadOrderInfoUseCase
import br.com.ia4tube.app.domain.usecase.PayOrderWithBalanceUseCase
import br.com.ia4tube.app.domain.usecase.RequestOrderAdjustmentUseCase
import br.com.ia4tube.app.R
import br.com.ia4tube.app.ui.text.UiText
import br.com.ia4tube.app.ui.text.toUiTextOrNull
import br.com.ia4tube.app.ui.text.uiText
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class OrderDetailUiState(
    val loading: Boolean = true,
    val approving: Boolean = false,
    val downloading: Boolean = false,
    val sharing: Boolean = false,
    val requestingAdjustment: Boolean = false,
    val generatingPix: Boolean = false,
    val payingWithBalance: Boolean = false,
    val polling: Boolean = false,
    val manualRefreshing: Boolean = false,
    val info: OrderInfo? = null,
    val paymentInfo: PaymentInfo? = null,
    val sharePayload: SharePayload? = null,
    val error: UiText? = null,
    val actionMessage: UiText? = null
)

data class SharePayload(
    val pedidoId: String,
    val image: DownloadedImage,
    val description: String
)

class OrderDetailViewModel(
    private val pedidoId: String,
    val previewToken: String,
    private val loadOrderInfo: LoadOrderInfoUseCase,
    private val approveOrder: ApproveOrderUseCase,
    private val downloadOrderResult: DownloadOrderResultUseCase,
    private val requestOrderAdjustment: RequestOrderAdjustmentUseCase,
    private val loadPaymentInfo: LoadPaymentInfoUseCase,
    private val generatePix: GeneratePixUseCase,
    private val payOrderWithBalance: PayOrderWithBalanceUseCase
) : ViewModel() {
    private val _uiState = MutableStateFlow(OrderDetailUiState())
    val uiState: StateFlow<OrderDetailUiState> = _uiState.asStateFlow()
    private var pollingJob: Job? = null

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            val info = loadInfo(showLoading = true)
            updatePolling(info)
        }
    }

    fun refreshNow() {
        if (_uiState.value.manualRefreshing) return

        viewModelScope.launch {
            _uiState.update { it.copy(manualRefreshing = true, error = null, actionMessage = null) }
            val info = loadInfo(showLoading = false)
            updatePolling(info)
            _uiState.update {
                it.copy(
                    manualRefreshing = false,
                    actionMessage = if (info != null) uiText(R.string.order_updated_success) else it.actionMessage
                )
            }
        }
    }

    fun approve() {
        val info = _uiState.value.info ?: return
        if (!info.imagemPronta || info.aprovadoCliente || _uiState.value.approving) return

        viewModelScope.launch {
            _uiState.update { it.copy(approving = true, error = null, actionMessage = null) }
            when (val result = approveOrder(pedidoId)) {
                is ApiResult.Success -> {
                    MobileAnalytics.track(
                        "mobile_aprovou_arte",
                        tela = "detalhe_pedido",
                        pedidoId = pedidoId,
                        flushNow = true
                    )
                    _uiState.update {
                        it.copy(approving = false, actionMessage = uiText(R.string.order_approved_success))
                    }
                    refresh()
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        approving = false,
                        error = result.message.toUiTextOrNull() ?: uiText(R.string.order_approve_error)
                    )
                }
            }
        }
    }

    fun downloadResult() {
        val info = _uiState.value.info
        if (info == null) {
            _uiState.update { it.copy(error = uiText(R.string.order_download_error), actionMessage = null) }
            return
        }
        if (_uiState.value.downloading) return
        if (!info.canDownloadResult()) {
            _uiState.update { it.copy(error = uiText(R.string.order_download_not_available), actionMessage = null) }
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(downloading = true, error = null, actionMessage = null) }
            when (val result = downloadOrderResult(pedidoId)) {
                is ApiResult.Success -> {
                    MobileAnalytics.track(
                        "mobile_baixou_imagem",
                        tela = "detalhe_pedido",
                        pedidoId = pedidoId,
                        flushNow = true
                    )
                    _uiState.update {
                        it.copy(
                            downloading = false,
                            actionMessage = uiText(R.string.order_download_saved)
                        )
                    }
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        downloading = false,
                        error = result.message.toUiTextOrNull() ?: uiText(R.string.order_download_error)
                    )
                }
            }
        }
    }

    fun shareResult() {
        val info = _uiState.value.info
        if (info == null) {
            _uiState.update { it.copy(error = uiText(R.string.order_download_error), actionMessage = null) }
            return
        }
        if (_uiState.value.sharing) return
        if (!info.canDownloadResult()) {
            _uiState.update { it.copy(error = uiText(R.string.order_download_not_available), actionMessage = null) }
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(sharing = true, error = null, actionMessage = null, sharePayload = null) }
            when (val result = downloadOrderResult.downloadImage(pedidoId)) {
                is ApiResult.Success -> {
                    MobileAnalytics.track(
                        "mobile_compartilhou_imagem",
                        tela = "detalhe_pedido",
                        pedidoId = pedidoId,
                        flushNow = true
                    )
                    _uiState.update {
                        it.copy(
                            sharing = false,
                            sharePayload = SharePayload(
                                pedidoId = pedidoId,
                                image = result.value,
                                description = info.descricaoInstagram
                            )
                        )
                    }
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        sharing = false,
                        error = result.message.toUiTextOrNull() ?: uiText(R.string.order_download_error)
                    )
                }
            }
        }
    }

    fun clearSharePayload() {
        _uiState.update { it.copy(sharePayload = null) }
    }

    fun requestAdjustment(motivo: String) {
        val info = _uiState.value.info ?: return
        val cleanMotivo = motivo.trim()
        if (!info.imagemPronta || !info.podePedirAjuste || _uiState.value.requestingAdjustment) return
        if (cleanMotivo.isBlank()) {
            _uiState.update { it.copy(error = uiText(R.string.order_adjustment_empty_error)) }
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(requestingAdjustment = true, error = null, actionMessage = null) }
            when (val result = requestOrderAdjustment(pedidoId, cleanMotivo)) {
                is ApiResult.Success -> {
                    MobileAnalytics.track(
                        "mobile_pediu_ajuste",
                        tela = "detalhe_pedido",
                        pedidoId = pedidoId,
                        flushNow = true
                    )
                    _uiState.update {
                        it.copy(
                            requestingAdjustment = false,
                            actionMessage = result.value.message.toUiTextOrNull()
                        )
                    }
                    refresh()
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        requestingAdjustment = false,
                        error = result.message.toUiTextOrNull() ?: uiText(R.string.order_adjustment_error)
                    )
                }
            }
        }
    }

    fun generatePix() {
        val info = _uiState.value.info ?: return
        if (!info.pagamentoPendente || _uiState.value.generatingPix) return

        viewModelScope.launch {
            MobileAnalytics.track("mobile_pagamento_abriu", tela = "detalhe_pedido", pedidoId = pedidoId)
            _uiState.update { it.copy(generatingPix = true, error = null, actionMessage = null) }
            when (val result = generatePix(pedidoId)) {
                is ApiResult.Success -> {
                    MobileAnalytics.track(
                        "mobile_gerou_pix",
                        tela = "detalhe_pedido",
                        pedidoId = pedidoId,
                        flushNow = true
                    )
                    _uiState.update {
                        it.copy(
                            generatingPix = false,
                            paymentInfo = mergePaymentInfo(it.paymentInfo, result.value),
                            actionMessage = uiText(R.string.order_pix_success)
                        )
                    }
                    refresh()
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        generatingPix = false,
                        error = result.message.toUiTextOrNull() ?: uiText(R.string.order_pix_error)
                    )
                }
            }
        }
    }

    fun payWithBalance() {
        val info = _uiState.value.info ?: return
        if (!info.pagamentoPendente || _uiState.value.payingWithBalance) return

        viewModelScope.launch {
            _uiState.update { it.copy(payingWithBalance = true, error = null, actionMessage = null) }
            when (val result = payOrderWithBalance(pedidoId)) {
                is ApiResult.Success -> {
                    MobileAnalytics.track(
                        "mobile_pagou_com_saldo",
                        tela = "detalhe_pedido",
                        pedidoId = pedidoId,
                        flushNow = true
                    )
                    _uiState.update {
                        it.copy(
                            payingWithBalance = false,
                            actionMessage = result.value.message.toUiTextOrNull()
                        )
                    }
                    refresh()
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        payingWithBalance = false,
                        error = result.message.toUiTextOrNull() ?: uiText(R.string.order_balance_error)
                    )
                }
            }
        }
    }

    private suspend fun refreshPaymentInfo() {
        when (val result = loadPaymentInfo(pedidoId)) {
            is ApiResult.Success -> _uiState.update {
                it.copy(paymentInfo = mergePaymentInfo(it.paymentInfo, result.value))
            }
            is ApiResult.Failure -> Unit
        }
    }

    private suspend fun loadInfo(showLoading: Boolean): OrderInfo? {
        if (showLoading) {
            _uiState.update { it.copy(loading = true, error = null) }
        }

        return when (val result = loadOrderInfo(pedidoId)) {
            is ApiResult.Success -> {
                val previousReady = _uiState.value.info?.imagemPronta == true
                val friendlyError = if (result.value.hasErrorStatus()) {
                    uiText(R.string.order_status_error_check)
                } else {
                    null
                }
                _uiState.update {
                    it.copy(
                        loading = false,
                        info = result.value,
                        error = friendlyError,
                        paymentInfo = if (result.value.pagamentoPendente) {
                            it.paymentInfo ?: result.value.toPaymentInfo()
                        } else {
                            null
                        }
                    )
                }

                if (result.value.pagamentoPendente) {
                    refreshPaymentInfo()
                }
                if (result.value.imagemPronta && !previousReady) {
                    MobileAnalytics.track(
                        "mobile_preview_carregou",
                        tela = "detalhe_pedido",
                        pedidoId = pedidoId
                    )
                }

                result.value
            }
            is ApiResult.Failure -> {
                _uiState.update {
                    it.copy(
                        loading = false,
                        error = result.message.toUiTextOrNull() ?: uiText(R.string.order_update_error)
                    )
                }
                null
            }
        }
    }

    private fun updatePolling(info: OrderInfo?) {
        if (info != null && info.shouldPoll()) {
            startPolling()
        } else {
            stopPolling()
        }
    }

    private fun startPolling() {
        if (pollingJob?.isActive == true) return

        _uiState.update { it.copy(polling = true) }
        pollingJob = viewModelScope.launch {
            try {
                while (true) {
                    delay(POLLING_INTERVAL_MS)
                    val info = loadInfo(showLoading = false)
                    if (info?.shouldPoll() != true) break
                }
            } finally {
                _uiState.update { it.copy(polling = false) }
                pollingJob = null
            }
        }
    }

    private fun stopPolling() {
        pollingJob?.cancel()
        pollingJob = null
        _uiState.update { it.copy(polling = false) }
    }

    private fun OrderInfo.toPaymentInfo(): PaymentInfo {
        return PaymentInfo(
            pagamentoPendente = pagamentoPendente,
            valorPendente = valorPendente,
            mpPaymentStatus = "",
            pixCopiaCola = "",
            qrCodeBase64 = "",
            ticketUrl = "",
            paymentId = ""
        )
    }

    private fun mergePaymentInfo(current: PaymentInfo?, next: PaymentInfo): PaymentInfo {
        return PaymentInfo(
            pagamentoPendente = next.pagamentoPendente,
            valorPendente = if (next.valorPendente > 0.0) next.valorPendente else current?.valorPendente ?: 0.0,
            mpPaymentStatus = next.mpPaymentStatus.ifBlank { current?.mpPaymentStatus.orEmpty() },
            pixCopiaCola = next.pixCopiaCola.ifBlank { current?.pixCopiaCola.orEmpty() },
            qrCodeBase64 = next.qrCodeBase64.ifBlank { current?.qrCodeBase64.orEmpty() },
            ticketUrl = next.ticketUrl.ifBlank { current?.ticketUrl.orEmpty() },
            paymentId = next.paymentId.ifBlank { current?.paymentId.orEmpty() }
        )
    }

    private fun OrderInfo.shouldPoll(): Boolean = !imagemPronta && !hasErrorStatus()

    private fun OrderInfo.hasErrorStatus(): Boolean = status.equals("erro", ignoreCase = true)

    private fun OrderInfo.canDownloadResult(): Boolean {
        return !pagamentoPendente && podeBaixar
    }

    override fun onCleared() {
        stopPolling()
        super.onCleared()
    }

    companion object {
        private const val POLLING_INTERVAL_MS = 5_000L
    }
}

class OrderDetailViewModelFactory(
    private val pedidoId: String,
    private val previewToken: String,
    private val loadOrderInfo: LoadOrderInfoUseCase,
    private val approveOrder: ApproveOrderUseCase,
    private val downloadOrderResult: DownloadOrderResultUseCase,
    private val requestOrderAdjustment: RequestOrderAdjustmentUseCase,
    private val loadPaymentInfo: LoadPaymentInfoUseCase,
    private val generatePix: GeneratePixUseCase,
    private val payOrderWithBalance: PayOrderWithBalanceUseCase
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return OrderDetailViewModel(
            pedidoId,
            previewToken,
            loadOrderInfo,
            approveOrder,
            downloadOrderResult,
            requestOrderAdjustment,
            loadPaymentInfo,
            generatePix,
            payOrderWithBalance
        ) as T
    }
}
