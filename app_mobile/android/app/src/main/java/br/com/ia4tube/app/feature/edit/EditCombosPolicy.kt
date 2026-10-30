package br.com.ia4tube.app.feature.edit

import java.net.URI
import java.util.Locale

/** Navigation only: no account data, order context or payment capability crosses this callback. */
internal object EditCombosPolicy {
    private const val PATH = "/edit/app-combos/open"
    private val nonce = Regex("[A-Za-z0-9_-]{43}")
    private fun uri(value: String?): URI? = runCatching { value?.let(::URI) }.getOrNull()

    fun isCallback(value: String?): Boolean =
        EditNavigationPolicy.isWebsite(value) && uri(value)?.rawPath == PATH

    fun canOpen(target: String?, current: String?, mainFrame: Boolean, userGesture: Boolean, expectedNonce: String): Boolean {
        if (!mainFrame || !userGesture || !EditCalendarPolicy.isDocument(current) || !isCallback(target) ||
            !nonce.matches(expectedNonce)) return false
        val request = uri(target) ?: return false
        val document = uri(current) ?: return false
        return request.host.lowercase(Locale.ROOT) == document.host.lowercase(Locale.ROOT) &&
            request.rawFragment == null && request.rawQuery == "nonce=$expectedNonce"
    }
}
