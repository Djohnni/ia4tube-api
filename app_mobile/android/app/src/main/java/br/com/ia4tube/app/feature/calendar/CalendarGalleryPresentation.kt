package br.com.ia4tube.app.feature.calendar

import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

enum class CalendarGalleryMode { UPCOMING, HISTORY }

internal val CalendarPresentationZone: ZoneId = ZoneId.of("America/Sao_Paulo")

internal fun calendarPresentationTime(date: String, time: String, scheduledAt: Long = 0): Long =
    if (scheduledAt > 0) scheduledAt else runCatching {
        LocalDate.parse(date).atTime(LocalTime.parse(time)).atZone(CalendarPresentationZone).toInstant().toEpochMilli()
    }.getOrDefault(Long.MIN_VALUE)

internal fun ScheduledArt.hasActiveCalendarWork(): Boolean = when (status) {
    "dispatching", "confirming", "publication_queued" -> true
    "preparing", "waiting_media" -> submissionState !in setOf("attention", "cancelled") &&
        (preparationPending || submissionState in setOf("accepted", "preparing") ||
            sourceKind != "upload" && imageUrl == null && media == null && generatedVideo == null)
    else -> false
}

internal fun ScheduledArt.isUpcomingCalendarArt(now: Instant): Boolean = status != "published" && status != "cancelled" &&
    (hasActiveCalendarWork() || calendarPresentationTime(date, time, scheduledAt) > now.toEpochMilli())

internal fun galleryItems(items: List<ScheduledArt>, now: Instant = Instant.now(),
                         mode: CalendarGalleryMode = CalendarGalleryMode.UPCOMING): List<ScheduledArt> {
    val selected = items.filter { it.isUpcomingCalendarArt(now) == (mode == CalendarGalleryMode.UPCOMING) }
    val order = compareBy<ScheduledArt> { calendarPresentationTime(it.date, it.time, it.scheduledAt) }.thenBy { it.id }
    return selected.sortedWith(if (mode == CalendarGalleryMode.HISTORY) order.reversed() else order)
}

// Existing deterministic date callers keep the same day boundary in Brasilia.
internal fun galleryItems(items: List<ScheduledArt>, today: LocalDate): List<ScheduledArt> =
    galleryItems(items, today.atStartOfDay(CalendarPresentationZone).toInstant())
