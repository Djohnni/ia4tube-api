package br.com.ia4tube.app.feature.company_profile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import br.com.ia4tube.app.R
import br.com.ia4tube.app.core.analytics.MobileAnalytics
import br.com.ia4tube.app.core.company.CompanyProfile
import br.com.ia4tube.app.core.company.CompanyProfileStore
import br.com.ia4tube.app.feature.create_art.CreateArtCatalog
import br.com.ia4tube.app.feature.create_art.CreateArtEmpresaViewModel
import br.com.ia4tube.app.ui.text.UiText
import br.com.ia4tube.app.ui.text.uiText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class CompanyProfileUiState(
    val nomeEmpresa: String = "",
    val ramo: String = "",
    val ramoSelecionadoCatalogo: Boolean = false,
    val ramoDigitacaoLivre: Boolean = false,
    val whatsapp: String = "",
    val instagram: String = "",
    val historia: String = "",
    val endereco: String = "",
    val cidade: String = "",
    val estado: String = "",
    val cep: String = "",
    val email: String = "",
    val site: String = "",
    val logoUri: String = "",
    val message: UiText? = null
)

class CompanyProfileViewModel(
    private val companyProfileStore: CompanyProfileStore
) : ViewModel() {
    private val _uiState = MutableStateFlow(companyProfileStore.getProfile().toUiState())
    val uiState: StateFlow<CompanyProfileUiState> = _uiState.asStateFlow()

    fun updateNomeEmpresa(value: String) = _uiState.update { it.copy(nomeEmpresa = value, message = null) }
    fun updateRamo(value: String) = _uiState.update {
        it.copy(
            ramo = value,
            ramoSelecionadoCatalogo = false,
            ramoDigitacaoLivre = if (value.trim().length <= CreateArtEmpresaViewModel.RAMO_SUGGESTION_MIN_CHARS) false else it.ramoDigitacaoLivre,
            message = null
        )
    }
    fun selectRamo(value: String) = _uiState.update {
        it.copy(ramo = value, ramoSelecionadoCatalogo = true, ramoDigitacaoLivre = false, message = null)
    }
    fun continueRamoTyping() = _uiState.update {
        it.copy(ramoSelecionadoCatalogo = false, ramoDigitacaoLivre = true, message = null)
    }
    fun updateWhatsapp(value: String) = _uiState.update { it.copy(whatsapp = value, message = null) }
    fun updateInstagram(value: String) = _uiState.update { it.copy(instagram = value, message = null) }
    fun updateHistoria(value: String) = _uiState.update { it.copy(historia = value, message = null) }
    fun updateEndereco(value: String) = _uiState.update { it.copy(endereco = value, message = null) }
    fun updateCidade(value: String) = _uiState.update { it.copy(cidade = value, message = null) }
    fun updateEstado(value: String) = _uiState.update { it.copy(estado = value, message = null) }
    fun updateCep(value: String) = _uiState.update { it.copy(cep = value, message = null) }
    fun updateEmail(value: String) = _uiState.update { it.copy(email = value, message = null) }
    fun updateSite(value: String) = _uiState.update { it.copy(site = value, message = null) }
    fun updateLogoUri(value: String) = _uiState.update { it.copy(logoUri = value, message = null) }
    fun removeLogo() = _uiState.update { it.copy(logoUri = "", message = null) }

    fun save(): Boolean {
        val state = _uiState.value
        if (CreateArtCatalog.isBlockedRamo(state.ramo)) {
            _uiState.update { it.copy(message = uiText(R.string.ramo_unavailable_error)) }
            return false
        }
        if (requiresRamoSelection(state)) {
            _uiState.update { it.copy(message = uiText(R.string.ramo_select_suggestion_error)) }
            return false
        }
        companyProfileStore.saveProfile(
            CompanyProfile(
                nomeEmpresa = state.nomeEmpresa.trim(),
                ramo = state.ramo.trim(),
                whatsapp = state.whatsapp.trim(),
                instagram = state.instagram.trim(),
                historia = state.historia.trim(),
                endereco = state.endereco.trim(),
                cidade = state.cidade.trim(),
                estado = state.estado.trim(),
                cep = state.cep.trim(),
                email = state.email.trim(),
                site = state.site.trim(),
                logoUri = state.logoUri
            )
        )
        MobileAnalytics.track("mobile_perfil_empresa_salvou", tela = "perfil_empresa", flushNow = true)
        _uiState.update { it.copy(message = uiText(R.string.company_profile_saved)) }
        return true
    }

    private fun CompanyProfile.toUiState(): CompanyProfileUiState {
        val safeRamo = ramo.takeUnless { CreateArtCatalog.isBlockedRamo(it) }.orEmpty()
        return CompanyProfileUiState(
            nomeEmpresa = nomeEmpresa,
            ramo = safeRamo,
            ramoSelecionadoCatalogo = safeRamo.isNotBlank(),
            whatsapp = whatsapp,
            instagram = instagram,
            historia = historia,
            endereco = endereco,
            cidade = cidade,
            estado = estado,
            cep = cep,
            email = email,
            site = site,
            logoUri = logoUri
        )
    }

    private fun requiresRamoSelection(state: CompanyProfileUiState): Boolean {
        val query = state.ramo.trim()
        return query.length >= CreateArtEmpresaViewModel.RAMO_SUGGESTION_MIN_CHARS &&
            !state.ramoSelecionadoCatalogo &&
            !state.ramoDigitacaoLivre &&
            CreateArtCatalog.suggestions(query).isNotEmpty()
    }
}

class CompanyProfileViewModelFactory(
    private val companyProfileStore: CompanyProfileStore
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return CompanyProfileViewModel(companyProfileStore) as T
    }
}
