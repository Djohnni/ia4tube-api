package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.data.models.CarouselRequest
import br.com.ia4tube.app.data.repository.CarouselRepository

class RequestCarouselUseCase(
    private val repository: CarouselRepository
) {
    suspend operator fun invoke(request: CarouselRequest) = repository.request(request)
}
