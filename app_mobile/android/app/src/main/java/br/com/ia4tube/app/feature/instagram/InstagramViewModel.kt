package br.com.ia4tube.app.feature.instagram

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.core.config.AppConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/** Each request uses the captured official IA4Tube session; changing it detaches all outstanding work. */
class InstagramViewModel(
    private val tokenProvider: () -> String,
    private val intentStore: InstagramPublicationIntentStore,
    private val apiOrigin: String = AppConfig.apiBase,
    private val gatewayFactory: (() -> String) -> InstagramGateway = { InstagramApiClient(it, AppConfig.apiBase) },
    private val authorizationStore: InstagramAuthorizationWitnessStore,
    private val uploadStore: InstagramUploadWitnessStore
) : ViewModel() {
    private val _uiState = MutableStateFlow(InstagramUiState())
    val uiState: StateFlow<InstagramUiState> = _uiState.asStateFlow()
    private var sessionToken = ""
    private var sessionEpoch = 0L
    private var operation: Job? = null
    private var gateway: InstagramGateway? = null
    private var authorizationWitness: InstagramAuthorizationWitness? = null
    private var availabilityEpoch = 0L
    private var foreground = false
    private var completedRefreshEpoch = -1L
    private var jpegSelection: JpegSelection? = null

    private data class JpegSelection(
        val ticket: String,
        val sessionEpoch: Long,
        val binding: InstagramConnectionBinding,
        var bytes: ByteArray? = null
    )

    private fun synchronizeSession(): Boolean {
        val currentToken = tokenProvider()
        if (currentToken != sessionToken) {
            operation?.cancel()
            discardJpegSelection()
            sessionEpoch += 1
            availabilityEpoch += 1
            sessionToken = currentToken
            authorizationWitness = null
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
        if (!foreground) {
            foreground = true
            invalidateOperationalAvailability()
        }
        if (!_uiState.value.busy) refresh()
    }

    fun onPause() {
        foreground = false
        invalidateOperationalAvailability()
    }

    private fun invalidateOperationalAvailability() {
        availabilityEpoch += 1
        _uiState.update { it.copy(operationalAvailability = null,
            authorization = null, authorizationChecked = false,
            confirmationOpen = false, reconciliationConfirmationOpen = false) }
    }

    private fun authorizationContextKey(): String = InstagramPolicies.sessionKey("$apiOrigin|$sessionToken")

    fun pickerSessionKey(): String? {
        if (!synchronizeSession() || !_uiState.value.canEditDraft || jpegSelection != null) return null
        val binding = _uiState.value.connection?.binding ?: return null
        discardJpegSelection()
        val ticket = UUID.randomUUID().toString()
        jpegSelection = JpegSelection(ticket, sessionEpoch, binding)
        _uiState.update { it.copy(jpegSelectionPending = true) }
        return ticket
    }

    fun acceptJpeg(bytes: ByteArray, pickerSessionKey: String) {
        val selection = currentJpegSelection(pickerSessionKey)
        if (selection == null || selection.bytes != null) {
            bytes.fill(0)
            return
        }
        if (!InstagramPolicies.validateJpeg(bytes)) {
            bytes.fill(0)
            showSelectionError(pickerSessionKey, "Escolha uma imagem JPEG de 1080 × 1080 pixels, com até 8 MB.")
            return
        }
        // Receiving local bytes is not authorization to upload. The return from GetContent
        // races ON_RESUME, whose refresh must finish checking the account and durable intent.
        selection.bytes = bytes
        settleJpegSelection()
    }

    private fun currentJpegSelection(ticket: String): JpegSelection? {
        if (!synchronizeSession()) return null
        val selection = jpegSelection?.takeIf { it.ticket == ticket } ?: return null
        if (selection.sessionEpoch != sessionEpoch || selection.binding != _uiState.value.connection?.binding) {
            discardJpegSelection()
            return null
        }
        return selection
    }

    private fun settleJpegSelection() {
        val selection = jpegSelection?.let { currentJpegSelection(it.ticket) } ?: return
        val bytes = selection.bytes ?: return
        if (!foreground || _uiState.value.busy || completedRefreshEpoch != availabilityEpoch ||
            _uiState.value.availability != InstagramAvailability.AVAILABLE) return
        if (!_uiState.value.canEditDraft) {
            discardJpegSelection()
            return
        }
        jpegSelection = null
        _uiState.value.draftJpeg?.fill(0)
        _uiState.update { it.copy(draftJpeg = bytes, jpegSelectionPending = false,
            selectedMediaId = null).withUploadDraftBinding() }
    }

    private fun discardJpegSelection() {
        jpegSelection?.bytes?.fill(0)
        jpegSelection = null
        _uiState.update { it.copy(jpegSelectionPending = false) }
    }

    fun cancelJpegSelection(ticket: String) {
        if (currentJpegSelection(ticket) != null) discardJpegSelection()
    }

    fun cancelPendingJpegSelection() {
        jpegSelection?.let { cancelJpegSelection(it.ticket) }
    }

    fun showSelectionError(ticket: String, message: String = "Não foi possível abrir a imagem selecionada.") {
        if (currentJpegSelection(ticket) == null) return
        discardJpegSelection()
        _uiState.update { it.copy(error = message) }
    }

    fun publicationBrowserUnavailable() {
        if (synchronizeSession()) _uiState.update {
            it.copy(error = "Não foi possível abrir a publicação no navegador.")
        }
    }

    fun updateCaption(caption: String) {
        if (!synchronizeSession() || caption == _uiState.value.draftCaption) return
        if (!_uiState.value.canEditDraft) return
        if (caption.length > 9000) {
            _uiState.update { it.copy(uploadFeedback = "A legenda excede o limite do campo. Revise o texto antes de enviar.") }
            return
        }
        // Editing a draft is not a result event. Keep all evidence of the previous operation.
        _uiState.update { it.copy(draftCaption = caption, selectedMediaId = null).withUploadDraftBinding() }
    }

    private fun InstagramUiState.withUploadDraftBinding(): InstagramUiState {
        val saved = uploadWitness
        val matches = saved != null && saved.binding == connection?.binding && draftJpeg?.let {
            instagramUploadFingerprint(it, draftCaption) == saved.contentFingerprint
        } == true
        return copy(uploadDraftMatches = matches, selectedMediaId = saved?.mediaId?.takeIf { id ->
            matches && saved.phase == InstagramUploadPhase.CONFIRMED && media.any { it.id == id }
        })
    }

    private suspend fun restoreUpload(epoch: Long, connection: InstagramConnection?) {
        if (connection == null) return
        val key = InstagramIntentPolicy.contextKey(apiOrigin, connection.connectionId)
        try {
            var saved = withContext(Dispatchers.IO) { uploadStore.read(key) }
            // A restart/refresh cannot prove whether a previously dispatched request was processed.
            if (saved?.phase in setOf(InstagramUploadPhase.PREPARED, InstagramUploadPhase.IN_FLIGHT)) {
                saved = saved!!.copy(phase = InstagramUploadPhase.UNKNOWN)
                check(withContext(Dispatchers.IO) { uploadStore.update(key, saved) })
            }
            if (!isCurrent(epoch)) return
            _uiState.update { it.copy(uploadWitness = saved, uploadStorageAvailable = true,
                uploadFeedback = when {
                    saved == null -> it.uploadFeedback
                    saved.binding != connection.binding -> "O registro abaixo pertence ao vínculo anterior da conta. Ele foi preservado e não autoriza um novo envio."
                    else -> instagramUploadPhaseLabel(saved)
                }
            ).withUploadDraftBinding() }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            if (isCurrent(epoch)) _uiState.update { it.copy(uploadStorageAvailable = false,
                uploadFeedback = "O registro do envio não pôde ser confirmado. Não reenvie; use Atualizar.") }
        }
    }

    fun refresh() {
        if (!synchronizeSession() || _uiState.value.busy) return
        val epoch = sessionEpoch
        val api = gateway ?: return
        val authorizationKey = authorizationContextKey()
        invalidateOperationalAvailability()
        val expectedAvailabilityEpoch = availabilityEpoch
        _uiState.update { it.copy(busy = true, availability = InstagramAvailability.CHECKING,
            authorizationUrlToOpen = null,
            error = if (it.uploadWitness != null || it.uploadLocalDiagnostic != null) it.error else null,
            message = if (it.uploadWitness != null) it.message else null,
            confirmationOpen = false, reconciliationConfirmationOpen = false) }
        operation = viewModelScope.launch {
            try {
                val witness = withContext(Dispatchers.IO) { authorizationStore.read(authorizationKey) }
                if (!isCurrent(epoch)) return@launch
                authorizationWitness = witness
                _uiState.update { it.copy(authorizationOutcomeUnknown = witness != null) }
                val connectionResult = api.currentSnapshot()
                if (!isCurrent(epoch)) return@launch
                when (val result = connectionResult) {
                    is InstagramResult.Failure -> { failAvailability(result.error); return@launch }
                    is InstagramResult.Success -> {
                        if (!isCurrent(epoch)) return@launch
                        val current = result.value.connection
                        val changed = _uiState.value.connection?.connectionId != current?.connectionId ||
                            _uiState.value.connection?.binding != current?.binding
                        if (changed) discardJpegSelection()
                        if (changed) _uiState.value.draftJpeg?.fill(0)
                        _uiState.update {
                            it.copy(connection = current, availability = InstagramAvailability.AVAILABLE,
                                operationalAvailability = result.value.operationalAvailability.takeIf {
                                    expectedAvailabilityEpoch == availabilityEpoch && foreground },
                                authorizationStatus = if (current == null && witness == null)
                                    null else it.authorizationStatus,
                                selectedMediaId = if (changed) null else it.selectedMediaId,
                                draftJpeg = if (changed) null else it.draftJpeg,
                                draftCaption = if (changed) "" else it.draftCaption,
                                intent = if (changed) null else it.intent,
                                uploadWitness = if (changed) null else it.uploadWitness,
                                uploadDraftMatches = if (changed) false else it.uploadDraftMatches,
                                uploadFeedback = if (changed) null else it.uploadFeedback,
                                uploadLocalDiagnostic = if (changed) null else it.uploadLocalDiagnostic,
                                error = if (changed) null else it.error,
                                message = if (changed) null else it.message)
                        }
                    }
                }
                val connection = _uiState.value.connection
                restoreUpload(epoch, connection)
                if (!isCurrent(epoch)) return@launch
                val authorizationConnectionId = connection?.connectionId ?: witness?.connectionId ?: witness?.previousConnectionId
                if (authorizationConnectionId != null) {
                    when (val result = api.authorizationStatus(authorizationConnectionId)) {
                        is InstagramResult.Success -> if (isCurrent(epoch)) {
                            val observed = result.value
                            if (observed.connectionId != authorizationConnectionId ||
                                (connection != null && observed.connectionId != connection.connectionId) ||
                                (witness != null && !witness.matches(observed))) {
                                _uiState.update { it.copy(authorizationChecked = false,
                                    message = AUTHORIZATION_UNKNOWN) }
                            } else {
                                if (witness != null) {
                                    val terminal = observed.status in setOf("authorization_completed", "authorization_expired",
                                        "authorization_cancelled", "authorization_failed")
                                    val identified = witness.copy(connectionId = observed.connectionId, expiresAt = observed.expiresAt)
                                    val stored = withContext(Dispatchers.IO) {
                                        if (terminal) authorizationStore.clear(authorizationKey, witness.id)
                                        else authorizationStore.update(authorizationKey, identified)
                                    }
                                    if (!isCurrent(epoch)) return@launch
                                    check(stored) { "Authorization witness not confirmed" }
                                    authorizationWitness = if (terminal) null else identified
                                }
                                _uiState.update { it.copy(authorization = observed, authorizationStatus = observed.status,
                                    authorizationChecked = expectedAvailabilityEpoch == availabilityEpoch && foreground,
                                    authorizationOutcomeUnknown = authorizationWitness != null) }
                            }
                        }
                        // Failure/404 is not proof that an earlier POST has expired or was cancelled.
                        is InstagramResult.Failure -> if (isCurrent(epoch)) {
                            _uiState.update { it.copy(authorizationChecked = false, message = AUTHORIZATION_UNKNOWN) }
                        }
                    }
                } else if (witness == null) {
                    _uiState.update { it.copy(authorization = null, authorizationStatus = null,
                        authorizationChecked = expectedAvailabilityEpoch == availabilityEpoch && foreground,
                        authorizationOutcomeUnknown = false) }
                } else {
                    _uiState.update { it.copy(authorizationStatus = "authorization_pending", message = AUTHORIZATION_UNKNOWN) }
                }
                if (!isCurrent(epoch)) return@launch
                when (val result = api.media()) {
                    is InstagramResult.Success -> if (isCurrent(epoch)) _uiState.update {
                        it.copy(media = result.value).withUploadDraftBinding()
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
                    } else if (saved?.binding != null) {
                        when (val result = api.publicationIntent(saved.clientRequestId)) {
                            is InstagramResult.Success -> if (isCurrent(epoch)) {
                                val publication = result.value
                                val identified = publication?.let { InstagramIntentPolicy.identify(saved, it) }
                                if (identified != null) observePublication(contextKey, identified, publication)
                                else _uiState.update { it.copy(message = UNKNOWN_RESULT) }
                            }
                            is InstagramResult.Failure -> if (isCurrent(epoch)) _uiState.update { it.copy(message = UNKNOWN_RESULT) }
                        }
                    }
                }
                if (isCurrent(epoch) && expectedAvailabilityEpoch == availabilityEpoch && foreground) {
                    completedRefreshEpoch = expectedAvailabilityEpoch
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (isCurrent(epoch)) _uiState.update {
                    it.copy(storageAvailable = false, authorizationChecked = false,
                        error = "Não foi possível confirmar os registros locais. As novas ações permanecem bloqueadas; use Atualizar.")
                }
            } finally {
                if (isCurrent(epoch)) {
                    _uiState.update { it.copy(busy = false) }
                    settleJpegSelection()
                }
            }
        }
    }

    private fun failAvailability(error: InstagramError) {
        _uiState.update { it.copy(
            availability = if (error == InstagramError.SESSION_REQUIRED) InstagramAvailability.SESSION_REQUIRED else InstagramAvailability.UNAVAILABLE,
            operationalAvailability = null, authorization = null, authorizationChecked = false,
            historyLoaded = false, freshPublicationAvailable = false, confirmationOpen = false, error = error.message
        ) }
    }

    fun connect() {
        if (!synchronizeSession() || !_uiState.value.canAuthorize) return
        val epoch = sessionEpoch
        val api = gateway ?: return
        val current = _uiState.value
        val purpose = current.authorizationPurpose ?: return
        val authorizationKey = authorizationContextKey()
        val witness = InstagramAuthorizationWitness(UUID.randomUUID().toString(), purpose,
            current.connection?.connectionId, current.authorization?.expiresAt)
        _uiState.update { it.copy(busy = true, authorization = null, authorizationChecked = false,
            authorizationOutcomeUnknown = true, authorizationUrlToOpen = null,
            authorizationStatus = "authorization_pending", error = null, message = null) }
        operation = viewModelScope.launch {
            try {
                // Persist only non-secret metadata before the sole POST. A lost response or
                // process death must not erase uncertainty and enable a duplicate request.
                val stored = withContext(Dispatchers.IO) { authorizationStore.create(authorizationKey, witness) }
                if (!isCurrent(epoch)) return@launch
                check(stored) { "Authorization witness not persisted" }
                authorizationWitness = witness
                val result = api.authorize(purpose)
                if (!isCurrent(epoch)) return@launch
                when (result) {
                    is InstagramResult.Success -> {
                        if (!InstagramPolicies.isOfficialAuthorizationUrl(result.value.authorizationUrl)) {
                            _uiState.update { it.copy(error = "O endereço de autorização não pôde ser confirmado.") }
                            return@launch
                        }
                        val identified = witness.copy(connectionId = result.value.connectionId, expiresAt = result.value.expiresAt)
                        val identifiedStored = withContext(Dispatchers.IO) { authorizationStore.update(authorizationKey, identified) }
                        if (!isCurrent(epoch)) return@launch
                        check(identifiedStored) { "Authorization response not persisted" }
                        authorizationWitness = identified
                        _uiState.update { it.copy(authorizationStatus = "authorization_pending",
                            authorizationUrlToOpen = result.value.authorizationUrl,
                            message = "Conclua a autorização no Instagram e volte ao aplicativo para consultar o resultado.") }
                    }
                    is InstagramResult.Failure -> {
                        if (result.error == InstagramError.UNAVAILABLE || result.error == InstagramError.SESSION_REQUIRED) {
                            failAvailability(result.error)
                        } else _uiState.update { it.copy(error = result.error.message, message = AUTHORIZATION_UNKNOWN) }
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (isCurrent(epoch)) _uiState.update { it.copy(authorizationStatus = "authorization_pending",
                    authorizationChecked = false, error = AUTHORIZATION_UNKNOWN) }
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
        if (!synchronizeSession()) {
            showUploadBlock(InstagramError.SESSION_REQUIRED.message, "local_session_required")
            return
        }
        // Keep the original operation/progress visible on a duplicate callback.
        if (_uiState.value.busy) return
        _uiState.value.uploadBlockReason?.let { showUploadBlock(it); return }
        val epoch = sessionEpoch
        val expectedAvailabilityEpoch = availabilityEpoch
        val api = gateway ?: run { showUploadBlock(InstagramError.UNAVAILABLE.message); return }
        val current = _uiState.value
        val binding = current.connection?.binding ?: run {
            showUploadBlock("A identidade da conta não foi confirmada. Use Atualizar."); return
        }
        val jpeg = current.draftJpeg?.copyOf() ?: run {
            showUploadBlock("Escolha uma imagem JPEG antes de enviar."); return
        }
        if (!InstagramPolicies.validateJpeg(jpeg)) {
            jpeg.fill(0)
            showUploadBlock("Escolha uma imagem JPEG de 1080 × 1080 pixels, com até 8 MB.", "local_invalid_input")
            return
        }
        val caption = current.draftCaption // Never silently change the approved draft.
        val contextKey = InstagramIntentPolicy.contextKey(apiOrigin, binding.connectionId)
        var record = InstagramUploadWitness(UUID.randomUUID().toString(),
            instagramUploadFingerprint(jpeg, caption), binding, System.currentTimeMillis())
        _uiState.update { it.copy(busy = true, error = null, message = null,
            uploadFeedback = instagramUploadPhaseLabel(record), uploadLocalDiagnostic = null) }
        operation = viewModelScope.launch {
            try {
                val stored = withContext(Dispatchers.IO) {
                    val previous = uploadStore.read(contextKey)
                    if (previous != null && (!InstagramUploadWitnessPolicy.isResolved(previous) ||
                            previous.binding != binding || (previous.phase == InstagramUploadPhase.CONFIRMED &&
                            previous.contentFingerprint == record.contentFingerprint))) false
                    else if (previous != null && !uploadStore.clearResolved(contextKey, previous.id)) false
                    else uploadStore.create(contextKey, record)
                }
                if (!isCurrent(epoch)) return@launch
                check(stored)
                _uiState.update { it.copy(uploadWitness = record).withUploadDraftBinding() }
                if (!foreground || expectedAvailabilityEpoch != availabilityEpoch ||
                    _uiState.value.connection?.binding != binding ||
                    _uiState.value.operationalAvailability?.publicationAllowed != true) {
                    val blocked = record.copy(phase = InstagramUploadPhase.REJECTED,
                        diagnostic = localUploadDiagnostic("local_unavailable"))
                    persistUploadResult(contextKey, blocked, epoch)
                    showUploadBlock("A disponibilidade mudou antes da requisição. Use Atualizar.")
                    return@launch
                }
                record = record.copy(phase = InstagramUploadPhase.IN_FLIGHT,
                    diagnostic = InstagramRequestDiagnostic(true, false, null, "request_started",
                        InstagramRequestStage.REQUEST_INITIATED, record.startedAtEpochMillis, 0, true))
                check(withContext(Dispatchers.IO) { uploadStore.update(contextKey, record) })
                if (!isCurrent(epoch)) return@launch
                _uiState.update { it.copy(uploadWitness = record,
                    uploadFeedback = instagramUploadPhaseLabel(record)).withUploadDraftBinding() }
                // A foreground/account change while committing still must not dispatch a request.
                if (!foreground || expectedAvailabilityEpoch != availabilityEpoch ||
                    _uiState.value.connection?.binding != binding) {
                    record = record.copy(phase = InstagramUploadPhase.REJECTED,
                        diagnostic = localUploadDiagnostic("local_unavailable"))
                    persistUploadResult(contextKey, record, epoch)
                    showUploadBlock("A disponibilidade mudou antes da requisição. Use Atualizar.")
                    return@launch
                }
                val result = api.uploadMedia(jpeg, caption)
                var outcome = when (result) {
                    is InstagramResult.Success -> record.copy(phase = InstagramUploadPhase.CONFIRMED,
                        mediaId = result.value.id, diagnostic = result.diagnostic)
                    is InstagramResult.Failure -> record.copy(phase =
                        if (result.diagnostic?.outcomeUnknown == false) InstagramUploadPhase.REJECTED
                        else InstagramUploadPhase.UNKNOWN, diagnostic = result.diagnostic ?: record.diagnostic)
                }
                // The gateway contract accepts generic media IDs elsewhere. This local ledger
                // only accepts the upload endpoint's known resource format, never arbitrary text.
                if (!InstagramUploadWitnessPolicy.valid(outcome)) {
                    val diagnostic = result.let {
                        when (it) {
                            is InstagramResult.Success -> it.diagnostic
                            is InstagramResult.Failure -> it.diagnostic
                        }
                    }
                    outcome = record.copy(phase = InstagramUploadPhase.UNKNOWN,
                        diagnostic = diagnostic?.takeIf { it.requestStarted }?.copy(
                            code = "response_invalid", stage = InstagramRequestStage.INVALID_RESPONSE, outcomeUnknown = true)
                            ?: record.diagnostic)
                }
                val persisted = persistUploadResult(contextKey, outcome, epoch)
                record = outcome
                if (!isCurrent(epoch) || _uiState.value.uploadWitness?.id != record.id ||
                    _uiState.value.connection?.binding != binding) return@launch
                if (!persisted) return@launch
                when (result) {
                    is InstagramResult.Success -> {
                        if (persisted && outcome.phase == InstagramUploadPhase.CONFIRMED) {
                            _uiState.update {
                                it.copy(media = listOf(result.value) + it.media.filterNot { media -> media.id == result.value.id },
                                    message = "Imagem enviada. Revise abaixo a prévia da legenda antes de publicar."
                                ).withUploadDraftBinding()
                            }
                        } else if (outcome.phase == InstagramUploadPhase.UNKNOWN) {
                            _uiState.update { it.copy(error = InstagramError.INVALID_RESPONSE.message) }
                        }
                    }
                    is InstagramResult.Failure -> _uiState.update { it.copy(error = result.error.message,
                        uploadFeedback = if (outcome.phase == InstagramUploadPhase.UNKNOWN)
                            "${result.error.message} ${instagramUploadPhaseLabel(outcome)}" else result.error.message) }
                }
            } catch (cancelled: CancellationException) {
                preserveUnfinishedUpload(contextKey, record, epoch)
                throw cancelled
            } catch (_: Exception) {
                preserveUnfinishedUpload(contextKey, record, epoch)
                if (isCurrent(epoch)) _uiState.update { it.copy(uploadStorageAvailable = false,
                    error = "Não foi possível confirmar o envio ou seu registro. Não reenvie; use Atualizar.",
                    uploadFeedback = "Não foi possível confirmar o envio ou seu registro. Não reenvie; use Atualizar.") }
            } finally {
                jpeg.fill(0)
                if (isCurrent(epoch)) _uiState.update { it.copy(busy = false) }
            }
        }
    }

    private fun localUploadDiagnostic(code: String) = InstagramRequestDiagnostic(false, false, null,
        code, InstagramRequestStage.LOCAL_VALIDATION, System.currentTimeMillis(), 0, false)

    private fun showUploadBlock(reason: String, code: String = "local_unavailable") {
        _uiState.update { it.copy(error = reason, uploadFeedback = reason,
            uploadLocalDiagnostic = localUploadDiagnostic(code)) }
    }

    private suspend fun persistUploadResult(key: String, result: InstagramUploadWitness, epoch: Long): Boolean {
        val saved = withContext(NonCancellable + Dispatchers.IO) { uploadStore.update(key, result) }
        // A refused CAS is not permission to overwrite a canonical/terminal result in the UI.
        val canonical = if (saved) result else withContext(NonCancellable + Dispatchers.IO) {
            runCatching { uploadStore.read(key) }.getOrNull()
        }
        if (isCurrent(epoch) && _uiState.value.uploadWitness?.id == result.id) {
            _uiState.update {
                val known = canonical ?: it.uploadWitness
                val visible = if (!saved && known != null && !InstagramUploadWitnessPolicy.isResolved(known))
                    known.copy(phase = InstagramUploadPhase.UNKNOWN) else known
                it.copy(uploadWitness = visible, uploadStorageAvailable = saved,
                uploadFeedback = if (saved) instagramUploadPhaseLabel(result)
                    else "O resultado não pôde ser salvo. O registro foi preservado; não reenvie.",
                error = if (saved) it.error else "O resultado não pôde ser salvo. Não reenvie."
            ).withUploadDraftBinding() }
        }
        return saved
    }

    private suspend fun preserveUnfinishedUpload(key: String, record: InstagramUploadWitness, epoch: Long) {
        try {
            val preserved = withContext(NonCancellable + Dispatchers.IO) {
                val existing = uploadStore.read(key)?.takeIf { it.id == record.id } ?: return@withContext null
                if (InstagramUploadWitnessPolicy.isResolved(existing)) existing else {
                    val unknown = existing.copy(phase = InstagramUploadPhase.UNKNOWN)
                    check(uploadStore.update(key, unknown))
                    unknown
                }
            }
            if (preserved != null && isCurrent(epoch) && _uiState.value.uploadWitness?.id == record.id) {
                _uiState.update { it.copy(uploadWitness = preserved,
                    uploadFeedback = instagramUploadPhaseLabel(preserved)).withUploadDraftBinding() }
            }
        } catch (_: Exception) {
            if (isCurrent(epoch)) _uiState.update {
                val known = it.uploadWitness
                it.copy(uploadStorageAvailable = false, uploadWitness =
                    if (known != null && !InstagramUploadWitnessPolicy.isResolved(known))
                        known.copy(phase = InstagramUploadPhase.UNKNOWN) else known)
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
        val binding = intent.binding ?: return
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
                val result = api.publish(intent.mediaId, intent.clientRequestId, binding)
                if (!isCurrent(epoch)) return@launch
                when (result) {
                    is InstagramResult.Success -> {
                        val publication = result.value
                        if (publication.connectionId != intent.connectionId || publication.mediaId != intent.mediaId ||
                            publication.binding != binding) {
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
        val binding = intent.binding ?: return
        val epoch = sessionEpoch
        invalidateOperationalAvailability()
        val expectedAvailabilityEpoch = availabilityEpoch
        val api = gateway ?: return
        val contextKey = InstagramIntentPolicy.contextKey(apiOrigin, intent.connectionId)
        _uiState.update { it.copy(busy = true, reconciliationConfirmationOpen = false, error = null, message = null) }
        operation = viewModelScope.launch {
            try {
                // Advisory refresh for honest UI only. The POST still carries the original
                // stable binding, which the server must check atomically to close this race.
                val currentConnection = api.currentSnapshot()
                if (!isCurrent(epoch) || expectedAvailabilityEpoch != availabilityEpoch || !foreground) return@launch
                when (currentConnection) {
                    is InstagramResult.Failure -> {
                        failAvailability(currentConnection.error)
                        return@launch
                    }
                    is InstagramResult.Success -> {
                        val current = currentConnection.value.connection
                        val operational = currentConnection.value.operationalAvailability
                        _uiState.update { it.copy(connection = current, operationalAvailability = operational) }
                        if (operational?.publicationAllowed != true) {
                            _uiState.update { it.copy(error = "A disponibilidade para continuar o envio não foi confirmada. Atualize a consulta.") }
                            return@launch
                        }
                        if (current?.canPublish != true || !InstagramIntentPolicy.matchesAccount(intent, current)) {
                            _uiState.update { it.copy(error = "A conta conectada mudou ou não está pronta. A continuação desta publicação permanece bloqueada.") }
                            return@launch
                        }
                    }
                }
                when (val result = api.reconcile(publicationId, binding)) {
                    is InstagramResult.Success -> if (isCurrent(epoch)) {
                        if (InstagramIntentPolicy.observe(intent, result.value) == null) {
                            _uiState.update { it.copy(error = UNKNOWN_RESULT) }
                        } else observePublication(contextKey, intent, result.value)
                    }
                    is InstagramResult.Failure -> if (isCurrent(epoch)) {
                        if (result.error == InstagramError.BINDING_CONFLICT) failAvailability(result.error)
                        else _uiState.update { it.copy(error = UNKNOWN_RESULT) }
                    }
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
                        selectedMediaId = null, uploadDraftMatches = false, message = null, error = null) }
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
        discardJpegSelection()
        _uiState.value.draftJpeg?.fill(0)
        super.onCleared()
    }

    private companion object {
        const val AUTHORIZATION_UNKNOWN = "A autorização ainda não foi confirmada. Use Atualizar para consultar a mesma tentativa; nenhuma nova autorização será iniciada automaticamente."
        const val UNKNOWN_RESULT = "O resultado ainda não foi confirmado. Consulte o histórico; nenhum novo envio será feito enquanto esta publicação estiver pendente."
    }
}

class InstagramViewModelFactory(
    private val tokenProvider: () -> String,
    private val intentStore: InstagramPublicationIntentStore,
    private val authorizationStore: InstagramAuthorizationWitnessStore,
    private val uploadStore: InstagramUploadWitnessStore
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        require(modelClass.isAssignableFrom(InstagramViewModel::class.java))
        @Suppress("UNCHECKED_CAST")
        return InstagramViewModel(tokenProvider, intentStore, authorizationStore = authorizationStore,
            uploadStore = uploadStore) as T
    }
}
