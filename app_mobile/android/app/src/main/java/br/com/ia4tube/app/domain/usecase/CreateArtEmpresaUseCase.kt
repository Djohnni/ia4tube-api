package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.data.models.CreateArtEmpresaRequest
import br.com.ia4tube.app.data.models.FootballOrderRequest
import br.com.ia4tube.app.data.repository.AuthRepository

class CreateArtEmpresaUseCase(private val repository: AuthRepository) {
    suspend operator fun invoke(request: CreateArtEmpresaRequest) =
        repository.criarArteEmpresa(request)

    suspend fun criarPedidoFutebol(request: FootballOrderRequest) =
        repository.criarPedidoFutebol(request)
}
