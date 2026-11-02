package br.com.ia4tube.app.feature.edit

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

internal data class EditCalendarReply(
    val requestId: String, val nonce: String, val accountKey: String,
    val ticket: String? = null, val error: String? = null,
)

internal class EditCalendarViewModel(
    private val clientFactory: () -> EditCalendarClient = { EditCalendarClient() },
) : ViewModel() {
    var nonce by mutableStateOf(freshNonce())
        private set
    var schedule by mutableStateOf<EditCalendarSchedule?>(null)
        private set
    var choosingSchedule by mutableStateOf(false)
        private set
    var mediaKind by mutableStateOf<String?>(null)
        private set
    var showDestinations by mutableStateOf(true)
        private set
    var destinationError by mutableStateOf<String?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    var reply by mutableStateOf<EditCalendarReply?>(null)
        private set
    private var accountKey: String? = null
    private var pendingRequest: String? = null
    private var pendingMediaKind: String? = null
    private var job: Job? = null
    private val requestSchedules = mutableMapOf<String, EditCalendarSchedule>()
    private val client by lazy(clientFactory)

    /** Keep only a fingerprint, never a saved token or Activity in this owner. */
    fun synchronizeSession(token: String): Boolean {
        val key = tokenKey(token)
        if (accountKey == key) return false
        val changed = accountKey != null
        accountKey = key
        if (changed) {
            job?.cancel(); job = null
            nonce = freshNonce()
            schedule = null
            choosingSchedule = false
            pendingRequest = null
            pendingMediaKind = null
            mediaKind = null
            showDestinations = true
            destinationError = null
            busy = false
            reply = null
            requestSchedules.clear()
        }
        return changed
    }

    fun openSchedule() {
        if (!busy) { mediaKind = null; showDestinations = true; destinationError = null; choosingSchedule = true }
    }

    fun cancelSchedule() {
        choosingSchedule = false
        pendingRequest?.let { respond(it, error = "cancelled") }
        pendingRequest = null
        pendingMediaKind = null
        destinationError = null
    }

    fun chooseSchedule(value: EditCalendarSchedule, token: String) {
        if (synchronizeSession(token) || !value.isFuture() || value.destination !in setOf("reel", "feed", "story", "both")) return
        schedule = value
        destinationError = null
        choosingSchedule = false
        pendingRequest?.let { requestId ->
            val kind = pendingMediaKind
            pendingRequest = null; pendingMediaKind = null
            request(requestId, token, kind)
        }
    }

    fun request(requestId: String, token: String, requestedMediaKind: String? = null) {
        if (!EditCalendarPolicy.validRequestId(requestId) ||
            (requestedMediaKind != null && requestedMediaKind !in setOf("image", "video"))) return
        if (synchronizeSession(token)) return
        if (token.isBlank()) { respond(requestId, error = "auth_required"); return }
        if (job?.isActive == true) return
        val value = requestSchedules[requestId] ?: schedule?.let {
            // A v1 document keeps its historical Feed/Reels intent. Typed pages
            // opt in to the new placement choice; retries use the frozen value.
            it.copy(destination = if (requestedMediaKind == null) "reel" else
                it.destination.takeIf { chosen -> chosen in setOf("feed", "story", "both") } ?: "both")
        }
        if (requestSchedules.containsKey(requestId) && value?.isFuture() != true) {
            // An uncertain retry retains its original intent instead of
            // silently scheduling the same order for a different time.
            respond(requestId, error = "schedule_expired")
            return
        }
        if (value == null || !value.isFuture()) {
            pendingRequest = requestId
            pendingMediaKind = requestedMediaKind
            mediaKind = requestedMediaKind
            showDestinations = requestedMediaKind != null
            choosingSchedule = true
            return
        }
        // A selection belongs to one new order. An uncertain retry keeps its
        // frozen schedule without consuming a later manual selection.
        if (!requestSchedules.containsKey(requestId)) schedule = null
        requestSchedules[requestId] = value
        val requestNonce = nonce
        val requestAccount = requireNotNull(accountKey)
        reply = null
        busy = true
        job = viewModelScope.launch {
            try {
                val result = client.create(token, requestId, value)
                if (nonce == requestNonce && accountKey == requestAccount) {
                    reply = EditCalendarReply(requestId, requestNonce, requestAccount, ticket = result.ticket)
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: EditCalendarException) {
                if (nonce == requestNonce && accountKey == requestAccount) {
                    if (error.code == "edit_calendar_story_business_required") {
                        // This explicit rejection occurs before any context or quota
                        // is created. Reopen the same intent for a user correction.
                        requestSchedules.remove(requestId)
                        schedule = value
                        pendingRequest = requestId
                        pendingMediaKind = requestedMediaKind
                        mediaKind = requestedMediaKind
                        showDestinations = true
                        destinationError = "Story exige uma conta Instagram Empresa. Desmarque Story para continuar."
                        choosingSchedule = true
                    } else respond(requestId, error = error.code)
                }
            } finally {
                if (nonce == requestNonce && accountKey == requestAccount) busy = false
            }
        }
    }

    fun canDeliver(value: EditCalendarReply, currentToken: String): Boolean =
        value.nonce == nonce && value.accountKey == accountKey && value.accountKey == tokenKey(currentToken)

    fun delivered(value: EditCalendarReply) { if (reply === value) reply = null }

    private fun respond(requestId: String, error: String) {
        reply = EditCalendarReply(requestId, nonce, requireNotNull(accountKey), error = error)
    }

    companion object {
        private fun freshNonce(): String = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })
        internal fun tokenKey(token: String): String = MessageDigest.getInstance("SHA-256")
            .digest(token.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}
