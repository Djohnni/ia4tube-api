package br.com.ia4tube.app.feature.calendar.imports

/** Finite foreground media waits; these do not authorize retries or another upload. */
internal object ImportMediaNetworkPolicy {
    const val CONNECT_SECONDS = 15L
    const val IDLE_SECONDS = 300L
    const val CALL_SECONDS = 300L
    const val VERIFICATION_WAIT_MS = 300_000L
    const val VERIFICATION_POLL_MS = 2_000L
}
