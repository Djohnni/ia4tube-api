package br.com.ia4tube.app.feature.calendar

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CalendarImportReturnPollingTest {
    private val dispatcher = StandardTestDispatcher()
    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun close() { Dispatchers.resetMain() }
    private fun pending() = ScheduledArt("a".repeat(40), "synthetic:1", "2026-11-10", "12:30", "Legenda escolhida",
        1, "waiting_media", "Recebendo e conferindo vídeo", true, false, null, null, 1,
        destination = "reel", sourceKind = "upload", preparationPending = true, mediaReadAvailable = false, submissionState = "accepted")
    private class Fake(item: ScheduledArt) : CalendarGateway {
        var snapshot = CalendarSnapshot(enabled = true, items = listOf(item))
        var reads = 0
        var failure: Exception? = null
        val failures = java.util.ArrayDeque<Exception>()
        var response: CompletableDeferred<Unit>? = null
        override suspend fun list(): CalendarSnapshot {
            reads++; response?.await()
            if (failures.isNotEmpty()) throw failures.removeFirst()
            failure?.let { throw it }; return snapshot
        }
        override suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot = error("Observation cannot change publishing consent")
        override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot = error("Observation cannot edit or publish")
    }

    @Test fun visiblePendingImportReadsAtTenSecondsThenStopsWhenTheSameItemIsReady() = runTest(dispatcher) {
        val item = pending(); val gateway = Fake(item); val model = CalendarViewModel({ "session" }, "session", gateway)
        try {
            model.refresh(); runCurrent()
            val watch = launch { model.observePendingImportReturn(item.id) }; runCurrent()
            advanceTimeBy(9_999); runCurrent(); assertEquals(1, gateway.reads)
            val ready = item.copy(preparationPending = false, submissionState = "scheduled", status = "manual", mediaReadAvailable = true)
            gateway.snapshot = gateway.snapshot.copy(items = listOf(ready))
            advanceTimeBy(1); runCurrent()
            assertEquals(2, gateway.reads); assertEquals(ready, model.uiState.value.data.items.single())
            assertEquals(item.caption, model.uiState.value.data.items.single().caption)
            assertFalse(model.uiState.value.data.items.single().automatic)
            assertTrue(watch.isCompleted)
            val refreshed = model.uiState.value.imageRefresh
            advanceTimeBy(600_000); runCurrent()
            assertEquals(2, gateway.reads); assertEquals(refreshed, model.uiState.value.imageRefresh)
        } finally { model.dispose() }
    }

    @Test fun attentionAndRemovedItemsStopReadsWithoutChangingTheServerResult() = runTest(dispatcher) {
        for (removed in listOf(false, true)) {
            val item = pending(); val gateway = Fake(item); val model = CalendarViewModel({ "session" }, "session", gateway)
            try {
                model.refresh(); runCurrent()
                val watch = launch { model.observePendingImportReturn(item.id) }; runCurrent()
                gateway.snapshot = gateway.snapshot.copy(items = if (removed) emptyList() else listOf(item.copy(
                    status = "attention", submissionState = "attention")))
                advanceTimeBy(10_000); runCurrent()
                assertTrue(watch.isCompleted); assertEquals(gateway.snapshot, model.uiState.value.data)
                advanceTimeBy(600_000); runCurrent(); assertEquals(2, gateway.reads)
            } finally { model.dispose() }
        }
    }

    @Test fun leavingTheVisibleCardCancelsAnInFlightReadAndAllowsSafeResume() = runTest(dispatcher) {
        val item = pending(); val gateway = Fake(item); val model = CalendarViewModel({ "session" }, "session", gateway)
        try {
            model.refresh(); runCurrent()
            gateway.response = CompletableDeferred()
            val watch = launch { model.observePendingImportReturn(item.id) }; runCurrent()
            advanceTimeBy(10_000); runCurrent(); assertTrue(model.uiState.value.busy)
            watch.cancel(); runCurrent(); assertFalse(model.uiState.value.busy)
            gateway.snapshot = gateway.snapshot.copy(items = listOf(item.copy(submissionState = "attention", status = "attention")))
            gateway.response!!.complete(Unit); runCurrent()
            assertEquals("accepted", model.uiState.value.data.items.single().submissionState)
            advanceTimeBy(60_000); runCurrent(); assertEquals(2, gateway.reads)
            gateway.response = null
            val resumed = launch { model.observePendingImportReturn(item.id) }; runCurrent()
            advanceTimeBy(10_000); runCurrent()
            assertTrue(resumed.isCompleted); assertEquals(3, gateway.reads)
            assertEquals("attention", model.uiState.value.data.items.single().submissionState)
        } finally { model.dispose() }
    }

    @Test fun expiredSessionAndThreeTransientReadFailuresStopWithoutNewWork() = runTest(dispatcher) {
        for (sessionChanged in listOf(false, true)) {
            var token = "session"
            val item = pending(); val gateway = Fake(item); val model = CalendarViewModel({ token }, token, gateway)
            try {
                model.refresh(); runCurrent()
                val watch = launch { model.observePendingImportReturn(item.id) }; runCurrent()
                if (sessionChanged) token = "another-owner" else gateway.failure = CalendarFailure(503)
                advanceTimeBy(10_000); runCurrent()
                if (!sessionChanged) {
                    assertTrue(model.uiState.value.busy)
                    model.edit(item, "cancel"); runCurrent()
                    advanceTimeBy(20_000); runCurrent()
                    assertEquals(4, gateway.reads)
                }
                assertTrue(watch.isCompleted); assertFalse(model.uiState.value.fresh)
                assertFalse(model.uiState.value.busy)
                if (sessionChanged) assertTrue(model.uiState.value.data.items.isEmpty())
                else { assertEquals(item, model.uiState.value.data.items.single()); assertNotNull(model.uiState.value.error) }
                val reads = gateway.reads; advanceTimeBy(600_000); runCurrent(); assertEquals(reads, gateway.reads)
            } finally { model.dispose() }
        }
    }

    @Test fun twoTransientReadsRecoverTheSameItemWithoutFreeingMutationsBetweenAttempts() = runTest(dispatcher) {
        val item = pending(); val gateway = Fake(item); val model = CalendarViewModel({ "session" }, "session", gateway)
        try {
            model.refresh(); runCurrent()
            gateway.failures.add(CalendarFailure(503)); gateway.failures.add(java.io.IOException("synthetic network failure"))
            gateway.snapshot = gateway.snapshot.copy(items = listOf(item.copy(preparationPending = false, submissionState = "scheduled", status = "manual")))
            val watch = launch { model.observePendingImportReturn(item.id) }; runCurrent()
            advanceTimeBy(10_000); runCurrent(); assertTrue(model.uiState.value.busy)
            model.edit(item, "cancel"); runCurrent()
            advanceTimeBy(10_000); runCurrent(); assertTrue(model.uiState.value.busy)
            assertNull(model.uiState.value.error); assertEquals(3, gateway.reads)
            advanceTimeBy(10_000); runCurrent()
            assertTrue(watch.isCompleted); assertEquals(4, gateway.reads)
            assertFalse(model.uiState.value.busy); assertTrue(model.uiState.value.fresh)
            assertEquals(item.id, model.uiState.value.data.items.single().id)
            assertEquals(item.caption, model.uiState.value.data.items.single().caption)
        } finally { model.dispose() }
    }

    @Test fun authenticationAndDeterministicReadFailuresAreNotRetried() = runTest(dispatcher) {
        for (status in listOf(401, 403, 400, 409, 501)) {
            val item = pending(); val gateway = Fake(item); val model = CalendarViewModel({ "session" }, "session", gateway)
            try {
                model.refresh(); runCurrent(); gateway.failure = CalendarFailure(status)
                val watch = launch { model.observePendingImportReturn(item.id) }; runCurrent()
                advanceTimeBy(10_000); runCurrent()
                assertTrue(watch.isCompleted); assertFalse(model.uiState.value.busy); assertFalse(model.uiState.value.fresh)
                advanceTimeBy(600_000); runCurrent(); assertEquals(2, gateway.reads)
                if (status in setOf(401, 403)) assertTrue(model.uiState.value.data.items.isEmpty())
            } finally { model.dispose() }
        }
    }

    @Test fun waitingObservationHasAFiniteTenMinuteBudgetAndNeverPollsGeneratedArt() = runTest(dispatcher) {
        val item = pending(); val gateway = Fake(item); val model = CalendarViewModel({ "session" }, "session", gateway)
        try {
            model.refresh(); runCurrent()
            val watch = launch { model.observePendingImportReturn(item.id) }; runCurrent()
            advanceTimeBy(610_000); runCurrent()
            assertTrue(watch.isCompleted); assertFalse(model.uiState.value.busy)
            assertTrue(gateway.reads in 2..61)
            val reads = gateway.reads; advanceTimeBy(600_000); runCurrent(); assertEquals(reads, gateway.reads)
            gateway.snapshot = gateway.snapshot.copy(items = listOf(item.copy(sourceKind = "generated")))
            model.refresh(); runCurrent()
            model.observePendingImportReturn(item.id)
            advanceTimeBy(600_000); runCurrent(); assertEquals(reads + 1, gateway.reads)
        } finally { model.dispose() }
    }
}
