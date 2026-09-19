package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class GalleryImportPreparationHttpTest {
    private val f = ImportPreparationTestData
    private val token = "synthetic-preparation-token"
    private fun api(server: MockWebServer, provider: () -> String = { token }) = GalleryImportHttpApi(provider, token, server.url("/"),
        GalleryImportHttpApi.metadataClient(), GalleryImportHttpApi.mediaClient(), allowLoopbackForTests = true)
    private fun MockWebServer.reply(json: JSONObject) = enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(json.toString()))
    private fun wrapped(key: String, value: JSONObject) = JSONObject().put("ok", true).put(key, value)
    private suspend fun failure(block: suspend () -> Unit): ImportApiFailure {
        try { block(); fail("Expected protected failure") } catch (error: ImportApiFailure) { return error }
        throw AssertionError()
    }

    @Test fun preparationUsesExactExistingRouteAndMetadataPreviewWithoutFetchingBytes() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.reply(f.capabilities(server.url("/").toString()))
            server.reply(wrapped("asset", f.status())); server.reply(wrapped("asset", f.status("ready")))
            server.reply(wrapped("preview", f.preview(server.url("/").toString())))
            val api = api(server); api.capabilities()
            val queued = api.prepare(f.owner, f.assetId, f.uploadId, f.intent, f.selection.kind, f.config)
            assertEquals(ImportPreparationPhase.QUEUED, queued.phase); assertNull(queued.previewDigest)
            val ready = api.preparationStatus(f.owner, f.assetId)
            val preview = api.preparationPreview(f.owner, ready)
            assertEquals(f.knownDigest, preview.previewDigest); assertEquals(f.derivedSha, preview.variants.single().sha256)
            assertEquals(4, server.requestCount)
            val requests = (1..4).map { server.takeRequest(1, TimeUnit.SECONDS)!! }
            assertTrue(requests.all { it.getHeader("Authorization") == "Bearer $token" && it.getHeader("Cookie") == null })
            assertEquals("/v1/social/calendar/imports/assets/${f.assetId}/prepare", requests[1].path)
            val input = JSONObject(requests[1].body.readUtf8())
            assertEquals(0, input.getInt("expectedMediaRevision")); assertEquals(f.intent.idempotencyKey, input.getString("idempotencyKey"))
            assertEquals("none", input.getJSONObject("selection").getString("audioMode"))
            assertEquals("GET", requests[3].method); assertTrue(requests[3].path!!.endsWith("/revisions/1/preview"))
            assertFalse(preview.toString().contains(token)); assertFalse(preview.variants.single().toString().contains("http"))
        }
    }

    @Test fun fingerprintMatchesActualBackendPolicyFixtureAndChangesWithAudioOrSelection() {
        val record = ImportPreparationProtocol.parseRecord(f.status("ready"))
        assertEquals(f.knownDigest, ImportPreparationProtocol.fingerprint(f.selection.kind, f.config, false, record.variants))
        assertNotEquals(f.knownDigest, ImportPreparationProtocol.fingerprint(f.selection.kind, f.config, true, record.variants))
    }

    @Test fun videoFingerprintMatchesBackendAndBothDeliveriesRequirePrivateSilentThumbnail() {
        val record = ImportPreparationProtocol.parseRecord(f.videoStatus())
        assertEquals("48fc62f7a9c7e3df077fc36745ca0259610ad9adea306c846fbebaf6b06e5067", record.previewDigest)
        val origin = "https://ia4tube-api.onrender.com"
        val metadata = f.preview(origin, record)
        val preview = ImportPreparationProtocol.parsePreview(metadata, record, origin.toHttpUrl())
        assertEquals(setOf("story", "reel"), preview.variants.map { it.target }.toSet())
        assertTrue(preview.variants.all { it.hasAudio && it.durationMs == 20_000L })
        assertEquals("thumbnail", preview.thumbnail!!.target); assertFalse(preview.thumbnail.hasAudio)
        assertThrows(Exception::class.java) { ImportPreparationProtocol.parsePreview(
            f.preview(origin, record).put("thumbnail", JSONObject.NULL), record, origin.toHttpUrl()) }
        val forged = f.preview(origin, record); forged.getJSONObject("thumbnail").put("hasAudio", true)
        assertThrows(Exception::class.java) { ImportPreparationProtocol.parsePreview(forged, record, origin.toHttpUrl()) }
    }

    @Test fun musicalPhotoMetadataIsSyntheticOnlyAndRequiresAudioTrackHashAndFifteenSecondVariant() {
        val configuration = ImportConfiguration(setOf(ImportTarget.STORY), ImportAudioMode.MUSIC, "synthetic-test-track", setOf(ImportTarget.STORY))
        val part = ImportPreparedMetadata(ImportTarget.STORY, f.derivedSha, f.sourceSha, "video/mp4", 1080, 1920, 123,
            15_000, ImportAudioMode.MUSIC, true, "e".repeat(64))
        val record = f.status("ready").put("selection", ImportPreparationProtocol.selection(ImportMediaKind.IMAGE, configuration)).put("testOnly", true)
            .put("variants", JSONObject().put("story", f.part().put("mimeType", "video/mp4").put("height", 1920).put("durationSeconds", 15)
                .put("audioMode", "music").put("hasAudio", true).put("musicSha256", "e".repeat(64))))
            .put("previewDigest", ImportPreparationProtocol.fingerprint(ImportMediaKind.IMAGE, configuration, true, listOf(part)))
        val parsed = ImportPreparationProtocol.parseRecord(record)
        assertTrue(parsed.testOnly); assertEquals("synthetic-test-track", parsed.configuration!!.musicTrackId)
        record.getJSONObject("variants").getJSONObject("story").put("durationSeconds", 20)
        assertThrows(Exception::class.java) { ImportPreparationProtocol.parseRecord(record) }
    }

    @Test fun encodedVideoMayUseQuarterSecondToleranceWithoutRaisingSourceUploadLimit() {
        val record = ImportPreparationProtocol.parseRecord(f.videoStatus(seconds = 60.25, audio = ImportAudioMode.MUTED))
        assertTrue(record.variants.all { it.durationMs == 60_250L && !it.hasAudio })
        assertThrows(Exception::class.java) { ImportPreparationProtocol.parseRecord(f.videoStatus(seconds = 60.251)) }
        assertEquals(ImportRejection.INVALID_DURATION, GalleryImportPolicy.validateSelection(f.selection.copy(
            kind = ImportMediaKind.VIDEO, mimeType = "video/mp4", durationMs = 60_001)))
    }

    @Test fun unavailablePreparationForeignOwnerAndChangedTokenDoNotIssueRequest() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.reply(f.capabilities(server.url("/").toString(), false))
            var current = token; val api = api(server) { current }; api.capabilities()
            assertEquals("import_preparation_unavailable", failure { api.preparationStatus(f.owner, f.assetId) }.code)
            assertEquals("import_owner_unavailable", failure { api.preparationStatus(f.owner.copy(userId = f.assetId), f.assetId) }.code)
            current = "other-synthetic-token"
            assertEquals("import_session_changed", failure { api.preparationStatus(f.owner, f.assetId) }.code)
            assertEquals(1, server.requestCount)
        }
    }

    @Test fun readyMustMatchDimensionsMimeAudioChecksumSourceAndFingerprint() {
        for (field in listOf("width", "height", "mimeType", "audioMode", "hasAudio", "sha256", "sourceSha256", "size", "durationSeconds")) {
            val bad = f.status("ready"); val part = bad.getJSONObject("variants").getJSONObject("feed")
            when (field) {
                "width", "height" -> part.put(field, 99)
                "mimeType" -> part.put(field, "image/png")
                "audioMode" -> part.put(field, "original")
                "hasAudio" -> part.put(field, true)
                "sha256", "sourceSha256" -> part.put(field, "c".repeat(64))
                "size" -> part.put(field, 0)
                "durationSeconds" -> part.put(field, 15)
            }
            assertThrows(Exception::class.java) { ImportPreparationProtocol.parseRecord(bad) }
        }
    }

    @Test fun forgedOrStalePreviewCannotChooseOriginalForeignUrlQueryOrAnotherVariant() = runBlocking {
        for (mode in listOf("foreign", "original", "query", "fragment", "revision", "target", "checksum", "source")) {
            MockWebServer().use { server ->
                server.start(); server.reply(f.capabilities(server.url("/").toString()))
                val metadata = f.preview(server.url("/").toString()); val part = metadata.getJSONArray("variants").getJSONObject(0)
                val existing = part.getString("url")
                when (mode) {
                    "foreign" -> part.put("url", "https://untrusted.invalid" + server.url("/").encodedPath)
                    "original" -> part.put("url", server.url("/v1/social/calendar/imports/uploads/${f.uploadId}").toString())
                    "query" -> part.put("url", "$existing?token=must-not-surface")
                    "fragment" -> part.put("url", "$existing#ignored")
                    "revision" -> metadata.put("currentRevision", 2)
                    "target" -> part.put("target", "story")
                    "checksum" -> part.put("sha256", "c".repeat(64))
                    "source" -> part.put("sourceSha256", "c".repeat(64))
                }
                server.reply(wrapped("preview", metadata)); val api = api(server); api.capabilities()
                val error = failure { api.preparationPreview(f.owner, ImportPreparationProtocol.parseRecord(f.status("ready"))) }
                assertEquals("import_response_invalid", error.code); assertFalse(error.message!!.contains("must-not-surface"))
                assertEquals(2, server.requestCount)
            }
        }
    }

    @Test fun unknownStateNonBooleanReadyAndUnexpectedRevisionAreRejected() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.reply(f.capabilities(server.url("/").toString()))
            server.reply(wrapped("asset", f.status().put("state", "new_unsupported_phase")))
            server.reply(wrapped("asset", f.status().put("ready", "false")))
            server.reply(wrapped("asset", f.status().put("mediaRevision", 2).put("currentRevision", 2)))
            val api = api(server); api.capabilities()
            assertEquals("import_response_invalid", failure { api.preparationStatus(f.owner, f.assetId) }.code)
            assertEquals("import_response_invalid", failure { api.preparationStatus(f.owner, f.assetId) }.code)
            val error = failure { api.prepare(f.owner, f.assetId, f.uploadId, f.intent, f.selection.kind, f.config) }
            assertTrue(error.resultUncertain)
        }
    }

    @Test fun previewRedirectIsNeverFollowedAndStaleRevisionStopsBeforeNetwork() = runBlocking {
        MockWebServer().use { server -> MockWebServer().use { foreign ->
            server.start(); foreign.start(); server.reply(f.capabilities(server.url("/").toString()))
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", foreign.url("/private-bytes")))
            val api = api(server); api.capabilities(); val record = ImportPreparationProtocol.parseRecord(f.status("ready"))
            assertEquals("import_response_invalid", failure { api.preparationPreview(f.owner, record.copy(currentRevision = 2)) }.code)
            assertEquals(1, server.requestCount)
            assertEquals("import_request_rejected", failure { api.preparationPreview(f.owner, record) }.code)
            assertEquals(0, foreign.requestCount)
        } }
    }
}
