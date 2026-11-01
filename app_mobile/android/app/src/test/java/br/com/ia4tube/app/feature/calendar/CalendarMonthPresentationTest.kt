package br.com.ia4tube.app.feature.calendar

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.YearMonth

class CalendarMonthPresentationTest {
    private val now = Instant.parse("2026-11-01T15:00:00Z")

    private fun art(id: Char, date: String, time: String, status: String = "scheduled"): ScheduledArt {
        val instant = LocalDate.parse(date).atTime(LocalTime.parse(time)).atZone(CalendarPresentationZone).toInstant()
        return ScheduledArt(id.toString().repeat(40), "synthetic:$id", date, time, "Legenda $id", 1,
            status, "Estado $status", status !in setOf("published", "cancelled"), true,
            "/synthetic-not-fetched", "synthetic", instant.toEpochMilli())
    }

    @Test fun sundayIsTheFirstColumnAndOtherMonthDaysAreBlank() {
        val november = calendarMonthCells(YearMonth.of(2026, 11))
        assertEquals(LocalDate.of(2026, 11, 1), november.first())
        assertEquals(LocalDate.of(2026, 11, 7), november[6])
        assertEquals(LocalDate.of(2026, 11, 8), november[7])
        assertEquals(35, november.size)
        assertTrue(november.takeLast(5).all { it == null })

        val mondayStart = calendarMonthCells(YearMonth.of(2021, 2))
        assertNull(mondayStart.first())
        assertEquals(LocalDate.of(2021, 2, 1), mondayStart[1])
    }

    @Test fun monthsOfAllLengthsKeepEveryDayExactlyOnceAndCompleteTheirWeeks() {
        val months = listOf(YearMonth.of(2026, 2), YearMonth.of(2024, 2),
            YearMonth.of(2026, 11), YearMonth.of(2026, 8))
        assertEquals(listOf(28, 29, 30, 31), months.map { it.lengthOfMonth() })
        months.forEach { month ->
            val cells = calendarMonthCells(month)
            assertEquals(0, cells.size % 7)
            assertTrue(cells.size in 28..42)
            assertEquals((1..month.lengthOfMonth()).map(month::atDay), cells.filterNotNull())
            assertEquals(cells.filterNotNull().size, cells.filterNotNull().toSet().size)
        }
        assertEquals(28, calendarMonthCells(YearMonth.of(2026, 2)).size)
        assertEquals(42, calendarMonthCells(YearMonth.of(2026, 8)).size)
    }

    @Test fun monthUsesTheExistingUpcomingPolicyIncludingWorkStillInFlight() {
        val future = art('a', "2026-11-02", "18:00")
        val confirming = art('b', "2026-10-31", "19:00", "confirming")
        val preparing = art('c', "2026-10-31", "18:00", "waiting_media").copy(
            imageUrl = null, preparationPending = true, submissionState = "preparing", sourceKind = "upload")
        val futureAttention = art('d', "2026-11-01", "16:00", "waiting_media").copy(
            imageUrl = null, preparationPending = true, submissionState = "attention", sourceKind = "upload")
        val pastAttention = futureAttention.copy(id = "e".repeat(40), date = "2026-10-31", time = "16:00",
            scheduledAt = Instant.parse("2026-10-31T19:00:00Z").toEpochMilli())
        val published = art('f', "2026-11-03", "18:00", "published")
        val cancelled = art('g', "2026-11-03", "19:00", "cancelled")
        val failedPast = art('h', "2026-10-30", "18:00", "failed")
        val all = listOf(published, futureAttention, confirming, cancelled, pastAttention, failedPast, preparing, future)

        val monthItems = calendarMonthItems(all, now)
        assertEquals(galleryItems(all, now).toSet(), monthItems.values.flatten().toSet())
        assertEquals(listOf(preparing, confirming), monthItems[LocalDate.of(2026, 10, 31)])
        assertFalse(monthItems.containsKey(LocalDate.of(2026, 11, 3)))
    }

    @Test fun daysAndRowsAreOrderedWithoutChangingTheirOriginalDataOrCounts() {
        val early = art('a', "2026-11-02", "09:00")
        val firstEvening = art('b', "2026-11-02", "18:00")
        val secondEvening = art('c', "2026-11-02", "18:00")
        val tomorrow = art('d', "2026-11-03", "07:00")
        val original = listOf(tomorrow, secondEvening, early, firstEvening)
        val snapshot = original.toList()

        val grouped = calendarMonthItems(original, now)
        assertEquals(listOf(LocalDate.of(2026, 11, 2), LocalDate.of(2026, 11, 3)), grouped.keys.toList())
        assertEquals(listOf(early, firstEvening, secondEvening), grouped[LocalDate.of(2026, 11, 2)])
        assertEquals(4, grouped.values.sumOf { it.size })
        assertSame(firstEvening, grouped[LocalDate.of(2026, 11, 2)]?.get(1))
        assertEquals(snapshot, original)
    }

    @Test fun malformedDatesAreSkippedAndTheGalleryDateIsNotReinterpreted() {
        val visibleDate = art('a', "2026-11-02", "18:00").copy(
            scheduledAt = Instant.parse("2026-11-03T21:00:00Z").toEpochMilli())
        val invalid = visibleDate.copy(id = "b".repeat(40), date = "2026-02-31")
        val blank = visibleDate.copy(id = "c".repeat(40), date = "")
        val grouped = calendarMonthItems(listOf(invalid, blank, visibleDate), now)
        assertEquals(mapOf(LocalDate.of(2026, 11, 2) to listOf(visibleDate)), grouped)
        assertEquals("2026-11-02", visibleDate.date)
    }

    @Test fun anEmptySnapshotHasNoHighlightedDays() {
        assertTrue(calendarMonthItems(emptyList(), now).isEmpty())
    }
}
