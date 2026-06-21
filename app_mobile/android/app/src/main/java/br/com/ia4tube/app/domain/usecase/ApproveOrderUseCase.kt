package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.data.repository.AuthRepository

class ApproveOrderUseCase(private val repository: AuthRepository) {
    suspend operator fun invoke(pedidoId: String) = repository.aprovarPedido(pedidoId)
}
