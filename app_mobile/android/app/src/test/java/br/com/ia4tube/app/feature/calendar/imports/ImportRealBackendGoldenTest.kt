package br.com.ia4tube.app.feature.calendar.imports

import android.app.Application
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.MessageDigest
import java.time.LocalDateTime

/** Raw HTTP fixture produced by the real isolated Node/FFmpeg pipeline, not hand-written expected records. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
class ImportRealBackendGoldenTest {
    @Test fun androidConsumesActualBackendSourcePreparationPreviewAvailabilityAndSameCalendarReceipt() = runBlocking {
        val bytes = requireNotNull(javaClass.classLoader!!.getResourceAsStream("gallery-import-http-contract.json")).use { it.readBytes() }
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        assertEquals("209350d6031869ecc27976567dd0349fac13fc04ec7a700fe75d82a0fa868e7c", sha)
        val golden = JSONObject(String(bytes, Charsets.UTF_8))
        val responses = java.util.ArrayDeque(listOf("capabilities", "source", "asset", "preview", "availability", "schedule", "schedule"))
        val requests = mutableListOf<String>()
        val token = "synthetic-local-golden-session"
        // Only a test transport: preserve official URLs and exact recorded response content;
        // every request is intercepted locally, including any unexpected one (which fails).
        val client = GalleryImportHttpApi.metadataClient().newBuilder().addInterceptor { chain ->
            synchronized(responses) {
                assertEquals("Bearer $token", chain.request().header("Authorization"))
                assertEquals("ia4tube-api.onrender.com", chain.request().url.host)
                requests.add("${chain.request().method} ${chain.request().url.encodedPath}")
                val body = golden.getJSONObject(responses.removeFirst()).toString()
                Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("Synthetic local fixture")
                    .body(body.toResponseBody("application/json".toMediaType())).build()
            }
        }.build()
        val api = GalleryImportHttpApi({ token }, token, "https://ia4tube-api.onrender.com".toHttpUrl(), client,
            GalleryImportHttpApi.mediaClient(), allowLoopbackForTests = true)
        val capability = api.capabilities(); val owner = capability.identity!!
        assertTrue(capability.localSimulation); assertTrue(capability.musicTracks.single().testOnly)
        assertFalse(capability.musicTracks.single().commercialRightsConfirmed)
        val original = golden.getJSONObject("source").getJSONObject("source")
        val source = api.adoptGenerated(owner, ImportGeneratedSourceIntent(original.getString("calendarItemId"), original.getLong("revision"), "synthetic-golden-source"))
        assertEquals(ImportServerPhase.UPLOADED, source.upload.phase)
        val ready = api.preparationStatus(owner, source.upload.assetId)
        val preview = api.preparationPreview(owner, ready)
        assertEquals(setOf("feed", "story"), preview.variants.map { it.target }.toSet())
        assertTrue(preview.variants.all { it.sourceSha256 == source.selection.sha256 })
        val availability = api.scheduleAvailability(owner, ready)
        assertTrue(availability.enabled); assertTrue(availability.automaticAllowed); assertTrue(availability.localSimulation)
        assertFalse(availability.commercialReady)
        val expected = golden.getJSONObject("schedule").getJSONObject("schedule")
        val at = LocalDateTime.parse("${expected.getString("date")}T${expected.getString("time")}:00")
            .atZone(ImportSchedulingProtocol.zone).toInstant().toEpochMilli()
        val binding = ImportSchedulingProtocol.binding(preview, at, true)
        val intent = ImportScheduleIntent(expected.getString("idempotencyKey"), 1, at, expected.getString("caption"), expected.getBoolean("automaticEnabled"))
        val receipt = api.schedule(owner, binding, intent); val replay = api.scheduleStatus(owner, binding, intent)
        assertEquals(receipt, replay); assertEquals(expected.getString("id"), receipt.id); assertTrue(receipt.localSimulation)
        assertEquals(7, requests.size); assertTrue(responses.isEmpty())
        assertTrue(requests.last().startsWith("GET ")); assertFalse(requests.any { it.contains("/orders") || it.contains("instagram") })
    }
}
