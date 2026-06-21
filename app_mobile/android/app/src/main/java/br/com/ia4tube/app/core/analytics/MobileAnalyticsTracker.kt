package br.com.ia4tube.app.core.analytics

import android.content.Context
import android.os.Build
import br.com.ia4tube.app.core.config.AppConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

class MobileAnalyticsTracker(
    context: Context,
    private val tokenProvider: () -> String,
    private val client: OkHttpClient = defaultClient()
) {
    private val appContext = context.applicationContext
    private val queue = MobileAnalyticsQueue()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sessao = "mobile_sess_${System.currentTimeMillis()}_${UUID.randomUUID()}"
    private val appVersion = readAppVersion()
    private val deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
    private var currentScreen = ""
    private var currentField = ""
    private var lastAction = ""
    private var lastActivityMs = System.currentTimeMillis()
    private var flushScheduled = false

    fun track(
        eventName: String,
        tela: String = currentScreen,
        produto: String = "",
        etapa: String = "",
        campoAtual: String = currentField,
        pedidoId: String = "",
        payload: Map<String, String> = emptyMap(),
        flushNow: Boolean = false
    ) {
        val safeEvent = if (eventName.startsWith("mobile_")) eventName else "mobile_$eventName"
        val sanitizedPayload = payload
            .filterKeys { key -> !key.contains("senha", ignoreCase = true) && !key.contains("token", ignoreCase = true) }
            .filterValues { value -> value.length <= 500 && !value.startsWith("data:image", ignoreCase = true) }

        val event = MobileAnalyticsEvent(
            evento = safeEvent,
            tela = tela,
            produto = produto,
            etapa = etapa,
            campoAtual = campoAtual,
            pedidoId = pedidoId,
            payload = sanitizedPayload
        )

        lastAction = safeEvent
        lastActivityMs = System.currentTimeMillis()
        if (!queue.add(event)) return

        if (flushNow || queue.size() >= BATCH_SIZE) {
            flush()
        } else {
            scheduleFlush()
        }
    }

    fun screen(name: String) {
        currentScreen = name
        track("mobile_${name}_abriu", tela = name)
    }

    fun fieldFocus(field: String, tela: String = currentScreen) {
        if (field == currentField) return
        currentField = field
        track("mobile_campo_foco", tela = tela, campoAtual = field)
    }

    fun flush() {
        scope.launch { flushInternal() }
    }

    private fun scheduleFlush() {
        if (flushScheduled) return
        flushScheduled = true
        scope.launch {
            delay(FLUSH_INTERVAL_MS)
            flushScheduled = false
            flushInternal()
        }
    }

    private suspend fun flushInternal() {
        val events = queue.drain(50)
        if (events.isEmpty()) return

        val body = JSONObject()
            .put("sessao", sessao)
            .put("eventos", JSONArray().apply {
                events.forEach { event ->
                    put(
                        JSONObject()
                            .put("e", event.evento)
                            .put("sessao", sessao)
                            .put("t", event.timestamp)
                            .put("produto", event.produto)
                            .put(
                                "p",
                                JSONObject()
                                    .put("tela", event.tela)
                                    .put("evento", event.evento)
                                    .put("produto", event.produto)
                                    .put("etapa", event.etapa)
                                    .put("campo_atual", event.campoAtual)
                                    .put("ultima_acao", lastAction)
                                    .put("pedido_id", event.pedidoId)
                                    .put("tempo_inativo_ms", System.currentTimeMillis() - lastActivityMs)
                                    .put("app_version", appVersion)
                                    .put("device_modelo", deviceModel)
                                    .put("payload", JSONObject(event.payload))
                            )
                    )
                }
            })

        val builder = Request.Builder()
            .url("${AppConfig.apiBase}/evento")
            .post(body.toString().toRequestBody(JSON))
            .header("Content-Type", "application/json")

        tokenProvider().takeIf { it.isNotBlank() }?.let { token ->
            builder.header("Authorization", "Bearer $token")
        }

        val ok = withContext(Dispatchers.IO) {
            runCatching {
                client.newCall(builder.build()).execute().use { response -> response.isSuccessful }
            }.getOrDefault(false)
        }

        if (!ok) queue.restore(events)
    }

    private fun readAppVersion(): String {
        return runCatching {
            val info = appContext.packageManager.getPackageInfo(appContext.packageName, 0)
            info.versionName.orEmpty()
        }.getOrDefault("")
    }

    companion object {
        private const val BATCH_SIZE = 12
        private const val FLUSH_INTERVAL_MS = 6_000L
        private val JSON = "application/json; charset=utf-8".toMediaType()

        private fun defaultClient(): OkHttpClient {
            return OkHttpClient.Builder()
                .connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(8, TimeUnit.SECONDS)
                .writeTimeout(8, TimeUnit.SECONDS)
                .build()
        }
    }
}
