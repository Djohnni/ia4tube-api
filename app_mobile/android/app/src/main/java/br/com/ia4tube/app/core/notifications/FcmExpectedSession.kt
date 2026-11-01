package br.com.ia4tube.app.core.notifications

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal fun fcmSessionMatches(expectedAuthToken: String?, currentAuthToken: () -> String): Boolean =
    expectedAuthToken == null || (expectedAuthToken.isNotBlank() && currentAuthToken() == expectedAuthToken)

/** Retains the legacy path when no snapshot is supplied. Never enters another account after waiting. */
internal suspend fun <T> withExpectedFcmSession(
    expectedAuthToken: String?,
    currentAuthToken: () -> String,
    mutex: Mutex,
    stale: () -> T,
    operation: suspend () -> T
): T {
    if (!fcmSessionMatches(expectedAuthToken, currentAuthToken)) return stale()
    return mutex.withLock {
        if (!fcmSessionMatches(expectedAuthToken, currentAuthToken)) stale() else operation()
    }
}
