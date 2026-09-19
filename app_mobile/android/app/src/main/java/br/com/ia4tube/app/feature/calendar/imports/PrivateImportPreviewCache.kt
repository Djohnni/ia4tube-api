package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFileAttributeView
import java.nio.file.attribute.PosixFilePermission
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class ImportPreviewFailure(val code: String) : Exception("Não foi possível conferir a prévia privada.")

/** An in-process lease, never a URL, persistent thumbnail, phone original or shareable provider URI. */
internal class VerifiedImportPreview internal constructor(val owner: ImportOwner, val assetId: String,
    val mediaRevision: Long, val previewDigest: String, val part: ImportPrivatePreviewPart,
    internal val file: File, internal val epoch: Long) {
    override fun toString() = "VerifiedImportPreview(content=redacted)"
}

/** One bounded, evictable derived file for the entire runtime. Every entry requires a fresh authenticated GET. */
internal class PrivateImportPreviewCache(
    directory: File,
    private val origin: HttpUrl = "https://ia4tube-api.onrender.com".toHttpUrl(),
    private val client: OkHttpClient = previewClient(),
    private val allowLoopbackForTests: Boolean = false,
    private val deleteFileForTests: ((File) -> Boolean)? = null
) {
    private val root = directory.absoluteFile
    private val lock = Any()
    private val changes = MutableStateFlow(0L)
    val epochs = changes.asStateFlow()
    private var activeCall: Call? = null
    private var activeFile: File? = null
    private var activeOwner: ImportOwner? = null
    private var activeToken: String? = null
    private var storageUnavailable = false

    init {
        require(origin.encodedPath == "/" && origin.query == null && origin.fragment == null && origin.username.isEmpty() && origin.password.isEmpty())
        require(origin.isHttps || allowLoopbackForTests && origin.host in setOf("127.0.0.1", "localhost"))
        require(deleteFileForTests == null || allowLoopbackForTests && origin.host in setOf("127.0.0.1", "localhost"))
        require(!client.followRedirects && !client.followSslRedirects && !client.retryOnConnectionFailure &&
            client.cookieJar === CookieJar.NO_COOKIES && client.cache == null && client.interceptors.isEmpty() &&
            client.networkInterceptors.isEmpty() && client.authenticator === Authenticator.NONE && client.proxyAuthenticator === Authenticator.NONE)
        if (!root.exists()) require(root.mkdirs())
        require(root.isDirectory && root.canonicalFile == root && !Files.isSymbolicLink(root.toPath()))
        // Only this adapter's exact, flat cache namespace. Never recurse or touch source/checkpoint data.
        root.listFiles()?.forEach { candidate ->
            require(candidate.name.matches(Regex("[a-f0-9-]{36}\\.preview")) && candidate.canonicalFile.parentFile == root &&
                Files.isRegularFile(candidate.toPath(), LinkOption.NOFOLLOW_LINKS))
            require(candidate.delete())
        }
    }

    suspend fun load(owner: ImportOwner, token: String, tokenProvider: () -> String, ownerProvider: () -> ImportOwner?,
                     preview: ImportPrivatePreview, target: String): VerifiedImportPreview {
        val part = if (target == "thumbnail") preview.thumbnail else preview.variants.singleOrNull { it.target == target }
        if (part == null) throw ImportPreviewFailure("import_preview_target_invalid")
        validate(preview, part)
        if (token.isBlank() || token.length > 16_384 || tokenProvider() != token || ownerProvider() != owner)
            throw ImportPreviewFailure("import_preview_session_changed")
        val request = Request.Builder().url(part.url).header("Authorization", "Bearer $token")
            .header("Cache-Control", "no-store").header("Accept", part.mimeType).header("Accept-Encoding", "identity").get().build()
        val call = client.newCall(request)
        val file = File(root, "${UUID.randomUUID()}.preview")
        val epoch = synchronized(lock) {
            clearLocked()
            if (storageUnavailable) throw ImportPreviewFailure("import_preview_storage_unavailable")
            activeOwner = owner; activeToken = token; activeCall = call; activeFile = file; changes.value
        }
        fun guard() {
            if (!isCurrent(epoch, owner, token) || tokenProvider() != token || ownerProvider() != owner)
                throw ImportPreviewFailure("import_preview_session_changed")
        }
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { release(epoch) }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    release(epoch)
                    if (continuation.isActive) continuation.resumeWithException(ImportPreviewFailure("import_preview_interrupted"))
                }
                override fun onResponse(call: Call, response: Response) {
                    try {
                        response.use {
                            guard()
                            if (response.code in setOf(401, 403, 404, 410)) throw ImportPreviewFailure("import_preview_access_expired")
                            if (response.code != 200 || response.header("Content-Range") != null ||
                                response.header("Content-Encoding")?.let { it != "identity" } == true)
                                throw ImportPreviewFailure("import_preview_response_invalid")
                            val body = response.body ?: throw ImportPreviewFailure("import_preview_response_invalid")
                            if (body.contentType()?.toString()?.substringBefore(';') != part.mimeType ||
                                body.contentLength() != part.sizeBytes) throw ImportPreviewFailure("import_preview_response_invalid")
                            val digest = MessageDigest.getInstance("SHA-256")
                            var count = 0L
                            Files.newOutputStream(file.toPath(), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE).use { output ->
                                body.byteStream().use { input ->
                                    val buffer = ByteArray(64 * 1024)
                                    while (true) {
                                        guard(); if (!continuation.isActive) throw ImportPreviewFailure("import_preview_interrupted")
                                        val length = input.read(buffer); if (length < 0) break
                                        count += length
                                        if (count > part.sizeBytes) throw ImportPreviewFailure("import_preview_size_invalid")
                                        digest.update(buffer, 0, length); output.write(buffer, 0, length)
                                    }
                                    buffer.fill(0)
                                }
                            }
                            guard()
                            val sha = digest.digest().joinToString("") { "%02x".format(it) }
                            if (count != part.sizeBytes || sha != part.sha256) throw ImportPreviewFailure("import_preview_checksum_invalid")
                            val posix = Files.getFileAttributeView(file.toPath(), PosixFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)
                            if (posix != null) posix.setPermissions(setOf(PosixFilePermission.OWNER_READ))
                            else if (!allowLoopbackForTests || !file.setReadOnly())
                                throw ImportPreviewFailure("import_preview_storage_unavailable")
                            val verified = VerifiedImportPreview(owner, preview.assetId, preview.mediaRevision, preview.previewDigest, part, file, epoch)
                            if (continuation.isActive) continuation.resume(verified) else release(epoch)
                        }
                    } catch (error: Exception) {
                        release(epoch)
                        if (continuation.isActive) continuation.resumeWithException(if (error is ImportPreviewFailure) error
                            else ImportPreviewFailure("import_preview_invalid_result"))
                    } finally {
                        // A cancelled writer may have been holding an open file during release().
                        if (!isCurrent(epoch, owner, token)) discardOwnFile(file)
                    }
                }
            })
        }
    }

    fun isCurrent(epoch: Long, owner: ImportOwner, token: String): Boolean = synchronized(lock) {
        epoch == changes.value && activeOwner == owner && activeToken == token
    }
    fun release(epoch: Long) = synchronized(lock) { if (epoch == changes.value) clearLocked() }
    fun clear() = synchronized(lock) { clearLocked() }
    private fun clearLocked() {
        changes.value += 1; activeCall?.cancel(); activeCall = null
        activeOwner = null; activeToken = null
        activeFile?.let(::discardOwnFile)
        activeFile = null
    }
    private fun discardOwnFile(file: File): Unit = synchronized(lock) {
        if (storageUnavailable) return@synchronized
        val removed = runCatching {
            require(file.canonicalFile.parentFile == root)
            if (!Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS)) true
            else {
                require(Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS))
                deleteFileForTests?.invoke(file) ?: run { file.setWritable(true, true); file.delete() }
            }
        }.getOrDefault(false)
        // Keep the retained bytes charged by refusing all subsequent downloads in this runtime.
        // No repeated unlink, replacement file, recursive cleanup or hidden recovery.
        if (!removed) storageUnavailable = true
    }
    private fun validate(preview: ImportPrivatePreview, part: ImportPrivatePreviewPart) {
        require(GalleryImportPolicy.validId(preview.assetId) && preview.mediaRevision > 0 && preview.currentRevision >= preview.mediaRevision)
        require(GalleryImportPolicy.validSha256(preview.previewDigest) && part.sha256.matches(Regex("[a-f0-9]{64}")))
        require(part.target in setOf("feed", "story", "reel", "thumbnail") && part.mimeType == if (part.kind == ImportMediaKind.IMAGE) "image/jpeg" else "video/mp4")
        require(part.sizeBytes in 1..if (part.kind == ImportMediaKind.IMAGE) 8L * 1024 * 1024 else GalleryImportPolicy.VIDEO_MAX_BYTES)
        val url = part.url
        val expectedPath = preview.scheduleId?.let { scheduleId ->
            require(scheduleId.matches(Regex("[a-f0-9]{40}")))
            "/v1/social/calendar/imports/schedules/$scheduleId/preview/${part.target}"
        } ?: "/v1/social/calendar/imports/assets/${preview.assetId}/revisions/${preview.mediaRevision}/preview/${part.target}"
        require(url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port && url.query == null &&
            url.fragment == null && url.username.isEmpty() && url.password.isEmpty() &&
            url.encodedPath == expectedPath)
    }
    companion object {
        fun previewClient(): OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .retryOnConnectionFailure(false).cookieJar(CookieJar.NO_COOKIES).authenticator(Authenticator.NONE)
            .proxyAuthenticator(Authenticator.NONE).connectTimeout(15, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS)
            .callTimeout(60, TimeUnit.SECONDS).build()
    }
}
