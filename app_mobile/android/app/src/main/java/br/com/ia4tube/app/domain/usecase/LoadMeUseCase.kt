package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.data.repository.AuthRepository

class LoadMeUseCase(private val repository: AuthRepository) {
    suspend operator fun invoke() = repository.me()
}
