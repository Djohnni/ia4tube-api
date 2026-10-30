package br.com.ia4tube.app.feature.edit

import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

internal data class EditAvailabilityReply(
    val nonce: String, val accountKey: String, val revision: Long, val requestId: String?,
    val canImage: Boolean?, val canVideo: Boolean?, val validUntilElapsedMs: Long, val loading: Boolean = false,
)

internal class EditAvailabilityViewModel(
    private val loadAvailability: suspend (String) -> EditAvailabilitySnapshot = EditAvailabilityClient()::read,
    private val elapsedMs: () -> Long = SystemClock::elapsedRealtime,
) : ViewModel() {
    var reply by mutableStateOf<EditAvailabilityReply?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    private var accountKey: String? = null
    private var scopeNonce: String? = null
    private var revision = 0L
    private var job: Job? = null
    private var lastStarted: Long? = null
    private var awaitingRequestId: String? = null
    private val seenRequests = linkedSetOf<String>()

    fun synchronizeSession(token: String, nonce: String): Boolean {
        val key = EditCalendarViewModel.tokenKey(token)
        if (accountKey == key && scopeNonce == nonce) return false
        job?.cancel(); job = null
        accountKey = key; scopeNonce = nonce; revision++
        busy = false; reply = null; lastStarted = null; awaitingRequestId = null; seenRequests.clear()
        return true
    }

    fun refresh(token: String, nonce: String, force: Boolean = false, requestId: String? = null) {
        synchronizeSession(token, nonce)
        if (job?.isActive == true && !force) return
        val now = elapsedMs()
        if (!force && lastStarted?.let { now - it in 0..250L } == true) return
        job?.cancel()
        val expectedRevision = ++revision
        val expectedAccount = requireNotNull(accountKey)
        val responseRequestId = requestId ?: awaitingRequestId
        if (requestId != null) awaitingRequestId = requestId
        lastStarted = now
        reply = EditAvailabilityReply(nonce, expectedAccount, expectedRevision, responseRequestId, null, null, 0, loading = token.isNotBlank())
        if (token.isBlank()) { busy = false; return }
        busy = true
        job = viewModelScope.launch {
            try {
                val value = loadAvailability(token)
                val lifetime = value.validUntil - value.observedAt
                val remaining = if (lifetime in 1..30_000L) (lifetime - (elapsedMs() - now).coerceAtLeast(0)).coerceAtLeast(0) else 0
                if (matches(nonce, expectedAccount, expectedRevision)) reply = EditAvailabilityReply(
                    nonce, expectedAccount, expectedRevision, responseRequestId,
                    value.canImage.takeIf { remaining > 0 }, value.canVideo.takeIf { remaining > 0 }, elapsedMs() + remaining,
                )
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                if (matches(nonce, expectedAccount, expectedRevision)) reply = EditAvailabilityReply(
                    nonce, expectedAccount, expectedRevision, responseRequestId, null, null, 0,
                )
            } finally { if (matches(nonce, expectedAccount, expectedRevision)) busy = false }
        }
    }

    fun request(requestId: String, token: String, nonce: String) {
        if (!EditAvailabilityPolicy.validRequestId(requestId)) return
        synchronizeSession(token, nonce)
        if (!seenRequests.add(requestId)) return
        if (seenRequests.size > 64) seenRequests.remove(seenRequests.first())
        refresh(token, nonce, force = true, requestId = requestId)
    }

    private fun matches(nonce: String, key: String, version: Long): Boolean =
        scopeNonce == nonce && accountKey == key && revision == version

    fun canDeliver(value: EditAvailabilityReply, currentToken: String, currentNonce: String): Boolean =
        matches(value.nonce, value.accountKey, value.revision) && value.nonce == currentNonce &&
            value.accountKey == EditCalendarViewModel.tokenKey(currentToken)

    fun validForMs(value: EditAvailabilityReply): Long = (value.validUntilElapsedMs - elapsedMs()).coerceIn(0, 30_000L)
    fun delivered(value: EditAvailabilityReply) {
        if (reply === value) {
            reply = null
            if (!value.loading && value.requestId == awaitingRequestId) awaitingRequestId = null
        }
    }
}
