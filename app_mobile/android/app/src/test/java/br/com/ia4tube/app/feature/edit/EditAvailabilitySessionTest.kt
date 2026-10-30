package br.com.ia4tube.app.feature.edit

import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Injected reads and monotonic time only: no real HTTP, device, quota writes or calendar context. */
@OptIn(ExperimentalCoroutinesApi::class)
class EditAvailabilitySessionTest {
    private val dispatcher = StandardTestDispatcher()
    private val store = ViewModelStore()
    private val pending = mutableListOf<CompletableDeferred<EditAvailabilitySnapshot>>()
    private val token = "synthetic-availability-account-a"
    private val otherToken = "synthetic-availability-account-b"
    private val nonce = "A".repeat(43)
    private val otherNonce = "B".repeat(43)
    private val request = "56336c2f-53a8-4db0-996d-317088f1c827"
    private var elapsed = 1_000L
    private var owners = 0

    @Before fun before() { Dispatchers.setMain(dispatcher) }
    @After fun after() {
        try {
            pending.forEach { if (!it.isCompleted) it.complete(snapshot(null, null)) }
            store.clear()
            dispatcher.scheduler.runCurrent()
        } finally { Dispatchers.resetMain() }
    }

    private fun snapshot(image: Boolean? = false, video: Boolean? = true, lifetime: Long = 30_000L) =
        // Deliberately unrelated to the device wall clock: only the duration is meaningful here.
        EditAvailabilitySnapshot(image, video, 1_000_000L, 1_000_000L + lifetime)
    private fun gate() = CompletableDeferred<EditAvailabilitySnapshot>().also { pending += it }
    private fun createState(read: suspend (String) -> EditAvailabilitySnapshot) = EditAvailabilityViewModel(
        loadAvailability = read, elapsedMs = { elapsed },
    ).also { store.put("availability-${owners++}", it) }

    @Test fun refreshStartsUnknownThenPublishesTheSameRevisionWithoutDependingOnWallClock() = runTest(dispatcher) {
        val response = gate()
        var reads = 0
        val state = createState { reads++; response.await() }
        state.refresh(token, nonce)
        val initial = requireNotNull(state.reply)
        assertTrue(state.busy)
        assertTrue(initial.loading)
        assertNull(initial.canImage); assertNull(initial.canVideo); assertNull(initial.requestId)
        assertEquals(0L, state.validForMs(initial))
        assertTrue(state.canDeliver(initial, token, nonce))
        assertFalse(initial.toString().contains(token))
        runCurrent()
        response.complete(snapshot(false, true)); runCurrent()
        val fresh = requireNotNull(state.reply)
        assertEquals(initial.revision, fresh.revision)
        assertFalse(fresh.loading)
        assertEquals(false, fresh.canImage); assertEquals(true, fresh.canVideo)
        assertEquals(30_000L, state.validForMs(fresh))
        assertEquals(elapsed + 30_000L, fresh.validUntilElapsedMs)
        assertEquals(1, reads); assertFalse(state.busy)
    }

    @Test fun elapsedRequestTimeIsDiscountedAndExpiredResponsesRemainUnknown() = runTest(dispatcher) {
        val response = gate()
        val state = createState { response.await() }
        state.refresh(token, nonce); runCurrent()
        elapsed += 7_000L
        response.complete(snapshot(false, false)); runCurrent()
        val fresh = requireNotNull(state.reply)
        assertEquals(23_000L, state.validForMs(fresh))
        elapsed += 1_000L
        assertEquals(22_000L, state.validForMs(fresh))
        elapsed += 22_000L
        assertEquals(0L, state.validForMs(fresh))

        val late = gate()
        val lateState = createState { late.await() }
        lateState.refresh(token, nonce); runCurrent(); elapsed += 1_001L
        late.complete(snapshot(false, false, lifetime = 1_000L)); runCurrent()
        val expired = requireNotNull(lateState.reply)
        assertNull(expired.canImage); assertNull(expired.canVideo)
        assertEquals(0L, lateState.validForMs(expired))
    }

    @Test fun missingAuthenticationAndReadErrorsNeverTurnUnknownIntoAnExhaustedHint() = runTest(dispatcher) {
        var reads = 0
        val anonymous = createState { reads++; snapshot(false, false) }
        anonymous.refresh("", nonce); runCurrent()
        assertEquals(0, reads); assertFalse(anonymous.busy)
        assertFalse(requireNotNull(anonymous.reply).loading)
        assertNull(anonymous.reply?.canImage); assertNull(anonymous.reply?.canVideo)
        for (code in listOf("auth_required", "availability_unavailable", "invalid_availability_response")) {
            val failed = createState { throw EditAvailabilityException(code) }
            failed.request(request, token, nonce); runCurrent()
            val reply = requireNotNull(failed.reply)
            assertEquals(request, reply.requestId)
            assertFalse(reply.loading)
            assertNull(reply.canImage); assertNull(reply.canVideo)
            assertEquals(0L, failed.validForMs(reply)); assertFalse(failed.busy)
        }
    }

    @Test fun invalidSnapshotLifetimeCannotCreateAConfirmedBlock() = runTest(dispatcher) {
        for (lifetime in listOf(-1L, 0L, 30_001L)) {
            val state = createState { snapshot(false, false, lifetime) }
            state.refresh(token, nonce); runCurrent()
            val reply = requireNotNull(state.reply)
            assertNull(reply.canImage); assertNull(reply.canVideo)
            assertEquals(0L, state.validForMs(reply))
        }
    }

    @Test fun sameSessionPreservesResultButAccountDocumentOrLogoutFencesIt() = runTest(dispatcher) {
        var reads = 0
        val state = createState { reads++; snapshot(false, true) }
        state.refresh(token, nonce); runCurrent()
        val old = requireNotNull(state.reply)
        assertFalse(state.synchronizeSession(token, nonce))
        assertSame(old, state.reply)
        assertTrue(state.canDeliver(old, token, nonce))
        assertFalse(state.canDeliver(old, otherToken, nonce))
        assertFalse(state.canDeliver(old, token, otherNonce))
        assertTrue(state.synchronizeSession(token, otherNonce))
        assertNull(state.reply); assertFalse(state.busy)
        assertFalse(state.canDeliver(old, token, nonce))
        assertTrue(state.synchronizeSession(otherToken, otherNonce))
        assertTrue(state.synchronizeSession("", otherNonce))
        state.refresh("", otherNonce); runCurrent()
        assertEquals(1, reads)
        assertNull(state.reply?.canImage); assertNull(state.reply?.canVideo)
        assertFalse(state.canDeliver(old, token, nonce))
    }

    @Test fun cancelledOldAccountReadCannotOverwriteOrClearTheNewAccountsBusyState() = runTest(dispatcher) {
        val old = gate(); val current = gate()
        val state = createState { account ->
            if (account == token) withContext(NonCancellable) { old.await() } else current.await()
        }
        state.refresh(token, nonce); runCurrent()
        val oldReply = requireNotNull(state.reply)
        state.refresh(otherToken, otherNonce); runCurrent()
        val waiting = requireNotNull(state.reply)
        old.complete(snapshot(false, false)); runCurrent()
        assertSame(waiting, state.reply); assertTrue(state.busy)
        assertFalse(state.canDeliver(oldReply, token, nonce))
        current.complete(snapshot(true, false)); runCurrent()
        val fresh = requireNotNull(state.reply)
        assertEquals(true, fresh.canImage); assertEquals(false, fresh.canVideo)
        assertTrue(state.canDeliver(fresh, otherToken, otherNonce)); assertFalse(state.busy)
    }

    @Test fun returningFromAccountAToBToADoesNotReviveTheFirstARevision() = runTest(dispatcher) {
        val old = gate(); val current = gate()
        var reads = 0
        val state = createState {
            reads++
            if (reads == 1) withContext(NonCancellable) { old.await() } else current.await()
        }
        state.refresh(token, nonce); runCurrent()
        val first = requireNotNull(state.reply)
        state.synchronizeSession(otherToken, nonce)
        state.synchronizeSession(token, nonce)
        state.refresh(token, nonce); runCurrent()
        current.complete(snapshot(true, false)); runCurrent()
        val latest = requireNotNull(state.reply)
        old.complete(snapshot(false, false)); runCurrent()
        assertSame(latest, state.reply)
        assertTrue(latest.revision > first.revision)
        assertFalse(state.canDeliver(first, token, nonce))
        assertEquals(true, latest.canImage); assertEquals(false, latest.canVideo)
    }

    @Test fun postAckRequestForcesFreshReadAndCorrelatesBothUnknownAndFinalReply() = runTest(dispatcher) {
        val initial = gate(); val afterAck = gate()
        var reads = 0
        val state = createState {
            reads++
            if (reads == 1) withContext(NonCancellable) { initial.await() } else afterAck.await()
        }
        state.refresh(token, nonce); runCurrent()
        val first = requireNotNull(state.reply)
        state.request(request, token, nonce); runCurrent()
        val waiting = requireNotNull(state.reply)
        assertEquals(request, waiting.requestId)
        assertTrue(waiting.loading)
        assertTrue(waiting.revision > first.revision)
        assertNull(waiting.canImage); assertNull(waiting.canVideo)
        initial.complete(snapshot(true, true)); runCurrent()
        assertSame(waiting, state.reply); assertTrue(state.busy)
        afterAck.complete(snapshot(false, true)); runCurrent()
        val fresh = requireNotNull(state.reply)
        assertEquals(request, fresh.requestId)
        assertFalse(fresh.loading)
        assertEquals(waiting.revision, fresh.revision)
        assertEquals(false, fresh.canImage); assertEquals(true, fresh.canVideo)
        state.request(request, token, nonce); runCurrent()
        assertEquals(2, reads)
        assertSame(fresh, state.reply)
    }

    @Test fun invalidRequestIdsAndRapidResumeCannotDuplicateReads() = runTest(dispatcher) {
        var reads = 0
        val state = createState { reads++; snapshot() }
        state.request("not-a-request", token, nonce); runCurrent()
        assertEquals(0, reads); assertNull(state.reply)
        state.refresh(token, nonce); runCurrent()
        val known = requireNotNull(state.reply)
        state.refresh(token, nonce); runCurrent()
        assertEquals(1, reads); assertSame(known, state.reply)
        elapsed += 251L
        state.refresh(token, nonce); runCurrent()
        assertEquals(2, reads)
    }

    @Test fun deliveringAnOldReplyCannotClearTheNewReadOrItsPendingResult() = runTest(dispatcher) {
        val state = createState { snapshot(false, false) }
        state.refresh(token, nonce); runCurrent()
        val old = requireNotNull(state.reply)
        state.refresh(token, nonce, force = true)
        val waiting = requireNotNull(state.reply)
        assertNull(waiting.canImage); assertNull(waiting.canVideo)
        state.delivered(old)
        assertSame(waiting, state.reply)
        state.delivered(waiting)
        assertNull(state.reply)
        runCurrent()
        val fresh = requireNotNull(state.reply)
        assertEquals(waiting.revision, fresh.revision)
        assertEquals(false, fresh.canImage); assertEquals(false, fresh.canVideo)
    }

    @Test fun pendingPostAckCorrelationSurvivesLoadingDeliveryAndResumeUntilFinalDelivery() = runTest(dispatcher) {
        val first = gate(); val resumed = gate()
        var reads = 0
        val state = createState {
            when (++reads) { 1 -> first.await(); 2 -> resumed.await(); else -> snapshot(true, true) }
        }
        state.request(request, token, nonce)
        val initial = requireNotNull(state.reply)
        assertTrue(initial.loading); assertEquals(request, initial.requestId)
        state.delivered(initial)
        assertNull(state.reply)
        runCurrent(); first.complete(snapshot(false, true)); runCurrent()
        val notYetDelivered = requireNotNull(state.reply)
        assertFalse(notYetDelivered.loading)
        elapsed += 251L
        state.refresh(token, nonce)
        val resumedLoading = requireNotNull(state.reply)
        assertTrue(resumedLoading.loading)
        assertEquals(request, resumedLoading.requestId)
        state.delivered(notYetDelivered)
        assertSame(resumedLoading, state.reply)
        state.delivered(resumedLoading)
        runCurrent(); resumed.complete(snapshot(false, false)); runCurrent()
        val final = requireNotNull(state.reply)
        assertFalse(final.loading); assertEquals(request, final.requestId)
        state.delivered(final)
        assertNull(state.reply)
        state.refresh(token, nonce, force = true)
        assertNull(state.reply?.requestId)
        runCurrent()
        assertNull(state.reply?.requestId)
        assertEquals(3, reads)
    }
}
