package br.com.ia4tube.app.core.analytics

internal class MobileAnalyticsQueue(
    private val maxSize: Int = 120
) {
    private val events = ArrayDeque<MobileAnalyticsEvent>()
    private var lastSignature = ""

    fun add(event: MobileAnalyticsEvent): Boolean {
        val signature = listOf(
            event.evento,
            event.tela,
            event.produto,
            event.etapa,
            event.campoAtual,
            event.pedidoId
        ).joinToString("|")

        if (signature == lastSignature) return false
        lastSignature = signature

        events.addLast(event)
        while (events.size > maxSize) events.removeFirst()
        return true
    }

    fun drain(limit: Int): List<MobileAnalyticsEvent> {
        val drained = mutableListOf<MobileAnalyticsEvent>()
        repeat(minOf(limit, events.size)) {
            drained.add(events.removeFirst())
        }
        return drained
    }

    fun restore(eventsToRestore: List<MobileAnalyticsEvent>) {
        eventsToRestore.asReversed().forEach { event ->
            events.addFirst(event)
        }
        while (events.size > maxSize) events.removeFirst()
    }

    fun size(): Int = events.size
}
