package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class GalleryImportHttpApiTest {
    private val owner = ImportOwner("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
    private val uploadId = "33333333-3333-4333-8333-333333333333"
    private val assetId = "44444444-4444-4444-8444-444444444444"
    private val authorizationId = "55555555-5555-4555-8555-555555555555"
    private val token = "synthetic-auth-only"
    private val now = 100_000L
    private val bytes = "synthetic-image".toByteArray()
    private val sums = ImportPartChecksums.calculate(bytes)
    private val media = ImportSelection("selected-1", ImportMediaKind.IMAGE, "image/png", bytes.size.toLong(), 10, 10, null, sums.sha256)

    private fun capabilities(origin: String) = JSONObject().put("ok", true).put("enabled", true)
        .put("identity", JSONObject().put("companyId", owner.companyId).put("userId", owner.userId))
        .put("upload", JSONObject().put("origin", origin).put("chunkBytes", GalleryImportPolicy.CHUNK_BYTES)
            .put("maxImageBytes", GalleryImportPolicy.IMAGE_MAX_BYTES).put("maxVideoBytes", GalleryImportPolicy.VIDEO_MAX_BYTES))
        .put("preparation", JSONObject().put("enabled", false).put("maxVideoSeconds", 60).put("photoMusicSeconds", 15))
        .put("scheduling", JSONObject().put("enabled", false))
    private fun record(state: String = "uploading") = JSONObject().put("uploadId", uploadId).put("assetId", assetId)
        .put("kind", "image").put("mimeType", "image/png").put("sizeBytes", bytes.size).put("chunkBytes", GalleryImportPolicy.CHUNK_BYTES)
        .put("partCount", 1).put("state", state).put("ready", false).put("verification", if (state == "uploaded")
            JSONObject().put("sha256", sums.sha256).put("sizeBytes", bytes.size).put("mimeType", "image/png") else JSONObject.NULL)
    private fun authorization() = JSONObject().put("ok", true).put("part", JSONObject().put("uploadId", uploadId).put("partNumber", 1)
        .put("sizeBytes", bytes.size).put("authorizationId", authorizationId).put("expiresAt", now + 60_000))
    private fun grant(url: String, headers: JSONObject = JSONObject().put("Content-MD5", sums.md5Base64).put("Content-Length", bytes.size.toString())
        .put("x-amz-checksum-sha256", sums.sha256Base64)) = JSONObject().put("ok", true).put("grant", JSONObject()
        .put("url", url).put("method", "PUT").put("headers", headers).put("expiresAt", now + 60_000).put("sizeBytes", bytes.size))
    private fun MockWebServer.reply(json: JSONObject) { enqueue(MockResponse().setBody(json.toString()).setHeader("Content-Type", "application/json")) }
    private fun api(server: MockWebServer, tokenProvider: () -> String = { token }) = GalleryImportHttpApi(tokenProvider, token,
        server.url("/"), GalleryImportHttpApi.metadataClient(), GalleryImportHttpApi.mediaClient(), { now }, true)
    private suspend fun failure(action: suspend () -> Unit): ImportApiFailure {
        try { action(); fail("Expected protected failure") } catch (error: ImportApiFailure) { return error }
        throw AssertionError()
    }

    @Test fun authenticatedMetadataAndCredentialFreePutUseExplicitGrantsThenObserveProviderParts() = runBlocking {
        MockWebServer().use { metadata -> MockWebServer().use { storage ->
            metadata.start(); storage.start()
            metadata.reply(capabilities(storage.url("/").toString()))
            metadata.reply(JSONObject().put("ok", true).put("upload", record()))
            metadata.reply(authorization()); metadata.reply(grant(storage.url("/private-object?synthetic-signature=opaque").toString()))
            storage.enqueue(MockResponse().setResponseCode(200))
            metadata.reply(JSONObject().put("ok", true).put("upload", record().put("completedParts", JSONArray().put(
                JSONObject().put("partNumber", 1).put("sizeBytes", bytes.size).put("sha256", sums.sha256)))))
            val api = api(metadata)
            val capability = api.capabilities(); assertEquals(owner, capability.identity); assertFalse(capability.schedulingEnabled)
            val upload = api.start(owner, media, "stable-upload-key-1")
            val authorization = api.authorizePart(owner, upload, 1, sums)
            val grant = api.resolvePart(owner, authorization, sums)
            val progress = mutableListOf<Long>()
            api.putPart(grant, bytes) { done, _ -> progress.add(done) }
            val resumed = api.resume(owner, uploadId)
            assertEquals(0, resumed.completedParts.single().part)
            assertEquals(1, resumed.completedParts.single().serverPartNumber)
            assertEquals(bytes.size.toLong(), progress.last())
            val put = storage.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("PUT", put.method); assertNull(put.getHeader("Authorization")); assertNull(put.getHeader("Cookie"))
            assertEquals(sums.md5Base64, put.getHeader("Content-MD5")); assertArrayEquals(bytes, put.body.readByteArray())
            val metaRequests = (1..5).map { metadata.takeRequest(1, TimeUnit.SECONDS)!! }
            assertTrue(metaRequests.all { it.getHeader("Authorization") == "Bearer $token" })
            assertEquals("/v1/social/calendar/imports/uploads", metaRequests[1].path)
            assertEquals("stable-upload-key-1", JSONObject(metaRequests[1].body.readUtf8()).getString("idempotencyKey"))
            assertEquals(sums.sha256, JSONObject(metaRequests[2].body.readUtf8()).getString("sha256"))
            assertEquals("/v1/social/calendar/imports/uploads/$uploadId/resume", metaRequests.last().path)
        } }
    }

    @Test fun disabledCapabilityDoesNotAuthorizeAnotherAccountOrAnyUpload() = runBlocking {
        MockWebServer().use { metadata ->
            metadata.start(); metadata.reply(JSONObject().put("ok", true).put("enabled", false))
            val api = api(metadata)
            assertFalse(api.capabilities().enabled)
            assertEquals("import_owner_unavailable", failure { api.start(owner, media, "stable-upload-key") }.code)
            assertEquals(1, metadata.requestCount)
        }
    }

    @Test fun friendlyMusicLabelsPreserveStableIdsAndAcceptOlderServers() = runBlocking {
        MockWebServer().use { metadata ->
            metadata.start()
            val track = JSONObject().put("id", "track_aaaaaaaaaaaaaaaaaaaaaaaa")
                .put("commercialRightsConfirmed", true).put("testOnly", false)
            metadata.reply(capabilities(metadata.url("/").toString()).put("musicTracks", JSONArray()
                .put(JSONObject(track.toString()).put("displayName", "Café & Conforto"))))
            metadata.reply(capabilities(metadata.url("/").toString()).put("musicTracks", JSONArray().put(track)))
            val api = api(metadata)
            val named = api.capabilities().musicTracks.single()
            assertEquals(track.getString("id"), named.id)
            assertEquals("Café & Conforto", named.displayName)
            assertEquals(named.id, api.capabilities().musicTracks.single().displayName)
        }
    }

    @Test fun malformedMusicLabelsCannotReachThePicker() = runBlocking {
        for (name in listOf("", " leading", "trailing ", "line\nbreak", "hidden\u202e", "a".repeat(81))) {
            MockWebServer().use { metadata ->
                metadata.start()
                val track = JSONObject().put("id", "track_aaaaaaaaaaaaaaaaaaaaaaaa").put("displayName", name)
                    .put("commercialRightsConfirmed", true).put("testOnly", false)
                metadata.reply(capabilities(metadata.url("/").toString()).put("musicTracks", JSONArray().put(track)))
                assertEquals("import_response_invalid", failure { api(metadata).capabilities() }.code)
            }
        }
    }

    @Test fun foreignTenantAndChangedSessionDoNotSendAuthenticatedRequests() = runBlocking {
        MockWebServer().use { metadata ->
            metadata.start(); metadata.reply(capabilities("https://syntheticaccount.r2.cloudflarestorage.com"))
            var currentToken = token
            val api = api(metadata) { currentToken }; api.capabilities()
            assertEquals("import_owner_unavailable", failure { api.start(owner.copy(userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), media, "stable-upload-key") }.code)
            currentToken = "different-session"
            assertEquals("import_session_changed", failure { api.status(owner, uploadId) }.code)
            assertEquals(1, metadata.requestCount)
        }
    }

    @Test fun grantCannotChooseDifferentOriginInjectCredentialsOrChangeChecksum() = runBlocking {
        for (variant in listOf("origin", "authorization", "md5", "newline")) {
            MockWebServer().use { metadata -> MockWebServer().use { storage ->
                metadata.start(); storage.start(); metadata.reply(capabilities(storage.url("/").toString()))
                val headers = JSONObject().put("Content-MD5", sums.md5Base64)
                when (variant) {
                    "authorization" -> headers.put("Authorization", "Bearer synthetic-leak")
                    "md5" -> headers.put("Content-MD5", "incorrect")
                    "newline" -> headers.put("Content-Type", "application/octet-stream\r\nCookie: bad")
                }
                val url = if (variant == "origin") "https://different.r2.cloudflarestorage.com/private?secret=must-not-leak" else storage.url("/object").toString()
                metadata.reply(grant(url, headers))
                val api = api(metadata); api.capabilities()
                val error = failure { api.resolvePart(owner, ImportPartAuthorization(uploadId, 1, bytes.size, authorizationId, now + 60_000), sums) }
                assertEquals("import_response_invalid", error.code); assertFalse(error.message!!.contains("must-not-leak"))
                assertEquals(0, storage.requestCount)
            } }
        }
    }

    @Test fun metadataRedirectIsNotFollowedAndServerResponseCannotExposeSecretBody() = runBlocking {
        MockWebServer().use { metadata -> MockWebServer().use { foreign ->
            metadata.start(); foreign.start()
            metadata.enqueue(MockResponse().setResponseCode(302).setHeader("Location", foreign.url("/steal")))
            val api = api(metadata)
            assertEquals("import_request_rejected", failure { api.capabilities() }.code)
            assertEquals(0, foreign.requestCount)
            metadata.enqueue(MockResponse().setResponseCode(500).setBody("secret-token-should-not-surface"))
            val error = failure { api.capabilities() }
            assertFalse(error.message!!.contains("secret-token")); assertNull(error.cause)
        } }
    }

    @Test fun verifyingAndUploadedAreDifferentAndUploadedRequiresActualServerVerification() = runBlocking {
        MockWebServer().use { metadata ->
            metadata.start(); metadata.reply(capabilities("https://syntheticaccount.r2.cloudflarestorage.com"))
            metadata.reply(JSONObject().put("ok", true).put("upload", record("verifying")))
            metadata.reply(JSONObject().put("ok", true).put("upload", record("uploaded")))
            metadata.reply(JSONObject().put("ok", true).put("upload", record("uploaded").put("verification", JSONObject.NULL)))
            val api = api(metadata); api.capabilities()
            val pending = api.complete(owner, uploadId); assertEquals(ImportServerPhase.VERIFYING, pending.phase); assertNull(pending.verifiedSha256)
            val complete = api.status(owner, uploadId); assertEquals(sums.sha256, complete.verifiedSha256)
            assertEquals("import_response_invalid", failure { api.status(owner, uploadId) }.code)
        }
    }

    @Test fun duplicateProviderPartAndUnknownStateAreNotTrustedForResume() = runBlocking {
        MockWebServer().use { metadata ->
            metadata.start(); metadata.reply(capabilities("https://syntheticaccount.r2.cloudflarestorage.com"))
            val part = JSONObject().put("partNumber", 1).put("sizeBytes", bytes.size).put("sha256", sums.sha256)
            metadata.reply(JSONObject().put("ok", true).put("upload", record().put("completedParts", JSONArray().put(part).put(part))))
            metadata.reply(JSONObject().put("ok", true).put("upload", record("unexpected-new-state")))
            val api = api(metadata); api.capabilities()
            assertEquals("import_response_invalid", failure { api.resume(owner, uploadId) }.code)
            assertEquals("import_response_invalid", failure { api.status(owner, uploadId) }.code)
        }
    }

    @Test fun changedSessionAfterGrantCannotPutMedia() = runBlocking {
        MockWebServer().use { metadata -> MockWebServer().use { storage ->
            metadata.start(); storage.start(); metadata.reply(capabilities(storage.url("/").toString()))
            metadata.reply(grant(storage.url("/object").toString()))
            var session = token
            val api = api(metadata) { session }; api.capabilities()
            val grant = api.resolvePart(owner, ImportPartAuthorization(uploadId, 1, bytes.size, authorizationId, now + 60_000), sums)
            assertFalse(grant.toString().contains("object"))
            session = "other-session"
            assertEquals("import_session_changed", failure { api.putPart(grant, bytes) }.code)
            assertEquals(0, storage.requestCount)
        } }
    }

    @Test fun officialRenderOriginAcceptsOnlyTheExactBoundByteGrantWithoutSendingToProduction() = runBlocking {
        MockWebServer().use { metadata ->
            metadata.start()
            val origin = "https://ia4tube-api.onrender.com"
            metadata.reply(capabilities(origin))
            metadata.reply(grant("$origin/v1/social/calendar/imports/bytes/$authorizationId"))
            val api = api(metadata)
            assertEquals(origin, api.capabilities().uploadOrigin)
            val resolved = api.resolvePart(owner, ImportPartAuthorization(uploadId, 1, bytes.size, authorizationId, now + 60_000), sums)
            assertEquals("/v1/social/calendar/imports/bytes/$authorizationId", resolved.url.encodedPath)
            assertFalse(resolved.headers.keys.any { it.equals("authorization", true) || it.equals("cookie", true) })
            assertEquals(2, metadata.requestCount)
            // No putPart: this verifies metadata/grant validation only, never a live host.
        }
    }

    @Test fun renderUploadCannotBroadenOriginOrRedirectToAnotherApiPath() = runBlocking {
        val allowedOrigin = "https://ia4tube-api.onrender.com"
        for (origin in listOf("https://another.onrender.com", "http://ia4tube-api.onrender.com",
            "https://ia4tube-api.onrender.com:444", "https://ia4tube-api.onrender.com.attacker.invalid",
            "$allowedOrigin/other", "$allowedOrigin?other=1")) {
            MockWebServer().use { metadata ->
                metadata.start(); metadata.reply(capabilities(origin))
                assertEquals("import_response_invalid", failure { api(metadata).capabilities() }.code)
                assertEquals(1, metadata.requestCount)
            }
        }
        for (suffix in listOf("/v1/social/calendar", "/v1/social/calendar/imports/bytes/$uploadId",
            "/v1/social/calendar/imports/bytes/$authorizationId?extra=1", "/v1/social/calendar/imports/bytes/$authorizationId/extra")) {
            MockWebServer().use { metadata ->
                metadata.start(); metadata.reply(capabilities(allowedOrigin)); metadata.reply(grant(allowedOrigin + suffix))
                val api = api(metadata); api.capabilities()
                assertEquals("import_response_invalid", failure {
                    api.resolvePart(owner, ImportPartAuthorization(uploadId, 1, bytes.size, authorizationId, now + 60_000), sums)
                }.code)
                assertEquals(2, metadata.requestCount)
            }
        }
    }
}
