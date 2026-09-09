package br.com.ia4tube.app.feature.monthly_planning

import br.com.ia4tube.app.data.models.MonthlyPlanningRescheduleRequest
import java.time.Clock
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

internal val CalendarScheduleZone: ZoneId = ZoneId.of("America/Sao_Paulo")

// Match the calendar service's explicit zone, independent of the phone's zone.
internal fun calendarScheduleError(date: String, time: String, clock: Clock = Clock.systemUTC()): String? {
    val selectedDate = runCatching { LocalDate.parse(date) }.getOrNull()
        ?: return "Selecione uma data válida."
    if (!Regex("\\d{2}:\\d{2}").matches(time)) return "Selecione um horário válido."
    val selectedTime = runCatching { LocalTime.parse(time) }.getOrNull()
        ?: return "Selecione um horário válido."
    val instant = selectedDate.atTime(selectedTime).atZone(CalendarScheduleZone).toInstant()
    return if (instant.isAfter(clock.instant())) null else "Escolha uma data e horário no futuro."
}

internal fun MonthlyPlanningCalendarListItem.rescheduleRequest(date: String, time: String) =
    MonthlyPlanningRescheduleRequest(
        itemKey = key, planningId = planningId, planejamentoItemId = planejamentoItemId,
        pedidoId = pedidoId, date = date, time = time, calendarRevision = calendarRevision
    )
