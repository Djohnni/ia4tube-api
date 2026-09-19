package br.com.ia4tube.app.feature.monthly_planning

import br.com.ia4tube.app.feature.calendar.CalendarSnapshot
import br.com.ia4tube.app.feature.calendar.ScheduledArt
import br.com.ia4tube.app.feature.calendar.galleryItems
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate

class CalendarImportProjectionTest {
    private val planned = MonthlyPlanningCalendarListItem("planning:1", date = "2026-09-14", time = "10:00", dateLabel = "14/09/2026",
        status = "Pronta", title = "Arte existente", pedidoId = "real-order", imageReady = true, sortKey = "2026-09-14 10:00")
    private val imported = ScheduledArt("a".repeat(40), "upload:one", "2026-09-15", "14:30", "Legenda da foto",
        1, "scheduled", "Programada", true, true, null, "synthetic", 1789475400000,
        sourceKind = "upload", title = "Foto da galeria")
    @Test fun importSurvivesPlanningSyncAndUsesSameCalendarIdWithoutAnOrder() {
        val snapshot = CalendarSnapshot(enabled = true, items = listOf(imported), next = imported)
        val first = projectCalendarImports(listOf(planned), snapshot, true)
        assertEquals(2, first.size); assertEquals(planned, first.first())
        val item = first.single { it.calendarItemId != null }
        assertEquals(imported.id, item.calendarItemId); assertEquals(imported.key, item.key)
        assertEquals("", item.pedidoId); assertEquals("", item.planningId)
        assertEquals(first, projectCalendarImports(listOf(planned), snapshot, true))
        assertEquals(item.calendarItemId, galleryItems(snapshot.items, LocalDate.parse("2026-09-14")).single().id)
        assertEquals(item.calendarItemId, snapshot.next!!.id)
    }
    @Test fun editPauseAndCancelAreProjectionsOfTheSameServerRow() {
        val edited = imported.copy(date = "2026-09-16", time = "18:40", caption = "Editada", revision = 2,
            status = "paused", statusLabel = "Desativada", automatic = false)
        val projection = projectCalendarImports(listOf(planned), CalendarSnapshot(items = listOf(edited)), true)
        val row = projection.single { it.calendarItemId != null }
        assertEquals(imported.id, row.calendarItemId); assertEquals("18:40", row.time); assertEquals(2L, row.calendarRevision)
        assertEquals("Desativada", row.calendarStatusLabel)
        val cancelled = projectCalendarImports(projection, CalendarSnapshot(items = listOf(edited.copy(status = "cancelled"))), true)
        assertEquals(listOf(planned), cancelled)
    }
    @Test fun staleStateCannotEnableEditsAndOldCompanyProjectionIsNotRetained() {
        val old = projectCalendarImports(listOf(planned), CalendarSnapshot(items = listOf(imported)), false)
        assertFalse(old.single { it.calendarItemId != null }.calendarEditable)
        assertEquals(listOf(planned), projectCalendarImports(old, CalendarSnapshot(), true))
    }
}
