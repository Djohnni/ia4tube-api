package br.com.ia4tube.app.feature.edit

import java.net.URI
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.util.Locale

internal data class EditCalendarSchedule(val date: String, val time: String) {
    fun isFuture(now: Instant = Instant.now()): Boolean = runCatching {
        LocalDate.parse(date).atTime(LocalTime.parse(time)).atZone(ZoneId.of("America/Sao_Paulo"))
            .toInstant().isAfter(now) && date.matches(Regex("\\d{4}-\\d{2}-\\d{2}")) &&
            time.matches(Regex("\\d{2}:\\d{2}"))
    }.getOrDefault(false)
}

internal object EditCalendarPolicy {
    private const val CALLBACK_PATH = "/edit/app-calendar/request"
    private val uuid = Regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", RegexOption.IGNORE_CASE)
    private val nonce = Regex("[A-Za-z0-9_-]{43}")
    private val ticket = Regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\.[A-Za-z0-9_-]{43}", RegexOption.IGNORE_CASE)
    private fun uri(value: String?): URI? = runCatching { value?.let(::URI) }.getOrNull()

    fun isDocument(value: String?): Boolean {
        val parsed = uri(value) ?: return false
        return EditNavigationPolicy.isWebsite(value) && parsed.rawPath in setOf("/edit", "/edit/")
    }

    fun isCallback(value: String?): Boolean =
        EditNavigationPolicy.isWebsite(value) && uri(value)?.rawPath == CALLBACK_PATH

    fun requestId(target: String?, current: String?, mainFrame: Boolean, expectedNonce: String): String? {
        if (!mainFrame || !isDocument(current) || !isCallback(target) || !nonce.matches(expectedNonce)) return null
        val request = uri(target) ?: return null
        val document = uri(current) ?: return null
        if (request.host.lowercase(Locale.ROOT) != document.host.lowercase(Locale.ROOT) || request.rawFragment != null) return null
        val parts = request.rawQuery?.split('&') ?: return null
        if (parts.size != 2) return null
        val parameters = parts.map { it.split('=', limit = 2) }
        if (parameters.any { it.size != 2 } || parameters.map { it[0] }.toSet() != setOf("requestId", "nonce")) return null
        val fields = parameters.associate { it[0] to it[1] }
        return fields["requestId"]?.takeIf { uuid.matches(it) && fields["nonce"] == expectedNonce }
    }

    fun validTicket(value: String): Boolean = ticket.matches(value)
    fun validRequestId(value: String): Boolean = uuid.matches(value)
}
