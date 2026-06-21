package br.com.ia4tube.app.data.repository

import br.com.ia4tube.app.core.notifications.FcmTokenRegistrar
import br.com.ia4tube.app.core.session.SessionStore
import br.com.ia4tube.app.data.api.IA4TubeApiClient
import br.com.ia4tube.app.data.models.AdjustmentResult
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.BalancePaymentResult
import br.com.ia4tube.app.data.models.BillingPixResult
import br.com.ia4tube.app.data.models.CreateArtEmpresaRequest
import br.com.ia4tube.app.data.models.CreateOrderResponse
import br.com.ia4tube.app.data.models.DownloadedImage
import br.com.ia4tube.app.data.models.FootballOrderRequest
import br.com.ia4tube.app.data.models.LoginResponse
import br.com.ia4tube.app.data.models.MeResponse
import br.com.ia4tube.app.data.models.MonthlyPlanningDetailDto
import br.com.ia4tube.app.data.models.MonthlyPlanningRequest
import br.com.ia4tube.app.data.models.MonthlyPlanningRequestResponse
import br.com.ia4tube.app.data.models.MonthlyPlanningSummaryDto
import br.com.ia4tube.app.data.models.OrderInfo
import br.com.ia4tube.app.data.models.OrderSummary
import br.com.ia4tube.app.data.models.PaymentInfo
import br.com.ia4tube.app.data.models.SendSupportMessageResponse
import br.com.ia4tube.app.data.models.SupportMessage

class AuthRepository(
    private val apiClient: IA4TubeApiClient,
    private val sessionStore: SessionStore,
    private val fcmTokenRegistrar: FcmTokenRegistrar? = null
) {
    fun getSavedToken(): String = sessionStore.getToken()

    suspend fun login(login: String, senha: String): ApiResult<LoginResponse> {
        return when (val result = apiClient.login(login, senha)) {
            is ApiResult.Success -> {
                sessionStore.saveToken(result.value.token)
                fcmTokenRegistrar?.syncCurrentToken()
                result
            }
            is ApiResult.Failure -> result
        }
    }

    suspend fun register(whatsapp: String, senha: String): ApiResult<LoginResponse> {
        return when (val result = apiClient.register(whatsapp, senha)) {
            is ApiResult.Success -> {
                sessionStore.saveToken(result.value.token)
                fcmTokenRegistrar?.syncCurrentToken()
                result
            }
            is ApiResult.Failure -> result
        }
    }

    suspend fun me(): ApiResult<MeResponse> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.me(token)
    }

    suspend fun meusPedidos(): ApiResult<List<OrderSummary>> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.meusPedidos(token)
    }

    suspend fun listarPlanejamentosMensais(): ApiResult<List<MonthlyPlanningSummaryDto>> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.listarPlanejamentosMensais(token)
    }

    suspend fun planejamentoMensalDetalhe(planningId: String): ApiResult<MonthlyPlanningDetailDto> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.planejamentoMensalDetalhe(token, planningId)
    }

    suspend fun solicitarPlanejamentoMensal(request: MonthlyPlanningRequest): ApiResult<MonthlyPlanningRequestResponse> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.solicitarPlanejamentoMensal(token, request)
    }

    suspend fun pedidoInfo(pedidoId: String): ApiResult<OrderInfo> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.pedidoInfo(token, pedidoId)
    }

    suspend fun aprovarPedido(pedidoId: String): ApiResult<Unit> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.aprovarPedido(token, pedidoId)
    }

    suspend fun downloadResultado(pedidoId: String): ApiResult<DownloadedImage> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.downloadResultado(token, pedidoId)
    }

    suspend fun solicitarAjuste(pedidoId: String, motivo: String): ApiResult<AdjustmentResult> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.solicitarAjuste(token, pedidoId, motivo)
    }

    suspend fun pagamentoInfo(pedidoId: String): ApiResult<PaymentInfo> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.pagamentoInfo(token, pedidoId)
    }

    suspend fun gerarPix(pedidoId: String): ApiResult<PaymentInfo> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.gerarPix(token, pedidoId)
    }

    suspend fun criarSaldoPix(pacote: String = "saldo_990"): ApiResult<BillingPixResult> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.criarSaldoPix(token, pacote)
    }

    suspend fun criarArteAvulsaPix(): ApiResult<BillingPixResult> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.criarArteAvulsaPix(token)
    }

    suspend fun criarPlanoPix(planId: String): ApiResult<BillingPixResult> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.criarPlanoPix(token, planId)
    }

    suspend fun pagarComSaldo(pedidoId: String): ApiResult<BalancePaymentResult> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.pagarComSaldo(token, pedidoId)
    }

    suspend fun criarArteEmpresa(request: CreateArtEmpresaRequest): ApiResult<CreateOrderResponse> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.criarArteEmpresa(token, request)
    }

    suspend fun criarPedidoFutebol(request: FootballOrderRequest): ApiResult<CreateOrderResponse> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.criarPedidoFutebol(token, request)
    }

    suspend fun minhasMensagensSuporte(): ApiResult<List<SupportMessage>> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.minhasMensagensSuporte(token)
    }

    suspend fun enviarMensagemSuporte(mensagem: String): ApiResult<SendSupportMessageResponse> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.enviarMensagemSuporte(token, mensagem)
    }

    fun logout() {
        sessionStore.clear()
    }

    private companion object {
        const val SESSION_EXPIRED_MESSAGE = "Sessão expirada. Faça login novamente."
    }
}
