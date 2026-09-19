package br.com.ia4tube.app.feature.calendar

import br.com.ia4tube.app.feature.monthly_planning.projectCalendarImports
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate

/** Golden response captured by the real local backend pipeline with only synthetic sources.
 * No network, production authentication, orders or Instagram operations are used here. */
class CalendarImportContractTest {
    private fun fixture(): JSONObject = javaClass.getResourceAsStream("/gallery-import-calendar-contract.json")!!.use {
        JSONObject(it.bufferedReader().readText())
    }
    @Test fun actualBackendResponsePreservesSameRecordsAcrossCalendarGalleryAndNext() {
        val snapshot = parseCalendar(fixture())
        assertEquals(3, snapshot.items.size)
        assertNotNull(snapshot.identity)
        val imports = snapshot.items.filter { it.sourceKind == "upload" }
        assertEquals(2, imports.size)
        assertTrue(imports.all { it.localSimulation })
        val projected = projectCalendarImports(emptyList(), snapshot, true)
        assertEquals(imports.map { it.id }, projected.map { it.calendarItemId })
        assertTrue(projected.all { it.pedidoId.isEmpty() && it.planningId.isEmpty() })
        val gallery = galleryItems(snapshot.items, LocalDate.of(2026, 9, 13))
        assertSame(snapshot.items.first(), snapshot.next)
        assertSame(snapshot.next, gallery.first())
        assertEquals(snapshot.next!!.id, projected.first().calendarItemId)
        val photo = imports.first().media!!
        assertEquals(imports.first().id, photo.scheduleId)
        assertEquals(listOf("feed", "story"), photo.variants.map { it.target })
        val video = imports.last().media!!
        assertEquals(listOf("story", "reel"), video.variants.map { it.target })
        assertTrue(imports.last().shareToFeed)
        assertEquals(video.variants.first().sha256, video.variants.last().sha256)
        assertNotNull(video.thumbnail)
        assertEquals(2, imports.last().selectedTargets.size)
        assertNotNull(snapshot.items.last().imageUrl) // Existing generated image remains intact.
        assertFalse(snapshot.operationsAllowed) // This local response is not an operational release.
    }
    @Test fun missingIdentityOrMismatchedDestinationsCannotImportPrivateMedia() {
        val missing = fixture().apply { remove("identity") }
        assertThrows(IllegalArgumentException::class.java) { parseCalendar(missing) }
        val altered = fixture()
        altered.getJSONArray("items").getJSONObject(0).getJSONArray("selectedTargets").put(1, "reel")
        assertThrows(IllegalArgumentException::class.java) { parseCalendar(altered) }
    }
    @Test fun staleCalendarBlocksImportedEditingAndCompanySwitchClearsProjection() {
        val snapshot = parseCalendar(fixture())
        val rows = projectCalendarImports(emptyList(), snapshot, false)
        assertTrue(rows.all { !it.calendarEditable })
        assertTrue(projectCalendarImports(rows, CalendarSnapshot(), false).isEmpty())
        assertEquals(2, rows.map { it.calendarItemId }.distinct().size)
    }
    @Test fun formatAndSimulationLabelsCannotContradictExactScheduledMedia() {
        fun altered(change: (JSONObject) -> Unit) = fixture().also { change(it.getJSONArray("items").getJSONObject(0)) }
        for (value in listOf(
            altered { it.put("destination", "reel") },
            altered { it.getJSONObject("media").put("shareToFeed", true) },
            altered { it.getJSONObject("media").put("shareToFeed", "false") },
            altered { it.put("localSimulation", "true") },
            altered { it.put("localSimulation", false); it.getJSONObject("media").put("testOnly", true) }
        )) assertThrows(IllegalArgumentException::class.java) { parseCalendar(value) }
    }
}
