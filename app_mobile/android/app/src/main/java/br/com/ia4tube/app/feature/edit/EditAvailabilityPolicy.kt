package br.com.ia4tube.app.feature.edit

import java.net.URI
import java.util.Locale
import br.com.ia4tube.app.BuildConfig

internal object EditAvailabilityPolicy {
    private const val PATH = "/edit/app-availability/request"
    private val uuid = Regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", RegexOption.IGNORE_CASE)
    private val nonce = Regex("[A-Za-z0-9_-]{43}")
    private fun uri(value: String?): URI? = runCatching { value?.let(::URI) }.getOrNull()

    fun entryUrl(sessionNonce: String): String {
        require(nonce.matches(sessionNonce))
        return EDIT_URL + "?app_version=" + BuildConfig.VERSION_CODE + "#app-calendar=" + sessionNonce
    }

    fun isCallback(value: String?): Boolean =
        EditNavigationPolicy.isWebsite(value) && uri(value)?.rawPath == PATH

    fun requestId(target: String?, current: String?, mainFrame: Boolean, expectedNonce: String): String? {
        if (!mainFrame || !EditCalendarPolicy.isDocument(current) || !isCallback(target) || !nonce.matches(expectedNonce)) return null
        val request = uri(target) ?: return null
        val document = uri(current) ?: return null
        if (request.host.lowercase(Locale.ROOT) != document.host.lowercase(Locale.ROOT) || request.rawFragment != null) return null
        val parts = request.rawQuery?.split('&') ?: return null
        if (parts.size != 2) return null
        val pairs = parts.map { it.split('=', limit = 2) }
        if (pairs.any { it.size != 2 } || pairs.map { it[0] }.toSet() != setOf("requestId", "nonce")) return null
        val fields = pairs.associate { it[0] to it[1] }
        return fields["requestId"]?.takeIf { validRequestId(it) && fields["nonce"] == expectedNonce }
    }
    fun validRequestId(value: String): Boolean = uuid.matches(value)
}
