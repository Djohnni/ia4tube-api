package br.com.ia4tube.app.feature.calendar

import br.com.ia4tube.app.feature.monthly_planning.projectCalendarImports
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CalendarSubmissionProjectionTest {
    private fun fixture() = javaClass.getResourceAsStream("/gallery-import-calendar-contract.json")!!.use {
        JSONObject(it.bufferedReader().readText())
    }
    private fun pending() = fixture().also { root ->
        root.getJSONArray("items").getJSONObject(0).apply {
            put("media", JSONObject.NULL); put("preparationPending", true); put("submissionState", "preparing")
            put("status", "waiting_media"); put("statusLabel", "Preparando arquivo"); put("mediaReadAvailable", false)
            put("automatic", false); put("formatsReady", false)
        }
    }
    @Test fun serverAcceptedPendingRowAppearsInSameCalendarWithoutPlayableBytes() {
        val snapshot = parseCalendar(pending()); val item = snapshot.items.first()
        assertEquals("upload", item.sourceKind); assertTrue(item.preparationPending); assertNull(item.media)
        assertNull(item.imageUrl); assertFalse(item.mediaReadAvailable)
        val row = projectCalendarImports(emptyList(), snapshot, true).first()
        assertEquals(item.id, row.calendarItemId); assertEquals("Preparando arquivo", row.calendarStatusLabel)
        assertEquals("waiting_media", row.status); assertTrue(row.calendarEditable); assertTrue(row.calendarPreparationPending)
    }
    @Test fun closedMediaRuntimePreservesMetadataAndNeverCreatesPublicFallback() {
        val json = fixture()
        for (index in 0..1) json.getJSONArray("items").getJSONObject(index).apply {
            put("shareToFeed", getJSONObject("media").getBoolean("shareToFeed"))
            put("media", JSONObject.NULL); put("mediaReadAvailable", false)
        }
        val snapshot = parseCalendar(json)
        val imports = snapshot.items.filter { it.sourceKind == "upload" }
        assertEquals(2, imports.size)
        assertTrue(imports.all { !it.preparationPending && !it.mediaReadAvailable && it.media == null && it.imageUrl == null })
        assertTrue(imports.last().shareToFeed)
        assertEquals(2, projectCalendarImports(emptyList(), snapshot, true).size)
    }
    @Test fun missingMediaNeedsExplicitPendingOrUnavailableStateAndOwner() {
        val noReason = fixture().also { it.getJSONArray("items").getJSONObject(0).put("media", JSONObject.NULL) }
        assertThrows(IllegalArgumentException::class.java) { parseCalendar(noReason) }
        val noOwner = pending().apply { remove("identity") }
        assertThrows(IllegalArgumentException::class.java) { parseCalendar(noOwner) }
        val fallback = pending().also { root ->
            val item = root.getJSONArray("items").getJSONObject(0)
            item.put("imageUrl", "/v1/social/calendar/items/${item.getString("id")}/image")
        }
        assertThrows(IllegalArgumentException::class.java) { parseCalendar(fallback) }
    }
}
