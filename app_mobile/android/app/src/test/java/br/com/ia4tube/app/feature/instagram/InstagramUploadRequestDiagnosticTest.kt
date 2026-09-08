package br.com.ia4tube.app.feature.instagram

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.util.concurrent.TimeUnit

/** Synthetic payloads and an explicitly bound loopback server; never production or Instagram. */
class InstagramUploadRequestDiagnosticTest {
    private lateinit var server: MockWebServer
    private lateinit var client: InstagramApiClient
    private var token = "synthetic-upload-session"

    @Before fun setUp() {
        server = MockWebServer()
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        client = InstagramApiClient.forLocalTests({ token }, base())
    }
    @After fun tearDown() { server.shutdown() }

    @Test fun successPreservesTheRealStatusAndTimeWithoutCopyingMediaOrHeaders() = runBlocking {
        enqueue(success(), 201)
        val before = System.currentTimeMillis()
        val result = upload() as InstagramResult.Success
        val diagnostic = result.diagnostic!!
        assertEquals(201, diagnostic.httpStatus)
        assertEquals(InstagramRequestStage.HTTP_RESPONSE, diagnostic.stage)
        assertEquals("http_success", diagnostic.code)
        assertTrue(diagnostic.requestStarted)
        assertTrue(diagnostic.responseReceived)
        assertFalse(diagnostic.outcomeUnknown)
        assertTrue(diagnostic.startedAtEpochMillis in before..System.currentTimeMillis())
        assertTrue(diagnostic.durationMillis >= 0)
        assertSanitized(diagnostic)
        assertEquals(1, server.requestCount)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/social/reviewer/media", request.path)
        assertTrue(request.getHeader("Content-Type")!!.startsWith("multipart/form-data;"))
        assertFalse(request.path!!.contains(token))
    }

    @Test fun localInputFailureHasNoInventedRequestOrStatus() = runBlocking {
        val result = client.uploadMedia(byteArrayOf(1, 2, 3), PRIVATE_CAPTION) as InstagramResult.Failure
        assertLocal(result, "local_invalid_input")
        assertEquals(0, server.requestCount)
    }

    @Test fun localSessionAndOriginFailuresHaveNoRequestOrSecret() = runBlocking {
        for (invalid in listOf("", "Bearer $PRIVATE_TOKEN", "x".repeat(8193))) {
            token = invalid
            assertLocal(upload() as InstagramResult.Failure, "local_session_required")
        }
        token = "synthetic-upload-session"
        val refused = InstagramApiClient({ token }, "https://untrusted.invalid/$PRIVATE_TOKEN")
        assertLocal(refused.uploadMedia(InstagramPoliciesTest.jpegEnvelope(), PRIVATE_CAPTION) as InstagramResult.Failure,
            "local_unavailable")
        assertEquals(0, server.requestCount)
    }

    @Test fun contractFourHundredsAreRejectedWithOnlyAllowlistedCodes() = runBlocking {
        val cases = listOf(
            400 to "reviewer_media_invalid", 401 to "social_session_login_required",
            403 to "social_origin_forbidden", 404 to "resource_unavailable",
            409 to "reviewer_media_limit_reached", 413 to "reviewer_media_too_large",
            429 to "reviewer_media_upload_in_progress"
        )
        for ((status, code) in cases) {
            enqueue(rejection(code), status)
            val diagnostic = (upload() as InstagramResult.Failure).diagnostic!!
            assertEquals(status, diagnostic.httpStatus)
            assertEquals(code, diagnostic.code)
            assertEquals(InstagramRequestStage.HTTP_RESPONSE, diagnostic.stage)
            assertTrue(diagnostic.requestStarted && diagnostic.responseReceived)
            assertFalse(diagnostic.outcomeUnknown)
            assertSanitized(diagnostic)
        }
        assertEquals(cases.size, server.requestCount)
    }

    @Test fun untrustedCodesAreNeverCoercedOrEchoedIntoDiagnostics() = runBlocking {
        for (code in listOf<Any>(PRIVATE_TOKEN, "reviewer_media_invalid$PRIVATE_TOKEN", 400,
            JSONObject().put("code", PRIVATE_TOKEN), JSONObject.NULL)) {
            enqueue(rejection(code).put("correlationId", PRIVATE_TOKEN).put("resource", PRIVATE_URL), 422)
            val result = upload() as InstagramResult.Failure
            assertEquals("http_rejected", result.diagnostic!!.code)
            assertEquals(422, result.diagnostic.httpStatus)
            assertFalse(result.diagnostic.outcomeUnknown)
            assertSanitized(result.diagnostic)
            assertFalse(result.toString().contains(PRIVATE_TOKEN))
        }
    }

    @Test fun everyServerErrorStaysUnknownEvenWithAnOtherwiseNormalRejectionBody() = runBlocking {
        for (status in listOf(500, 501, 502, 503, 504)) {
            enqueue(rejection("reviewer_media_storage_unavailable").put("status", 400), status)
            val diagnostic = (upload() as InstagramResult.Failure).diagnostic!!
            assertEquals(status, diagnostic.httpStatus)
            assertEquals("reviewer_media_storage_unavailable", diagnostic.code)
            assertTrue(diagnostic.outcomeUnknown)
            assertEquals(InstagramRequestStage.HTTP_RESPONSE, diagnostic.stage)
            assertSanitized(diagnostic)
        }
        assertEquals(5, server.requestCount)
    }

    @Test fun serverErrorWithUnknownCodeUsesStaticFallbackAndNotClaimedBodyStatus() = runBlocking {
        enqueue(rejection(PRIVATE_TOKEN).put("httpStatus", 201), 503)
        val diagnostic = (upload() as InstagramResult.Failure).diagnostic!!
        assertEquals(503, diagnostic.httpStatus)
        assertEquals("http_server_error", diagnostic.code)
        assertTrue(diagnostic.outcomeUnknown)
        assertSanitized(diagnostic)
    }

    @Test fun invalidOrContradictoryResponseAfterSendingNeverBecomesAProvenRejection() = runBlocking {
        val cases = listOf(
            201 to PRIVATE_TOKEN,
            201 to rejection("reviewer_media_invalid").toString(),
            400 to "<html>$PRIVATE_TOKEN</html>",
            400 to success().toString(),
            201 to success().put("media", JSONObject().put("id", PRIVATE_TOKEN)).toString(),
            201 to success().put("contentOwnerDerivedFromSession", "true").toString(),
            201 to success().also { it.remove("contentOwnerDerivedFromSession") }.toString(),
            201 to success().put("ok", "true").toString()
        )
        for ((status, body) in cases) {
            server.enqueue(MockResponse().setResponseCode(status).setBody(body))
            val diagnostic = (upload() as InstagramResult.Failure).diagnostic!!
            assertEquals(status, diagnostic.httpStatus)
            assertEquals("response_invalid", diagnostic.code)
            assertEquals(InstagramRequestStage.INVALID_RESPONSE, diagnostic.stage)
            assertTrue(diagnostic.requestStarted && diagnostic.responseReceived && diagnostic.outcomeUnknown)
            assertSanitized(diagnostic)
        }
        assertEquals(cases.size, server.requestCount)
    }

    @Test fun oversizedResponseIsBoundedAndCannotCopyASecret() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(201).setBody(PRIVATE_TOKEN + "x".repeat(1024 * 1024)))
        val diagnostic = (upload() as InstagramResult.Failure).diagnostic!!
        assertEquals("response_invalid", diagnostic.code)
        assertTrue(diagnostic.outcomeUnknown)
        assertEquals(201, diagnostic.httpStatus)
        assertSanitized(diagnostic)
        assertEquals(1, server.requestCount)
    }

    @Test fun redirectIsNotFollowedAndItsLocationNeverBecomesDiagnosticData() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", PRIVATE_URL))
        val diagnostic = (upload() as InstagramResult.Failure).diagnostic!!
        assertEquals(307, diagnostic.httpStatus)
        assertEquals("http_redirect_refused", diagnostic.code)
        assertTrue(diagnostic.outcomeUnknown)
        assertSanitized(diagnostic)
        assertEquals(1, server.requestCount)
    }

    @Test fun connectionLossAfterRequestDoesNotInventStatusOrRetry() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        val diagnostic = (upload() as InstagramResult.Failure).diagnostic!!
        assertTrue(diagnostic.requestStarted)
        assertFalse(diagnostic.responseReceived)
        assertNull(diagnostic.httpStatus)
        assertEquals(InstagramRequestStage.TRANSPORT, diagnostic.stage)
        assertEquals("transport_failure", diagnostic.code)
        assertTrue(diagnostic.outcomeUnknown)
        assertEquals(1, server.requestCount)
    }

    @Test fun connectionClosedBeforeHttpParsingStillDoesNotClaimNoProcessing() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        val diagnostic = (upload() as InstagramResult.Failure).diagnostic!!
        assertTrue(diagnostic.requestStarted && diagnostic.outcomeUnknown)
        assertFalse(diagnostic.responseReceived)
        assertNull(diagnostic.httpStatus)
        assertEquals("transport_failure", diagnostic.code)
        assertEquals(InstagramRequestStage.TRANSPORT, diagnostic.stage)
        assertTrue("No second attempt may be made", server.requestCount <= 1)
    }

    @Test fun timeoutWithoutResponseKeepsUnknownAndHasNoHttpStatus() = runBlocking {
        client = InstagramApiClient.forLocalTests({ token }, base(), timeoutMillis = 300)
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val diagnostic = (upload() as InstagramResult.Failure).diagnostic!!
        assertTrue(diagnostic.requestStarted && diagnostic.outcomeUnknown)
        assertFalse(diagnostic.responseReceived)
        assertNull(diagnostic.httpStatus)
        assertEquals("transport_timeout", diagnostic.code)
        assertEquals(InstagramRequestStage.TRANSPORT, diagnostic.stage)
        assertEquals(1, server.requestCount)
    }

    @Test fun timeoutAfterResponseHeadersRetainsOnlyTheObservedStatus() = runBlocking {
        client = InstagramApiClient.forLocalTests({ token }, base(), timeoutMillis = 500)
        server.enqueue(MockResponse().setResponseCode(201).setBody(success().toString()).setBodyDelay(2, TimeUnit.SECONDS))
        val diagnostic = (upload() as InstagramResult.Failure).diagnostic!!
        assertTrue(diagnostic.requestStarted && diagnostic.responseReceived && diagnostic.outcomeUnknown)
        assertEquals(201, diagnostic.httpStatus)
        assertEquals("transport_timeout", diagnostic.code)
        assertEquals(InstagramRequestStage.TRANSPORT, diagnostic.stage)
        assertSanitized(diagnostic)
        assertEquals(1, server.requestCount)
    }

    @Test fun changedSessionDoesNotAdoptSuccessAndStillPreservesObservedHttpEvidence() = runBlocking {
        var reads = 0
        client = InstagramApiClient.forLocalTests({ if (reads++ == 0) "old-synthetic" else "new-synthetic" }, base())
        enqueue(success(), 201)
        val result = upload() as InstagramResult.Failure
        assertEquals(InstagramError.SESSION_REQUIRED, result.error)
        assertEquals(201, result.diagnostic!!.httpStatus)
        assertEquals("session_changed", result.diagnostic.code)
        assertTrue(result.diagnostic.outcomeUnknown)
        assertSanitized(result.diagnostic)
        assertEquals(1, server.requestCount)
    }

    @Test fun constructorRejectsSensitiveCodesAndImpossibleEvidenceWithoutEcho() {
        val valid = InstagramRequestDiagnostic(true, false, null, "request_started",
            InstagramRequestStage.REQUEST_INITIATED, 1, 0, true)
        assertTrue(InstagramRequestDiagnostic.isAllowedCode(valid.code))
        val invalid = listOf<() -> InstagramRequestDiagnostic>(
            { valid.copy(code = PRIVATE_TOKEN) }, { valid.copy(httpStatus = 201) },
            { valid.copy(responseReceived = true) }, { valid.copy(outcomeUnknown = false) },
            { valid.copy(startedAtEpochMillis = -1) }, { valid.copy(durationMillis = -1) },
            { valid.copy(stage = InstagramRequestStage.LOCAL_VALIDATION) },
            { valid.copy(stage = InstagramRequestStage.HTTP_RESPONSE, responseReceived = true,
                httpStatus = 503, code = "http_server_error", outcomeUnknown = false) },
            { valid.copy(stage = InstagramRequestStage.HTTP_RESPONSE, responseReceived = true,
                httpStatus = 400, code = "http_success", outcomeUnknown = false) }
        )
        for (create in invalid) {
            try { create(); fail("Invalid diagnostic accepted") }
            catch (error: IllegalArgumentException) {
                assertEquals("Invalid request diagnostic", error.message)
                assertFalse(error.toString().contains(PRIVATE_TOKEN))
            }
        }
    }

    @Test fun unrelatedResultCallersRetainNullDiagnosticsAndExistingEquality() = runBlocking {
        token = ""
        assertEquals(InstagramResult.Failure(InstagramError.SESSION_REQUIRED), client.currentConnection())
        val success = InstagramResult.Success("ordinary-safe-result")
        assertNull(success.diagnostic)
        assertEquals(InstagramResult.Success("ordinary-safe-result"), success)
        assertEquals(0, server.requestCount)
    }

    private suspend fun upload() = client.uploadMedia(InstagramPoliciesTest.jpegEnvelope(), PRIVATE_CAPTION)
    private fun base() = "http://127.0.0.1:${server.port}/"
    private fun enqueue(body: JSONObject, status: Int) {
        server.enqueue(MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json")
            .setHeader("Set-Cookie", PRIVATE_TOKEN).setHeader("X-Request-Id", PRIVATE_TOKEN).setBody(body.toString()))
    }
    private fun rejection(code: Any) = JSONObject().put("ok", false).put("code", code)
        .put("error", PRIVATE_TOKEN).put("body", PRIVATE_CAPTION).put("signedUrl", PRIVATE_URL)
    private fun success() = JSONObject().put("ok", true).put("contentOwnerDerivedFromSession", true)
        .put("correlationId", PRIVATE_TOKEN).put("resource", PRIVATE_URL).put("media", JSONObject()
            .put("id", "reviewer-jpeg:" + "a".repeat(64)).put("mimeType", "image/jpeg")
            .put("caption", PRIVATE_CAPTION).put("width", 1080).put("height", 1080)
            .put("thumbnailUrl", InstagramPolicies.OFFICIAL_API_ORIGIN + "/v1/social/reviewer/media-capability/$PRIVATE_TOKEN"))
    private fun assertLocal(result: InstagramResult.Failure, code: String) {
        val diagnostic = result.diagnostic!!
        assertEquals(code, diagnostic.code)
        assertEquals(InstagramRequestStage.LOCAL_VALIDATION, diagnostic.stage)
        assertFalse(diagnostic.requestStarted || diagnostic.responseReceived || diagnostic.outcomeUnknown)
        assertNull(diagnostic.httpStatus)
        assertSanitized(diagnostic)
    }
    private fun assertSanitized(diagnostic: InstagramRequestDiagnostic) {
        val text = diagnostic.toString()
        for (secret in listOf(PRIVATE_TOKEN, PRIVATE_CAPTION, PRIVATE_URL, token)) {
            if (secret.isNotBlank()) assertFalse("Sensitive fixture entered diagnostic", text.contains(secret))
        }
        assertFalse(text.contains("thumbnailUrl"))
        assertFalse(text.contains("correlationId"))
        assertFalse(text.contains("Authorization"))
        assertFalse(text.contains("reviewer-jpeg:"))
    }

    companion object {
        private const val PRIVATE_TOKEN = "synthetic_sensitive_token_CANARY_83291"
        private const val PRIVATE_CAPTION = "Synthetic private caption CANARY_97241"
        private const val PRIVATE_URL = "https://untrusted.invalid/capability/synthetic_sensitive_token_CANARY_83291"
    }
}
