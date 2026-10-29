package br.com.ia4tube.app.feature.monthly_planning

import br.com.ia4tube.app.feature.calendar.CalendarSnapshot
import br.com.ia4tube.app.feature.calendar.calendarPresentationTime
import br.com.ia4tube.app.feature.calendar.isUpcomingCalendarArt
import java.text.Normalizer
import java.time.Instant
import java.util.Locale

/** A screen projection only. Orders, detailed results and cached server rows remain complete. */
internal fun upcomingGeneralCalendarItems(items: List<MonthlyPlanningCalendarListItem>, calendar: CalendarSnapshot,
                                         now: Instant = Instant.now()): List<MonthlyPlanningCalendarListItem> {
    val byId = calendar.items.associateBy { it.id }
    val byKey = calendar.items.associateBy { it.key }
    return items.filter { item ->
        val status = presentationStatus(item.status)
        val label = presentationStatus(item.calendarStatusLabel)
        val terminal = setOf("published", "publicada", "publicado", "cancelled", "cancelada", "cancelado")
        // Do not resurrect a completed row from an older social-calendar response.
        if (status in terminal || label in terminal) return@filter false
        val scheduled = item.calendarItemId?.let(byId::get) ?: byKey[item.key] ?:
            item.pedidoId.takeIf { it.isNotBlank() }?.let { byKey["order:$it"] }
        if (scheduled != null) scheduled.isUpcomingCalendarArt(now) else {
            val active = status in setOf("dispatching", "confirming", "publication_queued") ||
                item.calendarPreparationPending && status in setOf("preparing", "waiting_media")
            active || calendarPresentationTime(item.date, item.time) > now.toEpochMilli()
        }
    }
}

private fun presentationStatus(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFD)
    .replace(Regex("\\p{M}+"), "").trim().lowercase(Locale.ROOT)
