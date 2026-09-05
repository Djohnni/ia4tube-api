package br.com.ia4tube.app.data.api

import br.com.ia4tube.app.data.models.ApiResult
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FcmDeviceApiClientTest {
    @Test
    fun registerAndDeactivateUseOnlyTheAuthorizedLocalContract() = runBlocking {
        val server = MockWebServer()
        server.enqueue(jsonOk())
        server.enqueue(jsonOk())
        server.enqueue(jsonOk())
        server.start()
        try {
            val client = FcmDeviceApiClient(baseUrl = server.url("/").toString())
            val authToken = "synthetic-jwt-never-use-outside-tests"
            val fcmToken = "synthetic-fcm-token-never-use-outside-tests"

            assertTrue(client.register(authToken, fcmToken) is ApiResult.Success)
            assertTrue(
                client.register(
                    authToken,
                    "synthetic-fcm-token-replacement",
                    previousToken = fcmToken
                ) is ApiResult.Success
            )
            assertTrue(client.deactivate(authToken, fcmToken) is ApiResult.Success)

            val register = server.takeRequest()
            val replacement = server.takeRequest()
            val deactivate = server.takeRequest()
            assertEquals("POST", register.method)
            assertEquals("POST", replacement.method)
            assertEquals("DELETE", deactivate.method)
            assertEquals("/me/fcm-token", register.path)
            assertEquals("/me/fcm-token", replacement.path)
            assertEquals("/me/fcm-token", deactivate.path)
            assertEquals("Bearer $authToken", register.getHeader("Authorization"))
            assertEquals("Bearer $authToken", replacement.getHeader("Authorization"))
            assertEquals("Bearer $authToken", deactivate.getHeader("Authorization"))
            assertBody(register.body.readUtf8(), fcmToken, "")
            assertBody(
                replacement.body.readUtf8(),
                "synthetic-fcm-token-replacement",
                fcmToken
            )
            assertBody(deactivate.body.readUtf8(), fcmToken, "")
        } finally {
            server.shutdown()
        }
    }

    private fun assertBody(
        serialized: String,
        expectedToken: String,
        expectedPreviousToken: String
    ) {
        val body = JSONObject(serialized)
        val expectedKeys = if (expectedPreviousToken.isBlank()) {
            setOf("token", "platform")
        } else {
            setOf("token", "platform", "previous_token")
        }
        assertEquals(expectedKeys, body.keys().asSequence().toSet())
        assertEquals(expectedToken, body.getString("token"))
        assertEquals("android", body.getString("platform"))
        if (expectedPreviousToken.isNotBlank()) {
            assertEquals(expectedPreviousToken, body.getString("previous_token"))
        }
    }

    private fun jsonOk(): MockResponse {
        return MockResponse()
            .setResponseCode(200)
            .setHeader("Content-Type", "application/json")
            .setBody("""{"ok":true}""")
    }
}
