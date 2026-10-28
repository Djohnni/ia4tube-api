package br.com.ia4tube.app.feature.edit

import java.net.URI
import java.net.URLDecoder
import java.util.Locale

internal const val EDIT_URL = "https://ia4tube.com/edit/"
internal enum class EditNavigation { IN_WEBVIEW, EXTERNAL, BLOCK }

/** Only the public website owns this WebView; app credentials never enter it. */
internal object EditNavigationPolicy {
    private val siteHosts = setOf("ia4tube.com", "www.ia4tube.com")

    private fun https(value: String?): URI? = try {
        value?.let(::URI)?.takeIf {
            it.scheme.equals("https", ignoreCase = true) && it.host != null &&
                it.rawUserInfo == null && (it.port == -1 || it.port == 443)
        }
    } catch (_: Exception) { null }

    fun isWebsite(value: String?): Boolean =
        https(value)?.host?.lowercase(Locale.ROOT) in siteHosts

    fun isEditPage(value: String?): Boolean {
        val uri = https(value) ?: return false
        return isWebsite(value) && (uri.path == "/edit" || uri.path.startsWith("/edit/"))
    }

    private fun isOrderWhatsApp(uri: URI): Boolean {
        if (!uri.host.equals("wa.me", ignoreCase = true) || uri.rawPath != "/554791049079" ||
            uri.rawFragment != null) return false
        val query = uri.rawQuery ?: return false
        // This is the exact destination generated after the site's successful POST.
        if (!query.startsWith("text=") || '&' in query || query.length > 36_000) return false
        return try {
            URLDecoder.decode(query.substring(5), "UTF-8").let { it.isNotBlank() && it.length <= 6_000 }
        } catch (_: IllegalArgumentException) { false }
    }

    fun decide(target: String?, currentPage: String?, mainFrame: Boolean, userGesture: Boolean): EditNavigation {
        if (!mainFrame) return EditNavigation.BLOCK
        val uri = https(target) ?: return EditNavigation.BLOCK
        if (isWebsite(target)) return EditNavigation.IN_WEBVIEW
        if (!isWebsite(currentPage)) return EditNavigation.BLOCK
        // Saving is asynchronous, so WebView may not preserve hasGesture here.
        // Opening this trusted draft does not send the WhatsApp message.
        if (isEditPage(currentPage) && isOrderWhatsApp(uri)) return EditNavigation.EXTERNAL
        return if (userGesture) EditNavigation.EXTERNAL else EditNavigation.BLOCK
    }
}
