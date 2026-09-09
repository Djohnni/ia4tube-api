package br.com.ia4tube.app.feature.monthly_planning

import org.junit.Assert.*
import org.junit.Test
import java.time.Clock
import java.time.Instant
import java.time.ZoneId

class CalendarScheduleTest {
    private val clock = Clock.fixed(Instant.parse("2026-09-09T15:00:00Z"), ZoneId.of("Asia/Tokyo"))
    @Test fun `uses Brasilia not device zone and rejects elapsed minute`() {
        assertNull(calendarScheduleError("2026-09-09", "12:01", clock))
        assertNotNull(calendarScheduleError("2026-09-09", "12:00", clock))
        assertNotNull(calendarScheduleError("2026-09-09", "11:59", clock))
    }
    @Test fun `validates dates and all time boundaries`() {
        assertNull(calendarScheduleError("2026-09-10", "00:00", clock))
        assertNull(calendarScheduleError("2026-09-10", "23:59", clock))
        listOf("", "24:00", "12:60", "9:00", "09:00:59").forEach {
            assertNotNull(calendarScheduleError("2026-09-10", it, clock))
        }
        assertNotNull(calendarScheduleError("2026-02-30", "09:00", clock))
        assertNotNull(calendarScheduleError("", "09:00", clock))
    }
    @Test fun `changes only time on same item and preserves concurrency revision`() {
        val item = MonthlyPlanningCalendarListItem("p:i", "p", "i", "2026-09-10", "09:00", "", "", "Art", "o", true, "", calendarRevision = 8)
        val request = item.rescheduleRequest(item.date, "18:45")
        assertEquals("18:45", request.time)
        assertEquals(item.date, request.date)
        assertEquals(item.key, request.itemKey)
        assertEquals(item.pedidoId, request.pedidoId)
        assertEquals(item.planningId, request.planningId)
        assertEquals(item.planejamentoItemId, request.planejamentoItemId)
        assertEquals(item.calendarRevision, request.calendarRevision)
        assertEquals("09:00", item.time)
    }
    @Test fun `can change date alone without losing selected time`() {
        val item = MonthlyPlanningCalendarListItem("p:i", date = "2026-09-10", time = "18:45", dateLabel = "", status = "", title = "Art", pedidoId = "o", imageReady = true, sortKey = "")
        val request = item.rescheduleRequest("2026-09-11", item.time)
        assertEquals("2026-09-11", request.date)
        assertEquals("18:45", request.time)
    }
}
