package br.com.ia4tube.app.feature.company_profile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.R
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.CompanyGraphicMaterial
import br.com.ia4tube.app.data.models.CompanyGraphicMaterialProfileRequest
import br.com.ia4tube.app.data.models.GeneratedCompanyGraphicMaterial
import br.com.ia4tube.app.domain.usecase.CheckCompanyGraphicMaterialStatusUseCase
import br.com.ia4tube.app.domain.usecase.DownloadCompanyGraphicMaterialUseCase
import br.com.ia4tube.app.domain.usecase.GenerateCompanyGraphicMaterialUseCase
import br.com.ia4tube.app.domain.usecase.ListCompanyGraphicMaterialsUseCase
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

data class CompanyGraphicMaterialsUiState(
    val loading: Boolean = false,
    val generatingMaterialId: String = "",
    val downloadingMaterialId: String = "",
    val shareAfterDownload: Boolean = false,
    val materials: List<CompanyGraphicMaterial> = emptyList(),
    val ciclo: String = "",
    val planName: String = "",
    val planStatus: String = "",
    val generated: GeneratedCompanyGraphicMaterial? = null,
    val message: UiText? = null,
    val error: UiText? = null
)

class CompanyGraphicMaterialsViewModel(
    private val listCompanyGraphicMaterials: ListCompanyGraphicMaterialsUseCase,
    private val generateCompanyGraphicMaterial: GenerateCompanyGraphicMaterialUseCase,
    private val checkCompanyGraphicMaterialStatus: CheckCompanyGraphicMaterialStatusUseCase,
    private val downloadCompanyGraphicMaterial: DownloadCompanyGraphicMaterialUseCase
) : ViewModel() {
    private val _uiState = MutableStateFlow(CompanyGraphicMaterialsUiState())
    val uiState: StateFlow<CompanyGraphicMaterialsUiState> = _uiState.asStateFlow()

    private var pollingJob: Job? = null
    private var pollingRamo: String = ""

    fun load(ramo: String) {
        loadInternal(ramo, showLoading = true)
    }

    fun create(material: CompanyGraphicMaterial, request: CompanyGraphicMaterialProfileRequest) {
        if (_uiState.value.generatingMaterialId.isNotBlank() || material.status != STATUS_AVAILABLE) return

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    generatingMaterialId = material.id,
                    generated = null,
                    shareAfterDownload = false,
                    message = uiText(R.string.company_graphic_materials_generating),
                    error = null
                )
            }

            when (val result = generateCompanyGraphicMaterial(material.id, request)) {
                is ApiResult.Success -> {
                    _uiState.update {
                        it.copy(
                            generatingMaterialId = "",
                            message = uiText(R.string.company_graphic_materials_requested),
                            materials = it.materials.map { item ->
                                if (item.id == material.id) {
                                    item.copy(
                                        status = STATUS_PROCESSING,
                                        statusLabel = "Em produção",
                                        documentId = result.value.documentId,
                                        ready = false,
                                        locked = false
                                    )
                                } else {
                                    item
                                }
                            }
                        )
                    }
                    loadInternal(request.ramo, showLoading = false)
                }
                is ApiResult.Failure -> {
                    _uiState.update {
                        it.copy(
                            generatingMaterialId = "",
                            error = result.message.toUiTextOrNull()
                                ?: uiText(R.string.company_graphic_materials_generate_error),
                            message = null
                        )
                    }
                }
            }
        }
    }

    fun download(material: CompanyGraphicMaterial, shareAfterDownload: Boolean) {
        if (_uiState.value.downloadingMaterialId.isNotBlank()) return
        if (material.status != STATUS_CREATED && !material.ready) return

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    downloadingMaterialId = material.id,
                    generated = null,
                    shareAfterDownload = false,
                    error = null
                )
            }

            when (val result = downloadCompanyGraphicMaterial(material)) {
                is ApiResult.Success -> {
                    _uiState.update {
                        it.copy(
                            downloadingMaterialId = "",
                            generated = result.value,
                            shareAfterDownload = shareAfterDownload,
                            message = uiText(R.string.company_graphic_materials_saved, result.value.savedPath)
                        )
                    }
                }
                is ApiResult.Failure -> {
                    _uiState.update {
                        it.copy(
                            downloadingMaterialId = "",
                            error = result.message.toUiTextOrNull()
                                ?: uiText(R.string.company_graphic_materials_download_error)
                        )
                    }
                }
            }
        }
    }

    fun clearGenerated() {
        _uiState.update { it.copy(generated = null, shareAfterDownload = false) }
    }

    fun consumeShareRequest() {
        _uiState.update { it.copy(shareAfterDownload = false) }
    }

    private fun loadInternal(ramo: String, showLoading: Boolean) {
        viewModelScope.launch {
            if (showLoading) {
                _uiState.update { it.copy(loading = true, error = null) }
            }

            when (val result = listCompanyGraphicMaterials(ramo)) {
                is ApiResult.Success -> {
                    _uiState.update {
                        it.copy(
                            loading = false,
                            materials = result.value.materiais,
                            ciclo = result.value.ciclo,
                            planName = result.value.plano.nome,
                            planStatus = result.value.plano.status,
                            error = null
                        )
                    }
                    schedulePollingIfNeeded(ramo, result.value.materiais)
                }
                is ApiResult.Failure -> {
                    _uiState.update {
                        it.copy(
                            loading = false,
                            error = result.message.toUiTextOrNull()
                                ?: uiText(R.string.company_graphic_materials_load_error)
                        )
                    }
                }
            }
        }
    }

    private fun schedulePollingIfNeeded(ramo: String, materials: List<CompanyGraphicMaterial>) {
        val hasProcessing = materials.any { it.status == STATUS_PROCESSING }
        if (!hasProcessing) {
            pollingJob?.cancel()
            pollingJob = null
            pollingRamo = ""
            return
        }

        if (pollingJob?.isActive == true && pollingRamo == ramo) return
        pollingJob?.cancel()
        pollingRamo = ramo
        pollingJob = viewModelScope.launch {
            while (true) {
                delay(POLLING_INTERVAL_MS)
                refreshProcessingStatuses(ramo)
            }
        }
    }

    private suspend fun refreshProcessingStatuses(ramo: String) {
        val processingIds = _uiState.value.materials
            .filter { it.status == STATUS_PROCESSING }
            .map { it.id }

        processingIds.forEach { materialId ->
            when (val result = checkCompanyGraphicMaterialStatus(materialId, ramo)) {
                is ApiResult.Success -> {
                    _uiState.update { state ->
                        state.copy(
                            materials = state.materials.map { item ->
                                if (item.id == materialId) result.value.material else item
                            }
                        )
                    }
                }
                is ApiResult.Failure -> Unit
            }
        }

        loadInternal(ramo, showLoading = false)
    }

    override fun onCleared() {
        pollingJob?.cancel()
        super.onCleared()
    }

    private companion object {
        const val STATUS_AVAILABLE = "available"
        const val STATUS_PROCESSING = "processing"
        const val STATUS_CREATED = "created"
        const val POLLING_INTERVAL_MS = 8000L
    }
}

class CompanyGraphicMaterialsViewModelFactory(
    private val listCompanyGraphicMaterials: ListCompanyGraphicMaterialsUseCase,
    private val generateCompanyGraphicMaterial: GenerateCompanyGraphicMaterialUseCase,
    private val checkCompanyGraphicMaterialStatus: CheckCompanyGraphicMaterialStatusUseCase,
    private val downloadCompanyGraphicMaterial: DownloadCompanyGraphicMaterialUseCase
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return CompanyGraphicMaterialsViewModel(
            listCompanyGraphicMaterials,
            generateCompanyGraphicMaterial,
            checkCompanyGraphicMaterialStatus,
            downloadCompanyGraphicMaterial
        ) as T
    }
}
