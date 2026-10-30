package br.com.ia4tube.app.data.api

import br.com.ia4tube.app.core.company.CompanyProfile
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.UploadFile
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

/** Local fake HTTP only. No account, payment, generated art or production request. */
class CompanyProfileApiClientTest {
    private fun response(profile: CompanyProfile = CompanyProfile(), logo: Boolean = false, updated: Any = JSONObject.NULL) =
        JSONObject().put("ok", true).put("profile", CompanyProfileApiClient.encode(profile)
            .put("has_logo", logo).put("updated_at", updated)).toString()

    @Test fun everyFieldIsOptionalAndFacebookAndOtherLinksRoundTrip() {
        val empty = CompanyProfileApiClient.parse(response())
        assertEquals(CompanyProfile(), empty.profile); assertNull(empty.updatedAt); assertFalse(empty.hasLogo)
        val profile = CompanyProfile(historia = "Linha 1\nLinha 2", facebook = "https://example.invalid/facebook",
            outrosLinks = "https://example.invalid/one\nhttps://example.invalid/two")
        assertEquals(profile, CompanyProfileApiClient.parse(response(profile, updated = "2026-10-30T00:00:00.000Z")).profile)
        assertEquals(13, CompanyProfileApiClient.encode(profile).length())
        assertFalse(CompanyProfileApiClient.encode(profile).has("logoUri"))
        assertFalse(CompanyProfileApiClient.encode(profile).has("owner"))
    }

    @Test fun readUsesBearerAndNoTokenQueryOrBody() = runBlocking {
        val server = MockWebServer()
        try {
            server.enqueue(MockResponse().setBody(response()))
            assertTrue(CompanyProfileApiClient(server.url("/").toString()).read("synthetic-jwt") is ApiResult.Success)
            val request = requireNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            assertEquals("GET", request.method); assertEquals("/company/profile", request.path)
            assertEquals("Bearer synthetic-jwt", request.getHeader("Authorization"))
            assertEquals("no-store", request.getHeader("Cache-Control")); assertEquals(0L, request.bodySize)
        } finally { server.shutdown() }
    }

    @Test fun multipartCanSaveBlankFieldsAndRemoveLogoWithoutGeneration() = runBlocking {
        val server = MockWebServer()
        try {
            server.enqueue(MockResponse().setBody(response(updated = "2026-10-30T00:00:00Z")))
            val result = CompanyProfileApiClient(server.url("/").toString()).save("synthetic-jwt", CompanyProfile(), null, true)
            assertTrue(result is ApiResult.Success)
            val sent = requireNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            assertEquals("PUT", sent.method); assertEquals("/company/profile", sent.path)
            assertTrue(requireNotNull(sent.getHeader("Content-Type")).startsWith("multipart/form-data;"))
            val body = sent.body.readUtf8()
            assertTrue(body.contains("name=\"profile\"")); assertTrue(body.contains("\"nome_empresa\":\"\""))
            assertTrue(body.contains("name=\"remove_logo\"")); assertFalse(body.contains("name=\"logo\""))
            assertFalse(body.contains("synthetic-jwt")); assertFalse(body.contains("gerar"))
        } finally { server.shutdown() }
    }

    @Test fun optionalLogoIsAFilePartAndConflictingOrOversizedInputNeverSends() = runBlocking {
        val server = MockWebServer()
        try {
            val api = CompanyProfileApiClient(server.url("/").toString())
            val logo = UploadFile("private-original.png", "image/png", byteArrayOf(1, 2, 3))
            assertTrue(api.save("synthetic-jwt", CompanyProfile(), logo, true) is ApiResult.Failure)
            assertTrue(api.save("synthetic-jwt", CompanyProfile(),
                logo.copy(bytes = ByteArray(CompanyProfileApiClient.MAX_LOGO_BYTES + 1)), false) is ApiResult.Failure)
            assertEquals(0, server.requestCount)
            server.enqueue(MockResponse().setBody(response(logo = true, updated = "2026-10-30T00:00:00Z")))
            assertTrue(api.save("synthetic-jwt", CompanyProfile(), logo, false) is ApiResult.Success)
            val sent = requireNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            val body = sent.body.readUtf8()
            assertTrue(body.contains("name=\"logo\"; filename=\"logo.png\""))
            assertFalse(body.contains("private-original"))
        } finally { server.shutdown() }
    }

    @Test fun redirectsAndInvalidResponsesFailClosedWithoutLeakingTheServerBody() = runBlocking {
        val server = MockWebServer(); val redirected = MockWebServer()
        try {
            redirected.start()
            val api = CompanyProfileApiClient(server.url("/").toString())
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", redirected.url("/private")))
            assertTrue(api.read("synthetic-jwt") is ApiResult.Failure)
            assertEquals(0, redirected.requestCount)
            for (status in listOf(401, 413, 503)) {
                server.enqueue(MockResponse().setResponseCode(status).setBody("server-private-text"))
                val result = api.read("synthetic-jwt") as ApiResult.Failure
                assertEquals(status, result.statusCode); assertFalse(result.message.contains("server-private-text"))
            }
            server.enqueue(MockResponse().setBody("not-json"))
            assertTrue(api.read("synthetic-jwt") is ApiResult.Failure)
            server.enqueue(MockResponse().setBody(" ".repeat(131_073)))
            assertTrue(api.read("synthetic-jwt") is ApiResult.Failure)
        } finally { server.shutdown(); redirected.shutdown() }
    }

    @Test fun logoIsAuthenticatedPngAndMalformedImageIsNotAccepted() = runBlocking {
        val server = MockWebServer()
        try {
            val png = byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10, 1)
            server.enqueue(MockResponse().setHeader("Content-Type", "image/png").setBody(okio.Buffer().write(png)))
            val api = CompanyProfileApiClient(server.url("/").toString())
            val result = api.logo("synthetic-jwt") as ApiResult.Success<UploadFile>
            assertArrayEquals(png, result.value.bytes)
            val sent = requireNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            assertEquals("/company/profile/logo", sent.path); assertEquals("Bearer synthetic-jwt", sent.getHeader("Authorization"))
            server.enqueue(MockResponse().setHeader("Content-Type", "image/png").setBody("not an image"))
            assertTrue(api.logo("synthetic-jwt") is ApiResult.Failure)
        } finally { server.shutdown() }
    }
}
