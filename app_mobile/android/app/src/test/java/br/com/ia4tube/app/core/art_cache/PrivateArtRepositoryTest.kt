package br.com.ia4tube.app.core.art_cache

import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.CRC32
import java.util.zip.DeflaterOutputStream
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** All requests stay on loopback and all identities/images are synthetic. */
class PrivateArtRepositoryTest {
    @get:Rule val temporary = TemporaryFolder()
    private lateinit var server: MockWebServer
    private lateinit var store: PrivateArtDiskStore
    private lateinit var client: OkHttpClient
    private val currentToken = AtomicReference(OWNER)
    private val generation = AtomicLong(1)
    private val firstImage = pixel(0xff336699.toInt())
    private val changedImage = pixel(0xffcc6633.toInt())

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
        store = PrivateArtDiskStore(temporary.newFolder("private-images"), TestCipher())
        client = privateArtHttpClient().newBuilder()
            .readTimeout(2, TimeUnit.SECONDS)
            .callTimeout(4, TimeUnit.SECONDS)
            .build()
    }

    @After fun tearDown() {
        server.shutdown()
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
    }

    @Test fun productionClientWaitsOneMinuteWithoutRedirectsRetriesOrSharedHttpCache() {
        val production = privateArtHttpClient()
        try {
            assertEquals(60_000, production.readTimeoutMillis)
            assertEquals(60_000, production.callTimeoutMillis)
            assertFalse(production.followRedirects)
            assertFalse(production.followSslRedirects)
            assertFalse(production.retryOnConnectionFailure)
            assertNull(production.cache)
        } finally {
            production.connectionPool.evictAll()
            production.dispatcher.executorService.shutdown()
        }
    }

    @Test fun firstDeliveryPersistsAndNewRepositoryShowsSavedBytesBeforeConditional304() {
        val url = preview()
        server.enqueue(imageResponse(firstImage, "\"first\""))
        val first = repository().load(url, OWNER)
        assertTrue(first.verified)
        assertArrayEquals(firstImage, first.art.bytes)
        assertArrayEquals(firstImage, store.get(key(url))!!.bytes)
        assertEquals("Bearer $OWNER", takeRequest().getHeader("Authorization"))

        server.enqueue(MockResponse().setResponseCode(304))
        val delivered = mutableListOf<ByteArray>()
        val reopened = repository().load(url, OWNER) {
            assertEquals("Saved delivery must precede the new HTTP request", 1, server.requestCount)
            delivered += it.bytes
        }
        assertTrue(reopened.verified)
        assertEquals(1, delivered.size)
        assertArrayEquals(firstImage, delivered.single())
        assertArrayEquals(firstImage, reopened.art.bytes)
        val conditional = takeRequest()
        assertEquals("GET", conditional.method)
        assertEquals("\"first\"", conditional.getHeader("If-None-Match"))
        assertEquals(0L, conditional.bodySize)
        assertEquals(2, server.requestCount)
    }

    @Test fun changedEtagReplacesTheSavedRepresentationAfterShowingPreviousCopy() {
        val url = preview()
        server.enqueue(imageResponse(firstImage, "\"first\""))
        repository().load(url, OWNER)
        takeRequest()
        server.enqueue(imageResponse(changedImage, "\"second\""))
        var immediate: SavedPrivateArt? = null
        val changed = repository().load(url, OWNER) { immediate = it }
        assertArrayEquals(firstImage, immediate!!.bytes)
        assertTrue(changed.verified)
        assertArrayEquals(changedImage, changed.art.bytes)
        assertArrayEquals(changedImage, store.get(key(url))!!.bytes)
        assertEquals("\"second\"", store.get(key(url))!!.etag)
        assertEquals("\"first\"", takeRequest().getHeader("If-None-Match"))
    }

    @Test fun undecodableEntryIsDiscardedAloneAndItsNextReadIsUnconditional() {
        val url = preview()
        val thumbnail = server.url("/pedidos/synthetic-order/thumbnail").toString()
        val repo = repository()
        listOf(url, thumbnail).forEach {
            server.enqueue(imageResponse(firstImage, "\"saved\""))
            repo.load(it, OWNER)
            takeRequest()
        }
        val anotherOwnerKey = privateArtKey("another-synthetic-owner", url.toHttpUrl())
        store.put(anotherOwnerKey, SavedPrivateArt(firstImage, "image/png", "\"other\"", null))

        repo.discardUndecodable(url, OWNER, generation.get())
        assertNull(store.get(key(url)))
        assertArrayEquals(firstImage, store.get(key(thumbnail))!!.bytes)
        assertArrayEquals(firstImage, store.get(anotherOwnerKey)!!.bytes)

        server.enqueue(imageResponse(changedImage, "\"repaired\""))
        var staleDelivered = false
        val repaired = repo.load(url, OWNER) { staleDelivered = true }
        assertFalse(staleDelivered)
        assertTrue(repaired.verified)
        assertArrayEquals(changedImage, repaired.art.bytes)
        val request = takeRequest()
        assertNull(request.getHeader("If-None-Match"))
        assertNull(request.getHeader("If-Modified-Since"))
        assertEquals(3, server.requestCount)
    }

    @Test fun staleSessionCannotDiscardCurrentSessionsSavedImage() {
        val url = preview()
        store.put(key(url), SavedPrivateArt(firstImage, "image/png", null, null))
        val repo = repository()
        repo.discardUndecodable(url, OWNER, generation.get() - 1)
        assertArrayEquals(firstImage, store.get(key(url))!!.bytes)
        repo.discardUndecodable(url, "another-synthetic-owner", generation.get())
        assertArrayEquals(firstImage, store.get(key(url))!!.bytes)
        assertEquals(0, server.requestCount)
    }

    @Test fun lastModifiedIsUsedOnlyWhenNoEtagExists() {
        val url = preview()
        val date = "Mon, 07 Sep 2026 12:00:00 GMT"
        server.enqueue(imageResponse(firstImage).addHeader("Last-Modified", date))
        repository().load(url, OWNER)
        takeRequest()
        server.enqueue(MockResponse().setResponseCode(304))
        assertTrue(repository().load(url, OWNER).verified)
        val request = takeRequest()
        assertEquals(date, request.getHeader("If-Modified-Since"))
        assertNull(request.getHeader("If-None-Match"))
    }

    @Test fun versionsAndPreviewThumbnailAndPreparedGalleryNeverAlias() {
        val urls = listOf(
            preview(),
            preview() + "?v=one",
            preview() + "?v=two",
            server.url("/pedidos/synthetic-order/thumbnail").toString(),
            server.url("/v1/social/calendar/items/${"a".repeat(40)}/image").toString()
        )
        val identities = urls.map(::key)
        assertEquals(urls.size, identities.toSet().size)
        val repo = repository()
        urls.forEach { url ->
            server.enqueue(imageResponse(firstImage, "\"same-content\""))
            var cacheDelivered = false
            repo.load(url, OWNER) { cacheDelivered = true }
            assertFalse("A distinct URL cannot inherit another representation", cacheDelivered)
            assertArrayEquals(firstImage, store.get(key(url))!!.bytes)
            assertNull(takeRequest().getHeader("If-None-Match"))
        }
        assertEquals(urls.size, server.requestCount)
    }

    @Test fun forbiddenAndMissingResponsesEvictAndDoNotReturnAnAuthorizedResult() {
        listOf(401, 403, 404).forEachIndexed { index, code ->
            val url = preview() + "?v=$index"
            server.enqueue(imageResponse(firstImage, "\"old\""))
            repository().load(url, OWNER)
            server.enqueue(MockResponse().setResponseCode(code))
            assertThrows(PrivateArtUnavailable::class.java) { repository().load(url, OWNER) }
            assertNull("HTTP $code must revoke the saved entry", store.get(key(url)))
        }
        assertEquals(6, server.requestCount)
    }

    @Test fun anonymousOrChangedAccountCannotReadAnotherOwnersSavedBytesOrSendARequest() {
        val url = preview()
        store.put(key(url), SavedPrivateArt(firstImage, "image/png", "\"private\"", null))
        val repo = repository()
        assertThrows(PrivateArtUnavailable::class.java) { repo.load(url, "") }
        currentToken.set("another-synthetic-owner")
        var exposed = false
        assertThrows(PrivateArtUnavailable::class.java) { repo.load(url, OWNER) { exposed = true } }
        assertFalse(exposed)
        assertEquals(0, server.requestCount)

        server.enqueue(MockResponse().setResponseCode(403))
        assertThrows(PrivateArtUnavailable::class.java) {
            repo.load(url, currentToken.get()) { exposed = true }
        }
        assertFalse(exposed)
        assertNull(takeRequest().getHeader("If-None-Match"))
        assertArrayEquals(firstImage, store.get(key(url))!!.bytes)
    }

    @Test fun tokenReplacementDuringResponseRejectsLateImageWithoutPersisting() {
        assertLateResponseRejected { currentToken.set("another-synthetic-owner") }
    }

    @Test fun sessionGenerationChangeDuringResponseRejectsLateImageWithoutPersisting() {
        assertLateResponseRejected { generation.incrementAndGet() }
    }

    @Test fun logoutDuringResponseCannotRepopulateTheClearedPrivateStore() {
        assertLateResponseRejected {
            currentToken.set("")
            generation.incrementAndGet()
            store.clear()
        }
    }

    @Test fun overlappingReadsOfTheSameRepresentationDownloadOnlyOnce() {
        val received = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                received.countDown()
                check(release.await(3, TimeUnit.SECONDS))
                return imageResponse(firstImage, "\"single\"")
            }
        }
        val repo = repository()
        val first = AtomicReference<PrivateArtResult?>()
        val second = AtomicReference<PrivateArtResult?>()
        val failure = AtomicReference<Throwable?>()
        val firstThread = Thread {
            try { first.set(repo.load(preview(), OWNER)) } catch (error: Throwable) { failure.set(error) }
        }
        val secondThread = Thread {
            try { second.set(repo.load(preview(), OWNER)) } catch (error: Throwable) { failure.set(error) }
        }
        try {
            firstThread.start()
            assertTrue(received.await(2, TimeUnit.SECONDS))
            secondThread.start()
            awaitBlocked(secondThread)
        } finally {
            release.countDown()
            firstThread.join(3_000)
            secondThread.join(3_000)
        }
        assertFalse(firstThread.isAlive)
        assertFalse(secondThread.isAlive)
        assertNull(failure.get())
        assertTrue(first.get()!!.verified)
        assertTrue(second.get()!!.verified)
        assertArrayEquals(first.get()!!.art.bytes, second.get()!!.art.bytes)
        assertEquals(1, server.requestCount)
    }

    @Test fun unavailableProviderKeepsExistingBytesButMarksThemUnverified() {
        val url = preview()
        server.enqueue(imageResponse(firstImage, "\"saved\""))
        repository().load(url, OWNER)
        server.enqueue(MockResponse().setResponseCode(503).setBody("temporarily unavailable"))
        val fallback = repository().load(url, OWNER)
        assertFalse(fallback.verified)
        assertArrayEquals(firstImage, fallback.art.bytes)
        assertArrayEquals(firstImage, store.get(key(url))!!.bytes)
        assertEquals(2, server.requestCount)
    }

    @Test fun failedNetworkKeepsSavedCopyUnverifiedAndDoesNotRetry() {
        val url = preview()
        server.enqueue(imageResponse(firstImage, "\"saved\""))
        repository().load(url, OWNER)
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        val fallback = repository().load(url, OWNER)
        assertFalse(fallback.verified)
        assertArrayEquals(firstImage, fallback.art.bytes)
        assertArrayEquals(firstImage, store.get(key(url))!!.bytes)
        assertEquals(2, server.requestCount)
    }

    @Test fun nonImageInvalidAndIncompletePayloadsAreNeverStored() {
        val candidates = listOf(
            "text/html" to "<html>not an image</html>".toByteArray(),
            "image/png" to "not-png".toByteArray(),
            "image/png" to firstImage.copyOf(firstImage.size - 7),
            "image/jpeg" to byteArrayOf(0xff.toByte(), 0xd8.toByte(), 1, 2, 3),
            "image/webp" to "RIFFbadlengthWEBPbad-data".toByteArray()
        )
        candidates.forEachIndexed { index, (contentType, bytes) ->
            val url = preview() + "?v=invalid-$index"
            server.enqueue(MockResponse().addHeader("Content-Type", contentType).setBody(Buffer().write(bytes)))
            assertThrows(PrivateArtUnavailable::class.java) { repository().load(url, OWNER) }
            assertNull(store.get(key(url)))
        }
        assertEquals(candidates.size, server.requestCount)
    }

    @Test fun brokenTransferCannotCreateAPartialCacheEntry() {
        val url = preview()
        server.enqueue(imageResponse(firstImage).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        assertThrows(PrivateArtUnavailable::class.java) { repository().load(url, OWNER) }
        assertNull(store.get(key(url)))
        assertEquals(1, server.requestCount)
    }

    @Test fun declaredOversizedBodyIsRejectedBeforeDownloadingIt() {
        val url = preview()
        server.enqueue(imageResponse(firstImage).setHeader("Content-Length", MAX_PRIVATE_ART_BYTES + 1))
        assertThrows(PrivateArtUnavailable::class.java) { repository().load(url, OWNER) }
        assertNull(store.get(key(url)))
        assertEquals(1, server.requestCount)
    }

    @Test fun chunkedBodyCannotExceedTheSameSizeLimit() {
        val url = preview()
        val oversized = ByteArray(MAX_PRIVATE_ART_BYTES + 1) { 1 }
        server.enqueue(MockResponse().addHeader("Content-Type", "image/png")
            .setChunkedBody(Buffer().write(oversized), 8192))
        assertThrows(PrivateArtUnavailable::class.java) { repository().load(url, OWNER) }
        assertNull(store.get(key(url)))
        assertEquals(1, server.requestCount)
    }

    @Test fun redirectIsNotFollowedAndNoCredentialReachesItsDestination() {
        val url = preview()
        server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", server.url("/elsewhere")))
        assertThrows(PrivateArtUnavailable::class.java) { repository().load(url, OWNER) }
        assertEquals(1, server.requestCount)
        assertEquals("/pedidos/synthetic-order/preview", takeRequest().path)
        assertNull(store.get(key(url)))
    }

    @Test fun exportMutationAndUnknownRoutesAreRejectedWithoutRequestsOrCacheReads() {
        val routes = listOf(
            "/pedidos/synthetic-order/download-resultado",
            "/pedidos/synthetic-order/download",
            "/pedidos/synthetic-order/publicar",
            "/pedidos/synthetic-order/preview?download=true",
            "/v1/social/calendar/items/${"a".repeat(40)}/image?anything=true",
            "/v1/social/calendar/items/not-an-id/image",
            "/v1/social/publish",
            "/v1/social/connect"
        )
        routes.forEach { path ->
            val url = server.url(path).toString()
            store.put(key(url), SavedPrivateArt(firstImage, "image/png", null, null))
            var delivered = false
            assertThrows(PrivateArtUnavailable::class.java) { repository().load(url, OWNER) { delivered = true } }
            assertFalse(delivered)
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun loadingOneArtDoesNotPrefetchOtherRepresentations() {
        server.enqueue(imageResponse(firstImage))
        repository().load(preview(), OWNER)
        assertEquals(1, server.requestCount)
        assertEquals("/pedidos/synthetic-order/preview", takeRequest().path)
        assertNull(store.get(key(server.url("/pedidos/synthetic-order/thumbnail").toString())))
    }

    private fun assertLateResponseRejected(changeSession: () -> Unit) {
        val requested = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requested.countDown()
                check(release.await(3, TimeUnit.SECONDS))
                return imageResponse(firstImage)
            }
        }
        val executor = Executors.newSingleThreadExecutor()
        val url = preview()
        try {
            val result = executor.submit<Boolean> {
                try { repository().load(url, OWNER); false } catch (_: PrivateArtUnavailable) { true }
            }
            assertTrue(requested.await(2, TimeUnit.SECONDS))
            changeSession()
            release.countDown()
            assertTrue(result.get(3, TimeUnit.SECONDS))
            assertNull(store.get(key(url)))
            assertEquals(1, server.requestCount)
        } finally {
            release.countDown()
            executor.shutdownNow()
        }
    }

    private fun repository() = PrivateArtRepository(
        cache = store,
        currentToken = { currentToken.get() },
        generation = { generation.get() },
        client = client,
        origin = server.url("/").toString().trimEnd('/')
    )

    private fun preview() = server.url("/pedidos/synthetic-order/preview").toString()
    private fun key(url: String) = privateArtKey(OWNER, url.toHttpUrl())
    private fun takeRequest() = requireNotNull(server.takeRequest(2, TimeUnit.SECONDS))

    private fun imageResponse(bytes: ByteArray, etag: String? = null) = MockResponse()
        .addHeader("Content-Type", "image/png")
        .setBody(Buffer().write(bytes))
        .apply { if (etag != null) addHeader("ETag", etag) }

    private fun awaitBlocked(thread: Thread) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
        while (thread.state != Thread.State.BLOCKED && thread.isAlive && System.nanoTime() < deadline) {
            Thread.yield()
        }
        assertEquals("Second read must overlap the first read's cache lock", Thread.State.BLOCKED, thread.state)
    }

    private class TestCipher : ArtCacheCipher {
        private val key = SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES")
        override fun encrypt(key: String, plain: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, this.key)
            cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
            return cipher.iv + cipher.doFinal(plain)
        }
        override fun decrypt(key: String, sealed: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, this.key, GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
            cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
            return cipher.doFinal(sealed.copyOfRange(12, sealed.size))
        }
    }

    companion object {
        private const val OWNER = "synthetic-private-art-owner"
        private fun pixel(argb: Int): ByteArray {
            val output = ByteArrayOutputStream()
            val png = DataOutputStream(output)
            png.write(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10))
            fun chunk(name: String, bytes: ByteArray) {
                val type = name.toByteArray(Charsets.US_ASCII)
                val checksum = CRC32().apply { update(type); update(bytes) }
                png.writeInt(bytes.size)
                png.write(type)
                png.write(bytes)
                png.writeInt(checksum.value.toInt())
            }
            val header = ByteArrayOutputStream().apply {
                DataOutputStream(this).use { data ->
                    data.writeInt(1)
                    data.writeInt(1)
                    data.write(byteArrayOf(8, 6, 0, 0, 0)) // Eight-bit RGBA, no interlace.
                }
            }.toByteArray()
            val pixels = ByteArrayOutputStream().apply {
                DeflaterOutputStream(this).use { compressed ->
                    compressed.write(byteArrayOf(
                        0, // PNG scanline filter: none.
                        (argb ushr 16).toByte(), (argb ushr 8).toByte(), argb.toByte(), (argb ushr 24).toByte()
                    ))
                }
            }.toByteArray()
            chunk("IHDR", header)
            chunk("IDAT", pixels)
            chunk("IEND", byteArrayOf())
            png.close()
            return output.toByteArray()
        }
    }
}
