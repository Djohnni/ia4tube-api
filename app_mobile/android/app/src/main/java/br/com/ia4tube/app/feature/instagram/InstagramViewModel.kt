package br.com.ia4tube.app.feature.instagram

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.core.config.AppConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Each request uses the captured official IA4Tube session; changing it detaches all outstanding work. */
class InstagramViewModel(
    private val tokenProvider: () -> String,
    private val intentStore: InstagramPublicationIntentStore,
    private val apiOrigin: String = AppConfig.apiBase,
    private val gatewayFactory: (() -> String) -> InstagramGateway = { InstagramApiClient(it, AppConfig.apiBase) }
) : ViewModel() {
    private val _uiState = MutableStateFlow(InstagramUiState())
    val uiState: StateFlow<InstagramUiState> = _uiState.asStateFlow()
    private var sessionToken = ""
    private var sessionEpoch = 0L
    private var operation: Job? = null
    private var gateway: InstagramGateway? = null
    private var pendingAuthorizationConnectionId: String? = null

    private fun synchronizeSession(): Boolean {
        val currentToken = tokenProvider()
        if (currentToken != sessionToken) {
            operation?.cancel()
            sessionEpoch += 1
            sessionToken = currentToken
            pendingAuthorizationConnectionId = null
            _uiState.value.draftJpeg?.fill(0)
            _uiState.value = InstagramUiState(
                availability = if (currentToken.isBlank()) InstagramAvailability.SESSION_REQUIRED else InstagramAvailability.CHECKING
            )
            val capturedToken = currentToken
            gateway = if (capturedToken.isBlank()) null else gatewayFactory { capturedToken }
        }
        if (currentToken.isBlank()) {
            _uiState.update { it.copy(availability = InstagramAvailability.SESSION_REQUIRED, busy = false) }
            return false
        }
        return true
    }

    private fun isCurrent(epoch: Long): Boolean {
        if (tokenProvider() != sessionToken) synchronizeSession()
        return epoch == sessionEpoch && sessionToken.isNotBlank()
    }

    fun onResume() {
        if (!synchronizeSession()) return
        if (!_uiState.value.busy) refresh()
    }

    fun pickerSessionKey(): String? {
        if (!synchronizeSession() || !_uiState.value.canEditDraft) return null
        return InstagramPolicies.sessionKey(sessionToken)
    }

    fun acceptJpeg(bytes: ByteArray, pickerSessionKey: String) {
        if (!synchronizeSession() || pickerSessionKey != InstagramPolicies.sessionKey(sessionToken) ||
            !_uiState.value.canEditDraft
        ) {
            bytes.fill(0)
            return
        }
        if (!InstagramPolicies.validateJpeg(bytes)) {
            bytes.fill(0)
            showSelectionError("Escolha uma imagem JPEG de 1080 × 1080 pixels, com até 8 MB.")
            return
        }
        _uiState.value.draftJpeg?.fill(0)
        _uiState.update { it.copy(draftJpeg = bytes, selectedMediaId = null, error = null, message = null) }
    }

    fun showSelectionError(message: String = "Não foi possível abrir a imagem selecionada.") {
        if (!synchronizeSession()) return
        _uiState.update { it.copy(error = message) }
    }

    fun updateCaption(caption: String) {
        if (!synchronizeSession() || !_uiState.value.canEditDraft) return
        if (caption.length > 9000) return
        _uiState.update { it.copy(draftCaption = caption, selectedMediaId = null, error = null, message = null) }
    }

    fun refresh() {
        if (!synchronizeSession() || _uiState.value.busy) return
        val epoch = sessionEpoch
        val api = gateway ?: return
        _uiState.update { it.copy(busy = true, error = null, confirmationOpen = false, reconciliationConfirmationOpen = false) }
        operation = viewModelScope.launch {
            try {
                val connectionResult = api.currentConnection()
                if (!isCurrent(epoch)) return@launch
                when (val result = connectionResult) {
                    is InstagramResult.Failure -> { failAvailability(result.error); return@launch }
                    is InstagramResult.Success -> {
                        if (!isCurrent(epoch)) return@launch
                        val changed = _uiState.value.connection?.connectionId != result.value?.connectionId
                        if (changed) _uiState.value.draftJpeg?.fill(0)
                        _uiState.update {
                            it.copy(connection = result.value, availability = InstagramAvailability.AVAILABLE,
                                authorizationStatus = if (result.value == null && pendingAuthorizationConnectionId == null)
                                    null else it.authorizationStatus,
                                selectedMediaId = if (changed) null else it.selectedMediaId,
                                draftJpeg = if (changed) null else it.draftJpeg,
                                draftCaption = if (changed) "" else it.draftCaption,
                                intent = if (changed) null else it.intent)
                        }
                    }
                }
                val connection = _uiState.value.connection
                val authorizationConnectionId = pendingAuthorizationConnectionId ?: connection?.connectionId
                if (authorizationConnectionId != null) {
                    when (val result = api.authorizationStatus(authorizationConnectionId)) {
                        is InstagramResult.Success -> if (isCurrent(epoch)) {
                            _uiState.update { it.copy(authorizationStatus = result.value.status) }
                            if (result.value.status !in setOf("authorization_pending", "authorization_processing")) {
                                pendingAuthorizationConnectionId = null
                            }
                        }
                        // An already connected account may have no current authorization record.
                        is InstagramResult.Failure -> if (pendingAuthorizationConnectionId != null && isCurrent(epoch)) {
                            _uiState.update { it.copy(message = "A autorização ainda não foi confirmada. Você pode consultar novamente.") }
                        }
                    }
                }
                if (!isCurrent(epoch)) return@launch
                when (val result = api.media()) {
                    is InstagramResult.Success -> if (isCurrent(epoch)) _uiState.update {
                        it.copy(media = result.value, selectedMediaId = it.selectedMediaId?.takeIf { id -> result.value.any { media -> media.id == id } })
                    }
                    is InstagramResult.Failure -> { if (isCurrent(epoch)) failAvailability(result.error); return@launch }
                }
                if (!isCurrent(epoch)) return@launch
                when (val result = api.publications()) {
                    is InstagramResult.Success -> if (isCurrent(epoch)) _uiState.update {
                        it.copy(history = result.value.publications, historyLoaded = true,
                            freshPublicationAvailable = result.value.freshPublicationAvailable)
                    }
                    is InstagramResult.Failure -> { if (isCurrent(epoch)) failAvailability(result.error); return@launch }
                }
                if (!isCurrent(epoch)) return@launch
                if (connection != null) {
                    val contextKey = InstagramIntentPolicy.contextKey(apiOrigin, connection.connectionId)
                    val saved = withContext(Dispatchers.IO) { intentStore.read(contextKey) }
                    if (!isCurrent(epoch)) return@launch
                    _uiState.update { it.copy(intent = saved, storageAvailable = true) }
                    if (saved?.publicationId != null) {
                        when (val result = api.publication(saved.publicationId)) {
                            is InstagramResult.Success -> if (isCurrent(epoch)) observePublication(contextKey, saved, result.value)
                            is InstagramResult.Failure -> if (isCurrent(epoch)) _uiState.update { it.copy(message = "O resultado continua pendente de confirmação. Nenhum novo envio será feito.") }
                        }
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (isCurrent(epoch)) _uiState.update {
                    it.copy(storageAvailable = false, error = "Não foi possível confirmar o registro da publicação. O envio permanece bloqueado.")
                }
            } finally {
                if (isCurrent(epoch)) _uiState.update { it.copy(busy = false) }
            }
        }
    }

    private fun failAvailability(error: InstagramError) {
        _uiState.update { it.copy(
            availability = if (error == InstagramError.SESSION_REQUIRED) InstagramAvailability.SESSION_REQUIRED else InstagramAvailability.UNAVAILABLE,
            historyLoaded = false, freshPublicationAvailable = false, confirmationOpen = false, error = error.message
        ) }
    }

    fun connect() {
        if (!synchronizeSession() || !_uiState.value.canAuthorize) return
        val epoch = sessionEpoch
        val api = gateway ?: return
        val purpose = if (_uiState.value.connection == null) "connect" else "reconnect"
        _uiState.update { it.copy(busy = true, error = null, message = null) }
        operation = viewModelScope.launch {
            try {
                val result = api.authorize(purpose)
                if (!isCurrent(epoch)) return@launch
                when (result) {
                    is InstagramResult.Success -> {
                        if (!InstagramPolicies.isOfficialAuthorizationUrl(result.value.authorizationUrl)) {
                            _uiState.update { it.copy(error = "O endereço de autorização não pôde ser confirmado.") }
                            return@launch
                        }
                        pendingAuthorizationConnectionId = result.value.connectionId
                        _uiState.update { it.copy(authorizationStatus = "authorization_pending",
                            authorizationUrlToOpen = result.value.authorizationUrl,
                            message = "Conclua a autorização no Instagram e volte ao aplicativo para consultar o resultado.") }
                    }
                    is InstagramResult.Failure -> {
                        if (result.error == InstagramError.UNAVAILABLE || result.error == InstagramError.SESSION_REQUIRED) {
                            failAvailability(result.error)
                        } else _uiState.update { it.copy(error = result.error.message,
                            authorizationStatus = if (result.error in setOf(InstagramError.NETWORK, InstagramError.RESULT_UNKNOWN, InstagramError.INVALID_RESPONSE))
                                "authorization_pending" else it.authorizationStatus) }
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (isCurrent(epoch)) _uiState.update { it.copy(authorizationStatus = "authorization_pending",
                    error = "A autorização ainda não foi confirmada. Consulte o estado antes de continuar.") }
            } finally {
                if (isCurrent(epoch)) _uiState.update { it.copy(busy = false) }
            }
        }
    }

    /** Consume the navigation event before opening the browser so rotation never opens it twice. */
    fun takeAuthorizationUrl(): String? {
        if (!synchronizeSession()) return null
        val url = _uiState.value.authorizationUrlToOpen ?: return null
        _uiState.update { it.copy(authorizationUrlToOpen = null) }
        return url.takeIf(InstagramPolicies::isOfficialAuthorizationUrl)
    }

    fun browserUnavailable() {
        _uiState.update { it.copy(error = "Não foi possível abrir o navegador. A autorização não foi confirmada; consulte novamente.") }
    }

    fun upload() {
        if (!synchronizeSession() || !_uiState.value.canUpload) return
        val epoch = sessionEpoch
        val api = gateway ?: return
        val jpeg = _uiState.value.draftJpeg?.copyOf() ?: return
        val caption = _uiState.value.draftCaption.trim()
        _uiState.update { it.copy(busy = true, error = null, message = null) }
        operation = viewModelScope.launch {
            try {
                val result = api.uploadMedia(jpeg, caption)
                if (!isCurrent(epoch)) return@launch
                when (result) {
                    is InstagramResult.Success -> _uiState.update {
                        it.copy(media = listOf(result.value) + it.media.filterNot { media -> media.id == result.value.id },
                            selectedMediaId = result.value.id,
                            message = "Imagem enviada. Revise abaixo a prévia da legenda antes de publicar.")
                    }
                    is InstagramResult.Failure -> _uiState.update { it.copy(error = result.error.message) }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (isCurrent(epoch)) _uiState.update { it.copy(error = "Não foi possível confirmar o envio da imagem.") }
            } finally {
                jpeg.fill(0)
                if (isCurrent(epoch)) _uiState.update { it.copy(busy = false) }
            }
        }
    }

    fun requestPublicationConfirmation() {
        if (synchronizeSession() && _uiState.value.canPublish) _uiState.update { it.copy(confirmationOpen = true) }
    }

    fun dismissPublicationConfirmation() {
        _uiState.update { it.copy(confirmationOpen = false) }
    }

    fun confirmPublish() {
        if (!synchronizeSession() || !_uiState.value.confirmationOpen || !_uiState.value.canPublish) return
        val epoch = sessionEpoch
        val api = gateway ?: return
        val connection = _uiState.value.connection ?: return
        val selectedMedia = _uiState.value.selectedMedia ?: return
        val contextKey = InstagramIntentPolicy.contextKey(apiOrigin, connection.connectionId)
        val intent = InstagramIntentPolicy.create(selectedMedia.id, connection)
        _uiState.update { it.copy(busy = true, confirmationOpen = false, message = null, error = null) }
        operation = viewModelScope.launch {
            try {
                // Synchronous durable storage completes BEFORE the first POST. A crash after this
                // point is treated as uncertain, even if the request had not yet left the device.
                val stored = withContext(Dispatchers.IO) { intentStore.create(contextKey, intent) }
                if (!isCurrent(epoch)) return@launch
                if (!stored) {
                    _uiState.update { it.copy(storageAvailable = false,
                        error = "Já existe um registro de envio ou não foi possível salvá-lo. Consulte o resultado antes de continuar.") }
                    return@launch
                }
                _uiState.update { it.copy(intent = intent) }
                val result = api.publish(intent.mediaId, intent.clientRequestId)
                if (!isCurrent(epoch)) return@launch
                when (result) {
                    is InstagramResult.Success -> {
                        val publication = result.value
                        if (publication.connectionId != intent.connectionId || publication.mediaId != intent.mediaId) {
                            _uiState.update { it.copy(error = UNKNOWN_RESULT) }
                            return@launch
                        }
                        val identified = intent.copy(publicationId = publication.publicationId, confirmed = publication.confirmed)
                        val saved = withContext(Dispatchers.IO) { intentStore.update(contextKey, identified) }
                        if (!isCurrent(epoch)) return@launch
                        _uiState.update { it.copy(intent = identified, storageAvailable = saved,
                            history = listOf(publication) + it.history.filterNot { item -> item.publicationId == publication.publicationId },
                            freshPublicationAvailable = false,
                            message = if (publication.confirmed) "Publicação confirmada pelo Instagram." else UNKNOWN_RESULT,
                            error = if (saved) null else "A confirmação não pôde ser salva. O envio permanece bloqueado.") }
                    }
                    is InstagramResult.Failure -> {
                        if (result.error in setOf(InstagramError.UNAVAILABLE, InstagramError.SESSION_REQUIRED)) {
                            failAvailability(result.error)
                        }
                        _uiState.update { it.copy(error = if (result.error in setOf(
                                InstagramError.NETWORK, InstagramError.RESULT_UNKNOWN, InstagramError.INVALID_RESPONSE
                            )) UNKNOWN_RESULT else "${result.error.message} O registro foi preservado; nenhum novo envio será feito automaticamente.") }
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (isCurrent(epoch)) _uiState.update { it.copy(storageAvailable = false, error = UNKNOWN_RESULT) }
            } finally {
                if (isCurrent(epoch)) _uiState.update { it.copy(busy = false) }
            }
        }
    }

    private suspend fun observePublication(
        contextKey: String,
        intent: InstagramPublicationIntent,
        publication: InstagramPublication
    ) {
        val updated = InstagramIntentPolicy.observe(intent, publication) ?: return
        val epoch = sessionEpoch
        val saved = withContext(Dispatchers.IO) { intentStore.update(contextKey, updated) }
        if (!isCurrent(epoch)) return
        _uiState.update { it.copy(intent = updated, storageAvailable = saved,
            history = listOf(publication) + it.history.filterNot { item -> item.publicationId == publication.publicationId },
            message = if (updated.confirmed) "Publicação confirmada pelo Instagram." else UNKNOWN_RESULT) }
    }

    fun requestContinuationConfirmation() {
        if (synchronizeSession() && _uiState.value.canContinueConfirmation) {
            _uiState.update { it.copy(reconciliationConfirmationOpen = true) }
        }
    }

    fun dismissContinuationConfirmation() {
        _uiState.update { it.copy(reconciliationConfirmationOpen = false) }
    }

    /** Explicit continuation only: reconcile may complete the already authorized provider send. */
    fun continuePublicationConfirmation() {
        if (!synchronizeSession() || !_uiState.value.reconciliationConfirmationOpen ||
            !_uiState.value.canContinueConfirmation
        ) return
        val intent = _uiState.value.intent ?: return
        val publicationId = intent.publicationId ?: return
        val epoch = sessionEpoch
        val api = gateway ?: return
        val contextKey = InstagramIntentPolicy.contextKey(apiOrigin, intent.connectionId)
        _uiState.update { it.copy(busy = true, reconciliationConfirmationOpen = false, error = null, message = null) }
        operation = viewModelScope.launch {
            try {
                // A reconnect can reuse a connection ID for a different Instagram account.
                // Do not use the account currently attached to a history row as the original binding.
                val currentConnection = api.currentConnection()
                if (!isCurrent(epoch)) return@launch
                when (currentConnection) {
                    is InstagramResult.Failure -> {
                        _uiState.update { it.copy(error = currentConnection.error.message) }
                        return@launch
                    }
                    is InstagramResult.Success -> {
                        val current = currentConnection.value
                        _uiState.update { it.copy(connection = current) }
                        if (current?.canPublish != true || !InstagramIntentPolicy.matchesAccount(intent, current)) {
                            _uiState.update { it.copy(error = "A conta conectada mudou ou não está pronta. A continuação desta publicação permanece bloqueada.") }
                            return@launch
                        }
                    }
                }
                when (val result = api.reconcile(publicationId)) {
                    is InstagramResult.Success -> if (isCurrent(epoch)) {
                        if (InstagramIntentPolicy.observe(intent, result.value) == null) {
                            _uiState.update { it.copy(error = UNKNOWN_RESULT) }
                        } else observePublication(contextKey, intent, result.value)
                    }
                    is InstagramResult.Failure -> if (isCurrent(epoch)) _uiState.update { it.copy(error = UNKNOWN_RESULT) }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (isCurrent(epoch)) _uiState.update { it.copy(error = UNKNOWN_RESULT) }
            } finally {
                if (isCurrent(epoch)) _uiState.update { it.copy(busy = false) }
            }
        }
    }

    fun startNewDraft() {
        if (!synchronizeSession()) return
        val state = _uiState.value
        val intent = state.intent ?: return
        if (state.busy || !intent.confirmed || !state.storageAvailable || !state.freshPublicationAvailable) return
        val connection = state.connection ?: return
        val epoch = sessionEpoch
        val contextKey = InstagramIntentPolicy.contextKey(apiOrigin, connection.connectionId)
        _uiState.update { it.copy(busy = true) }
        operation = viewModelScope.launch {
            try {
                val removed = withContext(Dispatchers.IO) { intentStore.removeConfirmed(contextKey, intent.clientRequestId) }
                if (!isCurrent(epoch)) return@launch
                if (removed) {
                    _uiState.value.draftJpeg?.fill(0)
                    _uiState.update { it.copy(intent = null, draftJpeg = null, draftCaption = "",
                        selectedMediaId = null, message = null, error = null) }
                } else _uiState.update { it.copy(storageAvailable = false, error = "O registro anterior não pôde ser confirmado.") }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (isCurrent(epoch)) _uiState.update { it.copy(storageAvailable = false,
                    error = "Não foi possível confirmar o registro anterior. O envio permanece bloqueado.") }
            } finally {
                if (isCurrent(epoch)) _uiState.update { it.copy(busy = false) }
            }
        }
    }

    override fun onCleared() {
        _uiState.value.draftJpeg?.fill(0)
        super.onCleared()
    }

    private companion object {
        const val UNKNOWN_RESULT = "O resultado ainda não foi confirmado. Consulte o histórico; nenhum novo envio será feito enquanto esta publicação estiver pendente."
    }
}

class InstagramViewModelFactory(
    private val tokenProvider: () -> String,
    private val intentStore: InstagramPublicationIntentStore
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        require(modelClass.isAssignableFrom(InstagramViewModel::class.java))
        @Suppress("UNCHECKED_CAST")
        return InstagramViewModel(tokenProvider, intentStore) as T
    }
}
