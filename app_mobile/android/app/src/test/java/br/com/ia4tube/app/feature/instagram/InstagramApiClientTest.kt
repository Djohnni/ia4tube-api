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

class InstagramApiClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: InstagramApiClient
    private var token = "synthetic-local-session"

    @Before fun setUp() {
        server = MockWebServer()
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        client = InstagramApiClient.forLocalTests({ token }, "http://127.0.0.1:${server.port}/")
    }
    @After fun tearDown() { server.shutdown() }

    @Test fun currentConnectionUsesOnlyExistingBearerSessionAndNoTenantInput() = runBlocking {
        enqueue(JSONObject().put("ok", true).put("connection", connection()))
        val result = client.currentConnection()
        val value = (result as InstagramResult.Success).value!!
        assertTrue(value.canPublish)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/v1/social/connections/instagram", request.path)
        assertEquals("Bearer $token", request.getHeader("Authorization"))
        assertEquals("no-store", request.getHeader("Cache-Control"))
        assertEquals(0L, request.bodySize)
    }

    @Test fun noSessionMakesNoRequest() = runBlocking {
        token = ""
        assertEquals(InstagramResult.Failure(InstagramError.SESSION_REQUIRED), client.currentConnection())
        assertEquals(0, server.requestCount)
    }

    @Test fun publicConstructorCannotUseLocalOrStagingOrigins() = runBlocking {
        val badOrigins = listOf("http://127.0.0.1:${server.port}", "https://ia4tube-api-staging-checkpoint-a.onrender.com")
        for (origin in badOrigins) {
            assertEquals(InstagramResult.Failure(InstagramError.UNAVAILABLE), InstagramApiClient({ token }, origin).currentConnection())
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun redirectsAreNotFollowedAndCannotForwardTheToken() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "/redirect-target"))
        assertEquals(InstagramResult.Failure(InstagramError.UNAVAILABLE), client.currentConnection())
        assertEquals(1, server.requestCount)
        assertEquals("/v1/social/connections/instagram", server.takeRequest().path)
    }

    @Test fun unavailableAndErrorsNeverExposeServerTextOrSecrets() = runBlocking {
        for (status in listOf(403, 404, 503)) {
            server.enqueue(MockResponse().setResponseCode(status).setBody("private-access-token secret internal host"))
            val failure = client.currentConnection() as InstagramResult.Failure
            assertEquals(InstagramError.UNAVAILABLE, failure.error)
            assertFalse(failure.toString().contains("private-access-token"))
        }
    }

    @Test fun sessionChangeDiscardsAnOtherwiseSuccessfulResponse() = runBlocking {
        var reads = 0
        val changingClient = InstagramApiClient.forLocalTests({ if (reads++ == 0) "first-session" else "second-session" },
            "http://127.0.0.1:${server.port}/")
        enqueue(JSONObject().put("ok", true).put("connection", connection()))
        assertEquals(InstagramResult.Failure(InstagramError.SESSION_REQUIRED), changingClient.currentConnection())
    }

    @Test fun authorizeAcceptsOnlyValidatedOfficialUrlAndExplicitPurpose() = runBlocking {
        val fixture = JSONObject().put("ok", true).put("provider", "instagram")
            .put("status", "authorization_pending").put("connectionId", CONNECTION)
            .put("authorizationUrl", InstagramPoliciesTest.authorizationUrl()).put("expiresAt", DATE)
        enqueue(fixture)
        assertTrue(client.authorize("connect") is InstagramResult.Success)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals(setOf("purpose"), JSONObject(request.body.readUtf8()).keys().asSequence().toSet())
        enqueue(fixture.put("authorizationUrl", "https://evil.example/oauth"))
        assertEquals(InstagramResult.Failure(InstagramError.INVALID_RESPONSE), client.authorize("connect"))
        val count = server.requestCount
        assertEquals(InstagramResult.Failure(InstagramError.INVALID_INPUT), client.authorize("other"))
        assertEquals(count, server.requestCount)
    }

    @Test fun authorizationResultMustBelongToRequestedConnection() = runBlocking {
        enqueue(JSONObject().put("ok", true).put("authorization", JSONObject()
            .put("connectionId", OTHER_CONNECTION).put("purpose", "connect")
            .put("status", "authorization_completed").put("expiresAt", DATE)))
        assertEquals(InstagramResult.Failure(InstagramError.INVALID_RESPONSE), client.authorizationStatus(CONNECTION))
    }

    @Test fun uploadValidatesLocallyAndUsesExactlyJpegAndCaption() = runBlocking {
        assertEquals(InstagramResult.Failure(InstagramError.INVALID_INPUT), client.uploadMedia(byteArrayOf(1), "caption"))
        assertEquals(0, server.requestCount)
        enqueue(JSONObject().put("ok", true).put("contentOwnerDerivedFromSession", true).put("media", media()))
        val result = client.uploadMedia(InstagramPoliciesTest.jpegEnvelope(), "caption") as InstagramResult.Success
        assertEquals("caption\n\n#IA4TubeReview_fixture", result.value.caption)
        val request = server.takeRequest()
        assertEquals("/v1/social/reviewer/media", request.path)
        assertTrue(request.getHeader("Content-Type")!!.startsWith("multipart/form-data;"))
        val body = request.body.readUtf8()
        assertTrue(body.contains("name=\"jpeg\"; filename=\"preview_ia4tube.jpg\""))
        assertTrue(body.contains("Content-Type: image/jpeg"))
        assertTrue(body.contains("name=\"caption\""))
        assertFalse(body.contains("companyId"))
    }

    @Test fun publishPreservesCallerIntentAndSendingIsNotPublished() = runBlocking {
        enqueue(JSONObject().put("ok", true).put("publication", publication("sending")), 202)
        val result = client.publish(MEDIA, REQUEST) as InstagramResult.Success
        assertFalse(result.value.confirmed)
        assertTrue(result.value.pending)
        val body = JSONObject(server.takeRequest().body.readUtf8())
        assertEquals(setOf("mediaId", "clientRequestId"), body.keys().asSequence().toSet())
        assertEquals(REQUEST, body.getString("clientRequestId"))
        assertEquals(MEDIA, body.getString("mediaId"))
    }

    @Test fun falsePublishedAndUntrustedPermalinkNeverBecomeSuccess() = runBlocking {
        enqueue(JSONObject().put("ok", true).put("publication", publication("published")), 201)
        assertEquals(InstagramResult.Failure(InstagramError.RESULT_UNKNOWN), client.publish(MEDIA, REQUEST))
        val unsafe = publication("published").put("providerMediaId", "1234567890")
            .put("publishedAt", DATE).put("permalink", "https://evil.example/p/AbCdE_123/")
        enqueue(JSONObject().put("ok", true).put("publication", unsafe), 201)
        assertEquals(InstagramResult.Failure(InstagramError.RESULT_UNKNOWN), client.publish(MEDIA, REQUEST))
    }

    @Test fun ambiguousPublicationTransportFailureIsNotAutomaticallyRetried() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        assertEquals(InstagramResult.Failure(InstagramError.RESULT_UNKNOWN), client.publish(MEDIA, REQUEST))
        assertEquals(1, server.requestCount)
    }

    @Test fun gateRejectionHasSafeUnavailableMessageEvenOnPublish() = runBlocking {
        enqueue(JSONObject().put("ok", false).put("code", "external_capability_disabled")
            .put("error", "private configuration"), 503)
        assertEquals(InstagramResult.Failure(InstagramError.UNAVAILABLE), client.publish(MEDIA, REQUEST))
    }

    @Test fun confirmedPublicationRequiresAllServerEvidenceAndRequestedId() = runBlocking {
        val confirmed = publication("published").put("providerMediaId", "1234567890")
            .put("publishedAt", DATE).put("permalink", "https://www.instagram.com/p/AbCdE_123/")
        enqueue(JSONObject().put("ok", true).put("publication", confirmed))
        val result = client.publication(PUBLICATION) as InstagramResult.Success
        assertTrue(result.value.confirmed)
        enqueue(JSONObject().put("ok", true).put("publication", confirmed.put("publicationId", OTHER_CONNECTION)))
        assertEquals(InstagramResult.Failure(InstagramError.INVALID_RESPONSE), client.publication(PUBLICATION))
    }

    @Test fun reconciliationUsesExistingPublicationAndNeverCreatesNewIntent() = runBlocking {
        enqueue(JSONObject().put("ok", true).put("publication", publication("provider_confirming")), 202)
        val result = client.reconcile(PUBLICATION) as InstagramResult.Success
        assertTrue(result.value.pending)
        val request = server.takeRequest()
        assertEquals("/v1/social/reviewer/publications/$PUBLICATION/reconcile", request.path)
        assertEquals("POST", request.method)
        assertEquals(0, JSONObject(request.body.readUtf8()).length())
    }

    @Test fun historyCannotOfferFreshPublicationWhileAnotherIsPending() = runBlocking {
        val history = JSONObject().put("ok", true).put("canonicalPersistence", true)
            .put("independentReview", true).put("freshPublicationAvailable", true)
            .put("publications", org.json.JSONArray().put(publication("sending")))
        enqueue(history)
        assertEquals(InstagramResult.Failure(InstagramError.INVALID_RESPONSE), client.publications())
    }

    @Test fun stagedMediaCapabilityIsRejectedByOfficialClient() = runBlocking {
        val staged = media().put("thumbnailUrl", "https://ia4tube-api-staging-checkpoint-a.onrender.com/v1/social/reviewer/media-capability/fixture")
        enqueue(JSONObject().put("ok", true).put("contentOwnerDerivedFromSession", true).put("media", staged))
        assertEquals(InstagramResult.Failure(InstagramError.INVALID_RESPONSE), client.uploadMedia(InstagramPoliciesTest.jpegEnvelope(), "caption"))
    }

    private fun enqueue(value: JSONObject, status: Int = 200) {
        server.enqueue(MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(value.toString()))
    }

    private fun connection() = JSONObject().put("connectionId", CONNECTION).put("provider", "instagram")
        .put("state", "connected").put("health", "healthy").put("username", "@fixture_account").put("accountType", "business")

    private fun media() = JSONObject().put("id", MEDIA).put("mimeType", "image/jpeg")
        .put("caption", "caption\n\n#IA4TubeReview_fixture").put("width", 1080).put("height", 1080)
        .put("thumbnailUrl", InstagramPolicies.OFFICIAL_API_ORIGIN + "/v1/social/reviewer/media-capability/fixture")

    private fun publication(state: String) = JSONObject().put("publicationId", PUBLICATION).put("connectionId", CONNECTION)
        .put("state", state).put("media", JSONObject().put("id", MEDIA).put("mimeType", "image/jpeg"))
        .put("caption", "caption").put("account", JSONObject.NULL).put("providerMediaId", JSONObject.NULL)
        .put("permalink", JSONObject.NULL).put("publishedAt", JSONObject.NULL).put("createdAt", DATE).put("updatedAt", DATE)

    companion object {
        private const val CONNECTION = "11111111-1111-4111-8111-111111111111"
        private const val OTHER_CONNECTION = "22222222-2222-4222-8222-222222222222"
        private const val PUBLICATION = "33333333-3333-4333-8333-333333333333"
        private const val REQUEST = "44444444-4444-4444-8444-444444444444"
        private const val MEDIA = "reviewer-jpeg:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        private const val DATE = "2026-09-05T12:00:00.000Z"
    }
}
