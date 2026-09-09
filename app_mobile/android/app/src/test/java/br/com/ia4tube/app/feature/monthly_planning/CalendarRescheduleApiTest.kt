package br.com.ia4tube.app.feature.monthly_planning

import android.app.Application
import br.com.ia4tube.app.data.api.IA4TubeApiClient
import br.com.ia4tube.app.data.models.ApiResult
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
class CalendarRescheduleApiTest {
    @Test fun selectedTimeAndExistingRevisionAreSerializedAndUpdatedRevisionIsRead() = runBlocking {
        val item = MonthlyPlanningCalendarListItem(
            key = "planning:post", planningId = "planning", planejamentoItemId = "post",
            date = "2026-09-10", time = "09:00", dateLabel = "", status = "Pronta",
            title = "Arte de teste", pedidoId = "synthetic-order", imageReady = true,
            sortKey = "", calendarRevision = 8
        )
        var writes = 0
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            // Short-circuit every request: this contract test must never contact a server.
            val request = chain.request()
            writes++
            assertEquals("POST", request.method)
            assertEquals("/empresa/calendario-planejamento-mensal/reagendar", request.url.encodedPath)
            assertEquals("Bearer synthetic-only", request.header("Authorization"))
            val buffer = Buffer()
            request.body!!.writeTo(buffer)
            val body = JSONObject(buffer.readUtf8())
            assertEquals(item.key, body.getString("item_key"))
            assertEquals(item.planningId, body.getString("planning_id"))
            assertEquals(item.planejamentoItemId, body.getString("planejamento_item_id"))
            assertEquals(item.pedidoId, body.getString("pedido_id"))
            assertEquals(item.date, body.getString("data"))
            assertEquals("18:45", body.getString("horario"))
            assertEquals(8L, body.getLong("calendar_revision"))
            val post = JSONObject().put("item_key", item.key).put("data", item.date)
                .put("horario", "18:45").put("calendar_revision", 9)
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(JSONObject().put("ok", true).put("postagem", post).toString().toResponseBody("application/json".toMediaType()))
                .build()
        }.build()
        try {
            val result = IA4TubeApiClient(client).reagendarItemCalendarioPlanejamento(
                "synthetic-only", item.rescheduleRequest(item.date, "18:45")
            )
            assertTrue(result is ApiResult.Success)
            val updated = (result as ApiResult.Success).value
            assertEquals(item.date, updated.date)
            assertEquals("18:45", updated.time)
            assertEquals(9L, updated.calendarRevision)
            assertEquals(1, writes)
        } finally {
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdown()
        }
    }
}
