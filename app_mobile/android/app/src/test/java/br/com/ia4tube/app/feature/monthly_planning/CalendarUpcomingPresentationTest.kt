package br.com.ia4tube.app.feature.monthly_planning

import br.com.ia4tube.app.feature.calendar.CalendarSnapshot
import br.com.ia4tube.app.feature.calendar.ScheduledArt
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class CalendarUpcomingPresentationTest {
    private val now = Instant.parse("2026-10-29T15:00:00Z")
    private fun row(key: String, time: String, status: String = "Pronta", label: String = "") =
        MonthlyPlanningCalendarListItem(key = key, date = "2026-10-29", time = time, dateLabel = "29/10", status = status,
            title = "Arte original", pedidoId = "", imageReady = true, sortKey = key, calendarStatusLabel = label)
    private fun scheduled(key: String, status: String, time: String, instant: String) = ScheduledArt("a".repeat(40), key,
        "2026-10-29", time, "Legenda original", 1, status, status, status != "published", true, null, null,
        Instant.parse(instant).toEpochMilli())

    @Test fun generalCalendarHidesPublishedAndElapsedWithoutRemovingStoredDetailedRows() {
        val future = row("future", "13:00")
        val published = row("published", "14:00", label = "Publicada")
        val past = row("past", "11:00", status = "failed")
        val cancelled = row("cancelled", "14:30", status = "cancelled", label = "Cancelada")
        val items = listOf(future, published, past, cancelled)
        assertEquals(listOf(future), upcomingGeneralCalendarItems(items, CalendarSnapshot(), now))
        assertEquals(4, items.size)
        assertEquals("failed", past.status)
    }

    @Test fun exactCalendarRecordWinsOverProductionLabelAndKeepsActiveConfirmation() {
        val published = row("order:one", "14:00")
        val confirming = row("order:two", "11:00")
        val snapshot = CalendarSnapshot(items = listOf(scheduled(published.key, "published", "14:00", "2026-10-29T17:00:00Z"),
            scheduled(confirming.key, "confirming", "11:00", "2026-10-29T14:00:00Z").copy(id = "b".repeat(40))))
        assertEquals(listOf(confirming), upcomingGeneralCalendarItems(listOf(published, confirming), snapshot, now))
        assertEquals(2, snapshot.items.size)
    }

    @Test fun importedRowsMatchTheirExistingCalendarIdAndPastPartialNeverBecomesPublished() {
        val imported = row("import", "11:00", "partial", "Falha parcial").copy(calendarItemId = "a".repeat(40))
        val snapshot = CalendarSnapshot(items = listOf(scheduled("other-key", "partial", "11:00", "2026-10-29T14:00:00Z").copy(sourceKind = "upload")))
        assertTrue(upcomingGeneralCalendarItems(listOf(imported), snapshot, now).isEmpty())
        assertEquals("partial", imported.status)
        assertEquals("Falha parcial", imported.calendarStatusLabel)
    }

    @Test fun completedMonthlyRowWinsOverAnOlderSocialCalendarConfirmation() {
        val published = row("order:one", "11:00", label = "Publicada")
        val cancelled = row("order:two", "14:00", label = "Cancelada")
        val snapshot = CalendarSnapshot(items = listOf(
            scheduled(published.key, "confirming", "11:00", "2026-10-29T14:00:00Z"),
            scheduled(cancelled.key, "scheduled", "14:00", "2026-10-29T17:00:00Z").copy(id = "b".repeat(40))))
        assertTrue(upcomingGeneralCalendarItems(listOf(published, cancelled), snapshot, now).isEmpty())
        assertEquals(listOf("confirming", "scheduled"), snapshot.items.map { it.status })
    }

    @Test fun futurePartialRemainsScheduledAndMissingDateDoesNotInventAFutureEntry() {
        val futurePartial = row("partial", "13:00", "partial", "Publicada parcialmente")
        val noDate = row("draft", "").copy(date = "")
        assertEquals(listOf(futurePartial), upcomingGeneralCalendarItems(listOf(futurePartial, noDate), CalendarSnapshot(), now))
    }
}
