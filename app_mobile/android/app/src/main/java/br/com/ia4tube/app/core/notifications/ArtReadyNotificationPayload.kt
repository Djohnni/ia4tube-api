package br.com.ia4tube.app.core.notifications

internal data class ArtReadyNotificationPayload(
    val eventId: String,
    val pedidoId: String
) {
    companion object {
        const val SCHEMA_VERSION = "1"
        const val TYPE = "arte_pronta"
        const val TITLE = "Sua arte está pronta!"
        const val BODY = "Toque para visualizar sua criação na IA4Tube."

        val EXPECTED_KEYS = setOf(
            "schema_version",
            "tipo",
            "event_id",
            "pedido_id",
            "title",
            "body"
        )

        fun parse(
            hasNotificationBlock: Boolean,
            data: Map<String, String>
        ): ArtReadyNotificationPayload? {
            if (hasNotificationBlock || data.keys != EXPECTED_KEYS) return null
            if (data["schema_version"] != SCHEMA_VERSION) return null
            if (data["tipo"] != TYPE) return null
            if (data["title"] != TITLE || data["body"] != BODY) return null

            val eventId = data["event_id"].orEmpty()
            val pedidoId = data["pedido_id"].orEmpty()
            if (!isSafeEventId(eventId) || !isSafePedidoId(pedidoId)) return null
            return ArtReadyNotificationPayload(
                eventId = eventId,
                pedidoId = pedidoId
            )
        }

        fun isSafeEventId(value: String): Boolean {
            return EVENT_ID_PATTERN.matches(value)
        }

        fun isSafePedidoId(value: String): Boolean {
            return PEDIDO_ID_PATTERN.matches(value)
        }

        private val EVENT_ID_PATTERN = Regex(
            "^art_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-" +
                "[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
        )
        private val PEDIDO_ID_PATTERN = Regex(
            "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        )
    }
}
