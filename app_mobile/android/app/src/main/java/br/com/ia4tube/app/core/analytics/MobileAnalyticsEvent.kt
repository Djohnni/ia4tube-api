package br.com.ia4tube.app.core.analytics

data class MobileAnalyticsEvent(
    val evento: String,
    val tela: String = "",
    val produto: String = "",
    val etapa: String = "",
    val campoAtual: String = "",
    val pedidoId: String = "",
    val payload: Map<String, String> = emptyMap(),
    val timestamp: Long = System.currentTimeMillis()
)
