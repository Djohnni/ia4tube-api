package br.com.ia4tube.app.core.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ArtReadyNotificationPayloadTest {
    private val validData = mapOf(
        "schema_version" to "1",
        "tipo" to "arte_pronta",
        "event_id" to "art_12345678-1234-4abc-8def-1234567890ab",
        "pedido_id" to "pedido-sintetico-001",
        "title" to "Sua arte está pronta!",
        "body" to "Toque para visualizar sua criação na IA4Tube."
    )

    @Test
    fun acceptsOnlyTheControlledDataOnlyContract() {
        val payload = ArtReadyNotificationPayload.parse(
            hasNotificationBlock = false,
            data = validData
        )
        assertNotNull(payload)
        assertEquals("art_12345678-1234-4abc-8def-1234567890ab", payload?.eventId)
        assertEquals("pedido-sintetico-001", payload?.pedidoId)
    }

    @Test
    fun rejectsNotificationBlockAndEveryExtraField() {
        assertNull(
            ArtReadyNotificationPayload.parse(
                hasNotificationBlock = true,
                data = validData
            )
        )
        assertNull(
            ArtReadyNotificationPayload.parse(
                hasNotificationBlock = false,
                data = validData + ("image" to "https://example.invalid/image.jpg")
            )
        )
        assertNull(
            ArtReadyNotificationPayload.parse(
                hasNotificationBlock = false,
                data = validData + ("route" to "orders")
            )
        )
    }

    @Test
    fun rejectsChangedTextAndUnsafeIdentifiers() {
        assertNull(
            ArtReadyNotificationPayload.parse(
                hasNotificationBlock = false,
                data = validData + ("title" to "Texto arbitrario")
            )
        )
        assertNull(
            ArtReadyNotificationPayload.parse(
                hasNotificationBlock = false,
                data = validData + ("pedido_id" to "../outro-cliente")
            )
        )
        assertFalse(ArtReadyNotificationPayload.isSafeEventId("event_20260728_0001"))
        assertFalse(ArtReadyNotificationPayload.isSafePedidoId(".pedido"))
        assertTrue(ArtReadyNotificationPayload.isSafePedidoId("pedido:2026-07.28"))
    }
}
