package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.core.download.ZipDownloadStore
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.CarouselSharePayload
import br.com.ia4tube.app.data.models.DownloadedCarousel
import br.com.ia4tube.app.data.repository.CarouselRepository

class DownloadCarouselUseCase(
    private val repository: CarouselRepository,
    private val zipDownloadStore: ZipDownloadStore
) {
    suspend operator fun invoke(carrosselId: String): ApiResult<DownloadedCarousel> {
        return when (val file = repository.download(carrosselId)) {
            is ApiResult.Failure -> file
            is ApiResult.Success -> zipDownloadStore.saveCarouselImages(carrosselId, file.value)
        }
    }

    suspend fun prepareShare(carrosselId: String, descricaoInstagram: String): ApiResult<CarouselSharePayload> {
        return when (val file = repository.download(carrosselId)) {
            is ApiResult.Failure -> file
            is ApiResult.Success -> {
                when (val images = zipDownloadStore.extractCarouselImages(carrosselId, file.value)) {
                    is ApiResult.Failure -> images
                    is ApiResult.Success -> ApiResult.Success(
                        CarouselSharePayload(
                            carrosselId = carrosselId,
                            images = images.value,
                            descricaoInstagram = descricaoInstagram
                        )
                    )
                }
            }
        }
    }
}
