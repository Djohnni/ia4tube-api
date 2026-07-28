package br.com.ia4tube.app.core.notifications

import android.content.Intent

data class NotificationNavigationTarget(
    val eventId: String,
    val pedidoId: String
) {
    val nonce: Long = eventId.hashCode().toLong()
}

fun Intent?.toNotificationNavigationTarget(): NotificationNavigationTarget? {
    val intent = this ?: return null
    if (intent.action != IA4TubeNotificationHelper.ACTION_OPEN_ART_READY) return null

    val eventId = intent.getStringExtra(IA4TubeNotificationHelper.EXTRA_EVENT_ID)
        ?.trim()
        .orEmpty()
    val pedidoId = intent.getStringExtra(IA4TubeNotificationHelper.EXTRA_PEDIDO_ID)
        ?.trim()
        .orEmpty()
    val type = intent.getStringExtra(IA4TubeNotificationHelper.EXTRA_TYPE)
        ?.trim()
        .orEmpty()
    if (
        type != ArtReadyNotificationPayload.TYPE ||
        !ArtReadyNotificationPayload.isSafeEventId(eventId) ||
        !ArtReadyNotificationPayload.isSafePedidoId(pedidoId)
    ) {
        return null
    }

    return NotificationNavigationTarget(
        eventId = eventId,
        pedidoId = pedidoId
    )
}
