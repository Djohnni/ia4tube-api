package br.com.ia4tube.app.feature.edit

import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.test.resetMain
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.util.concurrent.TimeUnit

/** Only a local MockWebServer is used; no production credentials or API calls. */
@OptIn(ExperimentalCoroutinesApi::class)
class EditCalendarOrderScheduleTest {
    private val dispatcher = StandardTestDispatcher()
    private val token = "synthetic-edit-order-session"
    private val firstId = "56336c2f-53a8-4db0-996d-317088f1c827"
    private val secondId = "a629117b-5f4e-4541-a63f-166f44ccbdf3"
    private val thirdId = "6e57ee36-ef8d-49fb-9152-b012d4e550fb"
    private lateinit var server: MockWebServer
    private lateinit var store: ViewModelStore
    private lateinit var state: EditCalendarViewModel
    private var clientCreations = 0

    @Before fun before() {
        Dispatchers.setMain(dispatcher)
        server = MockWebServer().also { it.start() }
        store = ViewModelStore()
        state = EditCalendarViewModel {
            clientCreations++
            EditCalendarClient(server.url("/").toString())
        }
        store.put("edit-calendar", state)
        state.synchronizeSession(token)
    }

    @After fun after() {
        try { store.clear(); dispatcher.scheduler.runCurrent(); server.shutdown() }
        finally { Dispatchers.resetMain() }
    }

    private fun schedule(days: Long, time: String) = EditCalendarSchedule(LocalDate.now().plusDays(days).toString(), time)
    private fun success(id: String) = MockResponse().setBody(JSONObject().put("ok", true)
        .put("ticket", "$id.${"A".repeat(43)}")
        .put("expiresAt", Instant.now().plusSeconds(300).toString()).toString())

    private fun awaitReply(id: String): EditCalendarReply {
        // OkHttp runs on Dispatchers.IO. Pump only this isolated Main scheduler
        // while allowing the local server's real IO thread to return its bytes.
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (state.busy && System.nanoTime() < deadline) {
            dispatcher.scheduler.runCurrent()
            if (state.busy) Thread.sleep(5)
        }
        dispatcher.scheduler.runCurrent()
        assertFalse("The controlled local request must finish", state.busy)
        return requireNotNull(state.reply).also { assertEquals(id, it.requestId) }
    }

    private fun nextRequest(): RecordedRequest = requireNotNull(server.takeRequest(5, TimeUnit.SECONDS))
    private fun assertSchedule(request: RecordedRequest, id: String, selected: EditCalendarSchedule) {
        assertEquals("POST", request.method)
        assertEquals("/empresa/edit/context", request.path)
        val body = JSONObject(request.body.readUtf8())
        assertEquals(id, body.getString("requestId"))
        assertEquals(selected.date, body.getString("date"))
        assertEquals(selected.time, body.getString("time"))
        assertEquals(selected.destination, body.getString("destination"))
    }

    @Test fun restrictedStoryImagesReopenAnOldFeedSelectionBeforeCreatingAnyContext() {
        state.setStoryImagesOnly(true)
        val selected=schedule(1,"18:00").copy(destination="both")
        state.chooseSchedule(selected,token)
        state.request(firstId,token,"image")
        assertTrue(state.choosingSchedule)
        assertEquals(0,server.requestCount)
        server.enqueue(success(firstId))
        val story=selected.copy(destination="story")
        state.chooseSchedule(story,token)
        assertNotNull(awaitReply(firstId).ticket)
        assertSchedule(nextRequest(),firstId,story)
    }

    private fun completeFirst(selected: EditCalendarSchedule = schedule(1, "18:00")): EditCalendarReply {
        server.enqueue(success(firstId))
        state.request(firstId, token)
        assertTrue(state.choosingSchedule)
        state.chooseSchedule(selected, token)
        val reply = awaitReply(firstId)
        assertNotNull(reply.ticket)
        state.delivered(reply)
        return reply
    }

    @Test fun twoOrdersInTheSameOpeningRequireSeparateSelectionsBeforeTheirPosts() = runTest(dispatcher) {
        val nonce = state.nonce
        val first = schedule(1, "18:00")
        val second = schedule(2, "19:30")
        completeFirst(first)
        assertNull(state.schedule)
        assertSchedule(nextRequest(), firstId, first)

        state.request(secondId, token)
        runCurrent()
        assertTrue("A new order must ask again", state.choosingSchedule)
        assertFalse(state.busy)
        assertEquals("No second POST before the second selection", 1, server.requestCount)
        server.enqueue(success(secondId))
        state.chooseSchedule(second, token)
        val reply = awaitReply(secondId)
        assertSchedule(nextRequest(), secondId, second)
        assertNull(state.schedule)
        state.delivered(reply)

        state.request(thirdId, token)
        assertTrue(state.choosingSchedule)
        assertEquals(2, server.requestCount)
        assertEquals(nonce, state.nonce)
    }

    @Test fun lostResponseRetryKeepsItsOriginalTimeWithoutConsumingTheNextManualSelection() = runTest(dispatcher) {
        val first = schedule(1, "18:00")
        val preparedNext = schedule(3, "20:15")
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        state.request(firstId, token)
        state.chooseSchedule(first, token)
        val failure = awaitReply(firstId)
        assertEquals("calendar_unavailable", failure.error)
        assertNull(state.schedule)
        assertSchedule(nextRequest(), firstId, first)
        state.delivered(failure)

        state.openSchedule()
        state.chooseSchedule(preparedNext, token)
        assertEquals(preparedNext, state.schedule)
        server.enqueue(success(firstId))
        state.request(firstId, token)
        assertFalse(state.choosingSchedule)
        val retry = awaitReply(firstId)
        assertSchedule(nextRequest(), firstId, first)
        assertEquals("Retry cannot consume the prepared next order", preparedNext, state.schedule)
        state.delivered(retry)

        server.enqueue(success(secondId))
        state.request(secondId, token)
        assertFalse("The explicit Calendar selection is still usable once", state.choosingSchedule)
        val second = awaitReply(secondId)
        assertSchedule(nextRequest(), secondId, preparedNext)
        assertNull(state.schedule)
        state.delivered(second)
        state.request(thirdId, token)
        assertTrue(state.choosingSchedule)
        assertEquals(3, server.requestCount)
        assertEquals(1, clientCreations)
    }

    @Test fun cancellingTheSecondSelectionDoesNotSendOrInheritTheFirstTime() = runTest(dispatcher) {
        completeFirst()
        nextRequest()
        state.request(secondId, token)
        assertTrue(state.choosingSchedule)
        state.cancelSchedule()
        val cancelled = requireNotNull(state.reply)
        assertEquals(secondId, cancelled.requestId)
        assertEquals("cancelled", cancelled.error)
        assertNull(cancelled.ticket)
        assertNull(state.schedule)
        assertEquals(1, server.requestCount)
        state.delivered(cancelled)
        state.request(secondId, token)
        assertTrue(state.choosingSchedule)
        assertEquals(1, server.requestCount)
    }

    @Test fun accountSwitchInvalidatesFrozenAndPreparedSelectionsWithoutPosting() = runTest(dispatcher) {
        val oldReply = completeFirst()
        nextRequest()
        state.openSchedule()
        state.chooseSchedule(schedule(3, "20:15"), token)
        val oldNonce = state.nonce
        assertTrue(state.synchronizeSession("synthetic-other-session"))
        assertNotEquals(oldNonce, state.nonce)
        assertNull(state.schedule)
        assertNull(state.reply)
        assertFalse(state.canDeliver(oldReply, "synthetic-other-session"))
        state.request(firstId, "synthetic-other-session")
        assertTrue("Even a formerly frozen UUID cannot reuse the prior account's time", state.choosingSchedule)
        assertEquals(1, server.requestCount)
    }

    @Test fun typedRetryRetainsBothPlacementsAndNewOrderRequiresANewChoice() = runTest(dispatcher) {
        val first = schedule(1, "18:00").copy(destination = "both")
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        state.request(firstId, token, "image")
        assertEquals("image", state.mediaKind)
        assertTrue(state.showDestinations)
        state.chooseSchedule(first, token)
        assertEquals("calendar_unavailable", awaitReply(firstId).error)
        assertSchedule(nextRequest(), firstId, first)
        state.delivered(requireNotNull(state.reply))
        server.enqueue(success(firstId))
        state.request(firstId, token, "video")
        assertNotNull(awaitReply(firstId).ticket)
        assertSchedule(nextRequest(), firstId, first)
        state.delivered(requireNotNull(state.reply))
        state.request(secondId, token, "video")
        assertTrue(state.choosingSchedule)
        assertEquals("video", state.mediaKind)
        assertNull(state.schedule)
        assertEquals(2, server.requestCount)
    }

    @Test fun explicitStoryRejectionReopensSameIntentBeforeAnyRetryOrNewTicket() = runTest(dispatcher) {
        val selected = schedule(1, "18:00").copy(destination = "both")
        server.enqueue(MockResponse().setResponseCode(409).setBody(JSONObject()
            .put("code", "edit_calendar_story_business_required").put("error", "Business required").toString()))
        state.request(firstId, token, "image")
        state.chooseSchedule(selected, token)
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (state.busy && System.nanoTime() < deadline) {
            dispatcher.scheduler.runCurrent()
            if (state.busy) Thread.sleep(5)
        }
        dispatcher.scheduler.runCurrent()
        assertFalse(state.busy)
        assertTrue(state.choosingSchedule)
        assertNotNull(state.destinationError)
        assertEquals(selected, state.schedule)
        assertNull("Web request stays pending for the corrected choice", state.reply)
        assertSchedule(nextRequest(), firstId, selected)
        assertEquals(1, server.requestCount)
        server.enqueue(success(firstId))
        val feedOnly = selected.copy(destination = "feed")
        state.chooseSchedule(feedOnly, token)
        assertNotNull(awaitReply(firstId).ticket)
        assertSchedule(nextRequest(), firstId, feedOnly)
        assertNull(state.destinationError)
        assertEquals(2, server.requestCount)
    }

    @Test fun legacyPageNeverInheritsNewHeaderPlacementOrAdditionalFields() = runTest(dispatcher) {
        state.openSchedule()
        assertTrue(state.showDestinations)
        state.chooseSchedule(schedule(1, "18:00").copy(destination = "both"), token)
        server.enqueue(success(firstId))
        state.request(firstId, token)
        assertNotNull(awaitReply(firstId).ticket)
        assertSchedule(nextRequest(), firstId, schedule(1, "18:00"))
    }

    @Test fun authenticationAndCancelledChoiceNeverInstantiateTheContextClient() = runTest(dispatcher) {
        assertEquals(0, clientCreations)
        state.synchronizeSession("")
        state.request(firstId, "")
        assertEquals("auth_required", state.reply?.error)
        assertEquals(0, clientCreations)
        state.synchronizeSession(token)
        state.request(firstId, token)
        assertTrue(state.choosingSchedule)
        assertEquals(0, clientCreations)
        state.cancelSchedule()
        assertEquals(0, clientCreations)
        assertEquals(0, server.requestCount)
    }
}
