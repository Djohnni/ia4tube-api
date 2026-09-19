package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class PrivateImportPreviewCacheTest {
    private lateinit var server: MockWebServer
    private lateinit var directory: File
    private lateinit var cache: PrivateImportPreviewCache
    private val owner = ImportPreparationTestData.owner
    private var token = "synthetic-session"
    private var activeOwner: ImportOwner? = owner
    private val bytes = ByteArray(130_017) { (it % 251).toByte() }
    @Before fun start() {
        server = MockWebServer(); server.start()
        directory = Files.createTempDirectory("private-preview-test-").toFile().canonicalFile
        cache = PrivateImportPreviewCache(directory, server.url("/"), allowLoopbackForTests = true)
    }
    @After fun end() {
        cache.clear(); server.shutdown()
        directory.listFiles()?.forEach { it.setWritable(true, true); check(it.delete()) }; check(directory.delete())
    }
    private fun preview(sha: String = hash(bytes), target: String = "feed", url: String? = null, schedule: String? = null): ImportPrivatePreview {
        val asset = ImportPreparationTestData.assetId
        val path = if (schedule != null) "/v1/social/calendar/imports/schedules/$schedule/preview/$target"
            else "/v1/social/calendar/imports/assets/$asset/revisions/1/preview/$target"
        val part = ImportPrivatePreviewPart(target, ImportMediaKind.IMAGE, "image/jpeg", sha, "a".repeat(64), 1080, 1350,
            bytes.size.toLong(), null, ImportAudioMode.NONE, false, (url ?: server.url(path).toString()).toHttpUrl())
        return ImportPrivatePreview(asset, 1, 1, "c".repeat(64), false, listOf(part), null, schedule)
    }
    private fun response(body: ByteArray = bytes) = MockResponse().setHeader("Content-Type", "image/jpeg").setBody(Buffer().write(body))
    private suspend fun load(preview: ImportPrivatePreview = preview()) = cache.load(owner, token, { token }, { activeOwner }, preview, "feed")
    private suspend fun failure(action: suspend () -> Unit): Exception {
        try { action(); fail("Expected bounded, sanitized rejection") } catch (failure: Exception) { return failure }
        error("unreachable")
    }
    @Test fun `download is exact derived bytes authenticated no-store and one bounded private lease`() = runBlocking {
        server.enqueue(response())
        val result = load()
        assertArrayEquals(bytes, result.file.readBytes())
        assertTrue(cache.isCurrent(result.epoch, owner, token))
        assertEquals(1, directory.listFiles()!!.size)
        val request = server.takeRequest()
        assertEquals("Bearer synthetic-session", request.getHeader("Authorization"))
        assertEquals("no-store", request.getHeader("Cache-Control"))
        assertEquals("identity", request.getHeader("Accept-Encoding"))
        assertFalse(result.toString().contains(token)); assertFalse(result.toString().contains(result.file.path))
        cache.release(result.epoch)
        assertFalse(result.file.exists())
    }
    @Test fun `checksum tamper and truncated body leave no playable cache`() = runBlocking {
        server.enqueue(response())
        assertEquals("import_preview_checksum_invalid", (failure { load(preview("e".repeat(64))) } as ImportPreviewFailure).code)
        server.enqueue(response(bytes.copyOf(500)))
        assertEquals("import_preview_response_invalid", (failure { load() } as ImportPreviewFailure).code)
        assertTrue(directory.listFiles()!!.isEmpty())
    }
    @Test fun `foreign path origin and mismatched scheduled record rejected before credentials`() = runBlocking {
        failure { load(preview(url = "https://foreign.invalid/private.jpg")) }
        failure { load(preview(url = server.url("/v1/social/calendar/items/anything/image").toString())) }
        val id = "d".repeat(40)
        failure { load(preview(schedule = id).copy(scheduleId = "e".repeat(40))) }
        assertEquals(0, server.requestCount)
    }
    @Test fun `historical schedule bytes use exactly schedule binding not latest editor revision`() = runBlocking {
        val id = "d".repeat(40)
        server.enqueue(response())
        val result = load(preview(schedule = id))
        assertEquals("/v1/social/calendar/imports/schedules/$id/preview/feed", server.takeRequest().path)
        assertEquals(ImportPreparationTestData.assetId, result.assetId)
    }
    @Test fun `redirect expired partial and wrong MIME responses never become playable`() = runBlocking {
        val responses = listOf(MockResponse().setResponseCode(302).setHeader("Location", server.url("/elsewhere")),
            MockResponse().setResponseCode(403), response().setResponseCode(206).setHeader("Content-Range", "bytes 0-100/130017"),
            response().setHeader("Content-Type", "text/html"))
        for (response in responses) { server.enqueue(response); failure { load() } }
        assertEquals(4, server.requestCount); assertTrue(directory.listFiles()!!.isEmpty())
    }
    @Test fun `next visible item retires old lease and owner token cannot reuse it`() = runBlocking {
        server.enqueue(response()); val first = load()
        server.enqueue(response()); val second = load()
        assertFalse(first.file.exists()); assertFalse(cache.isCurrent(first.epoch, owner, token))
        assertEquals(1, directory.listFiles()!!.size)
        assertFalse(cache.isCurrent(second.epoch, owner.copy(companyId = "other"), token))
        assertFalse(cache.isCurrent(second.epoch, owner, "another-session"))
        cache.release(first.epoch); assertTrue(second.file.exists())
    }
    @Test fun `session change in flight removes partial bytes and cannot revive prior result`() = runBlocking {
        server.enqueue(response().throttleBody(1024, 30, TimeUnit.MILLISECONDS))
        val result = async { runCatching { load() } }
        delay(80); activeOwner = owner.copy(companyId = "another-company")
        val error = result.await().exceptionOrNull()
        assertTrue(error is ImportPreviewFailure)
        assertTrue(directory.listFiles()!!.isEmpty())
        activeOwner = owner
        assertFalse(cache.isCurrent(cache.epochs.value - 1, owner, token))
    }
    @Test fun `leaving cancels pending download and removes transient file`() = runBlocking {
        server.enqueue(response().throttleBody(1024, 30, TimeUnit.MILLISECONDS))
        val job = async { load() }
        delay(60); job.cancel(); job.join(); delay(100)
        assertTrue(directory.listFiles()!!.isEmpty())
    }
    @Test fun `unrecognized cache contents fail closed without deleting another artifact`() {
        val other = File(directory, "original-photo.jpg").apply { writeBytes(byteArrayOf(1)) }
        assertThrows(IllegalArgumentException::class.java) { PrivateImportPreviewCache(directory, server.url("/"), allowLoopbackForTests = true) }
        assertTrue(other.exists())
    }
    @Test fun `failed unlink preserves charged file and blocks later downloads without cleanup retry`(): Unit = runBlocking {
        var deletes = 0
        cache = PrivateImportPreviewCache(directory, server.url("/"), allowLoopbackForTests = true,
            deleteFileForTests = { deletes++; false })
        server.enqueue(response()); val retained = load()
        cache.release(retained.epoch)
        assertTrue(retained.file.exists()); assertEquals(1, deletes)
        server.enqueue(response())
        assertEquals("import_preview_storage_unavailable", (failure { load() } as ImportPreviewFailure).code)
        cache.clear()
        assertEquals(1, deletes); assertEquals(1, server.requestCount); assertTrue(retained.file.exists())
        assertThrows(IllegalArgumentException::class.java) {
            PrivateImportPreviewCache(directory, "https://ia4tube-api.onrender.com".toHttpUrl(), allowLoopbackForTests = true,
                deleteFileForTests = { true })
        }
    }
    private fun hash(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
}
