package br.com.ia4tube.app.data.repository

import br.com.ia4tube.app.core.session.SessionStore
import br.com.ia4tube.app.data.api.IA4TubeApiClient
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.CarouselListResponse
import br.com.ia4tube.app.data.models.CarouselRequest
import br.com.ia4tube.app.data.models.CarouselRequestResponse
import br.com.ia4tube.app.data.models.CarouselStatusResponse
import br.com.ia4tube.app.data.models.DownloadedFile

class CarouselRepository(
    private val apiClient: IA4TubeApiClient,
    private val sessionStore: SessionStore
) {
    suspend fun request(request: CarouselRequest): ApiResult<CarouselRequestResponse> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.solicitarCarrossel(token, request)
    }

    suspend fun list(): ApiResult<CarouselListResponse> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.listarCarrosseis(token)
    }

    suspend fun status(carrosselId: String): ApiResult<CarouselStatusResponse> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.statusCarrossel(token, carrosselId)
    }

    suspend fun download(carrosselId: String): ApiResult<DownloadedFile> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.downloadCarrossel(token, carrosselId)
    }

    private companion object {
        const val SESSION_EXPIRED_MESSAGE = "SessÃ£o expirada. FaÃ§a login novamente."
    }
}
