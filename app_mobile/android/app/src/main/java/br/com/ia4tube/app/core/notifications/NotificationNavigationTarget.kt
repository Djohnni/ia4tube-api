package br.com.ia4tube.app.core.notifications

import android.content.Intent

data class NotificationNavigationTarget(
    val tipo: String,
    val route: String,
    val pedidoId: String,
    val planejamentoId: String,
    val planejamentoItemId: String,
    val nonce: Long = System.nanoTime()
)

fun Intent?.toNotificationNavigationTarget(): NotificationNavigationTarget? {
    val extras = this?.extras ?: return null

    fun read(vararg keys: String): String {
        for (key in keys) {
            val value = extras.getString(key)?.trim().orEmpty()
            if (value.isNotBlank()) return value
        }
        return ""
    }

    val tipo = read("tipo", "type")
    val route = read("route", "destino")
    val pedidoId = read("pedido_id", "pedidoId")
    val planejamentoId = read("planejamento_id", "planning_id", "planningId")
    val planejamentoItemId = read("planejamento_item_id", "planning_item_id", "planningItemId")

    if (
        tipo.isBlank() &&
        route.isBlank() &&
        pedidoId.isBlank() &&
        planejamentoId.isBlank() &&
        planejamentoItemId.isBlank()
    ) {
        return null
    }

    return NotificationNavigationTarget(
        tipo = tipo,
        route = route,
        pedidoId = pedidoId,
        planejamentoId = planejamentoId,
        planejamentoItemId = planejamentoItemId
    )
}
