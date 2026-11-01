package br.com.ia4tube.app.feature.calendar

import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.YearMonth

// Presentation only: the upload workflow remains available for a later reactivation.
internal const val CALENDAR_MANUAL_UPLOAD_ENTRY_VISIBLE = false

/** Use the same upcoming rows as the gallery; opening a month never fetches or changes a schedule. */
internal fun calendarMonthItems(items: List<ScheduledArt>, now: Instant): Map<LocalDate, List<ScheduledArt>> {
    val byDate = galleryItems(items, now, CalendarGalleryMode.UPCOMING)
        .mapNotNull { item -> runCatching { LocalDate.parse(item.date) }.getOrNull()?.let { it to item } }
        .groupBy({ it.first }, { it.second })
    val order = compareBy<ScheduledArt> { runCatching { LocalTime.parse(it.time) }.getOrDefault(LocalTime.MAX) }
        .thenBy { it.id }
    return byDate.toSortedMap().mapValues { (_, dayItems) -> dayItems.sortedWith(order) }
}

/** Sunday-first grid (Dom through Sáb), padded to complete weeks without dates from another month. */
internal fun calendarMonthCells(month: YearMonth): List<LocalDate?> {
    val leading = month.atDay(1).dayOfWeek.value % 7
    val length = month.lengthOfMonth()
    val cellCount = ((leading + length + 6) / 7) * 7
    return List(cellCount) { index ->
        val day = index - leading + 1
        if (day in 1..length) month.atDay(day) else null
    }
}
