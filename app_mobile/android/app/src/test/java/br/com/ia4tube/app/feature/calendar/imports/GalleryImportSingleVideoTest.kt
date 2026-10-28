package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Synthetic HTTP and content only. No device or external service is accessed. */
class GalleryImportSingleVideoTest {
    private val owner = ImportOwner("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
    private val upload = "33333333-3333-4333-8333-333333333333"
    private val asset = "44444444-4444-4444-8444-444444444444"
    private val token = "synthetic-private-token"
    private val now = 100_000L
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun capabilities(single: Boolean = true) = JSONObject().put("ok", true).put("enabled", true)
        .put("identity", JSONObject().put("companyId", owner.companyId).put("userId", owner.userId))
        .put("upload", JSONObject().put("origin", "https://ia4tube-api.onrender.com").put("chunkBytes", GalleryImportPolicy.CHUNK_BYTES)
            .put("maxImageBytes", GalleryImportPolicy.IMAGE_MAX_BYTES).put("maxVideoBytes", GalleryImportPolicy.VIDEO_MAX_BYTES)
            .put("gcs", ImportGoogleStorageTestData.profile().put("transport", ImportGoogleStoragePolicy.TRANSPORT).also {
                if (single) it.put("singleRequestVideo", true)
            }))
        .put("preparation", JSONObject().put("enabled", true).put("maxVideoSeconds", 60).put("photoMusicSeconds", 15))
        .put("scheduling", JSONObject().put("enabled", false))
    private fun record(size: Int) = JSONObject().put("ok", true).put("upload", JSONObject()
        .put("uploadId", upload).put("assetId", asset).put("kind", "video").put("mimeType", "video/mp4")
        .put("sizeBytes", size).put("chunkBytes", size).put("partCount", 1).put("uploadMode", "single")
        .put("state", "uploading").put("ready", false).put("verification", JSONObject.NULL))
    private fun api(server: MockWebServer, diagnostics: ImportMediaDiagnostics = ImportMediaDiagnostics()) =
        GalleryImportHttpApi({ token }, token, server.url("/"), GalleryImportHttpApi.metadataClient(),
            GalleryImportHttpApi.mediaClient(), { now }, true, diagnostics)

    @Test fun onlyExplicitVideoStartOptsIntoWholeFileAndReceivesOnePartGeometry() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.enqueue(MockResponse().setBody(capabilities().toString()))
            server.enqueue(MockResponse().setBody(record(22_225_691).toString()))
            val api = api(server)
            assertTrue(api.capabilities().googleStorage!!.singleRequestVideo)
            val media = ImportSelection("selected-video", ImportMediaKind.VIDEO, "video/mp4", 22_225_691,
                1080, 1920, 16_000, "a".repeat(64))
            val result = api.startSingleVideo(owner, media, "same-intent-key")
            assertTrue(result.singleRequestVideo); assertEquals(1, result.partCount); assertEquals(22_225_691, result.chunkBytes)
            server.takeRequest(1, TimeUnit.SECONDS)
            val posted = JSONObject(server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8())
            assertEquals("single", posted.getString("uploadMode"))
            assertEquals(22_225_691, posted.getLong("sizeBytes"))
            assertEquals("same-intent-key", posted.getString("idempotencyKey"))
        }
    }

    @Test fun missingCapabilityNeverPermitsSingleStartAndDoesNotChangeLegacyCall() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.enqueue(MockResponse().setBody(capabilities(false).toString()))
            val api = api(server); assertFalse(api.capabilities().googleStorage!!.singleRequestVideo)
            val media = ImportSelection("selected-video", ImportMediaKind.VIDEO, "video/mp4", 22_225_691,
                1080, 1920, 16_000, "a".repeat(64))
            try { api.startSingleVideo(owner, media, "same-intent-key"); fail("Must require capability") }
            catch (_: ImportApiFailure) { }
            assertEquals(1, server.requestCount)
        }
    }

    @Test fun twentyTwoMegabytesUseOneFixedLengthPutAndBoundedStreamWithoutCredentials() = runBlocking {
        val bytes = ByteArray(22_225_691) { (it % 251).toByte() }
        var opens = 0
        var largestRead = 0
        val file = ImportWholeVideoFile.inspect(bytes.size, sha(bytes), {
            opens++
            object : ByteArrayInputStream(bytes) {
                override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                    largestRead = maxOf(largestRead, length)
                    return super.read(buffer, offset, length)
                }
            }
        }, {})
        val timings = java.util.Collections.synchronizedList(mutableListOf<ImportMediaTimingEvent>())
        MockWebServer().use { metadata -> MockWebServer().use { media ->
            metadata.start(); media.start()
            metadata.enqueue(MockResponse().setBody(capabilities().toString()))
            media.enqueue(MockResponse().setResponseCode(200))
            val api = api(metadata, ImportMediaDiagnostics(timingSink = { timings.add(it) }))
            api.capabilities()
            val grant = ImportPartGrant(media.url("/whole"), mapOf("content-md5" to file.checksums.md5Base64,
                "content-length" to bytes.size.toString(), "content-type" to "application/octet-stream"),
                bytes.size, now + 600_000, token, true)
            var progress = 0L
            api.putWholeFile(grant, file) { transferred, total ->
                assertEquals(bytes.size.toLong(), total); assertTrue(transferred >= progress); progress = transferred
            }
            assertEquals(1, media.requestCount); assertEquals(1, metadata.requestCount)
            val request = media.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("PUT", request.method); assertEquals(bytes.size.toLong(), request.bodySize)
            assertEquals(bytes.size.toString(), request.getHeader("Content-Length"))
            assertNull(request.getHeader("Transfer-Encoding")); assertNull(request.getHeader("Authorization"))
            assertNull(request.getHeader("Cookie")); assertNull(request.getHeader(ImportGoogleStoragePolicy.HEADER))
            assertArrayEquals(bytes, request.body.readByteArray())
            assertEquals(2, opens); assertEquals(64 * 1024, largestRead); assertEquals(bytes.size.toLong(), progress)
            assertEquals(1, timings.count { it.stage == ImportMediaStage.MEDIA_PUT })
            assertTrue(timings.none { it.fixedMessage().contains(token) || it.fixedMessage().contains("/whole") })
        } }
    }

    @Test fun disconnectedWholePutDoesNotRetryOrCreateAnotherUpload() = runBlocking {
        val bytes = ByteArray(6_000_000) { 42 }
        val file = ImportWholeVideoFile.inspect(bytes.size, sha(bytes), { bytes.inputStream() }, {})
        MockWebServer().use { metadata -> MockWebServer().use { media ->
            metadata.start(); media.start()
            metadata.enqueue(MockResponse().setBody(capabilities().toString()))
            media.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_DURING_REQUEST_BODY))
            val api = api(metadata); api.capabilities()
            val grant = ImportPartGrant(media.url("/whole"), mapOf("content-md5" to file.checksums.md5Base64),
                bytes.size, now + 600_000, token, true)
            try { api.putWholeFile(grant, file); fail("Expected uncertain transfer") }
            catch (error: ImportApiFailure) { assertTrue(error.resultUncertain) }
            assertEquals(1, media.requestCount); assertEquals(1, metadata.requestCount)
        } }
    }

    @Test fun wholeFileHashingRejectsTruncatedExtendedAndChangedContentBeforeAuthorization() {
        val bytes = ByteArray(100) { 42 }
        for ((size, digest) in listOf(99 to sha(bytes), 101 to sha(bytes), 100 to "a".repeat(64))) {
            try { ImportWholeVideoFile.inspect(size, digest, { bytes.inputStream() }, {}); fail("Expected source rejection") }
            catch (_: ImportSourceFailure) { }
        }
    }

    @Test fun arbitraryGeometryCannotMasqueradeAsAnImageOrLegacyUpload() {
        assertFalse(GalleryImportPolicy.validUploadGeometry(ImportMediaKind.IMAGE, 22_225_691, 22_225_691, true))
        assertFalse(GalleryImportPolicy.validUploadGeometry(ImportMediaKind.VIDEO, 22_225_691, 22_225_691, false))
        assertFalse(GalleryImportPolicy.validUploadGeometry(ImportMediaKind.VIDEO, 22_225_691, 5_242_880, true))
        assertFalse(GalleryImportPolicy.validUploadGeometry(ImportMediaKind.VIDEO, GalleryImportPolicy.VIDEO_MAX_BYTES + 1,
            (GalleryImportPolicy.VIDEO_MAX_BYTES + 1).toInt(), true))
    }
}
