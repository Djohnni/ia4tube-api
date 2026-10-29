package br.com.ia4tube.app.feature.calendar

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class CalendarGalleryPresentationTest {
    private val now = Instant.parse("2026-10-29T15:00:00Z")
    private fun art(id: Char, status: String, offsetSeconds: Long, source: String = "order") =
        now.plusSeconds(offsetSeconds).atZone(CalendarPresentationZone).let { at ->
            ScheduledArt(id.toString().repeat(40), "order:$id", at.toLocalDate().toString(),
                at.toLocalTime().toString().take(5), "Legenda original $id", 1, status, "Estado original: $status",
                status != "published", false, null, "synthetic", at.toInstant().toEpochMilli(), sourceKind = source)
        }

    @Test fun allPublishedSourcesBelongToHistoryEvenTodayOrFuture() {
        val items = listOf("generated", "planning", "order", "upload").mapIndexed { index, source ->
            art(('a'.code + index).toChar(), "published", 7200, source)
        }
        assertTrue(galleryItems(items, now).isEmpty())
        assertEquals(items.toSet(), galleryItems(items, now, CalendarGalleryMode.HISTORY).toSet())
        assertTrue(items.all { it.status == "published" })
    }

    @Test fun cancelledFutureScheduleBelongsToHistoryWithoutChangingItsOriginalStatus() {
        val cancelled = art('a', "cancelled", 7200)
        assertTrue(galleryItems(listOf(cancelled), now).isEmpty())
        assertEquals(listOf(cancelled), galleryItems(listOf(cancelled), now, CalendarGalleryMode.HISTORY))
        assertEquals("cancelled", cancelled.status)
    }

    @Test fun onlyFutureNonPublishedRowsAreUpcomingUnlessWorkIsActuallyInFlight() {
        val future = art('a', "manual", 60)
        val dueNow = art('b', "scheduled", 0)
        val failed = art('c', "failed", -60)
        val partial = art('d', "partial", -120)
        val confirming = art('e', "confirming", -3600)
        val dispatching = art('f', "dispatching", -7200)
        val queued = art('g', "publication_queued", -1800)
        val items = listOf(future, dueNow, failed, partial, confirming, dispatching, queued)
        assertEquals(setOf(future, confirming, dispatching, queued), galleryItems(items, now).toSet())
        val history = galleryItems(items, now, CalendarGalleryMode.HISTORY)
        assertEquals(listOf(dueNow, failed, partial), history)
        assertEquals(listOf("scheduled", "failed", "partial"), history.map { it.status })
        assertEquals(listOf("Estado original: scheduled", "Estado original: failed", "Estado original: partial"), history.map { it.statusLabel })
    }

    @Test fun pendingPreparationStaysVisibleButAttentionAndFinishedMediaDoNotPretendToBeActive() {
        val upload = art('a', "waiting_media", -60, "upload").copy(preparationPending = true, submissionState = "preparing")
        val edit = art('b', "waiting_media", -120)
        val preparing = art('c', "preparing", -180)
        val attention = upload.copy(id = "d".repeat(40), submissionState = "attention")
        val finished = edit.copy(id = "e".repeat(40), imageUrl = "/already-ready")
        assertEquals(setOf(upload, edit, preparing), galleryItems(listOf(upload, edit, preparing, attention, finished), now).toSet())
        assertEquals(setOf(attention, finished), galleryItems(listOf(upload, edit, preparing, attention, finished), now, CalendarGalleryMode.HISTORY).toSet())
    }

    @Test fun galleryAndHistoryPartitionCompleteRowsWithoutLosingOriginalVideoOrStatus() {
        val video = GeneratedCalendarVideo("/v1/social/calendar/items/${"a".repeat(40)}/video", 1234, "f".repeat(64), true)
        val published = art('a', "published", -60).copy(generatedVideo = video, imageUrl = null)
        val items = listOf(published, art('b', "failed", -120), art('c', "scheduled", 3600), art('d', "confirming", -600))
        val upcoming = galleryItems(items, now)
        val history = galleryItems(items, now, CalendarGalleryMode.HISTORY)
        assertEquals(items.size, upcoming.size + history.size)
        assertTrue(upcoming.toSet().intersect(history.toSet()).isEmpty())
        assertEquals(items.toSet(), (upcoming + history).toSet())
        assertSame(video, history.first { it.id == published.id }.generatedVideo)
        assertEquals("published", published.status)
    }

    @Test fun upcomingAscendsAndHistoryDescendsByExistingScheduledInstant() {
        val earliest = art('a', "manual", 60)
        val latest = art('b', "manual", 3600)
        assertEquals(listOf(earliest, latest), galleryItems(listOf(latest, earliest), now))
        val old = art('c', "published", -3600)
        val recent = art('d', "published", -60)
        assertEquals(listOf(recent, old), galleryItems(listOf(old, recent), now, CalendarGalleryMode.HISTORY))
    }

    @Test fun missingTimestampUsesBrasiliaAndExactTimeRatherThanOnlyDate() {
        val later = art('a', "manual", 0).copy(date = "2026-10-29", time = "12:30", scheduledAt = 0)
        val earlier = later.copy(id = "b".repeat(40), time = "11:30")
        assertEquals(Instant.parse("2026-10-29T15:30:00Z").toEpochMilli(), calendarPresentationTime(later.date, later.time))
        assertEquals(listOf(later), galleryItems(listOf(earlier, later), now))
        assertEquals(listOf(earlier), galleryItems(listOf(earlier, later), now, CalendarGalleryMode.HISTORY))
    }

    @Test fun existingServerTimestampWinsAndInvalidFallbackCannotBecomeAFutureSchedule() {
        val old = art('a', "scheduled", -60).copy(date = "2030-01-01", time = "23:59")
        val future = art('b', "scheduled", 60).copy(date = "2020-01-01", time = "00:00")
        val invalid = art('c', "manual", 0).copy(date = "", time = "", scheduledAt = 0)
        assertEquals(listOf(future), galleryItems(listOf(old, future, invalid), now))
        assertEquals(setOf(old, invalid), galleryItems(listOf(old, future, invalid), now, CalendarGalleryMode.HISTORY).toSet())
    }
}
