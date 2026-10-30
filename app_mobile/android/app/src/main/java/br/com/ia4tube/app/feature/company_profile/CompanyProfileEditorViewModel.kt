package br.com.ia4tube.app.feature.company_profile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.core.company.CompanyProfile
import br.com.ia4tube.app.data.api.CompanyProfileBackend
import br.com.ia4tube.app.data.api.CompanyProfileSnapshot
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.UploadFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal data class CompanyProfileEditorCache(
    val profile: CompanyProfile = CompanyProfile(),
    val pending: Boolean = false,
    val uploadLogo: Boolean = false,
    val removeLogo: Boolean = false
)

internal data class CompanyProfileEditorState(
    val profile: CompanyProfile = CompanyProfile(),
    val loading: Boolean = false,
    val saving: Boolean = false,
    val readingLogo: Boolean = false,
    val dirty: Boolean = false,
    val hasLogo: Boolean = false,
    val message: String? = null,
    val authRequired: Boolean = false
)

internal class CompanyProfileEditorViewModel(
    private val backend: CompanyProfileBackend,
    private val currentToken: () -> String,
    private val readCache: (String) -> CompanyProfileEditorCache,
    private val writeCache: (String, CompanyProfileEditorCache) -> Unit,
    private val persistLogo: suspend (String, UploadFile) -> String,
    private val readLocalLogo: suspend (String) -> ApiResult<UploadFile>
) : ViewModel() {
    private val mutable = MutableStateFlow(CompanyProfileEditorState())
    val state = mutable.asStateFlow()
    private var session: String? = null
    private var epoch = 0L
    private var revision = 0L
    private var readVersion = 0L
    private var opened = false
    private var remoteKnown = false
    private var job: Job? = null
    private var pendingUpload = false
    private var pendingRemoval = false

    fun open(force: Boolean = false) {
        val token = currentToken()
        if (session != token) {
            job?.cancel()
            session = token; epoch++; revision++; opened = false; remoteKnown = false
            val cached = if (token.isNotBlank()) runCatching { readCache(token) }.getOrDefault(CompanyProfileEditorCache())
                else CompanyProfileEditorCache()
            pendingUpload = cached.uploadLogo; pendingRemoval = cached.removeLogo
            mutable.value = CompanyProfileEditorState(profile = cached.profile, dirty = cached.pending,
                hasLogo = cached.profile.logoUri.isNotBlank())
        }
        if (token.isBlank()) {
            mutable.update { it.copy(authRequired = true, message = "Entre novamente para acessar o perfil.") }
            return
        }
        if (mutable.value.saving || mutable.value.readingLogo || (opened && !force)) return
        opened = true
        job?.cancel()
        val expectedEpoch = epoch
        val expectedRevision = ++revision
        val expectedReadVersion = ++readVersion
        mutable.update { it.copy(loading = true, message = null, authRequired = false) }
        job = viewModelScope.launch {
            try {
                when (val result = backend.read(token)) {
                    is ApiResult.Failure -> if (matches(token, expectedEpoch) && revision == expectedRevision) showFailure(result)
                    is ApiResult.Success -> {
                        if (!matches(token, expectedEpoch) || revision != expectedRevision) return@launch
                        remoteKnown = true
                        // A new account with no saved remote profile must retain its old local profile.
                        if (result.value.updatedAt == null) {
                            if (!pendingRemoval && mutable.value.profile.logoUri.isNotBlank()) pendingUpload = true
                            return@launch
                        }
                        if (mutable.value.dirty || revision != expectedRevision) return@launch
                        var profile = result.value.profile.copy(
                            logoUri = mutable.value.profile.logoUri.takeIf { result.value.hasLogo }.orEmpty()
                        )
                        profile = attachRemoteLogo(token, expectedEpoch, expectedRevision, result.value, profile)
                        if (!matches(token, expectedEpoch) || revision != expectedRevision || mutable.value.dirty) return@launch
                        writeCache(token, CompanyProfileEditorCache(profile))
                        mutable.update { it.copy(profile = profile, hasLogo = result.value.hasLogo) }
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { if (matches(token, expectedEpoch) && revision == expectedRevision) fail("Não foi possível carregar o perfil. Suas informações locais foram mantidas.") }
            finally {
                if (matches(token, expectedEpoch) && readVersion == expectedReadVersion) mutable.update { it.copy(loading = false) }
            }
        }
    }

    fun edit(transform: (CompanyProfile) -> CompanyProfile) {
        if (mutable.value.saving || mutable.value.readingLogo) return
        revision++
        mutable.update { it.copy(profile = transform(it.profile), dirty = true, message = null) }
    }

    fun removeLogo() {
        if (mutable.value.saving || mutable.value.readingLogo) return
        pendingUpload = false; pendingRemoval = true
        edit { it.copy(logoUri = "") }
        mutable.update { it.copy(hasLogo = false) }
    }

    fun selectLogo(load: suspend () -> ApiResult<UploadFile>) {
        if (mutable.value.saving || mutable.value.readingLogo) return
        val token = currentToken()
        if (token != session || token.isBlank()) { open(); return }
        val expectedEpoch = epoch
        revision++
        mutable.update { it.copy(readingLogo = true, message = null) }
        viewModelScope.launch {
            try {
                when (val result = load()) {
                    is ApiResult.Failure -> if (matches(token, expectedEpoch)) fail("Não foi possível ler a imagem. Escolha outra.")
                    is ApiResult.Success -> {
                        if (!matches(token, expectedEpoch)) return@launch
                        val uri = persistLogo(token, result.value)
                        if (!matches(token, expectedEpoch)) return@launch
                        pendingUpload = true; pendingRemoval = false
                        mutable.update { it.copy(profile = it.profile.copy(logoUri = uri), dirty = true, hasLogo = true) }
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { if (matches(token, expectedEpoch)) fail("Não foi possível guardar a imagem. Escolha outra.") }
            finally { if (matches(token, expectedEpoch)) mutable.update { it.copy(readingLogo = false) } }
        }
    }

    fun save() {
        if (mutable.value.saving || mutable.value.readingLogo) return
        val token = currentToken()
        if (token != session || token.isBlank()) { open(); return }
        job?.cancel()
        val expectedEpoch = epoch
        var draft = mutable.value.profile
        val upload = pendingUpload || (!remoteKnown && draft.logoUri.isNotBlank() && !pendingRemoval)
        val remove = pendingRemoval
        val expectedRevision = ++revision
        mutable.update { it.copy(saving = true, loading = false, dirty = true, message = null, authRequired = false) }
        job = viewModelScope.launch {
            try {
                if (!matches(token, expectedEpoch)) return@launch
                writeCache(token, CompanyProfileEditorCache(draft, pending = true, uploadLogo = upload, removeLogo = remove))
                val file = if (upload) {
                    when (val result = readLocalLogo(draft.logoUri)) {
                        is ApiResult.Success -> result.value
                        is ApiResult.Failure -> {
                            if (matches(token, expectedEpoch)) fail("Não foi possível ler a logo. Suas alterações foram mantidas.")
                            return@launch
                        }
                    }
                } else null
                if (!matches(token, expectedEpoch)) return@launch
                if (file != null) {
                    val localUri = persistLogo(token, file)
                    if (!matches(token, expectedEpoch)) return@launch
                    draft = draft.copy(logoUri = localUri)
                    writeCache(token, CompanyProfileEditorCache(draft, true, upload, remove))
                    mutable.update { it.copy(profile = draft) }
                }
                when (val result = backend.save(token, draft, file, remove)) {
                    is ApiResult.Failure -> if (matches(token, expectedEpoch)) showFailure(result)
                    is ApiResult.Success -> {
                        if (!matches(token, expectedEpoch)) return@launch
                        remoteKnown = true
                        var profile = result.value.profile.copy(logoUri = draft.logoUri.takeIf { result.value.hasLogo }.orEmpty())
                        profile = attachRemoteLogo(token, expectedEpoch, expectedRevision, result.value, profile)
                        if (!matches(token, expectedEpoch)) return@launch
                        writeCache(token, CompanyProfileEditorCache(profile))
                        pendingUpload = false; pendingRemoval = false
                        mutable.update { it.copy(profile = profile, dirty = false, hasLogo = result.value.hasLogo,
                            message = it.message ?: "Perfil salvo.") }
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { if (matches(token, expectedEpoch)) fail("Não foi possível salvar na conta. Suas alterações foram mantidas neste aparelho.") }
            finally { if (matches(token, expectedEpoch)) mutable.update { it.copy(saving = false) } }
        }
    }

    private suspend fun attachRemoteLogo(
        token: String, expectedEpoch: Long, expectedRevision: Long, snapshot: CompanyProfileSnapshot, profile: CompanyProfile
    ): CompanyProfile {
        if (!snapshot.hasLogo || !matches(token, expectedEpoch)) return profile
        return when (val result = backend.logo(token)) {
            is ApiResult.Success -> {
                if (!matches(token, expectedEpoch) || revision != expectedRevision) profile
                else profile.copy(logoUri = persistLogo(token, result.value))
            }
            is ApiResult.Failure -> {
                if (matches(token, expectedEpoch) && revision == expectedRevision) fail("O perfil está na conta, mas não foi possível carregar a logo. Tente atualizar.")
                profile
            }
        }
    }

    fun keepDraft(): Boolean {
        val token = currentToken()
        if (token.isBlank() || token != session || !mutable.value.dirty) return true
        return try {
            writeCache(token, CompanyProfileEditorCache(mutable.value.profile, true, pendingUpload, pendingRemoval))
            true
        } catch (_: Exception) {
            fail("Não foi possível guardar o rascunho. Tente salvar novamente.")
            false
        }
    }

    private fun matches(token: String, expectedEpoch: Long): Boolean =
        epoch == expectedEpoch && session == token && currentToken() == token
    private fun fail(message: String) = mutable.update { it.copy(message = message) }
    private fun showFailure(value: ApiResult.Failure) = mutable.update {
        it.copy(message = value.message, authRequired = value.statusCode == 401)
    }
}
