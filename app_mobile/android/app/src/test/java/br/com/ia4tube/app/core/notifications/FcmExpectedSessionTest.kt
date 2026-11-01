package br.com.ia4tube.app.core.notifications

import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class FcmExpectedSessionTest {
    @Test fun staleSessionIsRefusedBeforeWaitingForTheMutex() = runTest {
        val mutex = Mutex(locked = true)
        var calls = 0
        val result = withExpectedFcmSession("synthetic-a", { "synthetic-b" }, mutex,
            stale = { "stale" }) { calls++; "entered" }
        assertEquals("stale", result); assertEquals(0, calls); assertTrue(mutex.isLocked)
        mutex.unlock()
    }
    @Test fun accountChangedWhileWaitingIsRefusedInsideTheMutex() = runTest {
        val mutex = Mutex(locked = true); var token = "synthetic-a"; var calls = 0
        val pending = async {
            withExpectedFcmSession("synthetic-a", { token }, mutex, stale = { "stale" }) { calls++; "entered" }
        }
        runCurrent(); assertFalse(pending.isCompleted)
        token = "synthetic-b"; mutex.unlock(); runCurrent()
        assertEquals("stale", pending.await()); assertEquals(0, calls)
    }
    @Test fun unchangedSessionEntersExactlyOnceAndKeepsTheOriginalResult() = runTest {
        var calls = 0
        val result = withExpectedFcmSession("synthetic-a", { "synthetic-a" }, Mutex(),
            stale = { "stale" }) { calls++; "entered" }
        assertEquals("entered", result); assertEquals(1, calls)
    }
    @Test fun legacyDefaultDoesNotAddAnAuthenticationReadOrChangeItsOperation() = runTest {
        var calls = 0
        val result = withExpectedFcmSession(null, { error("legacy must not add a token read") }, Mutex(),
            stale = { "stale" }) { calls++; "legacy" }
        assertEquals("legacy", result); assertEquals(1, calls)
        assertFalse(fcmSessionMatches("", { "" }))
    }
}
