package br.com.ia4tube.app.core.notifications

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationEventLedgerTest {
    @Test
    fun sameEventIsAcceptedOnlyOnceAcrossReloads() {
        val first = NotificationEventLedger.mark(
            serialized = "",
            eventId = eventId(1),
            nowMs = 1_000L
        )
        val repeated = NotificationEventLedger.mark(
            serialized = first.serialized,
            eventId = eventId(1),
            nowMs = 2_000L
        )
        assertTrue(first.isNew)
        assertFalse(repeated.isNew)
    }

    @Test
    fun distinctEventsRemainIndependent() {
        val first = NotificationEventLedger.mark(
            serialized = "",
            eventId = eventId(1),
            nowMs = 1_000L
        )
        val second = NotificationEventLedger.mark(
            serialized = first.serialized,
            eventId = eventId(2),
            nowMs = 2_000L
        )
        assertTrue(second.isNew)
    }

    @Test
    fun failedDisplayCanReleaseTheEventForOneControlledRetry() {
        val first = NotificationEventLedger.mark(
            serialized = "",
            eventId = eventId(1),
            nowMs = 1_000L
        )
        val released = NotificationEventLedger.forget(
            serialized = first.serialized,
            eventId = eventId(1)
        )
        val retried = NotificationEventLedger.mark(
            serialized = released,
            eventId = eventId(1),
            nowMs = 2_000L
        )

        assertTrue(first.isNew)
        assertTrue(retried.isNew)
    }

    @Test
    fun ledgerIsBoundedAndOldestEventCanBeAcceptedAfterEviction() {
        var serialized = ""
        repeat(129) { index ->
            val result = NotificationEventLedger.mark(
                serialized = serialized,
                eventId = eventId(index),
                nowMs = 1_000L + index
            )
            assertTrue(result.isNew)
            serialized = result.serialized
        }

        val firstAgain = NotificationEventLedger.mark(
            serialized = serialized,
            eventId = eventId(0),
            nowMs = 2_000L
        )
        assertTrue(firstAgain.isNew)
    }

    private fun eventId(index: Int): String {
        return "art_12345678-1234-4abc-8def-${index.toString().padStart(12, '0')}"
    }
}
