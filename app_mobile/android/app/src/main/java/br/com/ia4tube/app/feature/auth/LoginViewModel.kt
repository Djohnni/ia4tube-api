package br.com.ia4tube.app.feature.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.core.analytics.MobileAnalytics
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.domain.usecase.LoginUseCase
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class LoginUiState(
    val login: String = "",
    val senha: String = "",
    val loading: Boolean = false,
    val error: String = "",
    val loggedIn: Boolean = false
)

class LoginViewModel(
    private val loginUseCase: LoginUseCase
) : ViewModel() {
    private val _uiState = MutableStateFlow(LoginUiState())
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    fun onLoginChange(value: String) {
        MobileAnalytics.fieldFocus("login", "login")
        _uiState.update { it.copy(login = value, error = "") }
    }

    fun onSenhaChange(value: String) {
        MobileAnalytics.fieldFocus("senha", "login")
        _uiState.update { it.copy(senha = value, error = "") }
    }

    fun submit() {
        val state = _uiState.value
        if (state.login.isBlank() || state.senha.isBlank()) {
            _uiState.update { it.copy(error = "Informe login e senha.") }
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, error = "") }
            when (val result = loginUseCase(state.login.trim(), state.senha)) {
                is ApiResult.Success -> {
                    MobileAnalytics.track("mobile_login_concluido", tela = "login", flushNow = true)
                    _uiState.update { it.copy(loading = false, loggedIn = true) }
                }
                is ApiResult.Failure -> _uiState.update {
                    MobileAnalytics.track(
                        "mobile_login_erro",
                        tela = "login",
                        payload = mapOf("erro" to result.message),
                        flushNow = true
                    )
                    it.copy(loading = false, error = result.message)
                }
            }
        }
    }
}

class LoginViewModelFactory(
    private val loginUseCase: LoginUseCase
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return LoginViewModel(loginUseCase) as T
    }
}
