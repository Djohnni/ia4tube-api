package br.com.ia4tube.app.feature.calendar

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.test.resetMain
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import java.time.LocalDate

@OptIn(ExperimentalCoroutinesApi::class)
class CalendarTest {
    private val dispatcher = StandardTestDispatcher()
    @Before fun before() { Dispatchers.setMain(dispatcher) }
    @After fun after() { Dispatchers.resetMain() }
    private fun art(id: String = "a".repeat(40), date: String = "2026-09-10", status: String = "scheduled") = ScheduledArt(
        id, "plan:1", date, "12:00", "Legenda exata", 2, status, "Programada", status != "published", true,
        null, "synthetic", java.time.LocalDate.parse(date).toEpochDay() * 86400000)
    private fun snapshot() = CalendarSnapshot(true, true, 2, true, "synthetic", false, listOf(art()), art())
    private class Fake(var snapshot: CalendarSnapshot) : CalendarGateway {
        var edits = 0; var changes = 0; var failure: Exception? = null; var pending: CompletableDeferred<Unit>? = null
        override suspend fun list(): CalendarSnapshot { pending?.await(); failure?.let { throw it }; return snapshot }
        override suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot { changes++; return snapshot.copy(automatic = enabled) }
        override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot {
            edits++; return snapshot.copy(items = if (action == "cancel") emptyList() else snapshot.items.map { it.copy(caption = caption, revision = it.revision + 1) })
        }
    }
    @Test fun displayKeepsTodayAndFutureAndDoesNotHideOverdueFailures() {
        val today = LocalDate.parse("2026-09-10")
        val oldPublished = art("b".repeat(40), "2026-09-09", "published")
        val oldUncertain = art("c".repeat(40), "2026-09-09", "confirming")
        assertEquals(listOf(oldUncertain, art()), galleryItems(listOf(art(), oldPublished, oldUncertain), today))
    }
    @Test fun noEditBeforeFreshReadOrAfterPause() = runTest(dispatcher) {
        val fake = Fake(snapshot()); val model = CalendarViewModel({ "synthetic" }, "synthetic", fake)
        model.edit(art(), "cancel"); advanceUntilIdle(); assertEquals(0, fake.edits)
        model.refresh(); advanceUntilIdle(); assertTrue(model.uiState.value.fresh)
        model.onPause(); model.edit(art(), "cancel"); advanceUntilIdle(); assertEquals(0, fake.edits); model.dispose()
    }
    @Test fun captionsUseSameRevisionAndCancellationRemovesScheduleOnly() = runTest(dispatcher) {
        val fake = Fake(snapshot()); val model = CalendarViewModel({ "synthetic" }, "synthetic", fake)
        model.refresh(); advanceUntilIdle(); model.edit(art(), "caption", caption = "Nova legenda"); advanceUntilIdle()
        assertEquals("Nova legenda", model.uiState.value.data.items.single().caption)
        model.edit(art(), "cancel"); advanceUntilIdle(); assertEquals(1, fake.edits) // stale dialog rejected locally
        model.edit(model.uiState.value.data.items.single(), "cancel"); advanceUntilIdle()
        assertTrue(model.uiState.value.data.items.isEmpty()); assertEquals(2, fake.edits); model.dispose()
    }
    @Test fun offlineDataIsNeverPresentedAsFreshOrEditable() = runTest(dispatcher) {
        val fake = Fake(snapshot()); val model = CalendarViewModel({ "synthetic" }, "synthetic", fake)
        model.refresh(); advanceUntilIdle(); fake.failure = CalendarFailure(503); model.refresh(); advanceUntilIdle()
        assertFalse(model.uiState.value.fresh); assertNotNull(model.uiState.value.error)
        model.edit(art(), "cancel"); advanceUntilIdle(); assertEquals(0, fake.edits); model.dispose()
    }
    @Test fun sessionChangeDropsLateResponseAndPreventsOwnerLeak() = runTest(dispatcher) {
        var token = "owner-a"; val fake = Fake(snapshot()); fake.pending = CompletableDeferred()
        val model = CalendarViewModel({ token }, token, fake)
        model.refresh(); runCurrent(); token = "owner-b"; fake.pending!!.complete(Unit); advanceUntilIdle()
        assertTrue(model.uiState.value.data.items.isEmpty()); assertFalse(model.uiState.value.fresh); model.dispose()
    }
    @Test fun forbiddenSessionClearsPreviousImagesAndItems() = runTest(dispatcher) {
        val fake = Fake(snapshot()); val model = CalendarViewModel({ "synthetic" }, "synthetic", fake)
        model.refresh(); advanceUntilIdle(); fake.failure = CalendarFailure(401); model.refresh(); advanceUntilIdle()
        assertTrue(model.uiState.value.data.items.isEmpty()); model.dispose()
    }
    private fun json(image: String? = null): JSONObject {
        val item = JSONObject().put("id", "a".repeat(40)).put("key", "plan:1").put("date", "2026-09-10").put("time", "12:00")
            .put("caption", "Legenda").put("revision", 2).put("status", "scheduled").put("statusLabel", "Programada")
            .put("editable", true).put("automatic", true).put("imageUrl", image ?: JSONObject.NULL).put("username", "synthetic").put("scheduledAt", 1000)
        return JSONObject().put("ok", true).put("enabled", true).put("operationsAllowed", false)
            .put("preferences", JSONObject().put("enabled", true).put("revision", 2)).put("connection", JSONObject.NULL)
            .put("items", JSONArray().put(item)).put("next", item)
    }
    @Test fun parserAcceptsOnlyOwnedImageEndpointAndNotExternalUrl() {
        assertEquals(1, parseCalendar(json("/v1/social/calendar/items/${"a".repeat(40)}/image")).items.size)
        assertThrows(IllegalArgumentException::class.java) { parseCalendar(json("https://example.com/private")) }
        assertThrows(IllegalArgumentException::class.java) { parseCalendar(json("/v1/social/calendar/items/${"b".repeat(40)}/image")) }
    }
    @Test fun parserRejectsRepeatedIdentityAndInvalidTime() {
        val root = json(); root.getJSONArray("items").put(root.getJSONArray("items").getJSONObject(0))
        assertThrows(IllegalArgumentException::class.java) { parseCalendar(root) }
        val badTime = json(); badTime.getJSONArray("items").getJSONObject(0).put("time", "25:00")
        assertThrows(IllegalArgumentException::class.java) { parseCalendar(badTime) }
    }
    @Test fun featureOffNeverInventsProgramming() { assertEquals(CalendarSnapshot(), parseCalendar(JSONObject().put("ok", true).put("enabled", false))) }
}
