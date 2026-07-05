package br.com.ia4tube.app.feature.carousel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.R
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.CarouselRequest
import br.com.ia4tube.app.data.models.CarouselSharePayload
import br.com.ia4tube.app.data.models.CarouselStatus
import br.com.ia4tube.app.data.models.DownloadedCarousel
import br.com.ia4tube.app.data.models.UploadFile
import br.com.ia4tube.app.domain.usecase.CheckCarouselStatusUseCase
import br.com.ia4tube.app.domain.usecase.DownloadCarouselUseCase
import br.com.ia4tube.app.domain.usecase.ListCarouselsUseCase
import br.com.ia4tube.app.domain.usecase.LoadMeUseCase
import br.com.ia4tube.app.domain.usecase.RequestCarouselUseCase
import br.com.ia4tube.app.ui.text.UiText
import br.com.ia4tube.app.ui.text.toUiTextOrNull
import br.com.ia4tube.app.ui.text.uiText
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class CarouselUiState(
    val tema: String = "",
    val briefing: String = "",
    val quantidadeTelas: String = "5",
    val nivelConteudo: Int = 2,
    val logo: UploadFile? = null,
    val fotos: List<UploadFile> = emptyList(),
    val requesting: Boolean = false,
    val loadingHistory: Boolean = false,
    val checkingStatus: Boolean = false,
    val downloading: Boolean = false,
    val sharing: Boolean = false,
    val carrosselId: String = "",
    val status: CarouselStatus? = null,
    val carousels: List<CarouselStatus> = emptyList(),
    val downloaded: DownloadedCarousel? = null,
    val sharePayload: CarouselSharePayload? = null,
    val carrosseisRestantes: Int? = null,
    val message: UiText? = null,
    val error: UiText? = null
)

class CarouselViewModel(
    private val requestCarousel: RequestCarouselUseCase,
    private val listCarousels: ListCarouselsUseCase,
    private val checkCarouselStatus: CheckCarouselStatusUseCase,
    private val downloadCarousel: DownloadCarouselUseCase,
    private val loadMe: LoadMeUseCase
) : ViewModel() {
    private val _uiState = MutableStateFlow(CarouselUiState())
    val uiState: StateFlow<CarouselUiState> = _uiState.asStateFlow()

    private var pollingJob: Job? = null

    init {
        refreshQuota()
        refreshHistory(showLoading = true)
    }

    fun onTemaChange(value: String) {
        _uiState.update { it.copy(tema = value, error = null) }
    }

    fun onBriefingChange(value: String) {
        _uiState.update { it.copy(briefing = value, error = null) }
    }

    fun onQuantidadeTelasChange(value: String) {
        val filtered = value.filter { it.isDigit() }.take(2)
        _uiState.update { it.copy(quantidadeTelas = filtered, error = null) }
    }

    fun onNivelConteudoChange(value: Int) {
        _uiState.update { it.copy(nivelConteudo = value.coerceIn(1, 3), error = null) }
    }

    fun setLogo(file: UploadFile) {
        _uiState.update { it.copy(logo = file, error = null) }
    }

    fun removeLogo() {
        _uiState.update { it.copy(logo = null, error = null) }
    }

    fun addFotos(files: List<UploadFile>) {
        if (files.isEmpty()) return
        _uiState.update { state ->
            val remaining = MAX_FOTOS_EMPRESA - state.fotos.size
            if (remaining <= 0) {
                state.copy(error = uiText(R.string.carousel_photos_limit_error, MAX_FOTOS_EMPRESA))
            } else {
                state.copy(
                    fotos = (state.fotos + files.take(remaining)).take(MAX_FOTOS_EMPRESA),
                    error = if (files.size > remaining) uiText(R.string.carousel_photos_limit_error, MAX_FOTOS_EMPRESA) else null
                )
            }
        }
    }

    fun removeFoto(index: Int) {
        _uiState.update { state ->
            state.copy(
                fotos = state.fotos.filterIndexed { itemIndex, _ -> itemIndex != index },
                error = null
            )
        }
    }

    fun setUploadError(message: String) {
        _uiState.update { it.copy(error = message.toUiTextOrNull()) }
    }

    fun submit() {
        val state = _uiState.value
        val tema = state.tema.trim()
        val briefing = state.briefing.trim()
        val quantidade = state.quantidadeTelas.toIntOrNull()?.coerceIn(1, 10) ?: 0

        when {
            state.carrosseisRestantes != null && state.carrosseisRestantes <= 0 -> {
                _uiState.update { it.copy(error = uiText(R.string.carousel_limit_reached)) }
                return
            }
            tema.isBlank() -> {
                _uiState.update { it.copy(error = uiText(R.string.carousel_theme_required)) }
                return
            }
            briefing.isBlank() -> {
                _uiState.update { it.copy(error = uiText(R.string.carousel_briefing_required)) }
                return
            }
            quantidade <= 0 -> {
                _uiState.update { it.copy(error = uiText(R.string.carousel_screen_count_required)) }
                return
            }
        }

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    requesting = true,
                    downloaded = null,
                    sharePayload = null,
                    message = uiText(R.string.carousel_requesting),
                    error = null
                )
            }

            val request = CarouselRequest(
                tema = tema,
                briefing = briefing,
                quantidadeTelas = quantidade,
                nivelConteudo = state.nivelConteudo.coerceIn(1, 3),
                logo = state.logo,
                fotos = state.fotos
            )

            when (val result = requestCarousel(request)) {
                is ApiResult.Success -> {
                    val carrosselId = result.value.carrosselId
                    val optimisticStatus = CarouselStatus(
                        id = carrosselId,
                        carrosselId = carrosselId,
                        tema = tema,
                        quantidadeTelas = quantidade,
                        nivelConteudo = state.nivelConteudo.coerceIn(1, 3),
                        status = result.value.status.ifBlank { "pendente" },
                        statusLabel = result.value.statusLabel.ifBlank { "Pendente" },
                        ready = false,
                        ciclo = result.value.ciclo,
                        criadoEm = "",
                        atualizadoEm = "",
                        descricaoInstagram = "",
                        downloadUrl = ""
                    )
                    _uiState.update {
                        it.copy(
                            requesting = false,
                            carrosselId = carrosselId,
                            status = optimisticStatus,
                            carousels = upsertCarousel(it.carousels, optimisticStatus),
                            message = uiText(R.string.carousel_requested),
                            error = null
                        )
                    }
                    refreshStatusInternal(carrosselId, showLoading = true)
                    refreshQuota()
                    startPolling()
                }
                is ApiResult.Failure -> {
                    _uiState.update {
                        it.copy(
                            requesting = false,
                            message = null,
                            error = result.message.toUiTextOrNull() ?: uiText(R.string.carousel_request_error)
                        )
                    }
                }
            }
        }
    }

    fun refreshHistory(showLoading: Boolean = true) {
        viewModelScope.launch {
            val items = loadHistory(showLoading)
            if (hasActiveCarousel(items)) startPolling()
        }
    }

    fun refreshStatus() {
        val carrosselId = _uiState.value.carrosselId
        if (carrosselId.isBlank()) return
        refreshStatus(carrosselId)
    }

    fun refreshStatus(carrosselId: String) {
        if (carrosselId.isBlank()) return
        viewModelScope.launch {
            refreshStatusInternal(carrosselId, showLoading = true)
        }
    }

    fun saveImages(carrosselId: String) {
        val item = _uiState.value.carousels.firstOrNull { it.carrosselId == carrosselId }
        if (carrosselId.isBlank() || item?.ready != true || _uiState.value.downloading) return

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    carrosselId = carrosselId,
                    status = item,
                    downloading = true,
                    downloaded = null,
                    error = null
                )
            }

            when (val result = downloadCarousel(carrosselId)) {
                is ApiResult.Success -> {
                    _uiState.update {
                        it.copy(
                            downloading = false,
                            downloaded = result.value,
                            message = uiText(
                                R.string.carousel_images_saved,
                                result.value.imageCount,
                                result.value.savedPath
                            )
                        )
                    }
                }
                is ApiResult.Failure -> {
                    _uiState.update {
                        it.copy(
                            downloading = false,
                            error = result.message.toUiTextOrNull() ?: uiText(R.string.carousel_download_error)
                        )
                    }
                }
            }
        }
    }

    fun shareCarousel(carrosselId: String, description: String) {
        val item = _uiState.value.carousels.firstOrNull { it.carrosselId == carrosselId }
        if (carrosselId.isBlank() || item?.ready != true || _uiState.value.sharing) return

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    carrosselId = carrosselId,
                    status = item,
                    sharing = true,
                    sharePayload = null,
                    error = null
                )
            }

            when (val result = downloadCarousel.prepareShare(carrosselId, description)) {
                is ApiResult.Success -> {
                    _uiState.update {
                        it.copy(
                            sharing = false,
                            sharePayload = result.value,
                            message = null
                        )
                    }
                }
                is ApiResult.Failure -> {
                    _uiState.update {
                        it.copy(
                            sharing = false,
                            error = result.message.toUiTextOrNull() ?: uiText(R.string.carousel_download_error)
                        )
                    }
                }
            }
        }
    }

    fun clearDownloaded() {
        _uiState.update { it.copy(downloaded = null) }
    }

    fun clearSharePayload() {
        _uiState.update { it.copy(sharePayload = null) }
    }

    private fun refreshQuota() {
        viewModelScope.launch {
            when (val result = loadMe()) {
                is ApiResult.Success -> {
                    _uiState.update {
                        it.copy(carrosseisRestantes = result.value.carrosseisRestantes)
                    }
                }
                is ApiResult.Failure -> Unit
            }
        }
    }

    private suspend fun loadHistory(showLoading: Boolean): List<CarouselStatus> {
        if (showLoading) {
            _uiState.update { it.copy(loadingHistory = true, error = null) }
        }

        return when (val result = listCarousels()) {
            is ApiResult.Success -> {
                val items = result.value.carousels
                _uiState.update { state ->
                    val current = items.firstOrNull { it.carrosselId == state.carrosselId }
                    state.copy(
                        loadingHistory = false,
                        carousels = items,
                        status = current ?: state.status,
                        error = null
                    )
                }
                items
            }
            is ApiResult.Failure -> {
                _uiState.update {
                    it.copy(
                        loadingHistory = false,
                        error = result.message.toUiTextOrNull() ?: uiText(R.string.carousel_status_error)
                    )
                }
                _uiState.value.carousels
            }
        }
    }

    private suspend fun refreshStatusInternal(carrosselId: String, showLoading: Boolean) {
        if (showLoading) {
            _uiState.update { it.copy(checkingStatus = true, error = null) }
        }

        when (val result = checkCarouselStatus(carrosselId)) {
            is ApiResult.Success -> {
                val status = result.value.carousel
                _uiState.update {
                    it.copy(
                        checkingStatus = false,
                        status = status,
                        carrosselId = status.carrosselId.ifBlank { carrosselId },
                        carousels = upsertCarousel(it.carousels, status),
                        message = if (status.ready) uiText(R.string.carousel_ready) else it.message,
                        error = null
                    )
                }
                if (hasActiveCarousel(_uiState.value.carousels)) {
                    startPolling()
                } else {
                    pollingJob?.cancel()
                    pollingJob = null
                }
            }
            is ApiResult.Failure -> {
                _uiState.update {
                    it.copy(
                        checkingStatus = false,
                        error = result.message.toUiTextOrNull() ?: uiText(R.string.carousel_status_error)
                    )
                }
            }
        }
    }

    private fun startPolling() {
        if (pollingJob?.isActive == true) return
        pollingJob = viewModelScope.launch {
            while (true) {
                delay(POLLING_INTERVAL_MS)
                val items = loadHistory(showLoading = false)
                if (!hasActiveCarousel(items)) {
                    pollingJob = null
                    break
                }
            }
        }
    }

    private fun hasActiveCarousel(items: List<CarouselStatus>): Boolean {
        return items.any { !it.ready && !it.status.equals("erro", ignoreCase = true) }
    }

    private fun upsertCarousel(items: List<CarouselStatus>, item: CarouselStatus): List<CarouselStatus> {
        return (listOf(item) + items.filterNot { it.carrosselId == item.carrosselId })
            .sortedWith(
                compareByDescending<CarouselStatus> {
                    it.criadoEm.ifBlank { it.atualizadoEm }
                }.thenByDescending { it.carrosselId }
            )
    }

    override fun onCleared() {
        pollingJob?.cancel()
        super.onCleared()
    }

    companion object {
        const val POLLING_INTERVAL_MS = 8000L
        const val MAX_FOTOS_EMPRESA = 2
    }
}

class CarouselViewModelFactory(
    private val requestCarousel: RequestCarouselUseCase,
    private val listCarousels: ListCarouselsUseCase,
    private val checkCarouselStatus: CheckCarouselStatusUseCase,
    private val downloadCarousel: DownloadCarouselUseCase,
    private val loadMe: LoadMeUseCase
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return CarouselViewModel(
            requestCarousel,
            listCarousels,
            checkCarouselStatus,
            downloadCarousel,
            loadMe
        ) as T
    }
}
