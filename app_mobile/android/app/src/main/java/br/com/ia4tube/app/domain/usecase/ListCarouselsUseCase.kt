package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.data.repository.CarouselRepository

class ListCarouselsUseCase(
    private val repository: CarouselRepository
) {
    suspend operator fun invoke() = repository.list()
}
