package br.com.ia4tube.app.feature.monthly_planning

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.core.analytics.MobileAnalytics
import br.com.ia4tube.app.core.company.CompanyProfile
import br.com.ia4tube.app.core.company.CompanyProfileStore
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.BillingPixResult
import br.com.ia4tube.app.data.models.DownloadedImage
import br.com.ia4tube.app.data.models.MarketingVideo
import br.com.ia4tube.app.data.models.MonthlyPlanningDetailDto
import br.com.ia4tube.app.data.models.MonthlyPlanningPhotoInput
import br.com.ia4tube.app.data.models.MonthlyPlanningPostDto
import br.com.ia4tube.app.data.models.MonthlyPlanningRequest
import br.com.ia4tube.app.data.models.MonthlyPlanningRequestResponse
import br.com.ia4tube.app.data.models.MonthlyPlanningRescheduleRequest
import br.com.ia4tube.app.data.models.MonthlyPlanningSummaryDto
import br.com.ia4tube.app.data.models.UploadFile
import br.com.ia4tube.app.data.repository.AuthRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val DEFAULT_CYCLE_ARTS = 0
const val PHOTO_TEXT_MAX_LENGTH = 200
private const val MIN_PHOTO_EDIT_LEVEL = 1
private const val MAX_PHOTO_EDIT_LEVEL = 3
private const val MARKETING_CONTEXT_FIRST_FREE_ART = "primeira_arte_gratis"
const val MOCK_PLANNING_ID = "planejamento-junho-2026"

enum class MonthlyPlanningStep {
    Upload,
    Confirmation,
    Processing,
    MyPlannings
}

data class MonthlyPlanningUiState(
    val step: MonthlyPlanningStep = MonthlyPlanningStep.Upload,
    val loading: Boolean = false,
    val cycleArts: Int = DEFAULT_CYCLE_ARTS,
    val currentFreeArts: Int = 0,
    val reservedInput: String = "",
    val photos: List<MonthlyPlanningPhotoDraft> = emptyList(),
    val companyProfile: MonthlyPlanningCompanyProfile = MonthlyPlanningCompanyProfile(),
    val uploadError: String? = null,
    val successMessage: String? = null,
    val planning: MonthlyPlanningSummary = MonthlyPlanningMockData.summary,
    val plannings: List<MonthlyPlanningSummary> = emptyList(),
    val detailPlanning: MonthlyPlanningSummary? = null,
    val calendarLoading: Boolean = false,
    val calendarError: String? = null,
    val calendarSharingItemKeys: Set<String> = emptySet(),
    val calendarSharePayload: MonthlyPlanningCalendarSharePayload? = null,
    val generalCalendarPosts: List<MonthlyPlanningCalendarListItem> = emptyList(),
    val billingRequired: Boolean = false,
    val billingPixLoading: Boolean = false,
    val billingPix: BillingPixResult? = null,
    val billingPixError: String? = null,
    val marketingVideo: MarketingVideo? = null,
    val marketingVideoFinished: Boolean = false
) {
    val reservedArts: Int
        get() = reservedInput.toIntOrNull()?.coerceIn(0, currentFreeArts) ?: 0

    val freeArts: Int
        get() = (currentFreeArts - reservedArts).coerceAtLeast(0)

    val requiredStandaloneArts: Int
        get() = photos.size.coerceAtLeast(1)

    val visibleGeneralCalendarPosts: List<MonthlyPlanningCalendarListItem>
        get() = generalCalendarPosts
}

data class MonthlyPlanningCompanyProfile(
    val nomeEmpresa: String = "",
    val ramo: String = "",
    val ramoSelecionadoCatalogo: Boolean = false,
    val ramoDigitacaoLivre: Boolean = false,
    val whatsapp: String = "",
    val instagram: String = "",
    val caracteristicasEmpresa: List<String> = emptyList(),
    val informacoesEmpresa: String = "",
    val showOtherInfo: Boolean = false,
    val logoUri: String = "",
    val logoFile: UploadFile? = null
)

data class MonthlyPlanningPhotoDraft(
    val file: UploadFile,
    val objetivo: String = "",
    val objetivoId: String = "",
    val escritaImagem: String = "",
    val nivelEdicao: Int = 2,
    val showNivelInfo: Boolean = false
)

data class MonthlyPlanningSummary(
    val id: String,
    val title: String,
    val createdAt: String = "",
    val status: String = "",
    val totalPosts: Int,
    val readyPosts: Int,
    val productionPosts: Int,
    val plannedPosts: Int,
    val posts: List<MonthlyPlanningPost>
)

data class MonthlyPlanningPost(
    val number: Int,
    val itemId: String = "",
    val planningId: String = "",
    val planejamentoItemId: String = "",
    val date: String = "",
    val time: String = "",
    val dateLabel: String,
    val theme: String = "",
    val objective: String,
    val status: String,
    val caption: String,
    val pedidoId: String = "",
    val imageReady: Boolean = false,
    val imageText: String = "",
    val thumbnailUrl: String = ""
)

data class MonthlyPlanningCalendarSharePayload(
    val pedidoId: String,
    val image: DownloadedImage,
    val description: String
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
        createdAt = "",
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
        refreshCompanyProfile()
        loadAccountAndPlannings()
    }

    private fun refreshCompanyProfile() {
        _uiState.update { it.copy(companyProfile = companyProfileStore.getProfile().toUiCompanyProfile()) }
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
                                .ifBlank { reservedInputForPhotos(state.photos.size, free) }
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

    fun loadGeneralCalendar() {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    calendarLoading = true,
                    calendarError = null
                )
            }

            when (val result = repository.calendarioPlanejamentoMensal()) {
                is ApiResult.Success -> {
                    val calendarPosts = result.value
                        .map { it.toUiPost().toCalendarListItem() }
                        .sortedWith(compareBy<MonthlyPlanningCalendarListItem> { it.sortKey }.thenBy { it.title })

                    _uiState.update {
                        it.copy(
                            calendarLoading = false,
                            calendarError = null,
                            generalCalendarPosts = calendarPosts
                        )
                    }
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        calendarLoading = false,
                        calendarError = result.message
                    )
                }
            }
        }
    }

    fun removeFromGeneralCalendar(itemKey: String) {
        viewModelScope.launch {
            when (val result = repository.ocultarItemCalendarioPlanejamento(itemKey)) {
                is ApiResult.Success -> _uiState.update {
                    it.copy(
                        calendarError = null,
                        generalCalendarPosts = it.generalCalendarPosts.filterNot { item -> item.key == itemKey }
                    )
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(calendarError = result.message)
                }
            }
        }
    }

    fun rescheduleGeneralCalendarItem(item: MonthlyPlanningCalendarListItem, newDate: String) {
        viewModelScope.launch {
            val request = MonthlyPlanningRescheduleRequest(
                itemKey = item.key,
                planningId = item.planningId,
                planejamentoItemId = item.planejamentoItemId,
                pedidoId = item.pedidoId,
                date = newDate,
                time = item.time
            )

            when (val result = repository.reagendarItemCalendarioPlanejamento(request)) {
                is ApiResult.Success -> {
                    val updated = result.value.toUiPost().toCalendarListItem()
                    _uiState.update { state ->
                        state.copy(
                            calendarError = null,
                            generalCalendarPosts = state.generalCalendarPosts
                                .filterNot { existing ->
                                    existing.key == item.key ||
                                        (updated.key.isNotBlank() && existing.key == updated.key)
                                }
                                .plus(updated)
                                .sortedWith(compareBy<MonthlyPlanningCalendarListItem> { it.sortKey }.thenBy { it.title })
                        )
                    }
                    loadGeneralCalendar()
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(calendarError = result.message)
                }
            }
        }
    }

    fun shareGeneralCalendarItem(item: MonthlyPlanningCalendarListItem) {
        if (!item.imageReady || item.pedidoId.isBlank()) return

        var shouldStart = false
        _uiState.update { state ->
            if (state.calendarSharingItemKeys.contains(item.key)) {
                state
            } else {
                shouldStart = true
                state.copy(
                    calendarError = null,
                    calendarSharePayload = null,
                    calendarSharingItemKeys = state.calendarSharingItemKeys + item.key
                )
            }
        }
        if (!shouldStart) return

        viewModelScope.launch {
            when (val result = repository.downloadResultado(item.pedidoId)) {
                is ApiResult.Success -> _uiState.update { state ->
                    state.copy(
                        calendarSharingItemKeys = state.calendarSharingItemKeys - item.key,
                        calendarError = null,
                        calendarSharePayload = MonthlyPlanningCalendarSharePayload(
                            pedidoId = item.pedidoId,
                            image = result.value,
                            description = item.title
                        )
                    )
                }
                is ApiResult.Failure -> _uiState.update { state ->
                    state.copy(
                        calendarSharingItemKeys = state.calendarSharingItemKeys - item.key,
                        calendarSharePayload = null,
                        calendarError = result.message.ifBlank { "Não foi possível compartilhar a imagem." }
                    )
                }
            }
        }
    }

    fun clearCalendarSharePayload() {
        _uiState.update { it.copy(calendarSharePayload = null) }
    }

    fun onMarketingVideoStarted() {
        val video = _uiState.value.marketingVideo ?: return
        trackMarketingVideo("mobile_video_marketing_iniciado", video)
    }

    fun onMarketingVideoQuartile(percent: Int, watchedSeconds: Long) {
        val video = _uiState.value.marketingVideo ?: return
        trackMarketingVideo(
            "mobile_video_marketing_$percent",
            video,
            mapOf("percentual" to percent.toString(), "segundos" to watchedSeconds.toString())
        )
    }

    fun onMarketingVideoEnded(watchedSeconds: Long) {
        val video = _uiState.value.marketingVideo ?: return
        _uiState.update { it.copy(marketingVideoFinished = true) }
        trackMarketingVideo(
            "mobile_video_marketing_100",
            video,
            mapOf("percentual" to "100", "segundos" to watchedSeconds.toString()),
            flushNow = true
        )
    }

    fun onMarketingVideoError() {
        val video = _uiState.value.marketingVideo
        _uiState.update { it.copy(marketingVideo = null, marketingVideoFinished = false) }
        if (video != null) {
            trackMarketingVideo("mobile_video_marketing_erro", video, flushNow = true)
        }
    }

    fun openReadyFromMarketingVideo(watchedSeconds: Long) {
        val video = _uiState.value.marketingVideo
        if (video != null) {
            trackMarketingVideo(
                "mobile_video_marketing_ver_arte",
                video,
                mapOf("segundos" to watchedSeconds.toString()),
                flushNow = true
            )
        }
        showMyPlannings()
    }

    fun onMarketingVideoAbandoned(watchedSeconds: Long) {
        val video = _uiState.value.marketingVideo ?: return
        trackMarketingVideo(
            "mobile_video_marketing_abandonou",
            video,
            mapOf("segundos" to watchedSeconds.toString())
        )
    }

    fun goToConfirmation() {
        _uiState.update { state ->
            when {
                state.photos.isEmpty() -> state.copy(
                    uploadError = "Adicione pelo menos 1 foto para continuar.",
                    successMessage = null
                )
                else -> state.copy(
                    step = MonthlyPlanningStep.Confirmation,
                    uploadError = null,
                    successMessage = null
                )
            }
        }
    }

    fun confirmPlanning() {
        confirmPlanningInternal()
    }

    private fun confirmPlanningInternal(reservationOverride: Int? = null) {
        val current = _uiState.value
        if (current.photos.isEmpty()) {
            _uiState.update {
                it.copy(
                    uploadError = "Adicione pelo menos 1 foto para continuar.",
                    successMessage = null
                )
            }
            return
        }

        val requestedReservedArts = reservationOverride?.coerceAtLeast(0) ?: current.reservedArts
        if (requestedReservedArts <= 0) {
            viewModelScope.launch {
                _uiState.update { it.copy(loading = true, uploadError = null, successMessage = null) }
                val freeArts = when (val me = repository.me()) {
                    is ApiResult.Success -> me.value.artesMensaisRestantes.coerceAtLeast(0)
                    is ApiResult.Failure -> current.currentFreeArts
                }
                if (freeArts > 0) {
                    _uiState.update { state ->
                        state.copy(
                            loading = false,
                            currentFreeArts = freeArts,
                            reservedInput = reservedInputForPhotos(state.photos.size, freeArts),
                            billingRequired = false,
                            billingPix = null,
                            billingPixError = null,
                            billingPixLoading = false
                        )
                    }
                    confirmPlanningInternal()
                } else {
                    val freeArtAvailable = current.requiredStandaloneArts == 1 &&
                        when (val status = repository.freeArtStatus()) {
                            is ApiResult.Success -> status.value.active && status.value.available && !status.value.used
                            is ApiResult.Failure -> false
                        }

                    if (freeArtAvailable) {
                        _uiState.update {
                            it.copy(
                                loading = false,
                                billingRequired = false,
                                billingPix = null,
                                billingPixError = null,
                                billingPixLoading = false,
                                uploadError = null,
                                successMessage = null
                            )
                        }
                        confirmPlanningInternal(reservationOverride = 1)
                        return@launch
                    }

                    _uiState.update {
                        it.copy(
                            loading = false,
                            billingRequired = true,
                            billingPix = null,
                            billingPixError = null,
                            billingPixLoading = false,
                            uploadError = null,
                            successMessage = null
                        )
                    }
                }
            }
            return
        }

        val uiProfile = current.companyProfile
        val nomeEmpresa = uiProfile.nomeEmpresa.trim()
        val ramo = uiProfile.ramo.trim()

        if (nomeEmpresa.isBlank() || ramo.isBlank()) {
            _uiState.update {
                it.copy(
                    companyProfile = uiProfile,
                    uploadError = "Preencha Nome da empresa e Ramo da empresa antes de enviar.",
                    successMessage = null
                )
            }
            return
        }

        saveCompanyProfile(uiProfile)

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    step = MonthlyPlanningStep.Processing,
                    companyProfile = uiProfile,
                    loading = true,
                    uploadError = null,
                    successMessage = null,
                    marketingVideo = null,
                    marketingVideoFinished = false
                )
            }

            val request = MonthlyPlanningRequest(
                quantidadeReservada = requestedReservedArts,
                nomeEmpresa = nomeEmpresa,
                ramo = ramo,
                caracteristicasEmpresa = uiProfile.caracteristicasEmpresa,
                informacoesEmpresa = uiProfile.informacoesEmpresa.trim(),
                logo = uiProfile.logoFile,
                fotos = current.photos.map { it.toRequestInput() }
            )

            when (val result = repository.solicitarPlanejamentoMensal(request)) {
                is ApiResult.Success -> handlePlanningCreated(result.value)
                is ApiResult.Failure -> _uiState.update {
                    val billingRequired = result.isBillingRequired()
                    it.copy(
                        step = MonthlyPlanningStep.Confirmation,
                        loading = false,
                        billingRequired = billingRequired,
                        billingPix = if (billingRequired) null else it.billingPix,
                        billingPixError = null,
                        billingPixLoading = false,
                        uploadError = if (billingRequired) null else result.message,
                        successMessage = null
                    )
                }
            }
        }
    }

    fun dismissBillingRequired() {
        _uiState.update {
            it.copy(
                billingRequired = false,
                billingPixLoading = false,
                billingPixError = null,
                uploadError = null,
                successMessage = null
            )
        }
    }

    fun generateStandaloneArtPix() {
        val quantity = _uiState.value.requiredStandaloneArts
        if (_uiState.value.billingPixLoading) return
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    billingPixLoading = true,
                    billingPixError = null,
                    billingPix = null,
                    uploadError = null,
                    successMessage = null
                )
            }
            when (val result = repository.criarArteAvulsaPix(quantity)) {
                is ApiResult.Success -> _uiState.update {
                    it.copy(
                        billingPixLoading = false,
                        billingPix = result.value,
                        billingPixError = null
                    )
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(
                        billingPixLoading = false,
                        billingPixError = result.message.ifBlank { "Não foi possível gerar o PIX agora." }
                    )
                }
            }
        }
    }

    fun showMyPlannings() {
        _uiState.update { it.copy(step = MonthlyPlanningStep.MyPlannings, uploadError = null) }
        loadAccountAndPlannings()
    }

    fun backToUpload() {
        _uiState.update {
            it.copy(
                step = MonthlyPlanningStep.Upload,
                uploadError = null,
                successMessage = null,
                marketingVideo = null,
                marketingVideoFinished = false
            )
        }
    }

    fun addPhotos(files: List<UploadFile>) {
        if (files.isEmpty()) return
        _uiState.update { state ->
            val photos = state.photos + files.map { file -> MonthlyPlanningPhotoDraft(file = file) }
            state.copy(
                photos = photos,
                reservedInput = reservedInputForPhotos(photos.size, state.currentFreeArts),
                uploadError = null,
                successMessage = null
            )
        }
    }

    fun removePhoto(index: Int) {
        _uiState.update { state ->
            val photos = state.photos.filterIndexed { itemIndex, _ -> itemIndex != index }
            state.copy(
                photos = photos,
                reservedInput = reservedInputForPhotos(photos.size, state.currentFreeArts),
                uploadError = null,
                successMessage = null
            )
        }
    }

    fun selectPhotoObjective(index: Int, objectiveId: String, objective: String) {
        updatePhoto(index) {
            it.copy(
                objetivo = objective,
                objetivoId = objectiveId
            )
        }
    }

    fun updatePhotoManualObjective(index: Int, value: String) {
        updatePhoto(index) {
            it.copy(
                objetivo = value,
                objetivoId = ""
            )
        }
    }

    fun updatePhotoText(index: Int, value: String) {
        updatePhoto(index) {
            it.copy(escritaImagem = value.take(PHOTO_TEXT_MAX_LENGTH))
        }
    }

    fun increasePhotoEditLevel(index: Int) {
        updatePhoto(index) {
            it.copy(nivelEdicao = (it.nivelEdicao + 1).coerceAtMost(MAX_PHOTO_EDIT_LEVEL))
        }
    }

    fun decreasePhotoEditLevel(index: Int) {
        updatePhoto(index) {
            it.copy(nivelEdicao = (it.nivelEdicao - 1).coerceAtLeast(MIN_PHOTO_EDIT_LEVEL))
        }
    }

    fun togglePhotoEditLevelInfo(index: Int) {
        updatePhoto(index) {
            it.copy(showNivelInfo = !it.showNivelInfo)
        }
    }

    fun updateCompanyName(value: String) = updateCompanyProfile {
        it.copy(nomeEmpresa = value)
    }

    fun updateCompanyRamo(value: String) = updateCompanyProfile {
        it.copy(
            ramo = value,
            ramoSelecionadoCatalogo = false,
            caracteristicasEmpresa = emptyList()
        )
    }

    fun selectCompanyRamo(value: String) = updateCompanyProfile {
        it.copy(
            ramo = value,
            ramoSelecionadoCatalogo = true,
            ramoDigitacaoLivre = false,
            caracteristicasEmpresa = emptyList()
        )
    }

    fun continueCompanyRamoTyping() = updateCompanyProfile {
        it.copy(
            ramoSelecionadoCatalogo = false,
            ramoDigitacaoLivre = true
        )
    }

    fun updateCompanyWhatsapp(value: String) = updateCompanyProfile {
        it.copy(whatsapp = value)
    }

    fun updateCompanyInstagram(value: String) = updateCompanyProfile {
        it.copy(instagram = value)
    }

    fun toggleCompanyCharacteristic(label: String) = updateCompanyProfile {
        val selected = it.caracteristicasEmpresa
        it.copy(
            caracteristicasEmpresa = if (selected.contains(label)) {
                selected.filterNot { item -> item == label }
            } else {
                selected + label
            }
        )
    }

    fun toggleCompanyOtherInfo() = updateCompanyProfile {
        it.copy(showOtherInfo = !it.showOtherInfo)
    }

    fun updateCompanyImportantInfo(value: String) = updateCompanyProfile {
        it.copy(informacoesEmpresa = value)
    }

    fun updateCompanyLogo(uri: String, file: UploadFile?) = updateCompanyProfile {
        it.copy(
            logoUri = uri,
            logoFile = file
        )
    }

    fun updateCompanyLogoUri(value: String) = updateCompanyProfile {
        it.copy(
            logoUri = value,
            logoFile = null
        )
    }

    fun removeCompanyLogo() = updateCompanyProfile {
        it.copy(
            logoUri = "",
            logoFile = null
        )
    }

    fun setUploadError(message: String) {
        _uiState.update { it.copy(uploadError = message, successMessage = null) }
    }

    private fun updatePhoto(
        index: Int,
        transform: (MonthlyPlanningPhotoDraft) -> MonthlyPlanningPhotoDraft
    ) {
        _uiState.update { state ->
            if (index !in state.photos.indices) return@update state
            state.copy(
                photos = state.photos.mapIndexed { itemIndex, item ->
                    if (itemIndex == index) transform(item) else item
                },
                uploadError = null,
                successMessage = null
            )
        }
    }

    private fun updateCompanyProfile(transform: (MonthlyPlanningCompanyProfile) -> MonthlyPlanningCompanyProfile) {
        _uiState.update {
            it.copy(
                companyProfile = transform(it.companyProfile),
                uploadError = null,
                successMessage = null
            )
        }
    }

    private fun saveCompanyProfile(profile: MonthlyPlanningCompanyProfile) {
        val current = companyProfileStore.getProfile()
        companyProfileStore.saveProfile(
            current.copy(
                nomeEmpresa = profile.nomeEmpresa.trim(),
                ramo = profile.ramo.trim(),
                whatsapp = profile.whatsapp.trim(),
                instagram = profile.instagram.trim(),
                logoUri = profile.logoUri.trim()
            )
        )
    }

    private suspend fun handlePlanningCreated(response: MonthlyPlanningRequestResponse) {
        val created = response.toUiSummary()
        val marketingVideo = if (response.shouldShowFirstFreeArtVideo()) {
            loadFirstFreeArtMarketingVideo()
        } else {
            null
        }
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
                step = MonthlyPlanningStep.Processing,
                loading = false,
                cycleArts = cycleArts,
                currentFreeArts = freeArts,
                reservedInput = "",
                photos = emptyList(),
                planning = merged.firstOrNull { item -> item.id == created.id } ?: created,
                plannings = merged,
                uploadError = null,
                successMessage = null,
                billingRequired = false,
                billingPixLoading = false,
                billingPix = null,
                billingPixError = null,
                marketingVideo = marketingVideo,
                marketingVideoFinished = false
            )
        }
    }

    private suspend fun loadFirstFreeArtMarketingVideo(): MarketingVideo? {
        return when (val result = repository.marketingVideo(MARKETING_CONTEXT_FIRST_FREE_ART)) {
            is ApiResult.Success -> result.value.takeIf { it.active && it.urlVideo.isNotBlank() }
            is ApiResult.Failure -> null
        }
    }

    private fun MonthlyPlanningRequestResponse.shouldShowFirstFreeArtVideo(): Boolean {
        return arteGratis ||
            cobrancaOrigem.equals("arte_gratis", ignoreCase = true) ||
            tipoCompra.equals("arte_gratis", ignoreCase = true)
    }

    private fun trackMarketingVideo(
        eventName: String,
        video: MarketingVideo,
        extraPayload: Map<String, String> = emptyMap(),
        flushNow: Boolean = false
    ) {
        MobileAnalytics.track(
            eventName,
            tela = "planejamento_mensal",
            produto = "primeira_arte_gratis",
            payload = mapOf(
                "video_id" to video.id,
                "versao" to video.version,
                "contexto" to video.context.ifBlank { MARKETING_CONTEXT_FIRST_FREE_ART }
            ) + extraPayload,
            flushNow = flushNow
        )
    }
}

private fun ApiResult.Failure.isBillingRequired(): Boolean {
    val normalizedMessage = message
        .lowercase()
        .replace('ã', 'a')
        .replace('á', 'a')
        .replace('à', 'a')
        .replace('â', 'a')
    return code == "billing_required" ||
        statusCode == 402 ||
        normalizedMessage.contains("saldo suficiente")
}

private fun String.clampReservedInput(max: Int): String {
    val value = toIntOrNull() ?: return this
    return value.coerceAtMost(max.coerceAtLeast(0)).takeIf { it > 0 }?.toString().orEmpty()
}

private fun reservedInputForPhotos(photoCount: Int, currentFreeArts: Int): String {
    if (photoCount <= 0) return ""
    val max = currentFreeArts.takeIf { it > 0 } ?: photoCount
    return photoCount.coerceAtMost(max).toString()
}

private fun MonthlyPlanningPhotoDraft.toRequestInput(): MonthlyPlanningPhotoInput {
    val orientacao = buildList {
        if (objetivo.isNotBlank()) add("Objetivo da foto: ${objetivo.trim()}")
        if (escritaImagem.isNotBlank()) add("Escrita que deve aparecer na imagem: ${escritaImagem.trim()}")
        add("Nivel de edicao: $nivelEdicao")
    }.joinToString("\n")

    return MonthlyPlanningPhotoInput(
        file = file,
        orientacao = orientacao
    )
}

private fun CompanyProfile.toUiCompanyProfile(): MonthlyPlanningCompanyProfile {
    return MonthlyPlanningCompanyProfile(
        nomeEmpresa = nomeEmpresa.trim(),
        ramo = ramo.trim(),
        ramoSelecionadoCatalogo = ramo.isNotBlank(),
        ramoDigitacaoLivre = false,
        whatsapp = whatsapp.trim(),
        instagram = instagram.trim(),
        logoUri = logoUri.trim()
    )
}

private fun MonthlyPlanningSummaryDto.toUiSummary(): MonthlyPlanningSummary {
    return MonthlyPlanningSummary(
        id = id,
        title = title.ifBlank { "Planejamento Mensal" },
        createdAt = createdAt,
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
        createdAt = createdAt,
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
        itemId = itemId,
        planningId = planningId,
        planejamentoItemId = planejamentoItemId,
        date = date,
        time = time,
        dateLabel = formatPlanningDateLabel(date, time),
        theme = theme,
        objective = objective,
        status = statusLabel.ifBlank { status },
        caption = caption,
        pedidoId = pedidoId,
        imageReady = imageReady,
        imageText = imageText,
        thumbnailUrl = thumbnailUrl
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
