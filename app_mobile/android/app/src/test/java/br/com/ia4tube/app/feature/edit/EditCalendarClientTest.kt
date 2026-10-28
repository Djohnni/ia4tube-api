package br.com.ia4tube.app.feature.edit

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class EditCalendarClientTest {
    private val requestId = "56336c2f-53a8-4db0-996d-317088f1c827"
    private val ticket = "$requestId.${"A".repeat(43)}"
    private fun schedule(): EditCalendarSchedule {
        val future = Instant.now().atZone(ZoneId.of("America/Sao_Paulo")).plusDays(1)
        return EditCalendarSchedule(future.toLocalDate().toString(), "18:00")
    }

    @Test fun contextUsesExistingAppAuthenticationAndSendsOnlyScheduleMetadata() = runBlocking {
        val server = MockWebServer()
        try {
            server.enqueue(MockResponse().setResponseCode(200).setBody(JSONObject().put("ok", true)
                .put("ticket", ticket).put("expiresAt", Instant.now().plusSeconds(300).toString()).toString()))
            val client = EditCalendarClient(server.url("/").toString())
            val selected = schedule()
            assertEquals(ticket, client.create("local-test-token", requestId, selected).ticket)
            val sent = server.takeRequest()
            assertEquals("POST", sent.method)
            assertEquals("/empresa/edit/context", sent.path)
            assertEquals("Bearer local-test-token", sent.getHeader("Authorization"))
            val body = JSONObject(sent.body.readUtf8())
            assertEquals(setOf("requestId", "date", "time", "destination"), body.keys().asSequence().toSet())
            assertEquals(requestId, body.getString("requestId"))
            assertEquals(selected.date, body.getString("date"))
            assertEquals(selected.time, body.getString("time"))
            assertEquals("reel", body.getString("destination"))
            assertFalse(body.toString().contains("local-test-token"))
        } finally { server.shutdown() }
    }

    @Test fun malformedOrExpiredCapabilitiesNeverReachTheWebPage() = runBlocking {
        val server = MockWebServer()
        try {
            val client = EditCalendarClient(server.url("/").toString())
            for (response in listOf(
                JSONObject().put("ok", true).put("ticket", "javascript:alert(1)").put("expiresAt", Instant.now().plusSeconds(300).toString()),
                JSONObject().put("ok", true).put("ticket", ticket).put("expiresAt", Instant.now().minusSeconds(1).toString()),
            )) {
                server.enqueue(MockResponse().setBody(response.toString()))
                try { client.create("local-test-token", requestId, schedule()); fail("Invalid capability accepted") }
                catch (error: EditCalendarException) { assertEquals("invalid_calendar_response", error.code) }
            }
            server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
            try { client.create("local-test-token", requestId, schedule()); fail("Authentication failure accepted") }
            catch (error: EditCalendarException) { assertEquals("auth_required", error.code) }
            val redirected = MockWebServer()
            try {
                redirected.enqueue(MockResponse().setBody(JSONObject().put("ok", true).put("ticket", ticket)
                    .put("expiresAt", Instant.now().plusSeconds(300).toString()).toString()))
                server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", redirected.url("/unexpected")))
                try { client.create("local-test-token", requestId, schedule()); fail("Authenticated context followed a redirect") }
                catch (error: EditCalendarException) { assertEquals("calendar_unavailable", error.code) }
                assertEquals(0, redirected.requestCount)
            } finally { redirected.shutdown() }
        } finally { server.shutdown() }
    }
}
