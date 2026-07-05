package br.com.ia4tube.app.data.api

import br.com.ia4tube.app.core.config.AppConfig
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

object PreviewUrlBuilder {
    fun build(pedidoId: String, apiPreviewUrl: String = ""): String {
        val cleanApiUrl = apiPreviewUrl.trim()
        if (cleanApiUrl.isNotBlank()) return normalize(cleanApiUrl)

        val encodedId = URLEncoder.encode(pedidoId, StandardCharsets.UTF_8.name())
        return "${AppConfig.apiBase}/pedidos/$encodedId/preview"
    }

    fun shouldSendAuthorization(previewUrl: String): Boolean {
        val previewHost = previewUrl.toHost()
        val apiHost = AppConfig.apiBase.toHost()
        return previewHost.isNotBlank() && previewHost == apiHost
    }

    private fun normalize(rawUrl: String): String {
        val absoluteUrl = when {
            rawUrl.startsWith("//") -> "https:$rawUrl"
            rawUrl.startsWith("/") -> "${AppConfig.apiBase}$rawUrl"
            else -> rawUrl
        }

        return if (absoluteUrl.startsWith("http://") && AppConfig.apiBase.startsWith("https://")) {
            "https://${absoluteUrl.removePrefix("http://")}"
        } else {
            absoluteUrl
        }
    }

    private fun String.toHost(): String = try {
        URI(this).host.orEmpty().lowercase()
    } catch (_: Exception) {
        ""
    }
}
