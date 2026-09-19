package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDateTime
import java.util.concurrent.TimeUnit

class GalleryImportSchedulingHttpTest {
    private val data = ImportPreparationTestData
    private val token = "synthetic-scheduling-session"
    private val binding = ImportScheduleBinding(data.assetId, 1, data.knownDigest, "2026-09-15", "09:00")
    private val intent = ImportScheduleIntent("synthetic-schedule-key", 1,
        LocalDateTime.parse("2026-09-15T09:00:00").atZone(ImportSchedulingProtocol.zone).toInstant().toEpochMilli(), "Caption", true)
    private val ready get() = ImportPreparationProtocol.parseRecord(data.status("ready"))
    private fun api(server: MockWebServer, provider: () -> String = { token }) = GalleryImportHttpApi(provider, token, server.url("/"),
        GalleryImportHttpApi.metadataClient(), GalleryImportHttpApi.mediaClient(), allowLoopbackForTests = true)
    private fun MockWebServer.reply(value: JSONObject) = enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(value.toString()))
    private fun envelope(key: String, value: JSONObject) = JSONObject().put("ok", true).put(key, value)
    private fun capability(server: MockWebServer, local: Boolean = false) = data.capabilities(server.url("/").toString())
        .put("scheduling", JSONObject().put("enabled", true)).put("localSimulation", local)
    private fun availability() = JSONObject().put("identity", JSONObject().put("companyId", data.owner.companyId).put("userId", data.owner.userId))
        .put("assetId", data.assetId).put("mediaRevision", 1).put("previewDigest", data.knownDigest).put("ready", true)
        .put("connected", true).put("authorized", true).put("automaticPreference", true).put("username", "synthetic-test")
        .put("calendarSaveAllowed", true).put("automaticAllowed", true)
        .put("localSimulation", false).put("commercialReady", true).put("blockedReason", JSONObject.NULL)
    private fun receipt() = JSONObject().put("id", "c".repeat(40)).put("assetId", data.assetId).put("mediaRevision", 1)
        .put("previewDigest", data.knownDigest).put("idempotencyKey", intent.idempotencyKey).put("date", binding.date).put("time", binding.time)
        .put("caption", intent.caption).put("revision", 1).put("phase", "ready").put("automaticEnabled", true).put("localSimulation", false)
    private suspend fun rejected(block: suspend () -> Any?): ImportApiFailure {
        try { block(); fail("Expected protected rejection") } catch (error: ImportApiFailure) { return error }; throw AssertionError()
    }
    @Test fun authenticatedAvailabilityScheduleAndReadOnlyReconcileUseSameCalendarBinding() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.reply(capability(server)); server.reply(envelope("availability", availability()))
            server.reply(envelope("schedule", receipt())); server.reply(envelope("schedule", receipt().put("phase", "cancelled").put("revision", 2).put("automaticEnabled", false)))
            val api = api(server); api.capabilities()
            assertTrue(api.scheduleAvailability(data.owner, ready).automaticAllowed)
            assertEquals("c".repeat(40), api.schedule(data.owner, binding, intent).id)
            val latest = api.scheduleStatus(data.owner, binding, intent)!!; assertEquals("cancelled", latest.phase); assertFalse(latest.automaticEnabled)
            val calls = (1..4).map { server.takeRequest(1, TimeUnit.SECONDS)!! }
            assertTrue(calls.all { it.getHeader("Authorization") == "Bearer $token" && it.getHeader("Cache-Control") == "no-store" })
            assertEquals("/v1/social/calendar/imports/assets/${data.assetId}/schedule", calls[2].path)
            val body = JSONObject(calls[2].body.readUtf8()); assertEquals(true, body.getBoolean("confirmed"))
            assertEquals(data.knownDigest, body.getString("previewDigest")); assertFalse(body.has("companyId")); assertFalse(body.has("localSimulation"))
            assertEquals("GET", calls[3].method); assertEquals("/v1/social/calendar/imports/assets/${data.assetId}/schedules/by-key/${intent.idempotencyKey}", calls[3].path)
        }
    }
    @Test fun lookup404DoesNotPostOrMintAnotherKey() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.reply(capability(server)); server.enqueue(MockResponse().setResponseCode(404))
            val api = api(server); api.capabilities(); assertNull(api.scheduleStatus(data.owner, binding, intent)); assertEquals(2, server.requestCount)
            server.takeRequest(); assertEquals("GET", server.takeRequest().method)
        }
    }
    @Test fun explicitClosedGatesAllowManualCalendarWithoutBorrowingConnectionOrOldPreference() {
        val connected = ImportSchedulingProtocol.parseAvailability(availability().put("automaticAllowed", false), data.owner, ready, true)
        assertTrue(connected.enabled); assertFalse(connected.automaticAllowed); assertTrue(connected.automaticPreference)
        val disconnected = ImportSchedulingProtocol.parseAvailability(availability().put("automaticAllowed", false)
            .put("connected", false).put("authorized", false), data.owner, ready, true)
        assertTrue(disconnected.enabled); assertFalse(disconnected.automaticAllowed)
        val unlicensed = ImportSchedulingProtocol.parseAvailability(availability().put("commercialReady", false), data.owner, ready, true)
        assertFalse(unlicensed.enabled); assertFalse(unlicensed.automaticAllowed)
    }
    @Test fun missingOperationalFieldsNeverDefaultToEnabledInProduction() {
        val legacy = availability().apply { remove("calendarSaveAllowed"); remove("automaticAllowed") }
        val value = ImportSchedulingProtocol.parseAvailability(legacy, data.owner, ready, true)
        assertFalse(value.enabled); assertFalse(value.automaticAllowed)
        val closed = ImportSchedulingProtocol.parseAvailability(availability().put("calendarSaveAllowed", false), data.owner, ready, true)
        assertFalse(closed.enabled); assertFalse(closed.automaticAllowed)
    }
    @Test fun operationalGateFieldsMustBeStrictBooleans() {
        for (key in listOf("calendarSaveAllowed", "automaticAllowed")) {
            for (bad in listOf<Any>("true", "false", 1, JSONObject.NULL)) {
                assertThrows(IllegalArgumentException::class.java) {
                    ImportSchedulingProtocol.parseAvailability(availability().put(key, bad), data.owner, ready, true)
                }
            }
        }
    }
    @Test fun availabilityCannotCrossOwnerRevisionOrCommercialAndTestBoundary() = runBlocking {
        for (mutate in listOf<(JSONObject) -> Unit>(
            { it.getJSONObject("identity").put("companyId", data.assetId) }, { it.put("mediaRevision", 2) },
            { it.put("previewDigest", "e".repeat(64)) }, { it.put("localSimulation", true) }, { it.put("authorized", "true") })) {
            MockWebServer().use { server ->
                server.start(); server.reply(capability(server)); val bad = availability(); mutate(bad); server.reply(envelope("availability", bad))
                val api = api(server); api.capabilities(); rejected { api.scheduleAvailability(data.owner, ready) }
            }
        }
    }
    @Test fun receiptMustMatchImmutableAssetRevisionDigestAndIdempotencyKey() = runBlocking {
        for ((field, value) in listOf("assetId" to data.jobId, "mediaRevision" to 2, "previewDigest" to "e".repeat(64),
            "idempotencyKey" to "other-key", "id" to data.jobId, "localSimulation" to true)) {
            MockWebServer().use { server ->
                server.start(); server.reply(capability(server)); server.reply(envelope("schedule", receipt().put(field, value)))
                val api = api(server); api.capabilities(); assertTrue(rejected { api.schedule(data.owner, binding, intent) }.resultUncertain)
            }
        }
    }
    @Test fun localIntentCannotReplayAtNonLocalServerAndTokenChangeBlocksPost() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.reply(capability(server)); var current = token; val api = api(server) { current }; api.capabilities()
            rejected { api.schedule(data.owner, binding.copy(localSimulation = true), intent) }
            current = "another-session"; rejected { api.schedule(data.owner, binding, intent) }
            assertEquals(1, server.requestCount)
        }
    }
    @Test fun syntheticCatalogueRequiresExplicitLocalEnvironmentAndNeverPretendsCommercialRights() = runBlocking {
        MockWebServer().use { server ->
            server.start(); val cap = capability(server, local = true).put("musicTracks", JSONArray().put(JSONObject()
                .put("id", "synthetic-test-track").put("commercialRightsConfirmed", false).put("testOnly", true)))
            server.reply(cap); val api = api(server); val result = api.capabilities()
            assertTrue(result.localSimulation); assertTrue(result.musicTracks.single().testOnly); assertFalse(result.musicTracks.single().commercialRightsConfirmed)
            server.reply(cap.put("localSimulation", false)); rejected { api.capabilities() }; Unit
        }
    }
    @Test fun generatedArtSourceIsOwnerBoundVerifiedAndDoesNotRequestAnotherCreation() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.reply(capability(server)); val sourceIntent = ImportGeneratedSourceIntent("a".repeat(40), 3, "existing-art-source-key")
            val upload = JSONObject().put("uploadId", data.uploadId).put("assetId", data.assetId).put("kind", "image").put("mimeType", "image/png")
                .put("sizeBytes", 12).put("chunkBytes", GalleryImportPolicy.CHUNK_BYTES).put("partCount", 1).put("state", "uploaded").put("ready", false)
                .put("verification", JSONObject().put("sha256", data.sourceSha).put("sizeBytes", 12).put("mimeType", "image/png"))
            val response = JSONObject().put("ok", true).put("upload", upload).put("source", JSONObject().put("kind", "generated_art")
                .put("calendarItemId", sourceIntent.calendarItemId).put("revision", 3).put("sha256", data.sourceSha).put("width", 1080).put("height", 1350))
                .put("identity", JSONObject().put("companyId", data.owner.companyId).put("userId", data.owner.userId))
            server.reply(response); val api = api(server); api.capabilities(); val result = api.adoptGenerated(data.owner, sourceIntent)
            assertEquals(ImportServerPhase.UPLOADED, result.upload.phase); assertEquals(sourceIntent, result.original)
            server.takeRequest(); val call = server.takeRequest(); assertEquals("/v1/social/calendar/imports/sources/generated/${sourceIntent.calendarItemId}", call.path)
            assertEquals(setOf("revision", "idempotencyKey"), JSONObject(call.body.readUtf8()).keys().asSequence().toSet())
            assertEquals(2, server.requestCount)
            server.reply(response.put("identity", JSONObject().put("companyId", data.assetId).put("userId", data.owner.userId)))
            rejected { api.adoptGenerated(data.owner, sourceIntent) }; Unit
        }
    }
    @Test fun dateTimeBindingRejectsSecondsAndStaysInExistingCalendarTimezone() {
        ImportSchedulingProtocol.validate(binding, intent)
        assertEquals("2026-09-15T12:00:00Z", java.time.Instant.ofEpochMilli(intent.scheduledAtEpochMs).toString())
        assertThrows(Exception::class.java) { ImportSchedulingProtocol.validate(binding, intent.copy(scheduledAtEpochMs = intent.scheduledAtEpochMs + 60_000)) }
    }
}
