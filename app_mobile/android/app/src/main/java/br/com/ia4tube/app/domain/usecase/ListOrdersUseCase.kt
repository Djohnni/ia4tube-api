package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.data.repository.AuthRepository

class ListOrdersUseCase(private val repository: AuthRepository) {
    suspend operator fun invoke() = repository.meusPedidos()
}
