package br.com.ia4tube.app.feature.calendar

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

@OptIn(ExperimentalCoroutinesApi::class)
class CalendarCaptionApiTest {
    @Before fun before() { Dispatchers.setMain(Dispatchers.Unconfined) }
    @After fun after() { Dispatchers.resetMain() }

    private fun payload(caption: String, revision: Long): String {
        val item = JSONObject().put("id", "a".repeat(40)).put("key", "synthetic:1")
            .put("date", "2026-09-10").put("time", "18:30").put("caption", caption)
            .put("revision", revision).put("status", "scheduled").put("statusLabel", "Programada")
            .put("editable", true).put("automatic", true).put("imageUrl", JSONObject.NULL)
            .put("username", "synthetic").put("scheduledAt", 1_789_077_000_000)
        return JSONObject().put("ok", true).put("enabled", true).put("operationsAllowed", false)
            .put("preferences", JSONObject().put("enabled", true).put("revision", 2))
            .put("connection", JSONObject().put("username", "synthetic"))
            .put("items", JSONArray().put(item)).put("next", item).toString()
    }

    @Test fun fullPostResponseUpdatesCaptionRevisionAndNextBeforeNotifyingSuccess() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(payload("Legenda inicial", 1)))
            server.enqueue(MockResponse().setBody(payload("Legenda confirmada", 2)))
            server.start()
            val client = calendarHttpClient()
            val model = CalendarViewModel({ "synthetic-only" }, "synthetic-only",
                CalendarApi("synthetic-only", server.url("/").toString().trimEnd('/'), client))
            try {
                model.refresh()
                withTimeout(5_000) { model.uiState.first { it.fresh && !it.busy } }
                val confirmation = CompletableDeferred<CalendarUiState>()
                model.edit(model.uiState.value.data.items.single(), "caption", "Legenda confirmada",
                    onSuccess = { confirmation.complete(model.uiState.value) })
                val confirmed = withTimeout(5_000) { confirmation.await() }
                assertEquals("Legenda confirmada", confirmed.data.items.single().caption)
                assertEquals(2L, confirmed.data.items.single().revision)
                assertEquals("Legenda confirmada", confirmed.data.next!!.caption)
                assertTrue(confirmed.fresh)
                assertFalse(confirmed.busy)
                assertEquals(2, server.requestCount)
                assertEquals("GET", server.takeRequest(1, TimeUnit.SECONDS)!!.method)
                val write = server.takeRequest(1, TimeUnit.SECONDS)!!
                assertEquals("POST", write.method)
                assertEquals("/v1/social/calendar/items/${"a".repeat(40)}", write.path)
                assertEquals("no-store", write.getHeader("Cache-Control"))
                val body = JSONObject(write.body.readUtf8())
                assertEquals("Legenda confirmada", body.getString("caption"))
                assertEquals(1L, body.getLong("revision"))
                assertNull("A confirmed edit must not issue another read or write", server.takeRequest(100, TimeUnit.MILLISECONDS))
            } finally {
                model.dispose()
                client.connectionPool.evictAll()
                client.dispatcher.executorService.shutdown()
            }
        }
    }

    @Test fun unconfirmedPostRetainsOldSnapshotUntilExplicitReadWithoutRepeatingWrite() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(payload("Legenda inicial", 1)))
            server.enqueue(MockResponse().setResponseCode(503).setBody("{}"))
            server.enqueue(MockResponse().setBody(payload("Legenda confirmada", 2)))
            server.start()
            val client = calendarHttpClient()
            val model = CalendarViewModel({ "synthetic-only" }, "synthetic-only",
                CalendarApi("synthetic-only", server.url("/").toString().trimEnd('/'), client))
            try {
                model.refresh()
                withTimeout(5_000) { model.uiState.first { it.fresh && !it.busy } }
                var confirmations = 0
                model.edit(model.uiState.value.data.items.single(), "caption", "Legenda confirmada",
                    onSuccess = { confirmations++ })
                withTimeout(5_000) { model.uiState.first { !it.busy } }
                assertEquals(0, confirmations)
                assertFalse(model.uiState.value.fresh)
                assertEquals("Legenda inicial", model.uiState.value.data.items.single().caption)
                assertTrue(model.uiState.value.error!!.contains("pode ter sido salva"))
                model.edit(model.uiState.value.data.items.single(), "caption", "Legenda confirmada")
                assertEquals(2, server.requestCount)
                model.refresh()
                withTimeout(5_000) { model.uiState.first { it.fresh && !it.busy } }
                assertEquals("Legenda confirmada", model.uiState.value.data.items.single().caption)
                assertEquals(listOf("GET", "POST", "GET"), (1..3).map { server.takeRequest(1, TimeUnit.SECONDS)!!.method })
                assertNull(server.takeRequest(100, TimeUnit.MILLISECONDS))
            } finally {
                model.dispose()
                client.connectionPool.evictAll()
                client.dispatcher.executorService.shutdown()
            }
        }
    }
}
