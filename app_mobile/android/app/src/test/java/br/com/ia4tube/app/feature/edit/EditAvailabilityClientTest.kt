package br.com.ia4tube.app.feature.edit

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

/** Synthetic JSON and local MockWebServer only; no account, reservation or production API. */
class EditAvailabilityClientTest {
    private val observed = 1_700_000_000_000L
    private fun body(image: Boolean? = false, video: Boolean? = true): JSONObject = JSONObject()
        .put("ok", true).put("availability", JSONObject().put("schemaVersion", 1)
            .put("canImage", image ?: JSONObject.NULL).put("canVideo", video ?: JSONObject.NULL)
            .put("observedAt", observed).put("validUntil", observed + 30_000L))

    private fun invalid(value: String) {
        try { EditAvailabilityClient.parse(value); fail("Unconfirmed availability accepted") }
        catch (error: EditAvailabilityException) { assertEquals("invalid_availability_response", error.code) }
    }

    @Test fun imageAndVideoRemainIndependentAndExplicitUnknownIsPreserved() {
        for ((image, video) in listOf(false to true, true to false, false to false,
            null to true, false to null, null to null)) {
            val parsed = EditAvailabilityClient.parse(body(image, video).toString())
            assertEquals(image, parsed.canImage)
            assertEquals(video, parsed.canVideo)
            assertEquals(observed, parsed.observedAt)
            assertEquals(observed + 30_000L, parsed.validUntil)
        }
    }

    @Test fun flagsAndSchemaCannotCoerceStringsNumbersOrMissingFieldsIntoExhaustion() {
        for (raw in listOf<Any>("false", "true", 0, 1, JSONObject(), org.json.JSONArray())) {
            invalid(body().also { it.getJSONObject("availability").put("canImage", raw) }.toString())
            invalid(body().also { it.getJSONObject("availability").put("canVideo", raw) }.toString())
        }
        for (raw in listOf<Any>("1", true, 2)) {
            invalid(body().also { it.getJSONObject("availability").put("schemaVersion", raw) }.toString())
        }
        invalid(body().toString().replace("\"schemaVersion\":1", "\"schemaVersion\":1.0"))
        invalid(body().also { it.getJSONObject("availability").remove("canImage") }.toString())
        invalid(body().also { it.getJSONObject("availability").put("owner", "synthetic-other") }.toString())
        invalid(body().put("extra", true).toString())
        invalid(body().put("ok", "true").toString())
        invalid(body().put("availability", JSONObject.NULL).toString())
        invalid("not JSON")
    }

    @Test fun timestampsAreSafeIntegersAndTheWindowNeverExceedsThirtySeconds() {
        for (raw in listOf<Any>(observed.toString(), 0, -1, 1.5, 9_007_199_254_740_992L, JSONObject.NULL)) {
            invalid(body().also { it.getJSONObject("availability").put("observedAt", raw) }.toString())
            invalid(body().also { it.getJSONObject("availability").put("validUntil", raw) }.toString())
        }
        for (end in listOf(observed - 1, observed, observed + 30_001)) {
            invalid(body().also { it.getJSONObject("availability").put("validUntil", end) }.toString())
        }
        val short = body().also { it.getJSONObject("availability").put("validUntil", observed + 1) }
        assertEquals(observed + 1, EditAvailabilityClient.parse(short.toString()).validUntil)
    }

    @Test fun requestIsReadOnlyAuthenticatedAndContainsNoCalendarTicketOrBody() = runBlocking {
        val server = MockWebServer()
        try {
            server.enqueue(MockResponse().setBody(body().toString()))
            val parsed = EditAvailabilityClient(server.url("/").toString()).read("synthetic-only-jwt")
            assertEquals(false, parsed.canImage)
            assertEquals(true, parsed.canVideo)
            val sent = requireNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            assertEquals("GET", sent.method)
            assertEquals("/empresa/edit/availability", sent.path)
            assertEquals("Bearer synthetic-only-jwt", sent.getHeader("Authorization"))
            assertEquals("no-store", sent.getHeader("Cache-Control"))
            assertEquals(0L, sent.bodySize)
            assertFalse(requireNotNull(sent.path).contains("jwt"))
        } finally { server.shutdown() }
    }

    @Test fun blankTokenNeverStartsARequestAndErrorsNeverBecomeKnownFalse() = runBlocking {
        val server = MockWebServer()
        try {
            val client = EditAvailabilityClient(server.url("/").toString())
            try { client.read(""); fail("Anonymous availability fetched") }
            catch (error: EditAvailabilityException) { assertEquals("auth_required", error.code) }
            assertEquals(0, server.requestCount)
            for (status in listOf(401, 403, 503)) {
                server.enqueue(MockResponse().setResponseCode(status).setBody("{}"))
                try { client.read("synthetic-only-jwt"); fail("HTTP error accepted") }
                catch (error: EditAvailabilityException) {
                    assertEquals(if (status == 401) "auth_required" else "availability_unavailable", error.code)
                }
            }
        } finally { server.shutdown() }
    }

    @Test fun authenticatedRedirectIsNeverFollowedAndOversizedOrInvalidDataIsRefused() = runBlocking {
        val server = MockWebServer()
        val redirect = MockWebServer()
        try {
            redirect.enqueue(MockResponse().setBody(body(false, false).toString()))
            val client = EditAvailabilityClient(server.url("/").toString())
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", redirect.url("/unexpected")))
            try { client.read("synthetic-only-jwt"); fail("Authenticated redirect followed") }
            catch (error: EditAvailabilityException) { assertEquals("availability_unavailable", error.code) }
            assertEquals(0, redirect.requestCount)
            for (source in listOf("{", body().toString() + " ".repeat(8193))) {
                server.enqueue(MockResponse().setBody(source))
                try { client.read("synthetic-only-jwt"); fail("Unbounded or malformed response accepted") }
                catch (error: EditAvailabilityException) { assertEquals("invalid_availability_response", error.code) }
            }
        } finally { server.shutdown(); redirect.shutdown() }
    }
}
