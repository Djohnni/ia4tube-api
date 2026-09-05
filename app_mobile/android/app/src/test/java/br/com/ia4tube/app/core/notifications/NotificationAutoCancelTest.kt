package br.com.ia4tube.app.core.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationAutoCancelTest {
    @Test
    fun validTargetRequestsExactlyOneTargetedCancellation() {
        val target = NotificationNavigationTarget(
            eventId = EVENT_ID,
            pedidoId = "pedido-autocancel"
        )
        val cancelledEventIds = mutableListOf<String>()

        val resolved = autoCancelOnNotificationTap(target) { eventId ->
            cancelledEventIds += eventId
        }

        assertSame(target, resolved)
        assertEquals(listOf(EVENT_ID), cancelledEventIds)
    }

    @Test
    fun missingTargetDoesNotRequestCancellation() {
        val cancelledEventIds = mutableListOf<String>()

        val resolved = autoCancelOnNotificationTap(null) { eventId ->
            cancelledEventIds += eventId
        }

        assertNull(resolved)
        assertTrue(cancelledEventIds.isEmpty())
    }

    @Test
    fun notificationIdIsStableAndNonNegative() {
        val first = IA4TubeNotificationHelper.notificationIdForEvent(EVENT_ID)
        val second = IA4TubeNotificationHelper.notificationIdForEvent(EVENT_ID)

        assertEquals(first, second)
        assertTrue(first >= 0)
    }

    @Test
    fun cancellationTargetsOnlyTheTappedEvent() {
        val otherEventId = "art_12345678-1234-4123-8123-123456789abd"
        val cancelledEventIds = mutableListOf<String>()

        autoCancelOnNotificationTap(
            NotificationNavigationTarget(EVENT_ID, "pedido-a")
        ) { eventId ->
            cancelledEventIds += eventId
        }

        assertEquals(listOf(EVENT_ID), cancelledEventIds)
        assertTrue(
            IA4TubeNotificationHelper.notificationIdForEvent(EVENT_ID) !=
                IA4TubeNotificationHelper.notificationIdForEvent(otherEventId)
        )
    }

    private companion object {
        const val EVENT_ID = "art_12345678-1234-4123-8123-123456789abc"
    }
}
