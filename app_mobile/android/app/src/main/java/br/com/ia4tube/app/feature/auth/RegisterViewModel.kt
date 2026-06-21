package br.com.ia4tube.app.feature.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.domain.usecase.RegisterUseCase
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class RegisterUiState(
    val whatsapp: String = "",
    val senha: String = "",
    val confirmarSenha: String = "",
    val loading: Boolean = false,
    val error: String = "",
    val registeredIn: Boolean = false
)

class RegisterViewModel(
    private val registerUseCase: RegisterUseCase
) : ViewModel() {
    private val _uiState = MutableStateFlow(RegisterUiState())
    val uiState: StateFlow<RegisterUiState> = _uiState.asStateFlow()

    fun onWhatsappChange(value: String) {
        _uiState.update { it.copy(whatsapp = value, error = "") }
    }

    fun onSenhaChange(value: String) {
        _uiState.update { it.copy(senha = value, error = "") }
    }

    fun onConfirmarSenhaChange(value: String) {
        _uiState.update { it.copy(confirmarSenha = value, error = "") }
    }

    fun submit() {
        val state = _uiState.value
        when {
            state.whatsapp.isBlank() || state.senha.isBlank() || state.confirmarSenha.isBlank() -> {
                _uiState.update { it.copy(error = "Informe WhatsApp, senha e confirmacao.") }
                return
            }
            state.senha.length < 3 -> {
                _uiState.update { it.copy(error = "A senha deve ter pelo menos 3 caracteres.") }
                return
            }
            state.senha != state.confirmarSenha -> {
                _uiState.update { it.copy(error = "As senhas nao conferem.") }
                return
            }
        }

        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, error = "") }
            when (val result = registerUseCase(state.whatsapp.trim(), state.senha)) {
                is ApiResult.Success -> _uiState.update {
                    it.copy(loading = false, registeredIn = true)
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(loading = false, error = result.message)
                }
            }
        }
    }
}

class RegisterViewModelFactory(
    private val registerUseCase: RegisterUseCase
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return RegisterViewModel(registerUseCase) as T
    }
}
