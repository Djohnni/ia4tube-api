package br.com.ia4tube.app.feature.splash

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.repository.AuthRepository
import br.com.ia4tube.app.domain.usecase.LoadMeUseCase
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface SplashDestination {
    data object Loading : SplashDestination
    data object Login : SplashDestination
    data object Home : SplashDestination
}

class SplashViewModel(
    private val repository: AuthRepository,
    private val loadMe: LoadMeUseCase
) : ViewModel() {
    private val _destination = MutableStateFlow<SplashDestination>(SplashDestination.Loading)
    val destination: StateFlow<SplashDestination> = _destination.asStateFlow()

    init {
        viewModelScope.launch {
            if (repository.getSavedToken().isBlank()) {
                _destination.value = SplashDestination.Home
                return@launch
            }

            _destination.value = when (loadMe()) {
                is ApiResult.Success -> SplashDestination.Home
                is ApiResult.Failure -> {
                    repository.logout()
                    SplashDestination.Home
                }
            }
        }
    }
}

class SplashViewModelFactory(
    private val repository: AuthRepository,
    private val loadMe: LoadMeUseCase
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return SplashViewModel(repository, loadMe) as T
    }
}
