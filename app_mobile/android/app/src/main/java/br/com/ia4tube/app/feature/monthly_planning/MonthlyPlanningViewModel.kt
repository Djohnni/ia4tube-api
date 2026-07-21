package br.com.ia4tube.app.feature.monthly_planning

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.core.analytics.MobileAnalytics
import br.com.ia4tube.app.core.company.CompanyProfile
import br.com.ia4tube.app.core.company.CompanyProfileStore
import br.com.ia4tube.app.core.monthly_planning.MonthlyPlanningCalendarCacheStore
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.BillingPixResult
import br.com.ia4tube.app.data.models.DownloadedImage
import br.com.ia4tube.app.data.models.MarketingVideo
import br.com.ia4tube.app.data.models.MonthlyPlanningDetailDto
import br.com.ia4tube.app.data.models.MonthlyPlanningDiscoveredProduct
import br.com.ia4tube.app.data.models.MonthlyPlanningPhotoInput
import br.com.ia4tube.app.data.models.MonthlyPlanningPostDto
import br.com.ia4tube.app.data.models.MonthlyPlanningRequest
import br.com.ia4tube.app.data.models.MonthlyPlanningRequestResponse
import br.com.ia4tube.app.data.models.MonthlyPlanningRescheduleRequest
import br.com.ia4tube.app.data.models.MonthlyPlanningSummaryDto
import br.com.ia4tube.app.data.models.UploadFile
import br.com.ia4tube.app.data.repository.AuthRepository
import java.io.ByteArrayOutputStream
import java.text.Normalizer
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val DEFAULT_CYCLE_ARTS = 0
const val PHOTO_TEXT_MAX_LENGTH = 200
const val PHOTO_PRICE_MAX_LENGTH = 40
const val IDENTIFIED_PRODUCT_MAX_LENGTH = 120
const val MONTHLY_PLANNING_REFERENCE_MANUAL = "foto_manual"
const val MONTHLY_PLANNING_REFERENCE_DISCOVERED = "produto_descoberto"
const val DEFAULT_MONTHLY_PLANNING_PHOTO_EDIT_LEVEL = 2
private const val MIN_PHOTO_EDIT_LEVEL = 1
private const val MAX_PHOTO_EDIT_LEVEL = 3
const val MONTHLY_PLANNING_INITIAL_VISIBLE_PHOTOS = 4
const val MONTHLY_PLANNING_MAX_ARTS_PER_REQUEST = 20
const val MONTHLY_PLANNING_EMPTY_REQUEST_MESSAGE = "Preencha um objetivo, uma escrita ou adicione uma imagem para criar sua arte."
const val PRODUCT_DISCOVERY_EMPTY_MESSAGE =
    "Não encontramos produtos claramente identificáveis nesta foto. Tente fotografar mais perto."
const val PRODUCT_DISCOVERY_OFFLINE_MESSAGE =
    "Você está sem conexão. Conecte-se e tente novamente."
const val PRODUCT_DISCOVERY_SESSION_EXPIRED_MESSAGE =
    "Sua sessão expirou. Entre novamente para continuar."
const val PRODUCT_DISCOVERY_INVALID_PHOTO_MESSAGE =
    "Não foi possível usar esta foto. Tente outra imagem."
const val PRODUCT_DISCOVERY_TIMEOUT_MESSAGE =
    "A análise demorou mais que o esperado. Tente novamente em instantes."
const val PRODUCT_DISCOVERY_INTERNAL_ERROR_MESSAGE =
    "Não foi possível analisar a foto agora. Tente novamente em instantes."
const val PRODUCT_DISCOVERY_RATE_LIMIT_MESSAGE =
    "Você fez muitas análises em pouco tempo. Aguarde alguns minutos."
private const val MARKETING_CONTEXT_FIRST_FREE_ART = "primeira_arte_gratis"
private const val PLANNING_PROCESSING_POLL_INTERVAL_MS = 5_000L
const val MOCK_PLANNING_ID = "planejamento-junho-2026"

enum class MonthlyPlanningStep {
    Upload,
    Confirmation,
    Processing,
    MyPlannings
}

enum class MonthlyPlanningDiscoveryStage(
    val progress: Float,
    val message: String
) {
    Sending(0.10f, "Enviando sua foto…"),
    Analyzing(0.30f, "Analisando os produtos…"),
    Identifying(0.60f, "Identificando preços e informações…"),
    Preparing(0.85f, "Preparando os produtos no Planejador…"),
    Complete(1.00f, "Preparando os produtos no Planejador…")
}

data class MonthlyPlanningUiState(
    val step: MonthlyPlanningStep = MonthlyPlanningStep.Upload,
    val loading: Boolean = false,
    val cycleArts: Int = DEFAULT_CYCLE_ARTS,
    val currentFreeArts: Int = 0,
    val reservedInput: String = "",
    val photos: List<MonthlyPlanningPhotoDraft> = createInitialMonthlyPlanningPhotoDrafts(),
    val discoveryLoading: Boolean = false,
    val discoveryStage: MonthlyPlanningDiscoveryStage? = null,
    val discoveryProgress: Float = 0f,
    val discoveryAttempt: Long = 0L,
    val ramoContextoDescoberta: String? = null,
    val technicalPlanningLimit: Int = MONTHLY_PLANNING_MAX_ARTS_PER_REQUEST,
    val companyProfile: MonthlyPlanningCompanyProfile = MonthlyPlanningCompanyProfile(),
    val uploadError: String? = null,
    val successMessage: String? = null,
    val planning: MonthlyPlanningSummary = MonthlyPlanningMockData.summary,
    val plannings: List<MonthlyPlanningSummary> = emptyList(),
    val detailPlanning: MonthlyPlanningSummary? = null,
    val calendarLoading: Boolean = false,
    val calendarError: String? = null,
    val calendarSuccessMessage: String? = null,
    val reschedulingCalendarItemKeys: Set<String> = emptySet(),
    val sharingCalendarItemKeys: Set<String> = emptySet(),
    val calendarSharePayload: MonthlyPlanningCalendarSharePayload? = null,
    val generalCalendarPosts: List<MonthlyPlanningCalendarListItem> = emptyList(),
    val billingRequired: Boolean = false,
    val billingPixLoading: Boolean = false,
    val billingPix: BillingPixResult? = null,
    val billingPixError: String? = null,
    val marketingVideo: MarketingVideo? = null,
    val marketingVideoFinished: Boolean = false
) {
    val activePhotos: List<MonthlyPlanningPhotoDraft>
        get() = photos.activeMonthlyPlanningPhotos()

    val activePhotoCount: Int
        get() = activePhotos.size

    val countedPhotoSlots: Int
        get() = photos.monthlyPlanningCountedSlots()

    val canAddMorePhotos: Boolean
        get() = countedPhotoSlots < MONTHLY_PLANNING_MAX_ARTS_PER_REQUEST

    val requestMaxArts: Int
        get() = if (photos.any { it.produtoIdentificado.isNotBlank() }) {
            technicalPlanningLimit.coerceAtLeast(MONTHLY_PLANNING_MAX_ARTS_PER_REQUEST)
        } else {
            MONTHLY_PLANNING_MAX_ARTS_PER_REQUEST
        }

    val reservedArts: Int
        get() = reservedInput.toIntOrNull()?.coerceIn(0, currentFreeArts) ?: 0

    val freeArts: Int
        get() = (currentFreeArts - reservedArts).coerceAtLeast(0)

    val requiredStandaloneArts: Int
        get() = activePhotoCount.coerceAtLeast(1)

    val visibleGeneralCalendarPosts: List<MonthlyPlanningCalendarListItem>
        get() = generalCalendarPosts
}

internal fun MonthlyPlanningUiState.tryStartProductDiscovery(): MonthlyPlanningUiState? {
    if (discoveryLoading) return null
    return copy(
        discoveryLoading = true,
        discoveryStage = MonthlyPlanningDiscoveryStage.Sending,
        discoveryProgress = MonthlyPlanningDiscoveryStage.Sending.progress,
        discoveryAttempt = discoveryAttempt + 1,
        uploadError = null,
        successMessage = null
    )
}

internal fun MonthlyPlanningUiState.advanceProductDiscovery(
    stage: MonthlyPlanningDiscoveryStage
): MonthlyPlanningUiState {
    if (!discoveryLoading || stage.progress < discoveryProgress) return this
    return copy(
        discoveryStage = stage,
        discoveryProgress = maxOf(discoveryProgress, stage.progress)
    )
}

@Suppress("UNUSED_PARAMETER")
internal fun productDiscoveryFriendlyErrorMessage(
    technicalMessage: String?,
    statusCode: Int? = null,
    code: String = "",
    localImageFailure: Boolean = false
): String {
    val normalizedCode = code.trim().lowercase(Locale.ROOT)
    return when {
        localImageFailure -> PRODUCT_DISCOVERY_INVALID_PHOTO_MESSAGE
        statusCode == 401 || normalizedCode == "session_expired" -> {
            PRODUCT_DISCOVERY_SESSION_EXPIRED_MESSAGE
        }
        statusCode == 400 || statusCode == 413 || statusCode == 415 ||
            normalizedCode == "product_discovery_image_required" ||
            normalizedCode == "product_discovery_empty_image" ||
            normalizedCode == "product_discovery_image_too_large" ||
            normalizedCode == "product_discovery_invalid_image" -> {
            PRODUCT_DISCOVERY_INVALID_PHOTO_MESSAGE
        }
        statusCode == 429 || normalizedCode == "product_discovery_in_progress" -> {
            PRODUCT_DISCOVERY_RATE_LIMIT_MESSAGE
        }
        statusCode == 502 || statusCode == 503 || statusCode == 504 ||
            normalizedCode == "network_timeout" ||
            normalizedCode == "product_discovery_timeout" ||
            normalizedCode == "product_discovery_ai_error" ||
            normalizedCode == "product_discovery_not_configured" ||
            normalizedCode == "product_discovery_unavailable" ||
            normalizedCode == "product_discovery_invalid_response" -> {
            PRODUCT_DISCOVERY_TIMEOUT_MESSAGE
        }
        normalizedCode == "network_unavailable" -> PRODUCT_DISCOVERY_OFFLINE_MESSAGE
        else -> PRODUCT_DISCOVERY_INTERNAL_ERROR_MESSAGE
    }
}

internal fun MonthlyPlanningUiState.finishProductDiscoveryWithError(
    technicalMessage: String? = null,
    statusCode: Int? = null,
    code: String = "",
    localImageFailure: Boolean = false
): MonthlyPlanningUiState {
    return copy(
        discoveryLoading = false,
        discoveryStage = null,
        discoveryProgress = 0f,
        uploadError = productDiscoveryFriendlyErrorMessage(
            technicalMessage = technicalMessage,
            statusCode = statusCode,
            code = code,
            localImageFailure = localImageFailure
        ),
        successMessage = null
    )
}

data class MonthlyPlanningCalendarSharePayload(
    val pedidoId: String,
    val image: DownloadedImage,
    val description: String
)

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
    val id: String,
    val number: Int,
    val file: UploadFile? = null,
    val objetivo: String = "",
    val objetivoId: String = "",
    val escritaImagem: String = "",
    val preco: String = "",
    val produtoIdentificado: String = "",
    val tipoReferencia: String = MONTHLY_PLANNING_REFERENCE_MANUAL,
    val nivelEdicao: Int = DEFAULT_MONTHLY_PLANNING_PHOTO_EDIT_LEVEL,
    val withoutPhotoSelected: Boolean = false,
    val expanded: Boolean = false,
    val fixedSlot: Boolean = false,
    val showNivelInfo: Boolean = false
) {
    val hasMeaningfulContent: Boolean
        get() = file != null || objetivo.isNotBlank() || escritaImagem.isNotBlank() || produtoIdentificado.isNotBlank()

    val hasUserData: Boolean
        get() = hasMeaningfulContent || preco.isNotBlank() || withoutPhotoSelected

    val isActive: Boolean
        get() = hasMeaningfulContent
}

internal data class MonthlyPlanningDiscoveryAppendResult(
    val photos: List<MonthlyPlanningPhotoDraft>,
    val added: Int,
    val limitReached: Boolean
)

private val GENERIC_DISCOVERY_BUSINESS_CONTEXTS = setOf(
    "loja",
    "comercio",
    "empresa",
    "produtos",
    "servicos",
    "outros",
    "diversos",
    "nao informado"
)

internal fun normalizeDiscoveryBusinessContext(value: String): String {
    return Normalizer.normalize(value.trim(), Normalizer.Form.NFD)
        .replace("[\\u0300-\\u036f]".toRegex(), "")
        .lowercase(Locale.ROOT)
        .replace("[^a-z0-9]+".toRegex(), " ")
        .trim()
        .replace("\\s+".toRegex(), " ")
}

internal fun isUsableDiscoveryBusinessContext(value: String): Boolean {
    val normalized = normalizeDiscoveryBusinessContext(value)
    return normalized.isNotBlank() && normalized !in GENERIC_DISCOVERY_BUSINESS_CONTEXTS
}

internal fun MonthlyPlanningUiState.withPreparedDiscoveryBusinessContext(): MonthlyPlanningUiState {
    if (ramoContextoDescoberta != null) return this
    val currentBusiness = companyProfile.ramo.trim()
    return if (isUsableDiscoveryBusinessContext(currentBusiness)) {
        copy(ramoContextoDescoberta = currentBusiness)
    } else {
        this
    }
}

internal fun MonthlyPlanningUiState.withDiscoveryBusinessContext(value: String): MonthlyPlanningUiState {
    return copy(ramoContextoDescoberta = value.trim())
}

fun createInitialMonthlyPlanningPhotoDrafts(): List<MonthlyPlanningPhotoDraft> {
    return (1..MONTHLY_PLANNING_INITIAL_VISIBLE_PHOTOS).map { number ->
        MonthlyPlanningPhotoDraft(
            id = fixedMonthlyPlanningPhotoId(number),
            number = number,
            expanded = number == 1,
            fixedSlot = true
        )
    }
}

fun List<MonthlyPlanningPhotoDraft>.activeMonthlyPlanningPhotos(): List<MonthlyPlanningPhotoDraft> {
    return filter { it.isActive }
}

fun List<MonthlyPlanningPhotoDraft>.monthlyPlanningCountedSlots(): Int {
    return count { it.isActive || !it.fixedSlot }
}

private fun fixedMonthlyPlanningPhotoId(number: Int): String = "fixed-photo-$number"

private fun newMonthlyPlanningPhotoId(number: Int): String = "extra-photo-$number-${System.nanoTime()}"

private fun List<MonthlyPlanningPhotoDraft>.normalizeMonthlyPlanningPhotoNumbers(): List<MonthlyPlanningPhotoDraft> {
    return mapIndexed { index, photo -> photo.copy(number = index + 1) }
}

private fun MonthlyPlanningPhotoDraft.clearedMonthlyPlanningPhotoSlot(): MonthlyPlanningPhotoDraft {
    return copy(
        file = null,
        objetivo = "",
        objetivoId = "",
        escritaImagem = "",
        preco = "",
        produtoIdentificado = "",
        nivelEdicao = DEFAULT_MONTHLY_PLANNING_PHOTO_EDIT_LEVEL,
        withoutPhotoSelected = false,
        expanded = false,
        showNivelInfo = false
    )
}

internal fun MonthlyPlanningPhotoDraft.toggleWithoutPhotoChoice(): MonthlyPlanningPhotoDraft {
    if (file != null) return this
    return copy(withoutPhotoSelected = !withoutPhotoSelected)
}

internal fun MonthlyPlanningPhotoDraft.withPhotoFile(file: UploadFile): MonthlyPlanningPhotoDraft {
    return copy(
        file = file,
        withoutPhotoSelected = false
    )
}

internal fun MonthlyPlanningPhotoDraft.withRemovedPhotoFile(): MonthlyPlanningPhotoDraft {
    return copy(
        file = null,
        withoutPhotoSelected = true
    )
}

internal fun MonthlyPlanningPhotoDraft.withIdentifiedProductName(value: String): MonthlyPlanningPhotoDraft {
    val limited = value.take(IDENTIFIED_PRODUCT_MAX_LENGTH)
    return if (limited.isBlank()) this else copy(produtoIdentificado = limited)
}

internal fun appendDiscoveredProductsToPlanning(
    currentPhotos: List<MonthlyPlanningPhotoDraft>,
    products: List<MonthlyPlanningDiscoveredProduct>,
    technicalLimit: Int,
    cropFactory: (MonthlyPlanningDiscoveredProduct) -> UploadFile?
): MonthlyPlanningDiscoveryAppendResult {
    val maxItems = technicalLimit.coerceAtLeast(1)
    val photos = currentPhotos.toMutableList()
    val knownProducts = photos
        .map { normalizeDiscoveredProductKey(it.produtoIdentificado) }
        .filter { it.isNotBlank() }
        .toMutableSet()
    var activeCount = photos.count { it.isActive }
    var added = 0
    var limitReached = false

    for (product in products) {
        val name = product.name.trim()
        val key = normalizeDiscoveredProductKey(name)
        if (key.isBlank() || !knownProducts.add(key)) continue
        if (activeCount >= maxItems) {
            limitReached = true
            break
        }

        val crop = if (product.useCrop && product.crop != null) cropFactory(product) else null
        val emptyIndex = photos.indexOfFirst { !it.hasUserData }
        if (emptyIndex >= 0) {
            val current = photos[emptyIndex]
            photos[emptyIndex] = current.copy(
                file = crop,
                preco = product.price.trim().take(PHOTO_PRICE_MAX_LENGTH),
                produtoIdentificado = name,
                tipoReferencia = MONTHLY_PLANNING_REFERENCE_DISCOVERED,
                withoutPhotoSelected = false
            )
        } else {
            val nextNumber = photos.size + 1
            photos.add(
                MonthlyPlanningPhotoDraft(
                    id = newMonthlyPlanningPhotoId(nextNumber),
                    number = nextNumber,
                    file = crop,
                    preco = product.price.trim().take(PHOTO_PRICE_MAX_LENGTH),
                    produtoIdentificado = name,
                    tipoReferencia = MONTHLY_PLANNING_REFERENCE_DISCOVERED,
                    expanded = false,
                    fixedSlot = false
                )
            )
        }
        activeCount += 1
        added += 1
    }

    return MonthlyPlanningDiscoveryAppendResult(
        photos = photos.normalizeMonthlyPlanningPhotoNumbers(),
        added = added,
        limitReached = limitReached
    )
}

internal fun normalizeDiscoveredProductKey(value: String): String {
    return Normalizer.normalize(value.trim(), Normalizer.Form.NFD)
        .replace(Regex("[\\u0300-\\u036f]"), "")
        .lowercase(Locale.ROOT)
        .replace(Regex("[^a-z0-9]+"), " ")
        .trim()
        .replace(Regex("\\s+"), " ")
}

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
    val thumbnailUrl: String = "",
    val origem: String = "",
    val tipo: String = "",
    val freeArtWeekly: Boolean = false,
    val campaignId: String = "",
    val assignmentId: String = ""
)

sealed class MonthlyPlanningResultDestination {
    object Unavailable : MonthlyPlanningResultDestination()
    data class SingleOrder(val pedidoId: String) : MonthlyPlanningResultDestination()
    data class PlanningResults(val planningId: String) : MonthlyPlanningResultDestination()
}

data class MonthlyPlanningProcessingStatus(
    val title: String,
    val message: String,
    val canOpenResults: Boolean,
    val fullyReady: Boolean
)

internal val MonthlyPlanningSummary.effectiveTotalPosts: Int
    get() = posts.size.takeIf { it > 0 } ?: totalPosts

internal val MonthlyPlanningSummary.readyResultPosts: List<MonthlyPlanningPost>
    get() = posts.filter { it.imageReady && it.pedidoId.isNotBlank() }

internal fun MonthlyPlanningSummary.hasReadyResult(): Boolean {
    return readyResultPosts.isNotEmpty()
}

internal fun MonthlyPlanningSummary.isFullyReadyForViewing(): Boolean {
    val total = effectiveTotalPosts
    val postsComplete = total > 0 && readyResultPosts.size >= total
    val summaryComplete = totalPosts > 0 && readyPosts >= totalPosts
    val hasPostLevelProgress = total > 0 || totalPosts > 0
    return postsComplete || summaryComplete || (!hasPostLevelProgress && hasCompleteStatus())
}

internal fun MonthlyPlanningSummary.toProcessingStatus(): MonthlyPlanningProcessingStatus {
    val hasReadyResult = hasReadyResult()
    val fullyReady = isFullyReadyForViewing()
    return MonthlyPlanningProcessingStatus(
        title = if (hasReadyResult) {
            "Suas imagens estão prontas"
        } else {
            "Estamos criando suas imagens"
        },
        message = when {
            !hasReadyResult -> "Seu pedido foi enviado para produção."
            fullyReady -> "Seu pedido foi concluído."
            else -> "Seu pedido já possui imagens prontas para visualizar."
        },
        canOpenResults = hasReadyResult,
        fullyReady = fullyReady
    )
}

internal fun MonthlyPlanningSummary.resultDestination(): MonthlyPlanningResultDestination {
    val firstReadyOrderId = readyResultPosts.firstOrNull()?.pedidoId.orEmpty()
    if (firstReadyOrderId.isBlank()) return MonthlyPlanningResultDestination.Unavailable

    return if (effectiveTotalPosts <= 1) {
        MonthlyPlanningResultDestination.SingleOrder(firstReadyOrderId)
    } else {
        val planningId = id
        if (planningId.isBlank()) {
            MonthlyPlanningResultDestination.Unavailable
        } else {
            MonthlyPlanningResultDestination.PlanningResults(planningId)
        }
    }
}

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
    private val companyProfileStore: CompanyProfileStore,
    private val calendarCacheStore: MonthlyPlanningCalendarCacheStore
) : ViewModel() {
    private val _uiState = MutableStateFlow(MonthlyPlanningUiState())
    val uiState: StateFlow<MonthlyPlanningUiState> = _uiState.asStateFlow()
    private var planningProcessingPollingJob: Job? = null
    private var productDiscoveryJob: Job? = null
    private var productDiscoveryProgressJob: Job? = null

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
                                .ifBlank { reservedInputForPhotos(state.activePhotoCount, free) }
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
        loadGeneralCalendar(forceRefresh = false)
    }

    fun refreshGeneralCalendar() {
        loadGeneralCalendar(forceRefresh = true)
    }

    private fun loadGeneralCalendar(forceRefresh: Boolean) {
        viewModelScope.launch {
            val token = repository.getSavedToken()
            val cachedPosts = if (forceRefresh) {
                emptyList()
            } else {
                calendarCacheStore.load(token).toCalendarListItems()
            }
            val hasCachedCalendar = cachedPosts.isNotEmpty()

            _uiState.update { state ->
                state.copy(
                    calendarLoading = true,
                    calendarError = null,
                    generalCalendarPosts = if (hasCachedCalendar) cachedPosts else state.generalCalendarPosts
                )
            }

            when (val result = repository.calendarioPlanejamentoMensal()) {
                is ApiResult.Success -> {
                    calendarCacheStore.save(token, result.value)
                    val calendarPosts = result.value.toCalendarListItems()

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
                        calendarError = if (hasCachedCalendar) null else result.message,
                        generalCalendarPosts = if (hasCachedCalendar) cachedPosts else it.generalCalendarPosts
                    )
                }
            }
        }
    }

    fun removeFromGeneralCalendar(itemKey: String) {
        viewModelScope.launch {
            when (val result = repository.ocultarItemCalendarioPlanejamento(itemKey)) {
                is ApiResult.Success -> {
                    calendarCacheStore.remove(repository.getSavedToken(), itemKey)
                    _uiState.update {
                        it.copy(
                            calendarError = null,
                            generalCalendarPosts = it.generalCalendarPosts.filterNot { item -> item.key == itemKey }
                        )
                    }
                }
                is ApiResult.Failure -> _uiState.update {
                    it.copy(calendarError = result.message)
                }
            }
        }
    }

    fun rescheduleGeneralCalendarItem(item: MonthlyPlanningCalendarListItem, newDate: String) {
        var shouldStart = false
        _uiState.update { state ->
            if (state.reschedulingCalendarItemKeys.contains(item.key)) {
                state
            } else {
                shouldStart = true
                state.copy(
                    calendarError = null,
                    calendarSuccessMessage = null,
                    reschedulingCalendarItemKeys = state.reschedulingCalendarItemKeys + item.key
                )
            }
        }
        if (!shouldStart) return

        viewModelScope.launch {
            try {
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
                        calendarCacheStore.upsert(repository.getSavedToken(), item.key, result.value)
                        val updated = result.value.toUiPost().toCalendarListItem()
                        MobileAnalytics.track(
                            "mobile_alterou_data_calendario",
                            tela = "calendario_geral",
                            produto = "planejamento_mensal",
                            pedidoId = item.pedidoId,
                            payload = mapOf(
                                "data_origem" to item.date,
                                "data_destino" to updated.date,
                                "horario" to updated.time
                            ),
                            flushNow = true
                        )
                        _uiState.update { state ->
                            state.copy(
                                calendarError = null,
                                calendarSuccessMessage = "Data alterada com sucesso.",
                                reschedulingCalendarItemKeys = state.reschedulingCalendarItemKeys - item.key,
                                generalCalendarPosts = state.generalCalendarPosts
                                    .filterNot { existing ->
                                        existing.key == item.key ||
                                            (updated.key.isNotBlank() && existing.key == updated.key)
                                    }
                                    .plus(updated)
                                    .sortedWith(compareBy<MonthlyPlanningCalendarListItem> { it.sortKey }.thenBy { it.title })
                            )
                        }
                        refreshGeneralCalendar()
                    }
                    is ApiResult.Failure -> showCalendarRescheduleError(item.key)
                }
            } catch (_: Exception) {
                showCalendarRescheduleError(item.key)
            }
        }
    }

    private fun showCalendarRescheduleError(itemKey: String) {
        _uiState.update {
            it.copy(
                calendarError = "Não foi possível alterar a data. Tente novamente.",
                calendarSuccessMessage = null,
                reschedulingCalendarItemKeys = it.reschedulingCalendarItemKeys - itemKey
            )
        }
    }

    fun shareGeneralCalendarItem(item: MonthlyPlanningCalendarListItem) {
        if (!item.imageReady || item.pedidoId.isBlank()) return

        var shouldStart = false
        _uiState.update { state ->
            if (state.sharingCalendarItemKeys.contains(item.key)) {
                state
            } else {
                shouldStart = true
                state.copy(
                    calendarError = null,
                    calendarSuccessMessage = null,
                    calendarSharePayload = null,
                    sharingCalendarItemKeys = state.sharingCalendarItemKeys + item.key
                )
            }
        }
        if (!shouldStart) return

        viewModelScope.launch {
            when (val result = repository.downloadResultado(item.pedidoId)) {
                is ApiResult.Success -> _uiState.update { state ->
                    MobileAnalytics.track(
                        "mobile_compartilhou_arte",
                        tela = "calendario_geral",
                        produto = "planejamento_mensal",
                        pedidoId = item.pedidoId,
                        flushNow = true
                    )
                    state.copy(
                        calendarError = null,
                        sharingCalendarItemKeys = state.sharingCalendarItemKeys - item.key,
                        calendarSharePayload = MonthlyPlanningCalendarSharePayload(
                            pedidoId = item.pedidoId,
                            image = result.value,
                            description = item.title
                        )
                    )
                }
                is ApiResult.Failure -> _uiState.update { state ->
                    state.copy(
                        calendarError = result.message.ifBlank { "NÃ£o foi possÃ­vel compartilhar a imagem agora." },
                        sharingCalendarItemKeys = state.sharingCalendarItemKeys - item.key
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
        trackMarketingVideo("mobile_video_marketing_iniciado", video, flushNow = true)
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

    fun openReadyFromMarketingVideo(
        watchedSeconds: Long,
        onOpenOrder: (String) -> Unit,
        onOpenPlanningResults: (String) -> Unit
    ) {
        val video = _uiState.value.marketingVideo
        if (video != null) {
            trackMarketingVideo(
                "mobile_video_marketing_ver_arte",
                video,
                mapOf("segundos" to watchedSeconds.toString()),
                flushNow = true
            )
        }
        openCurrentPlanningResults(onOpenOrder, onOpenPlanningResults)
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
                state.discoveryLoading -> state.copy(
                    uploadError = "Aguarde a análise da foto terminar.",
                    successMessage = null
                )
                state.activePhotos.isEmpty() -> state.copy(
                    uploadError = MONTHLY_PLANNING_EMPTY_REQUEST_MESSAGE,
                    successMessage = null
                )
                state.activePhotoCount > state.requestMaxArts -> state.copy(
                    uploadError = "Este pedido permite no máximo ${state.requestMaxArts} artes.",
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
        val activePhotos = current.activePhotos
        if (activePhotos.isEmpty()) {
            _uiState.update {
                it.copy(
                    uploadError = MONTHLY_PLANNING_EMPTY_REQUEST_MESSAGE,
                    successMessage = null
                )
            }
            return
        }
        if (activePhotos.size > current.requestMaxArts) {
            _uiState.update {
                it.copy(
                    uploadError = "Este pedido permite no máximo ${current.requestMaxArts} artes.",
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
                            reservedInput = reservedInputForPhotos(state.activePhotoCount, freeArts),
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

                    MobileAnalytics.track(
                        "mobile_sem_saldo",
                        tela = "planejamento_mensal",
                        produto = "planejamento_mensal",
                        payload = mapOf("quantidade" to current.requiredStandaloneArts.toString()),
                        flushNow = true
                    )
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
        val whatsappContato = uiProfile.whatsapp.trim()

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
                whatsapp = whatsappContato,
                instagram = uiProfile.instagram.trim(),
                caracteristicasEmpresa = uiProfile.caracteristicasEmpresa,
                informacoesEmpresa = uiProfile.informacoesEmpresa.trim(),
                logo = uiProfile.logoFile,
                fotos = activePhotos.map { it.toRequestInput() }
            )

            when (val result = repository.solicitarPlanejamentoMensal(request)) {
                is ApiResult.Success -> handlePlanningCreated(result.value)
                is ApiResult.Failure -> _uiState.update {
                    val billingRequired = result.isBillingRequired()
                    if (billingRequired) {
                        MobileAnalytics.track(
                            "mobile_sem_saldo",
                            tela = "planejamento_mensal",
                            produto = "planejamento_mensal",
                            payload = mapOf("quantidade" to current.requiredStandaloneArts.toString()),
                            flushNow = true
                        )
                    }
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
                is ApiResult.Success -> {
                    MobileAnalytics.track(
                        "mobile_gerou_pix",
                        tela = "planejamento_mensal",
                        produto = "arte_avulsa",
                        payload = mapOf(
                            "quantidade" to quantity.toString(),
                            "valor_total" to result.value.valorPago.toString()
                        ),
                        flushNow = true
                    )
                    _uiState.update {
                        it.copy(
                            billingPixLoading = false,
                            billingPix = result.value,
                            billingPixError = null
                        )
                    }
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
        stopPlanningProcessingPolling()
        _uiState.update { it.copy(step = MonthlyPlanningStep.MyPlannings, uploadError = null) }
        loadAccountAndPlannings()
    }

    fun openCurrentPlanningResults(
        onOpenOrder: (String) -> Unit,
        onOpenPlanningResults: (String) -> Unit
    ) {
        when (val destination = _uiState.value.planning.resultDestination()) {
            is MonthlyPlanningResultDestination.SingleOrder -> {
                stopPlanningProcessingPolling()
                onOpenOrder(destination.pedidoId)
            }
            is MonthlyPlanningResultDestination.PlanningResults -> {
                stopPlanningProcessingPolling()
                onOpenPlanningResults(destination.planningId)
            }
            MonthlyPlanningResultDestination.Unavailable -> Unit
        }
    }

    fun backToUpload() {
        stopPlanningProcessingPolling()
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

    fun loadResults(planningId: String) {
        startPlanningProcessingPolling(
            planningId = planningId,
            updateCurrentPlanning = true,
            updateDetailPlanning = true,
            showInitialLoading = true
        )
    }

    fun stopResultsPolling() {
        stopPlanningProcessingPolling()
    }

    private fun startPlanningProcessingPolling(
        planningId: String,
        updateCurrentPlanning: Boolean = false,
        updateDetailPlanning: Boolean = false,
        showInitialLoading: Boolean = false
    ) {
        if (planningId.isBlank()) return
        planningProcessingPollingJob?.cancel()
        if (showInitialLoading) {
            _uiState.update { it.copy(loading = true, uploadError = null) }
        }
        planningProcessingPollingJob = viewModelScope.launch {
            while (isActive) {
                when (val result = repository.planejamentoMensalDetalhe(planningId)) {
                    is ApiResult.Success -> {
                        val detail = result.value.toUiSummary()
                        _uiState.update { state ->
                            val updatedPlannings = state.plannings.replacePlanningSummary(detail)
                            val shouldUpdateCurrent = updateCurrentPlanning ||
                                state.step == MonthlyPlanningStep.Processing ||
                                state.planning.id == planningId
                            state.copy(
                                loading = false,
                                uploadError = null,
                                planning = if (shouldUpdateCurrent) detail else state.planning,
                                detailPlanning = if (updateDetailPlanning || state.detailPlanning?.id == planningId) {
                                    detail
                                } else {
                                    state.detailPlanning
                                },
                                plannings = updatedPlannings
                            )
                        }
                        if (!detail.shouldContinueProcessingPolling()) {
                            break
                        }
                    }
                    is ApiResult.Failure -> {
                        if (showInitialLoading) {
                            _uiState.update {
                                it.copy(
                                    loading = false,
                                    uploadError = result.message
                                )
                            }
                        }
                    }
                }
                delay(PLANNING_PROCESSING_POLL_INTERVAL_MS)
            }
            planningProcessingPollingJob = null
        }
    }

    private fun stopPlanningProcessingPolling() {
        planningProcessingPollingJob?.cancel()
        planningProcessingPollingJob = null
    }

    fun addPhotos(slotId: String, files: List<UploadFile>) {
        if (files.isEmpty()) return
        _uiState.update { state ->
            val photos = state.photos.toMutableList()
            var limitReached = false

            fun canActivate(index: Int): Boolean {
                return photos.getOrNull(index)?.isActive == true ||
                    photos.monthlyPlanningCountedSlots() < MONTHLY_PLANNING_MAX_ARTS_PER_REQUEST
            }

            fun assignFile(index: Int, file: UploadFile, expanded: Boolean) {
                val current = photos.getOrNull(index) ?: return
                photos[index] = current.withPhotoFile(file).copy(
                    expanded = expanded
                )
            }

            val targetIndex = photos.indexOfFirst { it.id == slotId }.takeIf { it >= 0 } ?: 0
            if (!canActivate(targetIndex)) {
                limitReached = true
            } else {
                val firstFile = files.first()
                val targetId = photos[targetIndex].id
                for (index in photos.indices) {
                    photos[index] = photos[index].copy(expanded = photos[index].id == targetId)
                }
                assignFile(targetIndex, firstFile, expanded = true)
            }

            files.drop(1).forEach { file ->
                if (limitReached) return@forEach
                if (photos.monthlyPlanningCountedSlots() >= MONTHLY_PLANNING_MAX_ARTS_PER_REQUEST) {
                    limitReached = true
                    return@forEach
                }
                val targetNumber = photos.getOrNull(targetIndex)?.number ?: 1
                val emptyFixedIndex = photos.indexOfFirst {
                    it.fixedSlot && !it.isActive && it.file == null && it.number > targetNumber
                }.takeIf { it >= 0 } ?: photos.indexOfFirst {
                    it.fixedSlot && !it.isActive && it.file == null
                }.takeIf { it >= 0 }

                if (emptyFixedIndex != null) {
                    assignFile(emptyFixedIndex, file, expanded = false)
                } else {
                    val nextNumber = photos.size + 1
                    photos.add(
                        MonthlyPlanningPhotoDraft(
                            id = newMonthlyPlanningPhotoId(nextNumber),
                            number = nextNumber,
                            file = file,
                            expanded = false,
                            fixedSlot = false
                        )
                    )
                }
            }

            val normalized = photos.normalizeMonthlyPlanningPhotoNumbers()
            state.copy(
                photos = normalized,
                reservedInput = reservedInputForPhotos(normalized.activeMonthlyPlanningPhotos().size, state.currentFreeArts),
                uploadError = if (limitReached) {
                    "Este pedido permite no máximo $MONTHLY_PLANNING_MAX_ARTS_PER_REQUEST artes."
                } else {
                    null
                },
                successMessage = null
            )
        }
    }

    fun beginProductDiscovery(): Boolean {
        var started = false
        _uiState.update { state ->
            state.tryStartProductDiscovery()?.also { started = true } ?: state
        }
        return started
    }

    fun prepareProductDiscoveryContext(): Boolean {
        var ready = false
        _uiState.update { state ->
            state.withPreparedDiscoveryBusinessContext().also {
                ready = it.ramoContextoDescoberta != null
            }
        }
        return ready
    }

    fun setDiscoveryBusinessContext(value: String) {
        _uiState.update { state -> state.withDiscoveryBusinessContext(value) }
    }

    fun failProductDiscovery(technicalMessage: String? = null) {
        productDiscoveryProgressJob?.cancel()
        _uiState.update { state ->
            state.finishProductDiscoveryWithError(
                technicalMessage = technicalMessage,
                localImageFailure = true
            )
        }
    }

    fun discoverProducts(image: UploadFile) {
        if (productDiscoveryJob?.isActive == true) return
        if (!_uiState.value.discoveryLoading && !beginProductDiscovery()) return
        val attempt = _uiState.value.discoveryAttempt

        productDiscoveryJob = viewModelScope.launch {
            productDiscoveryProgressJob = launch {
                delay(450)
                advanceProductDiscovery(MonthlyPlanningDiscoveryStage.Analyzing)
                delay(1_000)
                advanceProductDiscovery(MonthlyPlanningDiscoveryStage.Identifying)
            }

            try {
                when (
                    val result = repository.descobrirProdutosPlanejamentoMensal(
                        image = image,
                        ramoContexto = _uiState.value.ramoContextoDescoberta
                    )
                ) {
                    is ApiResult.Success -> {
                        productDiscoveryProgressJob?.cancel()
                        advanceProductDiscovery(MonthlyPlanningDiscoveryStage.Preparing)

                        val cropsByProduct = withContext(Dispatchers.Default) {
                            createDiscoveredProductCrops(image, result.value.products)
                        }
                        var finalError: String? = null
                        var finalSuccess: String? = null
                        _uiState.update { state ->
                            if (state.discoveryAttempt != attempt) return@update state
                            val append = appendDiscoveredProductsToPlanning(
                                currentPhotos = state.photos,
                                products = result.value.products,
                                technicalLimit = result.value.technicalPlanningLimit,
                                cropFactory = { product ->
                                    cropsByProduct[normalizeDiscoveredProductKey(product.name)]
                                }
                            )
                            finalError = when {
                                result.value.products.isEmpty() -> PRODUCT_DISCOVERY_EMPTY_MESSAGE
                                append.limitReached -> "Alguns produtos não foram adicionados porque o limite técnico do Planejador foi atingido."
                                else -> null
                            }
                            finalSuccess = when {
                                result.value.products.isEmpty() -> null
                                append.added == 0 -> "Os produtos identificados já estão no Planejador."
                                append.added == 1 -> "1 produto adicionado ao Planejador."
                                else -> "${append.added} produtos adicionados ao Planejador."
                            }
                            state.copy(
                                photos = append.photos,
                                discoveryStage = MonthlyPlanningDiscoveryStage.Complete,
                                discoveryProgress = MonthlyPlanningDiscoveryStage.Complete.progress,
                                technicalPlanningLimit = result.value.technicalPlanningLimit,
                                reservedInput = reservedInputForPhotos(
                                    append.photos.activeMonthlyPlanningPhotos().size,
                                    state.currentFreeArts
                                ),
                                uploadError = null,
                                successMessage = null
                            )
                        }
                        delay(350)
                        _uiState.update { state ->
                            if (state.discoveryAttempt != attempt) return@update state
                            state.copy(
                                discoveryLoading = false,
                                discoveryStage = null,
                                discoveryProgress = 0f,
                                uploadError = finalError,
                                successMessage = finalSuccess
                            )
                        }
                    }
                    is ApiResult.Failure -> {
                        productDiscoveryProgressJob?.cancel()
                        _uiState.update { state ->
                            if (state.discoveryAttempt != attempt) state
                            else state.finishProductDiscoveryWithError(
                                technicalMessage = result.message,
                                statusCode = result.statusCode,
                                code = result.code
                            )
                        }
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _uiState.update { state ->
                    if (state.discoveryAttempt != attempt) state
                    else state.finishProductDiscoveryWithError(error.message)
                }
            } finally {
                productDiscoveryProgressJob?.cancel()
                productDiscoveryProgressJob = null
                productDiscoveryJob = null
            }
        }
    }

    private fun advanceProductDiscovery(stage: MonthlyPlanningDiscoveryStage) {
        _uiState.update { state -> state.advanceProductDiscovery(stage) }
    }

    fun addAnotherPhotoSlot() {
        _uiState.update { state ->
            if (!state.canAddMorePhotos) {
                return@update state.copy(
                    uploadError = "Este pedido permite no máximo $MONTHLY_PLANNING_MAX_ARTS_PER_REQUEST artes.",
                    successMessage = null
                )
            }
            val nextNumber = state.photos.size + 1
            val photos = state.photos
                .map { it.copy(expanded = false) } + MonthlyPlanningPhotoDraft(
                    id = newMonthlyPlanningPhotoId(nextNumber),
                    number = nextNumber,
                    expanded = true,
                    fixedSlot = false
                )
            state.copy(
                photos = photos,
                reservedInput = reservedInputForPhotos(photos.activeMonthlyPlanningPhotos().size, state.currentFreeArts),
                uploadError = null,
                successMessage = null
            )
        }
    }

    fun togglePhotoExpanded(slotId: String) {
        _uiState.update { state ->
            val selected = state.photos.firstOrNull { it.id == slotId } ?: return@update state
            val shouldExpand = !selected.expanded
            state.copy(
                photos = state.photos.map { photo ->
                    when {
                        photo.id == slotId -> photo.copy(expanded = shouldExpand)
                        shouldExpand -> photo.copy(expanded = false)
                        else -> photo
                    }
                },
                uploadError = null,
                successMessage = null
            )
        }
    }

    fun removePhotoImage(slotId: String) {
        updatePhoto(slotId) {
            it.withRemovedPhotoFile()
        }
    }

    fun toggleWithoutPhotoChoice(slotId: String) {
        updatePhoto(slotId) {
            it.toggleWithoutPhotoChoice()
        }
    }

    fun removePhotoSlot(slotId: String) {
        _uiState.update { state ->
            val photo = state.photos.firstOrNull { it.id == slotId } ?: return@update state
            if (photo.number == 1) return@update state

            val photos = if (photo.fixedSlot) {
                state.photos.map {
                    if (it.id == slotId) {
                        it.clearedMonthlyPlanningPhotoSlot()
                    } else {
                        it
                    }
                }
            } else {
                state.photos.filterNot { it.id == slotId }.normalizeMonthlyPlanningPhotoNumbers()
            }
            state.copy(
                photos = photos,
                reservedInput = reservedInputForPhotos(photos.activeMonthlyPlanningPhotos().size, state.currentFreeArts),
                uploadError = null,
                successMessage = null
            )
        }
    }

    fun selectPhotoObjective(slotId: String, objectiveId: String, objective: String) {
        updatePhoto(slotId) {
            it.copy(
                objetivo = objective,
                objetivoId = objectiveId
            )
        }
    }

    fun updatePhotoManualObjective(slotId: String, value: String) {
        updatePhoto(slotId) {
            it.copy(
                objetivo = value,
                objetivoId = ""
            )
        }
    }

    fun updatePhotoText(slotId: String, value: String) {
        updatePhoto(slotId) {
            it.copy(escritaImagem = value.take(PHOTO_TEXT_MAX_LENGTH))
        }
    }

    fun updatePhotoPrice(slotId: String, value: String) {
        updatePhoto(slotId) {
            it.copy(preco = value.take(PHOTO_PRICE_MAX_LENGTH))
        }
    }

    fun updatePhotoIdentifiedProduct(slotId: String, value: String) {
        updatePhoto(slotId) {
            it.withIdentifiedProductName(value)
        }
    }

    fun increasePhotoEditLevel(slotId: String) {
        updatePhoto(slotId) {
            it.copy(nivelEdicao = (it.nivelEdicao + 1).coerceAtMost(MAX_PHOTO_EDIT_LEVEL))
        }
    }

    fun decreasePhotoEditLevel(slotId: String) {
        updatePhoto(slotId) {
            it.copy(nivelEdicao = (it.nivelEdicao - 1).coerceAtLeast(MIN_PHOTO_EDIT_LEVEL))
        }
    }

    fun togglePhotoEditLevelInfo(slotId: String) {
        updatePhoto(slotId) {
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
        slotId: String,
        transform: (MonthlyPlanningPhotoDraft) -> MonthlyPlanningPhotoDraft
    ) {
        _uiState.update { state ->
            if (state.photos.none { it.id == slotId }) return@update state
            val photos = state.photos.map { item ->
                if (item.id == slotId) transform(item) else item
            }
            state.copy(
                photos = photos,
                reservedInput = reservedInputForPhotos(photos.activeMonthlyPlanningPhotos().size, state.currentFreeArts),
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
                whatsapp = current.whatsapp,
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
                photos = createInitialMonthlyPlanningPhotoDrafts(),
                discoveryLoading = false,
                discoveryStage = null,
                discoveryProgress = 0f,
                technicalPlanningLimit = MONTHLY_PLANNING_MAX_ARTS_PER_REQUEST,
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
        startPlanningProcessingPolling(created.id)
    }

    private suspend fun loadFirstFreeArtMarketingVideo(): MarketingVideo? {
        return when (val result = repository.marketingVideo(MARKETING_CONTEXT_FIRST_FREE_ART)) {
            is ApiResult.Success -> result.value.takeIf { it.active && it.urlVideo.isNotBlank() }
            is ApiResult.Failure -> null
        }
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

internal fun MonthlyPlanningSummary.hasCompleteStatus(): Boolean {
    val normalizedStatus = status
        .lowercase()
        .replace('í', 'i')
        .replace('ï', 'i')
        .replace('ó', 'o')
        .replace('ô', 'o')
        .replace('ú', 'u')
    return normalizedStatus.contains("pronto") ||
        normalizedStatus.contains("concluido")
}

internal fun MonthlyPlanningRequestResponse.shouldShowFirstFreeArtVideo(): Boolean {
    return arteGratis ||
        cobrancaOrigem.equals("arte_gratis", ignoreCase = true) ||
        tipoCompra.equals("arte_gratis", ignoreCase = true)
}

internal fun MonthlyPlanningSummary.isProductionComplete(): Boolean {
    return isFullyReadyForViewing()
}

internal fun MonthlyPlanningSummary.shouldContinueProcessingPolling(): Boolean {
    return !isProductionComplete()
}

private fun List<MonthlyPlanningSummary>.replacePlanningSummary(
    updated: MonthlyPlanningSummary
): List<MonthlyPlanningSummary> {
    if (updated.id.isBlank()) return this
    var found = false
    val replaced = map { current ->
        if (current.id == updated.id) {
            found = true
            updated
        } else {
            current
        }
    }
    return if (found) replaced else listOf(updated) + this
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

internal fun MonthlyPlanningPhotoDraft.toRequestInput(): MonthlyPlanningPhotoInput {
    val identifiedProduct = produtoIdentificado.trim()
    val orientacao = buildList {
        if (withoutPhotoSelected && file == null) add("Cliente escolheu criar esta arte sem foto.")
        if (identifiedProduct.isNotBlank()) add("Produto identificado: $identifiedProduct")
        if (identifiedProduct.isNotBlank() && file != null) {
            add("Use a imagem anexada como referência do produto identificado. O foco é $identifiedProduct. Ignore objetos vizinhos, fundo, prateleira, cabos e elementos que não pertençam ao produto principal.")
        }
        if (objetivo.isNotBlank()) add("Objetivo da foto: ${objetivo.trim()}")
        if (escritaImagem.isNotBlank()) add("Escrita que deve aparecer na imagem: ${escritaImagem.trim()}")
        if (preco.isNotBlank()) add("Preco informado: ${preco.trim()}")
        add("Nivel de edicao: $nivelEdicao")
    }.joinToString("\n")

    return MonthlyPlanningPhotoInput(
        slotId = id,
        order = number,
        file = file,
        objetivo = objetivo.trim(),
        objetivoId = objetivoId.trim(),
        escritaImagem = escritaImagem.trim(),
        preco = preco.trim(),
        produtoIdentificado = identifiedProduct,
        tipoReferencia = tipoReferencia.ifBlank { MONTHLY_PLANNING_REFERENCE_MANUAL },
        nivelEdicao = nivelEdicao,
        withoutPhotoSelected = withoutPhotoSelected && file == null,
        orientacao = orientacao
    )
}

internal data class ProductReferenceCropBounds(
    val left: Int,
    val top: Int,
    val width: Int,
    val height: Int
)

internal data class ProductReferenceCropDecision(
    val bounds: ProductReferenceCropBounds? = null,
    val rejectionReason: String? = null
)

internal fun calculateProductReferenceCropBounds(
    imageWidth: Int,
    imageHeight: Int,
    crop: br.com.ia4tube.app.data.models.MonthlyPlanningProductCrop
): ProductReferenceCropDecision {
    if (imageWidth <= 0 || imageHeight <= 0) {
        return ProductReferenceCropDecision(rejectionReason = "invalid_source_dimensions")
    }
    val values = listOf(crop.x, crop.y, crop.width, crop.height)
    if (values.any { !it.isFinite() } || crop.width <= 0.0 || crop.height <= 0.0) {
        return ProductReferenceCropDecision(rejectionReason = "invalid_coordinates")
    }

    val normalizedLeft = crop.x.coerceIn(0.0, 1.0)
    val normalizedTop = crop.y.coerceIn(0.0, 1.0)
    val normalizedRight = (crop.x + crop.width).coerceIn(0.0, 1.0)
    val normalizedBottom = (crop.y + crop.height).coerceIn(0.0, 1.0)
    if (normalizedRight <= normalizedLeft || normalizedBottom <= normalizedTop) {
        return ProductReferenceCropDecision(rejectionReason = "region_outside_image")
    }

    val rawLeft = (normalizedLeft * imageWidth).toInt()
    val rawTop = (normalizedTop * imageHeight).toInt()
    val rawRight = (normalizedRight * imageWidth).toInt().coerceAtMost(imageWidth)
    val rawBottom = (normalizedBottom * imageHeight).toInt().coerceAtMost(imageHeight)
    val rawWidth = rawRight - rawLeft
    val rawHeight = rawBottom - rawTop
    if (rawWidth < 32 || rawHeight < 32) {
        return ProductReferenceCropDecision(rejectionReason = "product_region_too_small")
    }

    val horizontalMargin = maxOf(
        kotlin.math.ceil(rawWidth * 0.15).toInt(),
        kotlin.math.ceil(imageWidth * 0.015).toInt()
    )
    val verticalMargin = maxOf(
        kotlin.math.ceil(rawHeight * 0.15).toInt(),
        kotlin.math.ceil(imageHeight * 0.015).toInt()
    )
    val left = (rawLeft - horizontalMargin).coerceAtLeast(0)
    val top = (rawTop - verticalMargin).coerceAtLeast(0)
    val right = (rawRight + horizontalMargin).coerceAtMost(imageWidth)
    val bottom = (rawBottom + verticalMargin).coerceAtMost(imageHeight)
    return ProductReferenceCropDecision(
        bounds = ProductReferenceCropBounds(
            left = left,
            top = top,
            width = right - left,
            height = bottom - top
        )
    )
}

private fun createDiscoveredProductCrops(
    source: UploadFile,
    products: List<MonthlyPlanningDiscoveredProduct>
): Map<String, UploadFile> {
    val sourceBitmap = BitmapFactory.decodeByteArray(source.bytes, 0, source.bytes.size) ?: return emptyMap()
    val crops = mutableMapOf<String, UploadFile>()
    try {
        products.forEach { product ->
            if (!product.useCrop) return@forEach
            val crop = product.crop ?: return@forEach
            val key = normalizeDiscoveredProductKey(product.name)
            if (key.isBlank() || crops.containsKey(key)) return@forEach
            try {
                val bounds = calculateProductReferenceCropBounds(
                    imageWidth = sourceBitmap.width,
                    imageHeight = sourceBitmap.height,
                    crop = crop
                ).bounds ?: return@forEach

                val cropped = Bitmap.createBitmap(
                    sourceBitmap,
                    bounds.left,
                    bounds.top,
                    bounds.width,
                    bounds.height
                )
                try {
                    val output = ByteArrayOutputStream()
                    if (!cropped.compress(Bitmap.CompressFormat.JPEG, 92, output)) return@forEach
                    val bytes = output.toByteArray()
                    if (bytes.isEmpty()) return@forEach
                    crops[key] = UploadFile(
                        fileName = "produto_descoberto_${System.nanoTime()}.jpg",
                        contentType = "image/jpeg",
                        bytes = bytes,
                        optimized = true,
                        originalSizeBytes = source.bytes.size,
                        originalWidth = bounds.width,
                        originalHeight = bounds.height
                    )
                } finally {
                    if (cropped !== sourceBitmap) cropped.recycle()
                }
            } catch (_: Exception) {
                Unit
            }
        }
    } finally {
        sourceBitmap.recycle()
    }
    return crops
}

private fun CompanyProfile.toUiCompanyProfile(): MonthlyPlanningCompanyProfile {
    return MonthlyPlanningCompanyProfile(
        nomeEmpresa = nomeEmpresa.trim(),
        ramo = ramo.trim(),
        ramoSelecionadoCatalogo = ramo.isNotBlank(),
        ramoDigitacaoLivre = false,
        whatsapp = "",
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

private fun List<MonthlyPlanningPostDto>.toCalendarListItems(): List<MonthlyPlanningCalendarListItem> {
    return map { it.toUiPost().toCalendarListItem() }
        .sortedWith(compareBy<MonthlyPlanningCalendarListItem> { it.sortKey }.thenBy { it.title })
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
        thumbnailUrl = thumbnailUrl,
        origem = origem,
        tipo = tipo,
        freeArtWeekly = freeArtWeekly,
        campaignId = campaignId,
        assignmentId = assignmentId
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
    private val companyProfileStore: CompanyProfileStore,
    private val calendarCacheStore: MonthlyPlanningCalendarCacheStore
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return MonthlyPlanningViewModel(repository, companyProfileStore, calendarCacheStore) as T
    }
}
