package br.com.ia4tube.app.feature.edit

import java.text.Normalizer
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

internal data class EditPostingTimeSlot(val time: LocalTime, val contextLabel: String)

internal data class EditPostingTimeCategory(val label: String, val slots: List<EditPostingTimeSlot>)

internal data class EditPostingTimeWindow(val start: LocalTime, val end: LocalTime) {
    init { require(!end.isBefore(start)) }

    /** Keep this date and pick a future minute inside the displayed range. */
    fun selection(date: LocalDate, now: Instant = Instant.now()): EditCalendarSchedule? {
        fun schedule(time: LocalTime) = EditCalendarSchedule(date.toString(), time.format(postingTimeFormat))
            .takeIf { it.isFuture(now) }
        val middle = start.plusMinutes(ChronoUnit.MINUTES.between(start, end) / 2)
        schedule(middle)?.let { return it }
        val nextMinute = now.atZone(postingTimeZone).truncatedTo(ChronoUnit.MINUTES).plusMinutes(1)
        if (nextMinute.toLocalDate() != date) return null
        val time = nextMinute.toLocalTime()
        return if (!time.isBefore(start) && !time.isAfter(end)) schedule(time) else null
    }
}

private val postingTimeZone = ZoneId.of("America/Sao_Paulo")
private val postingTimeFormat = DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT)

/** Repeatable editorial variation by day, not measured follower activity. */
internal fun editPostingTimeWindow(baseTime: LocalTime, date: LocalDate): EditPostingTimeWindow {
    val offset = Math.floorMod(15 - (date.dayOfMonth - 1) * 7, 31) - 15
    val middle = (baseTime.hour * 60 + baseTime.minute + offset).coerceIn(0, 1439)
    fun time(minutes: Int) = LocalTime.of(minutes / 60, minutes % 60)
    return EditPostingTimeWindow(time((middle - 5).coerceAtLeast(0)), time((middle + 5).coerceAtMost(1439)))
}

/** Contextual starting points by business type, not measured audience activity or guaranteed optimal times. */
internal fun editPostingTimeCategory(businessType: String): EditPostingTimeCategory {
    val normalized = " " + Normalizer.normalize(businessType, Normalizer.Form.NFD)
        .replace(Regex("\\p{M}+"), "")
        .lowercase(Locale.ROOT)
        .replace(Regex("[^a-z0-9]+"), " ")
        .trim() + " "

    fun hasAny(vararg terms: String): Boolean = terms.any { normalized.contains(" $it ") }
    fun slot(hour: Int, minute: Int = 0, label: String) = EditPostingTimeSlot(LocalTime.of(hour, minute), label)

    return when {
        hasAny("pizza", "pizzas", "pizzaria", "pizzarias", "hamburguer", "hamburgueres", "hamburger",
            "hamburgueria", "hamburguerias", "burger", "burguer", "burgueria", "lanchonete", "lanchonetes",
            "lanche", "lanches") -> EditPostingTimeCategory("Hamburguerias e pizzarias", listOf(
            slot(18, label = "Jantar"), slot(11, 30, "Almoço")))
        hasAny("restaurante", "restaurantes", "marmita", "marmitas", "marmitaria", "almoco", "self service") ->
            EditPostingTimeCategory("Restaurantes", listOf(
                slot(11, label = "Almoço"), slot(18, label = "Jantar")))
        hasAny("padaria", "padarias", "cafeteria", "cafeterias", "cafe", "cafes", "confeitaria", "confeitarias",
            "pao", "paes") -> EditPostingTimeCategory("Padarias e cafés", listOf(
            slot(7, label = "Café da manhã"), slot(15, label = "Café da tarde")))
        hasAny("beleza", "salao", "saloes", "salon", "beauty", "barbearia", "barbearias",
            "cabeleireiro", "cabeleireira", "estetica") -> EditPostingTimeCategory("Beleza", listOf(
            slot(12, label = "Intervalo do almoço"), slot(18, label = "Fim do expediente")))
        hasAny("academia", "academias", "fitness", "musculacao") -> EditPostingTimeCategory("Academias", listOf(
            slot(7, label = "Início do dia"), slot(18, label = "Fim do expediente")))
        hasAny("varejo", "loja", "lojas", "comercio", "material de construcao", "materiais de construcao",
            "petshop", "petshops", "pet shop") -> EditPostingTimeCategory("Comércio", listOf(
            slot(9, label = "Início do expediente"), slot(12, label = "Intervalo do almoço")))
        else -> EditPostingTimeCategory("Sugestões gerais", listOf(
            slot(12, label = "Intervalo do almoço"), slot(18, label = "Fim do expediente")))
    }
}
