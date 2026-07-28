package br.com.ia4tube.app.data.repository

import br.com.ia4tube.app.core.company.CompanyProfileStore
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
import br.com.ia4tube.app.data.models.FreeArtStatus
import br.com.ia4tube.app.data.models.LoginResponse
import br.com.ia4tube.app.data.models.MarketingVideo
import br.com.ia4tube.app.data.models.MeResponse
import br.com.ia4tube.app.data.models.MonthlyPlanningDetailDto
import br.com.ia4tube.app.data.models.MonthlyPlanningPostDto
import br.com.ia4tube.app.data.models.MonthlyPlanningProductDiscoveryResponse
import br.com.ia4tube.app.data.models.MonthlyPlanningRequest
import br.com.ia4tube.app.data.models.MonthlyPlanningRequestResponse
import br.com.ia4tube.app.data.models.MonthlyPlanningRescheduleRequest
import br.com.ia4tube.app.data.models.MonthlyPlanningSummaryDto
import br.com.ia4tube.app.data.models.OrderInfo
import br.com.ia4tube.app.data.models.OrderSummary
import br.com.ia4tube.app.data.models.PaymentInfo
import br.com.ia4tube.app.data.models.SendSupportMessageResponse
import br.com.ia4tube.app.data.models.SupportMessage
import br.com.ia4tube.app.data.models.UploadFile
import java.nio.charset.StandardCharsets
import java.util.Base64

internal fun authenticatedAccountFromJwt(token: String): String {
    return runCatching {
        val payload = token.split('.').getOrNull(1).orEmpty()
        if (payload.isBlank()) return@runCatching ""
        val json = String(Base64.getUrlDecoder().decode(payload), StandardCharsets.UTF_8)
        Regex("\"whatsapp\"\\s*:\\s*\"([^\"]+)\"")
            .find(json)
            ?.groupValues
            ?.getOrNull(1)
            .orEmpty()
    }.getOrDefault("")
}

class AuthRepository(
    private val apiClient: IA4TubeApiClient,
    private val sessionStore: SessionStore,
    private val fcmTokenRegistrar: FcmTokenRegistrar? = null,
    private val companyProfileStore: CompanyProfileStore? = null
) {
    init {
        companyProfileStore?.prepareForAuthenticatedAccount(
            authenticatedAccountFromJwt(sessionStore.getToken())
        )
    }

    fun getSavedToken(): String = sessionStore.getToken()

    suspend fun login(login: String, senha: String): ApiResult<LoginResponse> {
        return when (val result = apiClient.login(login, senha)) {
            is ApiResult.Success -> {
                companyProfileStore?.prepareForAuthenticatedAccount(login)
                runCatching {
                    fcmTokenRegistrar?.prepareForAccountChange(result.value.token)
                }
                sessionStore.saveToken(result.value.token)
                runCatching {
                    fcmTokenRegistrar?.syncCurrentTokenNow()
                }
                result
            }
            is ApiResult.Failure -> result
        }
    }

    suspend fun register(whatsapp: String, senha: String): ApiResult<LoginResponse> {
        return when (val result = apiClient.register(whatsapp, senha)) {
            is ApiResult.Success -> {
                companyProfileStore?.prepareForAuthenticatedAccount(whatsapp)
                runCatching {
                    fcmTokenRegistrar?.prepareForAccountChange(result.value.token)
                }
                sessionStore.saveToken(result.value.token)
                runCatching {
                    fcmTokenRegistrar?.syncCurrentTokenNow()
                }
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

    suspend fun freeArtStatus(): ApiResult<FreeArtStatus> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.freeArtStatus(token)
    }

    suspend fun marketingVideo(context: String): ApiResult<MarketingVideo> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.marketingVideo(token, context)
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

    suspend fun calendarioPlanejamentoMensal(): ApiResult<List<MonthlyPlanningPostDto>> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.calendarioPlanejamentoMensal(token)
    }

    suspend fun ocultarItemCalendarioPlanejamento(itemKey: String): ApiResult<Unit> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.ocultarItemCalendarioPlanejamento(token, itemKey)
    }

    suspend fun reagendarItemCalendarioPlanejamento(request: MonthlyPlanningRescheduleRequest): ApiResult<MonthlyPlanningPostDto> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.reagendarItemCalendarioPlanejamento(token, request)
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

    suspend fun descobrirProdutosPlanejamentoMensal(
        image: UploadFile,
        ramoContexto: String? = null
    ): ApiResult<MonthlyPlanningProductDiscoveryResponse> {
        val token = sessionStore.getToken()
        if (token.isBlank()) {
            return ApiResult.Failure(
                message = SESSION_EXPIRED_MESSAGE,
                statusCode = 401,
                code = "session_expired"
            )
        }
        return apiClient.descobrirProdutosPlanejamentoMensal(token, image, ramoContexto)
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

    suspend fun criarArteAvulsaPix(quantidade: Int = 1): ApiResult<BillingPixResult> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.criarArteAvulsaPix(token, quantidade)
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

    suspend fun logout() {
        runCatching {
            fcmTokenRegistrar?.deactivateForLogout()
        }
        sessionStore.clear()
    }

    private companion object {
        const val SESSION_EXPIRED_MESSAGE = "Sessão expirada. Faça login novamente."
    }
}
