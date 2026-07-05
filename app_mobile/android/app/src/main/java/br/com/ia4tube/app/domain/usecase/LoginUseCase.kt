package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.data.repository.AuthRepository

class LoginUseCase(private val repository: AuthRepository) {
    suspend operator fun invoke(login: String, senha: String) = repository.login(login, senha)
}
