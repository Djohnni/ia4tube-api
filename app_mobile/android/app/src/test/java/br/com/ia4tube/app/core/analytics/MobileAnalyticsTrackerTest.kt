package br.com.ia4tube.app.core.analytics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class MobileAnalyticsTrackerTest {
    @Test
    fun sanitizePayloadKeepsStringValues() {
        val sanitized = MobileAnalyticsTracker.sanitizePayload(
            mapOf("origem" to "planejamento_mensal"),
        )

        assertEquals("planejamento_mensal", sanitized["origem"])
    }

    @Test
    fun sanitizePayloadKeepsIntValues() {
        val sanitized = MobileAnalyticsTracker.sanitizePayload(
            mapOf("quantidade" to 3),
        )

        assertEquals(3, sanitized["quantidade"])
    }

    @Test
    fun sanitizePayloadKeepsLongValues() {
        val sanitized = MobileAnalyticsTracker.sanitizePayload(
            mapOf("pedido_id" to 9_876_543_210L),
        )

        assertEquals(9_876_543_210L, sanitized["pedido_id"])
    }

    @Test
    fun sanitizePayloadKeepsDoubleValues() {
        val sanitized = MobileAnalyticsTracker.sanitizePayload(
            mapOf("valor_total" to 19.9),
        )

        assertEquals(19.9, sanitized["valor_total"])
    }

    @Test
    fun sanitizePayloadKeepsBooleanValues() {
        val sanitized = MobileAnalyticsTracker.sanitizePayload(
            mapOf("primeira_arte_gratis" to true),
        )

        assertEquals(true, sanitized["primeira_arte_gratis"])
    }

    @Test
    fun sanitizePayloadRejectsUnsupportedValuesSafely() {
        val sanitized = MobileAnalyticsTracker.sanitizePayload(
            mapOf<String, Any?>(
                "lista" to listOf("valor"),
                "mapa" to mapOf("chave" to "valor"),
                "objeto" to Any(),
                "nulo" to null,
                "ok" to "valor",
            ),
        )

        assertEquals(mapOf("ok" to "valor"), sanitized)
    }

    @Test
    fun sanitizePayloadRejectsSensitiveKeysAndLargeImageStrings() {
        val sanitized = MobileAnalyticsTracker.sanitizePayload(
            mapOf(
                "token" to "segredo",
                "senha" to "segredo",
                "imagem" to "data:image/png;base64,abc",
                "descricao" to "ok",
            ),
        )

        assertFalse(sanitized.containsKey("token"))
        assertFalse(sanitized.containsKey("senha"))
        assertFalse(sanitized.containsKey("imagem"))
        assertEquals("ok", sanitized["descricao"])
    }
}