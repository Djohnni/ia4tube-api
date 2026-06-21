package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.data.repository.AuthRepository

class SendSupportMessageUseCase(private val repository: AuthRepository) {
    suspend operator fun invoke(message: String) = repository.enviarMensagemSuporte(message)
}
