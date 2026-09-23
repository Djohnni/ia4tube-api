package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ImportCalendarSubmissionHttpTest {
    private val data = ImportPreparationTestData
    private val intent = ImportCalendarSubmissionIntent("synthetic-calendar-key", 1, 0)
    private fun api(server: MockWebServer) = GalleryImportHttpApi({ "synthetic-token" }, "synthetic-token", server.url("/"),
        GalleryImportHttpApi.metadataClient(), GalleryImportHttpApi.mediaClient(), allowLoopbackForTests = true)
    private fun receipt() = JSONObject().put("id", "d".repeat(40)).put("assetId", data.assetId).put("uploadId", data.uploadId)
        .put("idempotencyKey", intent.idempotencyKey).put("state", "accepted").put("calendarItemId", JSONObject.NULL)
        .put("mediaRevision", 0).put("date", "2026-09-24").put("time", "09:00").put("caption", "").put("errorCode", JSONObject.NULL)
    private fun MockWebServer.reply(json: JSONObject) = enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(json.toString()))
    private fun capabilities(server: MockWebServer) = data.capabilities(server.url("/").toString()).also {
        it.getJSONObject("scheduling").put("directSubmission", true)
    }

    @Test fun postAcceptsWithoutPreviewDigestConfirmedDateOrMandatoryCaptionThenGetIsReadOnly() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.reply(capabilities(server))
            repeat(2) { server.reply(JSONObject().put("ok", true).put("submission", receipt().put("caption", "Legenda da arte existente"))) }
            val api = api(server); api.capabilities()
            val accepted = api.submitToCalendar(data.owner, data.assetId, data.uploadId, intent, data.selection.kind, data.config)
            assertEquals("accepted", accepted.state); assertEquals("Legenda da arte existente", accepted.caption)
            assertNotNull(api.calendarSubmissionStatus(data.owner, data.assetId, data.uploadId, intent))
            server.takeRequest()
            val post = server.takeRequest(); val body = JSONObject(post.body.readUtf8())
            assertEquals("POST", post.method); assertTrue(post.path!!.endsWith("/calendar-submissions"))
            assertEquals("Bearer synthetic-token", post.getHeader("Authorization"))
            assertEquals(intent.idempotencyKey, body.getString("idempotencyKey"))
            assertFalse("An existing art must retain its caption unless overridden", body.has("caption"))
            assertEquals(data.config.targets.size, body.getJSONObject("selection").getJSONArray("targets").length())
            for (name in listOf("confirmed", "previewDigest", "date", "time", "automatic", "companyId")) assertFalse(body.has(name))
            val get = server.takeRequest(); assertEquals("GET", get.method)
            assertTrue(get.path!!.endsWith("/calendar-submissions/by-key/${intent.idempotencyKey}"))
        }
    }

    @Test fun lookup404DoesNotCreateAReplacementAndWrongReceiptBindingIsRejected() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.reply(capabilities(server))
            server.enqueue(MockResponse().setResponseCode(404))
            server.reply(JSONObject().put("ok", true).put("submission", receipt().put("uploadId", data.assetId)))
            val api = api(server); api.capabilities()
            assertNull(api.calendarSubmissionStatus(data.owner, data.assetId, data.uploadId, intent))
            try { api.submitToCalendar(data.owner, data.assetId, data.uploadId, intent, data.selection.kind, data.config); fail("Wrong binding") }
            catch (error: ImportApiFailure) { assertEquals("import_response_invalid", error.code); assertTrue(error.resultUncertain) }
            assertEquals(3, server.requestCount)
        }
    }

    @Test fun oldServerWithoutDirectSubmissionCapabilityCannotReceiveTheNewPost() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.reply(data.capabilities(server.url("/").toString()))
            val api = api(server); assertFalse(api.capabilities().calendarSubmissionEnabled)
            try { api.submitToCalendar(data.owner, data.assetId, data.uploadId, intent, data.selection.kind, data.config); fail("Old server") }
            catch (error: ImportApiFailure) { assertEquals("import_calendar_submission_unavailable", error.code) }
            assertEquals(1, server.requestCount)
        }
    }
}
