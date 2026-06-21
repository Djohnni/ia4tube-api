package br.com.ia4tube.app.data.repository

import br.com.ia4tube.app.core.session.SessionStore
import br.com.ia4tube.app.data.api.IA4TubeApiClient
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.CompanyGraphicMaterialProfileRequest
import br.com.ia4tube.app.data.models.CompanyGraphicMaterialRequestResponse
import br.com.ia4tube.app.data.models.CompanyGraphicMaterialStatusResponse
import br.com.ia4tube.app.data.models.CompanyGraphicMaterialsListResponse
import br.com.ia4tube.app.data.models.DownloadedImage

class CompanyGraphicMaterialsRepository(
    private val apiClient: IA4TubeApiClient,
    private val sessionStore: SessionStore
) {
    suspend fun list(ramo: String): ApiResult<CompanyGraphicMaterialsListResponse> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.listarMateriaisGraficos(token, ramo)
    }

    suspend fun request(
        materialId: String,
        request: CompanyGraphicMaterialProfileRequest
    ): ApiResult<CompanyGraphicMaterialRequestResponse> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.solicitarMaterialGrafico(token, materialId, request)
    }

    suspend fun status(materialId: String, ramo: String): ApiResult<CompanyGraphicMaterialStatusResponse> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.statusMaterialGrafico(token, materialId, ramo)
    }

    suspend fun download(materialId: String): ApiResult<DownloadedImage> {
        val token = sessionStore.getToken()
        if (token.isBlank()) return ApiResult.Failure(SESSION_EXPIRED_MESSAGE)
        return apiClient.downloadMaterialGrafico(token, materialId)
    }

    private companion object {
        const val SESSION_EXPIRED_MESSAGE = "Sessão expirada. Faça login novamente."
    }
}
