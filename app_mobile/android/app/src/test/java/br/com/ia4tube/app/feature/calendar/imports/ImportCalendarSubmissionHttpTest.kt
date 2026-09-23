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
            for (name in listOf("confirmed", "previewDigest", "date", "time", "schedule", "automatic", "companyId")) assertFalse(body.has(name))
            val get = server.takeRequest(); assertEquals("GET", get.method)
            assertTrue(get.path!!.endsWith("/calendar-submissions/by-key/${intent.idempotencyKey}"))
        }
    }

    @Test fun chosenScheduleIsSentInInitialRequestAndLaterLookupCanReflectAuthorizedCalendarEdit() = runBlocking {
        val chosen = ImportCalendarSchedule("2026-09-28", "14:35")
        val scheduledIntent = intent.copy(caption = "Chosen caption", schedule = chosen)
        MockWebServer().use { server ->
            server.start(); server.reply(capabilities(server))
            server.reply(JSONObject().put("ok", true).put("submission", receipt()
                .put("date", chosen.date).put("time", chosen.time).put("caption", scheduledIntent.caption)))
            server.reply(JSONObject().put("ok", true).put("submission", receipt().put("state", "scheduled")
                .put("calendarItemId", "d".repeat(40)).put("date", "2026-10-05").put("time", "18:30")))
            val api = api(server); api.capabilities()
            val accepted = api.submitToCalendar(data.owner, data.assetId, data.uploadId, scheduledIntent, data.selection.kind, data.config)
            assertEquals(chosen.date, accepted.date); assertEquals(chosen.time, accepted.time)
            val updated = api.calendarSubmissionStatus(data.owner, data.assetId, data.uploadId, scheduledIntent)!!
            assertEquals("2026-10-05", updated.date); assertEquals("18:30", updated.time)
            server.takeRequest()
            val body = JSONObject(server.takeRequest().body.readUtf8())
            val schedule = body.getJSONObject("schedule")
            assertEquals(setOf("date", "time", "timeZone"), schedule.keys().asSequence().toSet())
            assertEquals(chosen.date, schedule.getString("date")); assertEquals(chosen.time, schedule.getString("time"))
            assertEquals("America/Sao_Paulo", schedule.getString("timeZone"))
            assertEquals(scheduledIntent.caption, body.getString("caption"))
            assertFalse(body.has("confirmed")); assertFalse(body.has("previewDigest"))
            assertEquals("GET", server.takeRequest().method)
            assertEquals(3, server.requestCount)
        }
    }

    @Test fun invalidScheduleIsRejectedButPastSavedIntentCanStillBeReconciled() {
        for (schedule in listOf(ImportCalendarSchedule("2026-02-30", "09:00"), ImportCalendarSchedule("2026-9-24", "09:00"),
            ImportCalendarSchedule("2026-09-24", "24:00"), ImportCalendarSchedule("2026-09-24", "9:00"),
            ImportCalendarSchedule("2026-09-24", "09:00", "UTC"))) {
            assertThrows(RuntimeException::class.java) {
                ImportCalendarSubmissionProtocol.body(data.uploadId, intent.copy(schedule = schedule), data.selection.kind, data.config)
            }
        }
        val saved = intent.copy(schedule = ImportCalendarSchedule("2020-01-15", "08:45"))
        ImportCalendarSubmissionProtocol.validate(saved)
        assertEquals("2020-01-15", ImportCalendarSubmissionProtocol.body(data.uploadId, saved, data.selection.kind, data.config)
            .getJSONObject("schedule").getString("date"))
    }

    @Test fun lookup404DoesNotCreateAReplacementAndWrongReceiptBindingIsRejected() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.reply(capabilities(server))
            server.enqueue(MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json")
                .setBody(JSONObject().put("ok", false).put("code", "calendar_import_submission_not_found").toString()))
            server.reply(JSONObject().put("ok", true).put("submission", receipt().put("uploadId", data.assetId)))
            val api = api(server); api.capabilities()
            assertNull(api.calendarSubmissionStatus(data.owner, data.assetId, data.uploadId, intent))
            try { api.submitToCalendar(data.owner, data.assetId, data.uploadId, intent, data.selection.kind, data.config); fail("Wrong binding") }
            catch (error: ImportApiFailure) { assertEquals("import_response_invalid", error.code); assertTrue(error.resultUncertain) }
            assertEquals(3, server.requestCount)
        }
    }

    @Test fun onlyExactScheduleErrorAndStatusPairsAreExposedAsDefinitiveRefusals() = runBlocking {
        for ((code, status) in listOf("calendar_import_submission_time_occupied" to 409,
            "calendar_import_submission_time_outside_window" to 400, "calendar_import_submission_schedule_invalid" to 400,
            "calendar_import_submission_time_occupied" to 400, "calendar_import_submission_time_occupied" to 503,
            "calendar_import_submission_idempotency_conflict" to 409)) {
            MockWebServer().use { server ->
                server.start(); server.reply(capabilities(server))
                server.enqueue(MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json")
                    .setBody(JSONObject().put("ok", false).put("code", code).put("error", "DO_NOT_DISPLAY").toString()))
                val api = api(server); api.capabilities()
                try { api.submitToCalendar(data.owner, data.assetId, data.uploadId, intent, data.selection.kind, data.config); fail("Expected refusal") }
                catch (error: ImportApiFailure) {
                    val recognized = code == "calendar_import_submission_time_occupied" && status == 409 ||
                        code in setOf("calendar_import_submission_time_outside_window", "calendar_import_submission_schedule_invalid") && status == 400
                    assertEquals(if (recognized) code else "import_request_rejected", error.code)
                    assertEquals(status, error.status); assertEquals(status >= 500, error.resultUncertain)
                    assertFalse(error.message!!.contains("DO_NOT_DISPLAY"))
                }
                assertEquals(2, server.requestCount)
            }
        }
    }

    @Test fun genericOrOversized404CannotProveSubmissionAbsence() = runBlocking {
        for (body in listOf("", "{\"ok\":false,\"code\":\"import_route_not_found\"}",
            JSONObject().put("ok", false).put("code", "calendar_import_submission_not_found").put("error", "x".repeat(4096)).toString())) {
            MockWebServer().use { server ->
                server.start(); server.reply(capabilities(server))
                server.enqueue(MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json").setBody(body))
                val api = api(server); api.capabilities()
                try { api.calendarSubmissionStatus(data.owner, data.assetId, data.uploadId, intent); fail("Unknown absence must fail closed") }
                catch (error: ImportApiFailure) { assertEquals("import_request_rejected", error.code); assertEquals(404, error.status) }
                assertEquals(2, server.requestCount)
            }
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
