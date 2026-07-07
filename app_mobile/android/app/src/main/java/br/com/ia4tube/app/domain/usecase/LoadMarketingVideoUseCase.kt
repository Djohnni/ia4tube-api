package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.data.repository.AuthRepository

class LoadMarketingVideoUseCase(private val repository: AuthRepository) {
    suspend operator fun invoke(context: String) = repository.marketingVideo(context)
}
