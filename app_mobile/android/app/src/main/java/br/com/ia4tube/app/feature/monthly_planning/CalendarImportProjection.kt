package br.com.ia4tube.app.feature.monthly_planning

import br.com.ia4tube.app.feature.calendar.CalendarSnapshot
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/** Projection only: imported rows always come from the existing calendar's jobs,
 * never another collection, a generated order or the planning-orders cache. */
internal fun projectCalendarImports(planned: List<MonthlyPlanningCalendarListItem>, calendar: CalendarSnapshot,
                                    fresh: Boolean): List<MonthlyPlanningCalendarListItem> {
    val imported = calendar.items.filter { it.sourceKind == "upload" }
    val importKeys = imported.map { it.key }.toSet()
    val retainedPlanning = planned.filter { it.calendarItemId == null && it.key !in importKeys }
    val projection = imported.filter { it.status != "cancelled" }.map { item ->
        MonthlyPlanningCalendarListItem(key = item.key, date = item.date, time = item.time,
            dateLabel = LocalDate.parse(item.date).format(DateTimeFormatter.ofPattern("dd/MM/yyyy")),
            status = item.status, title = item.title, pedidoId = "", imageReady = false,
            sortKey = "${item.date} ${item.time}:${item.id}", origem = "gallery_import", tipo = "media",
            calendarRevision = item.revision, calendarStatusLabel = if (fresh) item.statusLabel else "Estado não confirmado — atualize",
            calendarItemId = item.id, calendarEditable = fresh && item.editable,
            calendarPreparationPending = item.preparationPending)
    }
    return (retainedPlanning + projection).sortedWith(compareBy<MonthlyPlanningCalendarListItem> { it.date }.thenBy { it.time }.thenBy { it.key })
}
