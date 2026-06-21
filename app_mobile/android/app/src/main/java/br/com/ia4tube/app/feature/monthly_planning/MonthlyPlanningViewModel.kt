package br.com.ia4tube.app.feature.monthly_planning

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.core.company.CompanyProfileStore
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.MonthlyPlanningDetailDto
import br.com.ia4tube.app.data.models.MonthlyPlanningPhotoInput
import br.com.ia4tube.app.data.models.MonthlyPlanningPostDto
import br.com.ia4tube.app.data.models.MonthlyPlanningRequest
import br.com.ia4tube.app.data.models.MonthlyPlanningRequestResponse
import br.com.ia4tube.app.data.models.MonthlyPlanningSummaryDto
import br.com.ia4tube.app.data.models.UploadFile
import br.com.ia4tube.app.data.repository.AuthRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val DEFAULT_CYCLE_ARTS = 0
const val MOCK_PLANNING_ID = "planejamento-junho-2026"

enum class MonthlyPlanningStep {
    Entry,
    Upload,
    Confirmation,
    Processing,
    MyPlannings
}

data class MonthlyPlanningUiState(
    val step: MonthlyPlanningStep = MonthlyPlanningStep.Entry,
    val loading: Boolean = false,
    val cycleArts: Int = DEFAULT_CYCLE_ARTS,
    val currentFreeArts: Int = 0,
    val reservedInput: String = "",
    val photos: List<MonthlyPlanningPhotoInput> = emptyList(),
    val uploadError: String? = null,
    val successMessage: String? = null,
    val planning: MonthlyPlanningSummary = MonthlyPlanningMockData.summary,
    val plannings: List<MonthlyPlanningSummary> = emptyList(),
    val detailPlanning: MonthlyPlanningSummary? = null
) {
    val reservedArts: Int
        get() = reservedInput.toIntOrNull()?.coerceIn(0, currentFreeArts) ?: 0

    val freeArts: Int
        get() = (currentFreeArts - reservedArts).coerceAtLeast(0)
}

data class MonthlyPlanningSummary(
    val id: String,
    val title: String,
    val status: String = "",
    val totalPosts: Int,
    val readyPosts: Int,
    val productionPosts: Int,
    val plannedPosts: Int,
    val posts: List<MonthlyPlanningPost>
)

data class MonthlyPlanningPost(
    val number: Int,
    val dateLabel: String,
    val theme: String = "",
    val objective: String,
    val status: String,
    val caption: String,
    val pedidoId: String = "",
    val imageReady: Boolean = false
)

object MonthlyPlanningMockData {
    val posts = listOf(
        MonthlyPlanningPost(
            number = 1,
            dateLabel = "05/06 às 09:00",
            objective = "Divulgar serviço principal",
            status = "Pronta",
            caption = "Hoje é dia de mostrar o serviço principal da sua empresa com uma comunicação clara e profissional."
        ),
        MonthlyPlanningPost(
            number = 2,
            dateLabel = "07/06 às 18:00",
            objective = "Mostrar bastidores da empresa",
            status = "Pronta",
            caption = "Bastidores ajudam o cliente a confiar mais no seu trabalho e conhecer melhor sua rotina."
        ),
        MonthlyPlanningPost(
            number = 3,
            dateLabel = "10/06 às 12:00",
            objective = "Apresentar benefício para o cliente",
            status = "Pronta",
            caption = "Uma boa arte explica o benefício com simplicidade e chama o cliente para agir."
        ),
        MonthlyPlanningPost(
            number = 4,
            dateLabel = "12/06 às 09:00",
            objective = "Reforçar prova social",
            status = "Pronta",
            caption = "Mostrar resultados, detalhes e atendimento ajuda a valorizar a marca."
        ),
        MonthlyPlanningPost(
            number = 5,
            dateLabel = "14/06 às 17:00",
            objective = "Divulgar produto ou serviço complementar",
            status = "Em produção",
            caption = "Uma comunicação complementar mantém o perfil ativo e cria novas oportunidades."
        ),
        MonthlyPlanningPost(
            number = 6,
            dateLabel = "17/06 às 09:00",
            objective = "Educar o cliente sobre o serviço",
            status = "Em produção",
            caption = "Conteúdo educativo aproxima o cliente e reduz dúvidas antes do contato."
        ),
        MonthlyPlanningPost(
            number = 7,
            dateLabel = "19/06 às 18:30",
            objective = "Chamar para orçamento",
            status = "Em produção",
            caption = "Uma chamada direta para orçamento facilita o próximo passo do cliente."
        )
    ) + (8..20).map { index ->
        MonthlyPlanningPost(
            number = index,
            dateLabel = "${(index + 12).toString().padStart(2, '0')}/06 às ${if (index % 2 == 0) "09:00" else "18:00"}",
            objective = "Postagem planejada do mês",
            status = "Planejada",
            caption = "Legenda planejada para a postagem $index."
        )
    }

    val summary = MonthlyPlanningSummary(
        id = MOCK_PLANNING_ID,
        title = "Planejamento Junho 2026",
        totalPosts = 20,
        readyPosts = 4,
        productionPosts = 3,
        plannedPosts = 13,
        posts = posts
    )
}

class MonthlyPlanningViewModel(
    private val repository: AuthRepository,
    private val companyProfileStore: CompanyProfileStore
) : ViewModel() {
    private val _uiState = MutableStateFlow(MonthlyPlanningUiState())
    val uiState: StateFlow<MonthlyPlanningUiState> = _uiState.asStateFlow()

    init {
        loadAccountAndPlannings()
    }

    private fun loadAccountAndPlannings() {
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, uploadError = null) }

            when (val me = repository.me()) {
                is ApiResult.Success -> {
                    _uiState.update { state ->
                        val total = me.value.artesMensaisTotal.coerceAtLeast(0)
                        val free = me.value.artesMensaisRestantes.coerceAtLeast(0)
                        state.copy(
                            cycleArts = total,
                            currentFreeArts = free,
                            reservedInput = state.reservedInput.clampReservedInput(free)
                        )
                    }
                }
                is ApiResult.Failure -> Unit
            }

            when (val result = repository.listarPlanejamentosMensais()) {
                is ApiResult.Success -> {
                    val mapped = result.value.map { it.toUiSummary() }
                    _uiState.update { state ->
                        state.copy(
                            loading = false,
                            plannings = mapped,
                            planning = mapped.firstOrNull() ?: state.planning
                        )
                    }
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        loading = false,
                        uploadError = result.message
                    )
                }
            }
        }
    }

    fun loadDetail(planningId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, uploadError = null) }
            when (val result = repository.planejamentoMensalDetalhe(planningId)) {
                is ApiResult.Success -> {
                    val detail = result.value.toUiSummary()
                    _uiState.update {
                        it.copy(
                            loading = false,
                            detailPlanning = detail,
                            planning = detail
                        )
                    }
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        loading = false,
                        uploadError = result.message,
                        detailPlanning = MonthlyPlanningMockData.summary.takeIf { mock -> mock.id == planningId }
                    )
                }
            }
        }
    }

    fun onReservedInputChange(value: String) {
        val digits = value.filter(Char::isDigit).take(2)
        _uiState.update { state ->
            state.copy(
                reservedInput = digits,
                uploadError = null,
                successMessage = null
            )
        }
    }

    fun goToUpload() {
        _uiState.update { state ->
            if (state.reservedArts <= 0) {
                state.copy(
                    uploadError = "Escolha pelo menos 1 arte para o planejamento.",
                    successMessage = null
                )
            } else {
                state.copy(step = MonthlyPlanningStep.Upload, uploadError = null, successMessage = null)
            }
        }
    }

    fun goToConfirmation() {
        _uiState.update { it.copy(step = MonthlyPlanningStep.Confirmation, uploadError = null, successMessage = null) }
    }

    fun confirmPlanning() {
        val current = _uiState.value
        if (current.reservedArts <= 0) {
            _uiState.update {
                it.copy(
                    uploadError = "Escolha pelo menos 1 arte para o planejamento.",
                    successMessage = null
                )
            }
            return
        }

        val profile = companyProfileStore.getProfile()
        val nomeEmpresa = profile.nomeEmpresa.trim()
        val ramo = profile.ramo.trim()

        if (nomeEmpresa.isBlank() || ramo.isBlank()) {
            _uiState.update {
                it.copy(
                    uploadError = "Preencha Nome da empresa e Ramo da empresa em Materiais Impressos antes de criar o planejamento.",
                    successMessage = null
                )
            }
            return
        }

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    step = MonthlyPlanningStep.Processing,
                    loading = true,
                    uploadError = null,
                    successMessage = null
                )
            }

            val request = MonthlyPlanningRequest(
                quantidadeReservada = current.reservedArts,
                nomeEmpresa = nomeEmpresa,
                ramo = ramo,
                fotos = current.photos
            )

            when (val result = repository.solicitarPlanejamentoMensal(request)) {
                is ApiResult.Success -> handlePlanningCreated(result.value)
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        step = MonthlyPlanningStep.Confirmation,
                        loading = false,
                        uploadError = result.message,
                        successMessage = null
                    )
                }
            }
        }
    }

    fun showMyPlannings() {
        _uiState.update { it.copy(step = MonthlyPlanningStep.MyPlannings, uploadError = null) }
        loadAccountAndPlannings()
    }

    fun backToEntry() {
        _uiState.update { it.copy(step = MonthlyPlanningStep.Entry, uploadError = null, successMessage = null) }
    }

    fun backToUpload() {
        _uiState.update { it.copy(step = MonthlyPlanningStep.Upload, uploadError = null, successMessage = null) }
    }

    fun addPhotos(files: List<UploadFile>) {
        if (files.isEmpty()) return
        _uiState.update { state ->
            state.copy(
                photos = state.photos + files.map { file -> MonthlyPlanningPhotoInput(file = file) },
                uploadError = null,
                successMessage = null
            )
        }
    }

    fun updatePhotoOrientation(index: Int, orientation: String) {
        _uiState.update { state ->
            state.copy(
                photos = state.photos.mapIndexed { itemIndex, item ->
                    if (itemIndex == index) item.copy(orientacao = orientation) else item
                },
                uploadError = null,
                successMessage = null
            )
        }
    }

    fun removePhoto(index: Int) {
        _uiState.update { state ->
            state.copy(
                photos = state.photos.filterIndexed { itemIndex, _ -> itemIndex != index },
                uploadError = null,
                successMessage = null
            )
        }
    }

    fun setUploadError(message: String) {
        _uiState.update { it.copy(uploadError = message, successMessage = null) }
    }

    private suspend fun handlePlanningCreated(response: MonthlyPlanningRequestResponse) {
        val created = response.toUiSummary()
        val refreshedAccount = repository.me()
        val plannings = when (val listResult = repository.listarPlanejamentosMensais()) {
            is ApiResult.Success -> listResult.value.map { it.toUiSummary() }
            is ApiResult.Failure -> emptyList()
        }
        val merged = if (plannings.any { it.id == created.id }) {
            plannings
        } else {
            listOf(created) + plannings
        }

        _uiState.update {
            val account = (refreshedAccount as? ApiResult.Success)?.value
            val cycleArts = account?.artesMensaisTotal?.coerceAtLeast(0)
                ?: response.artesDesteCiclo.coerceAtLeast(0)
            val freeArts = account?.artesMensaisRestantes?.coerceAtLeast(0)
                ?: response.livresParaCriarArte.coerceAtLeast(0)
            it.copy(
                step = MonthlyPlanningStep.MyPlannings,
                loading = false,
                cycleArts = cycleArts,
                currentFreeArts = freeArts,
                reservedInput = "",
                photos = emptyList(),
                planning = merged.firstOrNull { item -> item.id == created.id } ?: created,
                plannings = merged,
                uploadError = null,
                successMessage = "Planejamento criado. Status: ${created.status.ifBlank { "Em analise" }}."
            )
        }
    }
}

private fun String.clampReservedInput(max: Int): String {
    val value = toIntOrNull() ?: return this
    return value.coerceAtMost(max.coerceAtLeast(0)).takeIf { it > 0 }?.toString().orEmpty()
}

private fun MonthlyPlanningSummaryDto.toUiSummary(): MonthlyPlanningSummary {
    return MonthlyPlanningSummary(
        id = id,
        title = title.ifBlank { "Planejamento Mensal" },
        status = status,
        totalPosts = totalPosts,
        readyPosts = readyPosts,
        productionPosts = productionPosts,
        plannedPosts = plannedPosts,
        posts = emptyList()
    )
}

private fun MonthlyPlanningRequestResponse.toUiSummary(): MonthlyPlanningSummary {
    return MonthlyPlanningSummary(
        id = planningId,
        title = "Planejamento ${ciclo.ifBlank { "Mensal" }}",
        status = statusLabel.ifBlank { status },
        totalPosts = quantidadeReservada,
        readyPosts = 0,
        productionPosts = 0,
        plannedPosts = quantidadeReservada,
        posts = emptyList()
    )
}

private fun MonthlyPlanningDetailDto.toUiSummary(): MonthlyPlanningSummary {
    return summary.toUiSummary().copy(
        posts = posts.map { it.toUiPost() }
    )
}

private fun MonthlyPlanningPostDto.toUiPost(): MonthlyPlanningPost {
    return MonthlyPlanningPost(
        number = number,
        dateLabel = formatPlanningDateLabel(date, time),
        theme = theme,
        objective = objective,
        status = statusLabel.ifBlank { status },
        caption = caption,
        pedidoId = pedidoId,
        imageReady = imageReady
    )
}

private fun formatPlanningDateLabel(date: String, time: String): String {
    val parts = date.split("-")
    val formattedDate = if (parts.size == 3) {
        "${parts[2]}/${parts[1]}"
    } else {
        date
    }
    return listOf(formattedDate, time).filter { it.isNotBlank() }.joinToString(" as ")
}

class MonthlyPlanningViewModelFactory(
    private val repository: AuthRepository,
    private val companyProfileStore: CompanyProfileStore
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return MonthlyPlanningViewModel(repository, companyProfileStore) as T
    }
}
