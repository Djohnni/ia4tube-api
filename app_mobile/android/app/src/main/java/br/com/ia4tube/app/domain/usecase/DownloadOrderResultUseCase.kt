package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.core.download.ImageDownloadStore
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.DownloadedImage
import br.com.ia4tube.app.data.repository.AuthRepository

class DownloadOrderResultUseCase(
    private val repository: AuthRepository,
    private val imageDownloadStore: ImageDownloadStore
) {
    suspend operator fun invoke(pedidoId: String): ApiResult<String> {
        return when (val result = repository.downloadResultado(pedidoId)) {
            is ApiResult.Success -> imageDownloadStore.savePedidoImage(pedidoId, result.value)
            is ApiResult.Failure -> result
        }
    }

    suspend fun downloadImage(pedidoId: String): ApiResult<DownloadedImage> {
        return repository.downloadResultado(pedidoId)
    }
}
