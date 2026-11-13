package br.com.ia4tube.app.data.api

import br.com.ia4tube.app.data.models.ApiResult
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

/** Synthetic local HTTP only. Does not create accounts or use real Google credentials. */
class GoogleAuthApiClientTest {
    @Test fun readsTheExistingPublicConfigWithoutSendingAnAppSession() = runBlocking {
        val server = MockWebServer()
        try {
            server.enqueue(MockResponse().setBody("""{"ok":true,"client_id":"123-synthetic.apps.googleusercontent.com"}"""))
            val result = GoogleAuthApiClient(server.url("/").toString()).clientId() as ApiResult.Success
            assertEquals("123-synthetic.apps.googleusercontent.com", result.value)
            val request = requireNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            assertEquals("/auth/google-config", request.path)
            assertEquals("GET", request.method)
            assertNull(request.getHeader("Authorization"))
            assertEquals(0L, request.bodySize)
        } finally { server.shutdown() }
    }

    @Test fun googleIdTokenUsesOnlyTheExistingPostRouteAndTheOriginalResponseContract() = runBlocking {
        val server = MockWebServer()
        try {
            server.enqueue(MockResponse().setBody("""{"ok":true,"token":"synthetic-app-jwt","nome_time":"Empresa","saldo":0}"""))
            val result = GoogleAuthApiClient(server.url("/").toString()).signIn("synthetic-google-id-token") as ApiResult.Success
            assertEquals("synthetic-app-jwt", result.value.token)
            assertEquals("Empresa", result.value.nomeTime)
            val request = requireNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            assertEquals("POST", request.method)
            assertEquals("/auth/google", request.path)
            assertNull(request.getHeader("Authorization"))
            val body = JSONObject(request.body.readUtf8())
            assertEquals(1, body.length())
            assertEquals("synthetic-google-id-token", body.getString("id_token"))
        } finally { server.shutdown() }
    }

    @Test fun emptyTokensNeverLeaveTheDeviceAndErrorsDoNotExposeTheServerBody() = runBlocking {
        val server = MockWebServer()
        try {
            val api = GoogleAuthApiClient(server.url("/").toString())
            assertTrue(api.signIn("") is ApiResult.Failure)
            assertTrue(api.signIn("x".repeat(16_385)) is ApiResult.Failure)
            assertEquals(0, server.requestCount)
            for (status in listOf(401, 429, 503)) {
                server.enqueue(MockResponse().setResponseCode(status).setBody("private-server-body"))
                val result = api.signIn("synthetic-google-id-token") as ApiResult.Failure
                assertEquals(status, result.statusCode)
                assertFalse(result.message.contains("private-server-body"))
            }
        } finally { server.shutdown() }
    }

    @Test fun redirectsCannotForwardTheCredentialToAnotherHost() = runBlocking {
        val server = MockWebServer()
        val other = MockWebServer()
        try {
            other.start()
            server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", other.url("/collect")))
            assertTrue(GoogleAuthApiClient(server.url("/").toString()).signIn("synthetic-id-token") is ApiResult.Failure)
            assertEquals(0, other.requestCount)
        } finally { server.shutdown(); other.shutdown() }
    }

    @Test fun malformedConfigAndMissingSessionNeverCountAsSuccessfulLogin() = runBlocking {
        val server = MockWebServer()
        try {
            val api = GoogleAuthApiClient(server.url("/").toString())
            for (body in listOf("not-json", """{"ok":true,"client_id":"wrong.example"}""", """{"ok":false}""")) {
                server.enqueue(MockResponse().setBody(body))
                assertTrue(api.clientId() is ApiResult.Failure)
            }
            server.enqueue(MockResponse().setBody("""{"ok":true,"token":""}"""))
            assertTrue(api.signIn("synthetic-id-token") is ApiResult.Failure)
        } finally { server.shutdown() }
    }
}
