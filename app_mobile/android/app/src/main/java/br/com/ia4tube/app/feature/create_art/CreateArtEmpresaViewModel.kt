package br.com.ia4tube.app.feature.create_art

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.core.analytics.MobileAnalytics
import br.com.ia4tube.app.core.company.CompanyProfile
import br.com.ia4tube.app.core.company.CompanyProfileStore
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.CreateArtEmpresaRequest
import br.com.ia4tube.app.data.models.FootballOrderRequest
import br.com.ia4tube.app.data.models.UploadFile
import br.com.ia4tube.app.domain.usecase.CreateArtEmpresaUseCase
import br.com.ia4tube.app.R
import br.com.ia4tube.app.ui.text.UiText
import br.com.ia4tube.app.ui.text.toUiTextOrNull
import br.com.ia4tube.app.ui.text.uiText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class CreateArtEmpresaUiState(
    val nomeEmpresa: String = "",
    val ramo: String = "",
    val ramoSelecionadoCatalogo: Boolean = false,
    val ramoDigitacaoLivre: Boolean = false,
    val objetivo: String = "",
    val objetivoId: String = "",
    val estiloVisualCliente: String = "normal",
    val rodada: String = "Arte para Empresa",
    val data: String = "Arte para Empresa",
    val oferta: String = "",
    val cta: String = "",
    val whatsapp: String = "",
    val instagram: String = "",
    val observacoes: String = "",
    val historiaEmpresa: String = "",
    val fromCameraPhoto: Boolean = false,
    val fotoFrase: String = "",
    val camposDinamicos: Map<String, String> = emptyMap(),
    val logo: UploadFile? = null,
    val profileLogoUri: String = "",
    val profileLogoLoaded: Boolean = false,
    val fotos: List<UploadFile> = emptyList(),
    val referencias: List<UploadFile> = emptyList(),
    val modeloExistente: UploadFile? = null,
    val footballHomeTeam: String = "",
    val footballAwayTeam: String = "",
    val footballHomeScore: String = "",
    val footballAwayScore: String = "",
    val footballCompetition: String = "",
    val footballHeadline: String = "",
    val footballMatchDatetime: String = "",
    val footballVenue: String = "",
    val footballTitle: String = "",
    val footballPlayerName: String = "",
    val footballPlayerInfo: String = "",
    val footballMascotAnimal: String = "",
    val footballPlayersText: String = "",
    val footballTeamCrest: UploadFile? = null,
    val footballOpponentCrest: UploadFile? = null,
    val footballAuxImage: UploadFile? = null,
    val footballSponsorLogos: List<UploadFile> = emptyList(),
    val loading: Boolean = false,
    val reviewing: Boolean = false,
    val currentStep: Int = 0,
    val submitted: Boolean = false,
    val billingRequired: Boolean = false,
    val error: UiText? = null,
    val createdPedidoId: String = ""
)

class CreateArtEmpresaViewModel(
    private val createArtEmpresa: CreateArtEmpresaUseCase,
    private val companyProfileStore: CompanyProfileStore
) : ViewModel() {
    private val _uiState = MutableStateFlow(CreateArtEmpresaUiState().withCompanyProfile(companyProfileStore))
    val uiState: StateFlow<CreateArtEmpresaUiState> = _uiState.asStateFlow()

    fun updateNomeEmpresa(value: String) = _uiState.update { it.copy(nomeEmpresa = value, error = null, billingRequired = false) }
    fun updateRamo(value: String) = _uiState.update {
        MobileAnalytics.track(
            "mobile_selecionou_ramo",
            tela = "criar_arte",
            produto = "arte_empresa",
            etapa = "empresa",
            campoAtual = "ramo",
            payload = mapOf("ramo" to value)
        )
        it.copy(
            ramo = value,
            ramoSelecionadoCatalogo = false,
            ramoDigitacaoLivre = if (value.trim().length <= RAMO_SUGGESTION_MIN_CHARS) false else it.ramoDigitacaoLivre,
            objetivo = "",
            objetivoId = "",
            camposDinamicos = emptyMap(),
            error = null,
            billingRequired = false
        )
          .clearFootballFields()
    }
    fun selectRamo(value: String) = _uiState.update {
        it.copy(
            ramo = value,
            ramoSelecionadoCatalogo = true,
            ramoDigitacaoLivre = false,
            objetivo = "",
            objetivoId = "",
            camposDinamicos = emptyMap(),
            error = null,
            billingRequired = false
        ).clearFootballFields()
    }
    fun continueRamoTyping() = _uiState.update {
        it.copy(ramoDigitacaoLivre = true, ramoSelecionadoCatalogo = false, error = null, billingRequired = false)
    }
    fun updateObjetivo(value: String) = _uiState.update {
        it.copy(objetivo = value, objetivoId = "", camposDinamicos = emptyMap(), error = null, billingRequired = false)
          .clearFootballFields()
    }
    fun selectObjective(objective: CreateArtObjective) = _uiState.update {
        MobileAnalytics.track(
            "mobile_selecionou_objetivo",
            tela = "criar_arte",
            produto = "arte_empresa",
            etapa = "objetivo",
            campoAtual = "objetivo",
            payload = mapOf("objetivo_id" to objective.id, "objetivo" to objective.label)
        )
        it.copy(objetivo = objective.label, objetivoId = objective.id, camposDinamicos = emptyMap(), error = null, billingRequired = false)
            .clearFootballFields()
    }
    fun updateDynamicField(key: String, value: String) = _uiState.update { state ->
        MobileAnalytics.track(
            "mobile_preencheu_campo_dinamico",
            tela = "criar_arte",
            produto = "arte_empresa",
            etapa = "objetivo",
            campoAtual = key,
            payload = mapOf("campo" to key)
        )
        state.copy(camposDinamicos = state.camposDinamicos + (key to value), error = null, billingRequired = false)
    }
    fun updateEstiloVisual(value: String) = _uiState.update {
        MobileAnalytics.track(
            "mobile_selecionou_estilo",
            tela = "criar_arte",
            produto = "arte_empresa",
            etapa = "visual",
            payload = mapOf("estilo" to value)
        )
        it.copy(estiloVisualCliente = value, error = null, billingRequired = false)
    }
    fun updateRodada(value: String) = _uiState.update { it.copy(rodada = value, error = null, billingRequired = false) }
    fun updateData(value: String) = _uiState.update { it.copy(data = value, error = null, billingRequired = false) }
    fun updateOferta(value: String) = _uiState.update { it.copy(oferta = value, error = null, billingRequired = false) }
    fun updateCta(value: String) = _uiState.update { it.copy(cta = value, error = null, billingRequired = false) }
    fun updateWhatsapp(value: String) = _uiState.update { it.copy(whatsapp = value, error = null, billingRequired = false) }
    fun updateInstagram(value: String) = _uiState.update { it.copy(instagram = value, error = null, billingRequired = false) }
    fun updateObservacoes(value: String) = _uiState.update { it.copy(observacoes = value, error = null, billingRequired = false) }
    fun updateFotoFrase(value: String) = _uiState.update { it.copy(fotoFrase = value, error = null, billingRequired = false) }
    fun applyCameraPhoto(file: UploadFile) = _uiState.update { state ->
        val fotos = if (state.fotos.any { it.fileName == file.fileName }) state.fotos else listOf(file) + state.fotos
        state.copy(
            fromCameraPhoto = true,
            objetivo = state.objetivo.ifBlank { "Quero postar esta foto" },
            objetivoId = state.objetivoId.ifBlank { "foto_rapida" },
            fotos = fotos.take(MAX_IMAGENS_OPCIONAIS),
            logo = state.logo ?: file,
            error = null
        )
    }
    fun setLogo(value: UploadFile) = _uiState.update {
        MobileAnalytics.track(
            "mobile_selecionou_logo",
            tela = "criar_arte",
            produto = "arte_empresa",
            etapa = "visual",
            payload = mapOf("arquivo" to value.fileName, "tamanho" to value.bytes.size.toString())
        )
        it.copy(logo = value, error = null)
    }
    fun setLogoError(message: String) = _uiState.update { it.copy(error = message.toUiTextOrNull()) }
    fun markProfileLogoLoaded() = _uiState.update { it.copy(profileLogoLoaded = true) }
    fun addFotos(files: List<UploadFile>) = _uiState.update { state ->
        val remaining = MAX_IMAGENS_OPCIONAIS - state.fotos.size
        if (remaining <= 0) {
            state.copy(error = uiText(R.string.create_art_photos_limit_error, MAX_IMAGENS_OPCIONAIS))
        } else {
            MobileAnalytics.track(
                "mobile_adicionou_fotos",
                tela = "criar_arte",
                produto = "arte_empresa",
                etapa = "visual",
                payload = mapOf("quantidade" to files.take(remaining).size.toString())
            )
            state.copy(
                fotos = state.fotos + files.take(remaining),
                error = if (files.size > remaining) {
                    uiText(R.string.create_art_some_photos_ignored, MAX_IMAGENS_OPCIONAIS)
                } else {
                    null
                }
            )
        }
    }
    fun addReferencias(files: List<UploadFile>) = _uiState.update { state ->
        val remaining = MAX_IMAGENS_OPCIONAIS - state.referencias.size
        if (remaining <= 0) {
            state.copy(error = uiText(R.string.create_art_references_limit_error, MAX_IMAGENS_OPCIONAIS))
        } else {
            MobileAnalytics.track(
                "mobile_adicionou_referencias",
                tela = "criar_arte",
                produto = "arte_empresa",
                etapa = "visual",
                payload = mapOf("quantidade" to files.take(remaining).size.toString())
            )
            state.copy(
                referencias = state.referencias + files.take(remaining),
                error = if (files.size > remaining) {
                    uiText(R.string.create_art_some_references_ignored, MAX_IMAGENS_OPCIONAIS)
                } else {
                    null
                }
            )
        }
    }
    fun removeFoto(index: Int) = _uiState.update { state ->
        state.copy(fotos = state.fotos.filterIndexed { itemIndex, _ -> itemIndex != index })
    }
    fun removeReferencia(index: Int) = _uiState.update { state ->
        state.copy(referencias = state.referencias.filterIndexed { itemIndex, _ -> itemIndex != index })
    }
    fun setModeloExistente(value: UploadFile) = _uiState.update { state ->
        MobileAnalytics.track(
            "mobile_selecionou_modelo_existente",
            tela = "criar_arte",
            produto = "arte_empresa",
            etapa = "visual",
            payload = mapOf("arquivo" to value.fileName, "tamanho" to value.bytes.size.toString())
        )
        state.copy(modeloExistente = value, error = null)
    }
    fun removeModeloExistente() = _uiState.update { state ->
        state.copy(modeloExistente = null, error = null)
    }

    fun updateFootballHomeTeam(value: String) = _uiState.update { it.copy(footballHomeTeam = value, error = null) }
    fun updateFootballAwayTeam(value: String) = _uiState.update { it.copy(footballAwayTeam = value, error = null) }
    fun updateFootballHomeScore(value: String) = _uiState.update { it.copy(footballHomeScore = value, error = null) }
    fun updateFootballAwayScore(value: String) = _uiState.update { it.copy(footballAwayScore = value, error = null) }
    fun updateFootballCompetition(value: String) = _uiState.update { it.copy(footballCompetition = value, error = null) }
    fun updateFootballHeadline(value: String) = _uiState.update { it.copy(footballHeadline = value, error = null) }
    fun updateFootballMatchDatetime(value: String) = _uiState.update { it.copy(footballMatchDatetime = value, error = null) }
    fun updateFootballVenue(value: String) = _uiState.update { it.copy(footballVenue = value, error = null) }
    fun updateFootballTitle(value: String) = _uiState.update { it.copy(footballTitle = value, error = null) }
    fun updateFootballPlayerName(value: String) = _uiState.update { it.copy(footballPlayerName = value, error = null) }
    fun updateFootballPlayerInfo(value: String) = _uiState.update { it.copy(footballPlayerInfo = value, error = null) }
    fun updateFootballMascotAnimal(value: String) = _uiState.update { it.copy(footballMascotAnimal = value, error = null) }
    fun updateFootballPlayersText(value: String) = _uiState.update { it.copy(footballPlayersText = value, error = null) }
    fun setFootballTeamCrest(file: UploadFile) = _uiState.update { it.copy(footballTeamCrest = file, error = null) }
    fun setFootballOpponentCrest(file: UploadFile) = _uiState.update { it.copy(footballOpponentCrest = file, error = null) }
    fun setFootballAuxImage(file: UploadFile) = _uiState.update { it.copy(footballAuxImage = file, error = null) }
    fun setFootballUploadError(message: String) = _uiState.update { it.copy(error = message.toUiTextOrNull()) }
    fun addFootballSponsorLogos(files: List<UploadFile>) = _uiState.update { state ->
        state.copy(footballSponsorLogos = state.footballSponsorLogos + files, error = null)
    }
    fun removeFootballSponsorLogo(index: Int) = _uiState.update { state ->
        state.copy(footballSponsorLogos = state.footballSponsorLogos.filterIndexed { itemIndex, _ -> itemIndex != index })
    }

    fun nextStep() {
        val state = _uiState.value
        val validationError = validateStep(state)
        if (validationError != null) {
            _uiState.update { it.copy(submitted = true, error = validationError) }
            return
        }
        if (state.currentStep == 0) {
            saveCompanyProfileFromEmpresaStep(state)
        }
        _uiState.update {
            val next = it.currentStep + 1
            it.copy(
                currentStep = next.coerceAtMost(2),
                submitted = false,
                error = null
            )
        }
        val nextStep = _uiState.value.currentStep
        MobileAnalytics.track(
            eventName = if (nextStep == 1) "mobile_etapa_objetivo" else "mobile_etapa_visual",
            tela = "criar_arte",
            produto = "arte_empresa",
            etapa = if (nextStep == 1) "objetivo" else "visual"
        )
    }

    fun previousStep() {
        _uiState.update {
            it.copy(
                currentStep = (it.currentStep - 1).coerceAtLeast(0),
                submitted = false,
                error = null
            )
        }
    }

    fun review() {
        val state = _uiState.value
        MobileAnalytics.track("mobile_etapa_revisao", tela = "criar_arte", produto = "arte_empresa", etapa = "revisao")
        val footballProductKey = footballProductKey(state)

        val validationError = validate(state)
        if (validationError != null) {
            _uiState.update { it.copy(submitted = true, error = validationError) }
            return
        }

        if (footballProductKey.isBlank() && state.logo == null) {
            _uiState.update { it.copy(submitted = true, error = uiText(R.string.create_art_select_logo_error)) }
            return
        }

        _uiState.update { it.copy(reviewing = true, currentStep = 3, submitted = true, error = null) }
    }

    fun backToEdit() {
        _uiState.update { it.copy(reviewing = false, currentStep = 2, error = null, billingRequired = false) }
    }

    fun submit() {
        val state = _uiState.value
        val logo = state.logo
        if (state.loading) return
        val footballProductKey = footballProductKey(state)
        MobileAnalytics.track(
            "mobile_confirmou_pedido",
            tela = "criar_arte",
            produto = footballProductKey.ifBlank { "arte_empresa" },
            etapa = "revisao"
        )

        val validationError = validate(state)
        if (validationError != null) {
            _uiState.update { it.copy(reviewing = false, submitted = true, error = validationError) }
            return
        }

        if (footballProductKey.isNotBlank()) {
            submitFootball(state, footballProductKey)
            return
        }

        if (logo == null) {
            _uiState.update { it.copy(reviewing = false, submitted = true, error = uiText(R.string.create_art_select_logo_error)) }
            return
        }

        val observacoesComContexto = buildObservacoesComContexto(state)
        val camposDinamicos = state.camposDinamicos
            .mapValues { it.value.trim() }
            .filterValues { it.isNotBlank() }
            .toMutableMap()
        if (state.fromCameraPhoto) {
            camposDinamicos["frase_na_foto"] = state.fotoFrase.trim()
            camposDinamicos["origem"] = "foto_rapida_app"
        }
        if (state.historiaEmpresa.isNotBlank()) {
            camposDinamicos["historia_empresa"] = state.historiaEmpresa.trim()
        }

        val request = CreateArtEmpresaRequest(
            nomeEmpresa = state.nomeEmpresa.trim(),
            ramo = state.ramo.trim(),
            objetivo = state.objetivo.trim(),
            estiloVisualCliente = state.estiloVisualCliente.trim(),
            rodada = state.rodada.trim(),
            data = state.data.trim(),
            oferta = state.oferta.trim(),
            cta = state.cta.trim(),
            whatsapp = state.whatsapp.trim(),
            instagram = state.instagram.trim(),
            observacoes = observacoesComContexto,
            fraseFoto = state.fotoFrase.trim(),
            historiaEmpresa = state.historiaEmpresa.trim(),
            origemFotoRapida = state.fromCameraPhoto,
            camposDinamicos = camposDinamicos,
            logo = logo,
            fotos = state.fotos,
            referencias = state.referencias,
            modeloExistente = state.modeloExistente
        )

        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, submitted = true, error = null, billingRequired = false, createdPedidoId = "") }
            when (val result = createArtEmpresa(request)) {
                is ApiResult.Success -> {
                    MobileAnalytics.track(
                        "mobile_pedido_criado",
                        tela = "criar_arte",
                        produto = "arte_empresa",
                        etapa = "revisao",
                        pedidoId = result.value.pedidoId,
                        flushNow = true
                    )
                    _uiState.update {
                        it.copy(
                            loading = false,
                            createdPedidoId = result.value.pedidoId
                        )
                    }
                }
                is ApiResult.Failure -> {
                    val isBillingRequired = result.code == "billing_required" || result.statusCode == 402
                    val errorCode = result.code.ifBlank { if (isBillingRequired) "billing_required" else "" }
                    val statusCode = result.statusCode?.toString().orEmpty()
                    val userError = if (isBillingRequired) {
                        uiText(R.string.create_art_billing_required_error)
                    } else {
                        result.message.toUiTextOrNull() ?: uiText(R.string.create_art_create_error)
                    }
                    Log.w(
                        TAG,
                        "Erro ao criar pedido: statusCode=$statusCode code=$errorCode message=${result.message}"
                    )
                    MobileAnalytics.track(
                        "mobile_pedido_erro",
                        tela = "criar_arte",
                        produto = "arte_empresa",
                        etapa = "revisao",
                        payload = mapOf(
                            "erro" to result.message,
                            "statusCode" to statusCode,
                            "code" to errorCode,
                            "billingRequired" to isBillingRequired.toString()
                        ),
                        flushNow = true
                    )
                    _uiState.update {
                        it.copy(
                            loading = false,
                            billingRequired = isBillingRequired,
                            error = userError
                        )
                    }
                }
            }
        }
    }

    private fun validate(state: CreateArtEmpresaUiState): UiText? {
        val footballProductKey = footballProductKey(state)
        if (footballProductKey.isNotBlank()) {
            return validateFootball(state, footballProductKey)
        }
        return when {
            state.nomeEmpresa.isBlank() -> uiText(R.string.create_art_validate_company_name)
            state.ramo.isBlank() -> uiText(R.string.create_art_validate_business)
            CreateArtCatalog.isBlockedRamo(state.ramo) -> uiText(R.string.ramo_unavailable_error)
            requiresRamoSelection(state) -> uiText(R.string.ramo_select_suggestion_error)
            state.objetivo.isBlank() -> uiText(R.string.create_art_validate_goal)
            state.estiloVisualCliente.isBlank() -> uiText(R.string.create_art_validate_visual_style)
            state.rodada.isBlank() -> uiText(R.string.create_art_validate_round)
            state.data.isBlank() -> uiText(R.string.create_art_validate_date)
            else -> null
        }
    }

    private fun validateStep(state: CreateArtEmpresaUiState): UiText? {
        return when (state.currentStep) {
            0 -> when {
                state.ramo.isBlank() -> uiText(R.string.create_art_validate_business)
                state.nomeEmpresa.isBlank() -> uiText(R.string.create_art_validate_company_name)
                CreateArtCatalog.isBlockedRamo(state.ramo) -> uiText(R.string.ramo_unavailable_error)
                requiresRamoSelection(state) -> uiText(R.string.ramo_select_suggestion_error)
                else -> null
            }
            1 -> when {
                state.objetivo.isBlank() -> uiText(R.string.create_art_validate_goal)
                else -> null
            }
            2 -> footballProductKey(state).takeIf { it.isNotBlank() }?.let { validateFootball(state, it) }
            else -> null
        }
    }

    private fun submitFootball(state: CreateArtEmpresaUiState, productKey: String) {
        val request = buildFootballOrderRequest(state, productKey)
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, submitted = true, error = null, createdPedidoId = "") }
            when (val result = createArtEmpresa.criarPedidoFutebol(request)) {
                is ApiResult.Success -> {
                    MobileAnalytics.track(
                        "mobile_pedido_criado",
                        tela = "criar_arte",
                        produto = productKey,
                        etapa = "revisao",
                        pedidoId = result.value.pedidoId,
                        flushNow = true
                    )
                    _uiState.update {
                        it.copy(loading = false, createdPedidoId = result.value.pedidoId)
                    }
                }
                is ApiResult.Failure -> {
                    MobileAnalytics.track(
                        "mobile_pedido_erro",
                        tela = "criar_arte",
                        produto = productKey,
                        etapa = "revisao",
                        payload = mapOf("erro" to result.message),
                        flushNow = true
                    )
                    _uiState.update {
                        it.copy(
                            loading = false,
                            error = result.message.toUiTextOrNull() ?: uiText(R.string.create_art_create_error)
                        )
                    }
                }
            }
        }
    }

    private fun validateFootball(state: CreateArtEmpresaUiState, productKey: String): UiText? {
        val baseError = when {
            state.nomeEmpresa.isBlank() -> uiText(R.string.create_art_validate_company_name)
            state.ramo.isBlank() -> uiText(R.string.create_art_validate_business)
            CreateArtCatalog.isBlockedRamo(state.ramo) -> uiText(R.string.ramo_unavailable_error)
            requiresRamoSelection(state) -> uiText(R.string.ramo_select_suggestion_error)
            state.objetivo.isBlank() -> uiText(R.string.create_art_validate_goal)
            else -> null
        }
        if (baseError != null) return baseError

        fun required(message: String) = UiText.Dynamic(message)
        return when (productKey) {
            "mascote_uniforme" -> when {
                state.footballMascotAnimal.isBlank() -> required("Informe o animal ou mascote.")
                state.footballTeamCrest == null -> required("Envie o escudo do time.")
                state.footballAuxImage == null -> required("Envie a camiseta ou uniforme do time.")
                else -> null
            }
            "escudo3d" -> when {
                state.footballTeamCrest == null -> required("Envie o escudo do time.")
                else -> null
            }
            "resultado" -> when {
                state.footballHomeTeam.isBlank() -> required("Informe o Time A.")
                state.footballHomeScore.isBlank() -> required("Informe os gols do Time A.")
                state.footballAwayScore.isBlank() -> required("Informe os gols do Time B.")
                state.footballAwayTeam.isBlank() -> required("Informe o Time B.")
                state.footballTeamCrest == null -> required("Envie o escudo do Time A.")
                else -> null
            }
            "proximo_jogo" -> when {
                state.footballHomeTeam.isBlank() -> required("Informe o Time A.")
                state.footballAwayTeam.isBlank() -> required("Informe o Time B.")
                state.footballMatchDatetime.isBlank() -> required("Informe a data e horário.")
                state.footballCompetition.isBlank() -> required("Informe o campeonato ou competição.")
                state.footballTeamCrest == null -> required("Envie o escudo do Time A.")
                state.footballOpponentCrest == null -> required("Envie o escudo do Time B.")
                else -> null
            }
            "treino" -> when {
                state.footballTitle.isBlank() -> required("Informe a chamada do treino.")
                state.footballTeamCrest == null -> required("Envie o escudo do time.")
                else -> null
            }
            "escalacao" -> when {
                state.footballTitle.isBlank() -> required("Informe o confronto.")
                state.footballMatchDatetime.isBlank() -> required("Informe a data e horário.")
                state.footballCompetition.isBlank() -> required("Informe o campeonato ou competição.")
                state.footballTeamCrest == null -> required("Envie o escudo do time.")
                parseFootballPlayers(state).isEmpty() -> required("Adicione pelo menos um jogador.")
                else -> null
            }
            "contratacao" -> when {
                state.footballTitle.isBlank() -> required("Informe o título da arte.")
                state.footballPlayerName.isBlank() -> required("Informe o nome do jogador.")
                state.footballTeamCrest == null -> required("Envie o escudo do time.")
                state.footballOpponentCrest == null -> required("Envie a foto do jogador.")
                else -> null
            }
            "patrocinador" -> when {
                state.footballTitle.isBlank() -> required("Informe o título da arte.")
                state.footballTeamCrest == null -> required("Envie o escudo do time.")
                state.footballSponsorLogos.isEmpty() -> required("Envie pelo menos um patrocinador.")
                else -> null
            }
            else -> required("Produto de futebol inválido.")
        }
    }

    private fun buildFootballOrderRequest(state: CreateArtEmpresaUiState, productKey: String): FootballOrderRequest {
        val fields = linkedMapOf<String, String>()
        val nested = linkedMapOf<String, Any>()
        val files = linkedMapOf<String, UploadFile>()
        val multiFiles = linkedMapOf<String, List<UploadFile>>()

        fun put(key: String, value: String) {
            fields[key] = value.trim()
        }
        fun putFile(key: String, file: UploadFile?) {
            if (file != null) files[key] = file
        }
        fun emptyLists() {
            put("artilheiros", "[]")
            put("artilheiros_json", "[]")
            put("artilheiros_texto", "")
            put("artilheiros_qtd", "0")
        }
        fun matchup(): String = "${state.footballHomeTeam.trim()} x ${state.footballAwayTeam.trim()}".trim()
        fun resultadoFinal(): String {
            val t1 = state.footballHomeTeam.trim()
            val t2 = state.footballAwayTeam.trim()
            val g1 = state.footballHomeScore.trim().ifBlank { "0" }
            val g2 = state.footballAwayScore.trim().ifBlank { "0" }
            return if (t1.isNotBlank() && t2.isNotBlank()) "$t1 $g1 x $g2 $t2" else "$g1 x $g2"
        }

        val endpoint = if (productKey == "resultado") "/resultado_do_jogo" else "/pedidos"
        val flyerTipo = when (productKey) {
            "mascote_uniforme" -> "mascote_uniforme"
            "escudo3d" -> "escudo3d"
            "proximo_jogo" -> "zz1ft"
            "treino" -> "treino"
            "escalacao" -> "zz1fs"
            "contratacao" -> "zz1fm"
            "patrocinador" -> "zz1fj"
            else -> ""
        }

        when (productKey) {
            "mascote_uniforme" -> {
                val nome = state.footballMascotAnimal.trim()
                put("rodada", "Mascote + uniforme")
                put("data", nome)
                nested["mascot_animal"] = nome
                val jogadores = listOf(mapOf("nome" to nome, "posicao" to ""))
                nested["players"] = jogadores
                put("jogadores_json", playersJson(jogadores))
                put("jogadores_texto", nome)
                emptyLists()
                putFile("escudo1", state.footballTeamCrest)
                putFile("mascote", state.footballAuxImage)
            }
            "escudo3d" -> {
                put("rodada", "Escudo 3D")
                put("data", "Escudo 3D")
                nested["title"] = "Escudo 3D"
                putFile("escudo1", state.footballTeamCrest)
            }
            "resultado" -> {
                val rodada = resultadoFinal()
                val headline = state.footballHeadline.ifBlank { "Resultado do jogo" }
                put("rodada", rodada)
                put("data", headline)
                put("time_principal", state.footballHomeTeam)
                put("gols_time_principal", state.footballHomeScore)
                put("gols_adversario", state.footballAwayScore)
                put("time_adversario", state.footballAwayTeam)
                put("hora", state.footballCompetition)
                nested["score"] = mapOf(
                    "home_team" to state.footballHomeTeam.trim(),
                    "home_score" to state.footballHomeScore.trim(),
                    "away_score" to state.footballAwayScore.trim(),
                    "away_team" to state.footballAwayTeam.trim()
                )
                nested["competition"] = state.footballCompetition.trim()
                nested["headline"] = headline.trim()
                put("jogadores_json", "[]")
                put("jogadores_texto", "")
                emptyLists()
                putFile("escudo1", state.footballTeamCrest)
                putFile("escudo2", state.footballOpponentCrest)
                putFile("mascote", state.footballAuxImage)
            }
            "proximo_jogo" -> {
                put("rodada", matchup())
                put("time_principal", state.footballHomeTeam)
                put("time_adversario", state.footballAwayTeam)
                put("data", state.footballMatchDatetime)
                put("hora", state.footballCompetition)
                put("arena", state.footballVenue)
                nested["matchup"] = mapOf(
                    "home_team" to state.footballHomeTeam.trim(),
                    "away_team" to state.footballAwayTeam.trim()
                )
                nested["match_datetime"] = state.footballMatchDatetime.trim()
                nested["competition"] = state.footballCompetition.trim()
                nested["venue"] = state.footballVenue.trim()
                put("jogadores_json", "[]")
                put("jogadores_texto", "")
                emptyLists()
                putFile("escudo1", state.footballTeamCrest)
                putFile("escudo2", state.footballOpponentCrest)
                putFile("mascote", state.footballAuxImage)
            }
            "treino" -> {
                val title = state.footballTitle.trim().ifBlank { "Dia de Treino" }
                val headline = state.footballHeadline.ifBlank { title }
                put("rodada", title)
                put("data", headline)
                put("hora", state.footballCompetition)
                put("arena", state.footballVenue)
                nested["title"] = title
                nested["headline"] = headline.trim()
                nested["context"] = state.footballCompetition.trim()
                nested["venue"] = state.footballVenue.trim()
                put("jogadores_json", "[]")
                put("jogadores_texto", "")
                emptyLists()
                putFile("escudo1", state.footballTeamCrest)
                putFile("mascote", state.footballAuxImage)
            }
            "escalacao" -> {
                val jogadores = parseFootballPlayers(state)
                put("rodada", state.footballTitle)
                put("data", state.footballMatchDatetime)
                put("hora", state.footballCompetition)
                put("arena", state.footballVenue)
                nested["matchup"] = state.footballTitle.trim()
                nested["match_datetime"] = state.footballMatchDatetime.trim()
                nested["competition"] = state.footballCompetition.trim()
                nested["venue"] = state.footballVenue.trim()
                nested["players"] = jogadores
                put("jogadores_json", playersJson(jogadores))
                put("jogadores_texto", jogadores.joinToString("; ") { player ->
                    val nome = player["nome"].orEmpty()
                    val posicao = player["posicao"].orEmpty()
                    if (posicao.isNotBlank()) "$nome - $posicao" else nome
                })
                emptyLists()
                putFile("escudo1", state.footballTeamCrest)
                putFile("escudo2", state.footballOpponentCrest)
                putFile("mascote", state.footballAuxImage)
            }
            "contratacao" -> {
                put("rodada", state.footballTitle)
                put("data", state.footballPlayerName)
                put("hora", state.footballPlayerInfo)
                nested["title"] = state.footballTitle.trim()
                nested["player_name"] = state.footballPlayerName.trim()
                nested["player_info"] = state.footballPlayerInfo.trim()
                put("jogadores_json", "[]")
                put("jogadores_texto", "")
                emptyLists()
                putFile("escudo1", state.footballTeamCrest)
                putFile("escudo2", state.footballOpponentCrest)
            }
            "patrocinador" -> {
                val headline = state.footballHeadline.ifBlank { state.footballTitle }
                put("rodada", state.footballTitle)
                put("data", headline)
                nested["title"] = state.footballTitle.trim()
                nested["headline"] = headline.trim()
                put("jogadores_json", "[]")
                put("jogadores_texto", "")
                emptyLists()
                putFile("escudo1", state.footballTeamCrest)
                multiFiles["patrocinadores"] = state.footballSponsorLogos
            }
        }

        return FootballOrderRequest(
            productKey = productKey,
            endpoint = endpoint,
            flyerTipo = flyerTipo,
            nomeEmpresa = state.nomeEmpresa.trim(),
            ramo = "Futebol",
            objetivo = state.objetivo.trim(),
            fields = fields,
            nestedFields = nested,
            files = files,
            multiFiles = multiFiles
        )
    }

    private fun footballProductKey(state: CreateArtEmpresaUiState): String {
        val objective = CreateArtCatalog.objectivesForRamo(state.ramo).firstOrNull { it.id == state.objetivoId }
            ?: CreateArtCatalog.objectivesForRamo(state.ramo).firstOrNull { it.label == state.objetivo }
        return objective?.productKey.orEmpty()
    }

    private fun parseFootballPlayers(state: CreateArtEmpresaUiState): List<Map<String, String>> {
        return state.footballPlayersText
            .lineSequence()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .map { line ->
                val parts = line.split("-", limit = 2).map { it.trim() }
                mapOf(
                    "nome" to parts.firstOrNull().orEmpty(),
                    "posicao" to parts.getOrNull(1).orEmpty()
                )
            }
            .filter { it["nome"].orEmpty().isNotBlank() }
            .toList()
    }

    private fun playersJson(players: List<Map<String, String>>): String {
        return players.joinToString(prefix = "[", postfix = "]") { player ->
            val nome = player["nome"].orEmpty().replace("\"", "\\\"")
            val posicao = player["posicao"].orEmpty().replace("\"", "\\\"")
            "{\"nome\":\"$nome\",\"posicao\":\"$posicao\"}"
        }
    }

    companion object {
        private const val TAG = "CreateArtEmpresaVM"
        const val MAX_IMAGENS_OPCIONAIS = 5
        const val RAMO_SUGGESTION_MIN_CHARS = 4
    }

    private fun CreateArtEmpresaUiState.withCompanyProfile(
        companyProfileStore: CompanyProfileStore
    ): CreateArtEmpresaUiState {
        val profile = companyProfileStore.getProfile()
        val safeRamo = profile.ramo.takeUnless { CreateArtCatalog.isBlockedRamo(it) }.orEmpty()
        return copy(
            nomeEmpresa = profile.nomeEmpresa,
            ramo = safeRamo,
            ramoSelecionadoCatalogo = safeRamo.isNotBlank(),
            whatsapp = profile.whatsapp,
            instagram = profile.instagram,
            historiaEmpresa = profile.historia,
            profileLogoUri = profile.logoUri
        )
    }

    private fun buildObservacoesComContexto(state: CreateArtEmpresaUiState): String {
        val partes = buildList {
            val observacoes = state.observacoes.trim()
            if (observacoes.isNotBlank()) add(observacoes)
            if (state.fotoFrase.isNotBlank()) add("Frase para aparecer na foto: ${state.fotoFrase.trim()}")
            if (state.historiaEmpresa.isNotBlank()) add("História da empresa: ${state.historiaEmpresa.trim()}")
        }
        return partes.joinToString("\n")
    }

    private fun requiresRamoSelection(state: CreateArtEmpresaUiState): Boolean {
        val query = state.ramo.trim()
        return query.length >= RAMO_SUGGESTION_MIN_CHARS &&
            !state.ramoSelecionadoCatalogo &&
            !state.ramoDigitacaoLivre &&
            CreateArtCatalog.suggestions(query).isNotEmpty()
    }

    private fun saveCompanyProfileFromEmpresaStep(state: CreateArtEmpresaUiState) {
        val current = companyProfileStore.getProfile()
        companyProfileStore.saveProfile(
            CompanyProfile(
                nomeEmpresa = state.nomeEmpresa.trim(),
                ramo = state.ramo.trim(),
                whatsapp = state.whatsapp.trim(),
                instagram = state.instagram.trim(),
                historia = current.historia,
                endereco = current.endereco,
                cidade = current.cidade,
                estado = current.estado,
                cep = current.cep,
                email = current.email,
                site = current.site,
                logoUri = current.logoUri
            )
        )
    }

    private fun CreateArtEmpresaUiState.clearFootballFields(): CreateArtEmpresaUiState {
        return copy(
            footballHomeTeam = "",
            footballAwayTeam = "",
            footballHomeScore = "",
            footballAwayScore = "",
            footballCompetition = "",
            footballHeadline = "",
            footballMatchDatetime = "",
            footballVenue = "",
            footballTitle = "",
            footballPlayerName = "",
            footballPlayerInfo = "",
            footballMascotAnimal = "",
            footballPlayersText = "",
            footballTeamCrest = null,
            footballOpponentCrest = null,
            footballAuxImage = null,
            footballSponsorLogos = emptyList()
        )
    }
}

class CreateArtEmpresaViewModelFactory(
    private val createArtEmpresa: CreateArtEmpresaUseCase,
    private val companyProfileStore: CompanyProfileStore
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return CreateArtEmpresaViewModel(createArtEmpresa, companyProfileStore) as T
    }
}
