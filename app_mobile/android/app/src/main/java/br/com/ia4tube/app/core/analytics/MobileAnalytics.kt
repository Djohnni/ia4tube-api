package br.com.ia4tube.app.core.analytics

object MobileAnalytics {
    private var tracker: MobileAnalyticsTracker? = null

    fun init(tracker: MobileAnalyticsTracker) {
        this.tracker = tracker
        track("mobile_app_aberto", tela = "app")
    }

    fun track(
        eventName: String,
        tela: String = "",
        produto: String = "",
        etapa: String = "",
        campoAtual: String = "",
        pedidoId: String = "",
        payload: Map<String, String> = emptyMap(),
        flushNow: Boolean = false
    ) {
        tracker?.track(
            eventName = eventName,
            tela = tela,
            produto = produto,
            etapa = etapa,
            campoAtual = campoAtual,
            pedidoId = pedidoId,
            payload = payload,
            flushNow = flushNow
        )
    }

    fun screen(name: String) {
        tracker?.screen(name)
    }

    fun fieldFocus(field: String, tela: String = "") {
        tracker?.fieldFocus(field, tela)
    }

    fun flush() {
        tracker?.flush()
    }
}
