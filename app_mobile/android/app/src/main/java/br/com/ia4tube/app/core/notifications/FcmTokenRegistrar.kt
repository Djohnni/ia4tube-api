package br.com.ia4tube.app.core.notifications

import android.content.Context
import br.com.ia4tube.app.core.session.SessionStore
import br.com.ia4tube.app.data.api.FcmDeviceApiClient
import br.com.ia4tube.app.data.api.FcmDeviceBackend
import br.com.ia4tube.app.data.models.ApiResult
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class FcmTokenRegistrar(
    context: Context,
    sessionStore: SessionStore,
    backend: FcmDeviceBackend = FcmDeviceApiClient()
) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val coordinator = FcmRegistrationCoordinator(
        backend = backend,
        store = FcmSecureStateStore(context),
        tokenProvider = FirebaseFcmTokenProvider(context),
        authTokenProvider = sessionStore::getToken
    )

    fun syncCurrentToken() {
        scope.launch {
            OPERATION_MUTEX.withLock {
                coordinator.synchronizeCurrentToken()
            }
        }
    }

    suspend fun syncCurrentTokenNow(): ApiResult<Unit> {
        return OPERATION_MUTEX.withLock {
            coordinator.synchronizeCurrentToken()
        }
    }

    fun syncToken(token: String) {
        scope.launch {
            OPERATION_MUTEX.withLock {
                coordinator.onNewToken(token)
            }
        }
    }

    suspend fun prepareForAccountChange(newAuthToken: String) {
        beginDisplayBlock()
        try {
            OPERATION_MUTEX.withLock {
                coordinator.prepareForAccountChange(newAuthToken)
            }
        } finally {
            endDisplayBlock()
        }
    }

    suspend fun deactivateForLogout() {
        beginDisplayBlock()
        try {
            OPERATION_MUTEX.withLock {
                coordinator.deactivateForLogout()
            }
        } finally {
            endDisplayBlock()
        }
    }

    suspend fun grantConsentAndActivate(): ApiResult<Unit> {
        return OPERATION_MUTEX.withLock {
            coordinator.grantConsentAndActivate()
        }
    }

    suspend fun declineConsent() {
        beginDisplayBlock()
        try {
            OPERATION_MUTEX.withLock {
                coordinator.declineConsent()
            }
        } finally {
            endDisplayBlock()
        }
    }

    fun hasConsentDecisionForCurrentAccount(): Boolean {
        return coordinator.hasConsentDecisionForCurrentAccount()
    }

    fun canReceiveNotifications(): Boolean {
        return coordinator.canReceiveNotifications()
    }

    fun hasGrantedConsentForCurrentAccount(): Boolean {
        return coordinator.hasGrantedConsentForCurrentAccount()
    }

    internal fun showArtReadyIfAllowed(payload: ArtReadyNotificationPayload): Boolean {
        return synchronized(DISPLAY_LOCK) {
            if (displayBlockCount > 0) return@synchronized false
            if (!coordinator.canReceiveNotifications()) return@synchronized false
            if (!IA4TubeNotificationHelper.canPost(appContext)) return@synchronized false
            val eventStore = NotificationEventStore(appContext)
            if (!eventStore.markIfNew(payload.eventId)) return@synchronized false
            val shown = IA4TubeNotificationHelper.show(appContext, payload)
            if (!shown) eventStore.forget(payload.eventId)
            shown
        }
    }

    private fun beginDisplayBlock() {
        synchronized(DISPLAY_LOCK) {
            displayBlockCount += 1
            IA4TubeNotificationHelper.cancelAll(appContext)
        }
    }

    private fun endDisplayBlock() {
        synchronized(DISPLAY_LOCK) {
            IA4TubeNotificationHelper.cancelAll(appContext)
            displayBlockCount = (displayBlockCount - 1).coerceAtLeast(0)
        }
    }

    private companion object {
        val OPERATION_MUTEX = Mutex()
        val DISPLAY_LOCK = Any()
        var displayBlockCount = 0
    }
}

private class FirebaseFcmTokenProvider(
    context: Context
) : FcmTokenProvider {
    private val appContext = context.applicationContext

    override fun setAutoInitEnabled(enabled: Boolean) {
        if (!isConfigured()) return
        FirebaseMessaging.getInstance().isAutoInitEnabled = enabled
    }

    override suspend fun getToken(): String {
        check(isConfigured()) { "Firebase nao configurado." }
        return withTimeout(FIREBASE_TASK_TIMEOUT_MS) {
            suspendCancellableCoroutine { continuation ->
                FirebaseMessaging.getInstance().token
                    .addOnSuccessListener { token ->
                        if (continuation.isActive) continuation.resume(token)
                    }
                    .addOnFailureListener { error ->
                        if (continuation.isActive) continuation.resumeWithException(error)
                    }
                }
        }
    }

    override suspend fun deleteToken() {
        if (!isConfigured()) return
        withTimeout(FIREBASE_TASK_TIMEOUT_MS) {
            suspendCancellableCoroutine { continuation ->
                FirebaseMessaging.getInstance().deleteToken()
                    .addOnSuccessListener {
                        if (continuation.isActive) continuation.resume(Unit)
                    }
                    .addOnFailureListener { error ->
                        if (continuation.isActive) continuation.resumeWithException(error)
                    }
                }
        }
    }

    private fun isConfigured(): Boolean {
        return runCatching {
            FirebaseApp.getApps(appContext).isNotEmpty()
        }.getOrDefault(false)
    }

    private companion object {
        const val FIREBASE_TASK_TIMEOUT_MS = 10_000L
    }
}
