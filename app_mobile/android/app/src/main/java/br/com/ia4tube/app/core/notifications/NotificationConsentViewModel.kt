package br.com.ia4tube.app.core.notifications

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.data.models.ApiResult
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal data class NotificationConsentUiState(
    val ownerKey: String = "",
    val showPrompt: Boolean = false,
    val message: String? = null,
    val messageId: String? = null
)

/** Only these hashes and the decision ID cross saved-instance-state. No JWT or FCM token. */
internal data class NotificationPermissionRequest(
    val ownerKey: String,
    val sessionKey: String,
    val decisionId: String
) {
    fun encode(): String = listOf("1", ownerKey, sessionKey, decisionId).joinToString("|")
    companion object {
        fun decode(value: String?): NotificationPermissionRequest? = runCatching {
            val fields = value?.split('|') ?: return null
            if (fields.size != 4 || fields[0] != "1") return null
            if (!fields[1].matches(Regex("[a-f0-9]{64}")) || !fields[2].matches(Regex("[a-f0-9]{64}"))) return null
            if (UUID.fromString(fields[3]).toString() != fields[3]) return null
            NotificationPermissionRequest(fields[1], fields[2], fields[3])
        }.getOrNull()
    }
}

/** UI orchestration only; registration, cleanup and encrypted consent remain in the registrar. */
internal class NotificationConsentViewModel(
    private val currentToken: () -> String,
    private val hasConsentDecision: () -> Boolean,
    private val activate: suspend (String) -> ApiResult<Unit>,
    private val decline: suspend (String) -> Unit,
    private val worker: CoroutineDispatcher = Dispatchers.IO
) : ViewModel() {
    private val mutable = MutableStateFlow(NotificationConsentUiState())
    val state = mutable.asStateFlow()
    private var account = ""
    private var session = ""
    private var epoch = 0L
    private var readVersion = 0L
    private var decisionRead: Job? = null
    private val handledOwners = mutableSetOf<String>()
    private val operations = mutableMapOf<String, String>()
    private val completedPermissions = mutableSetOf<String>()
    private var pendingPermission: NotificationPermissionRequest? = null
    private var pendingEpoch = -1L

    fun refresh(savedPermission: String? = null) {
        synchronize()
        restorePending(savedPermission)
        val token = currentToken()
        val expectedOwner = account; val expectedSession = session; val expectedEpoch = epoch
        val version = ++readVersion
        decisionRead?.cancel()
        if (account.isBlank()) { mutable.value = NotificationConsentUiState(); return }
        decisionRead = viewModelScope.launch {
            val decided = try { withContext(worker) { hasConsentDecision() } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { true } // A failed consent read must not impose another modal.
            if (matches(token, expectedOwner, expectedSession, expectedEpoch) && readVersion == version) {
                if (decided) handledOwners += expectedOwner
                mutable.updateForOwner(expectedOwner) {
                    it.copy(showPrompt = !decided && expectedOwner !in handledOwners &&
                        expectedOwner !in operations && pendingPermission == null)
                }
            }
        }
    }

    /** Returns an Android request only for the first current-owner click. Prompt closes first. */
    fun enable(needsSystemPermission: Boolean): NotificationPermissionRequest? {
        val choice = takeChoice() ?: return null
        if (!needsSystemPermission) { startOperation(choice, grant = true); return null }
        val request = NotificationPermissionRequest(choice.owner, choice.session, choice.id)
        pendingPermission = request; pendingEpoch = choice.epoch
        return request
    }

    fun dismiss() {
        val choice = takeChoice() ?: return
        startOperation(choice, grant = false)
    }

    fun permissionResult(savedRequest: String?, granted: Boolean) {
        synchronize()
        val request = NotificationPermissionRequest.decode(savedRequest) ?: return
        if (request.decisionId in completedPermissions) return
        if (pendingPermission != request) return
        val expectedEpoch = pendingEpoch
        pendingPermission = null; pendingEpoch = -1
        completedPermissions += request.decisionId
        val token = currentToken()
        if (!matches(token, request.ownerKey, request.sessionKey, expectedEpoch)) {
            handledOwners.remove(request.ownerKey)
            refresh()
            return
        }
        startOperation(Choice(token, request.ownerKey, request.sessionKey, expectedEpoch, request.decisionId), granted)
    }

    fun permissionLaunchFailed(request: NotificationPermissionRequest) {
        if (pendingPermission != request) return
        val expectedEpoch = pendingEpoch
        pendingPermission = null; pendingEpoch = -1; completedPermissions += request.decisionId
        if (matches(currentToken(), request.ownerKey, request.sessionKey, expectedEpoch)) {
            mutable.value = NotificationConsentUiState(account, message = PERMISSION_FAILURE, messageId = request.decisionId)
        }
    }

    fun isDecisionInFlight(token: String): Boolean {
        val owner = ownerHash(token)
        return owner in operations || pendingPermission != null
    }

    fun isCurrentOwner(owner: String): Boolean = owner.isNotBlank() && account == owner && ownerHash(currentToken()) == owner

    fun acknowledgeExistingDecision(expectedToken: String) {
        if (currentToken() != expectedToken) return
        synchronize()
        if (account.isNotBlank()) {
            handledOwners += account
            mutable.value = mutable.value.copy(showPrompt = false)
        }
    }

    fun clearMessage(id: String?) {
        if (mutable.value.messageId == id) mutable.value = mutable.value.copy(message = null, messageId = null)
    }

    private data class Choice(val token: String, val owner: String, val session: String, val epoch: Long, val id: String)

    private fun takeChoice(): Choice? {
        val token = currentToken()
        if (ownerHash(token) != account || sessionKey(token) != session) { refresh(); return null }
        if (!mutable.value.showPrompt || account.isBlank() || account in handledOwners ||
            account in operations || pendingPermission != null) return null
        val choice = Choice(token, account, session, epoch, UUID.randomUUID().toString())
        handledOwners += account
        // Synchronous: neither a launcher nor a Firebase/backend coroutine runs before this.
        mutable.value = NotificationConsentUiState(account)
        return choice
    }

    private fun startOperation(choice: Choice, grant: Boolean) {
        if (choice.owner in operations) return
        operations[choice.owner] = choice.id
        viewModelScope.launch {
            val failed = try {
                withContext(worker) {
                    if (grant) activate(choice.token) !is ApiResult.Success
                    else { decline(choice.token); false }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { true }
            finally { if (operations[choice.owner] == choice.id) operations.remove(choice.owner) }
            if (matches(choice.token, choice.owner, choice.session, choice.epoch)) {
                mutable.value = NotificationConsentUiState(choice.owner,
                    message = if (failed) ACTIVATION_FAILURE else null,
                    messageId = choice.id.takeIf { failed })
            }
        }
    }

    private fun restorePending(encoded: String?) {
        if (pendingPermission != null) return
        val request = NotificationPermissionRequest.decode(encoded) ?: return
        if (request.decisionId in completedPermissions) return
        pendingPermission = request
        pendingEpoch = if (account == request.ownerKey && session == request.sessionKey) epoch else -1L
        handledOwners += request.ownerKey
        mutable.value = mutable.value.copy(showPrompt = false)
    }

    private fun synchronize() {
        val token = currentToken()
        val nextOwner = ownerHash(token); val nextSession = sessionKey(token)
        if (nextOwner == account && nextSession == session) return
        account = nextOwner; session = nextSession; epoch++
        mutable.value = NotificationConsentUiState(account)
    }

    private fun matches(token: String, owner: String, key: String, version: Long): Boolean =
        account == owner && session == key && epoch == version && currentToken() == token

    private inline fun MutableStateFlow<NotificationConsentUiState>.updateForOwner(
        owner: String, transform: (NotificationConsentUiState) -> NotificationConsentUiState
    ) { if (value.ownerKey == owner) value = transform(value) }

    companion object {
        fun sessionKey(token: String): String = if (token.isBlank()) "" else
            MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        private const val ACTIVATION_FAILURE = "Não foi possível atualizar os avisos agora. Você pode acompanhar suas artes pelo app."
        private const val PERMISSION_FAILURE = "Não foi possível abrir a permissão. Você pode acompanhar suas artes pelo app."
    }
}

internal class NotificationConsentViewModelFactory(
    private val currentToken: () -> String,
    private val registrar: FcmTokenRegistrar,
    private val prepareChannel: () -> Unit
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return NotificationConsentViewModel(currentToken, registrar::hasConsentDecisionForCurrentAccount,
            activate = { token -> prepareChannel(); registrar.grantConsentAndActivate(expectedAuthToken = token) },
            decline = { token -> registrar.declineConsent(expectedAuthToken = token) }) as T
    }
}
