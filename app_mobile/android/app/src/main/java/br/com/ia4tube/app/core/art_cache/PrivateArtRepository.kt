package br.com.ia4tube.app.core.art_cache

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

internal const val PRIVATE_ART_ORIGIN = "https://ia4tube-api.onrender.com"
internal const val MAX_PRIVATE_ART_BYTES = 20 * 1024 * 1024

internal fun privateArtHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
    .readTimeout(60, TimeUnit.SECONDS).callTimeout(60, TimeUnit.SECONDS).build()

internal data class PrivateArtResult(val art: SavedPrivateArt, val verified: Boolean)
internal class PrivateArtUnavailable : IOException("Não foi possível conferir esta imagem.")

/** Only these read-only representations may enter the private display cache.
 * In particular, download-resultado records a download and must never be prefetched.
 */
internal fun isPrivateArtUrl(url: HttpUrl, origin: HttpUrl): Boolean {
    if (url.scheme != origin.scheme || url.host != origin.host || url.port != origin.port ||
        url.username.isNotEmpty() || url.password.isNotEmpty() || url.fragment != null) return false
    val parts = url.pathSegments
    if (parts.size == 3 && parts[0] == "pedidos" && parts[2] in setOf("preview", "thumbnail")) {
        return parts[1].isNotBlank() && parts[1].length <= 200 &&
            parts[1].none { it == '/' || it == '\\' || it.code < 32 } &&
            url.queryParameterNames.all { it == "v" }
    }
    return parts.size == 6 && parts.take(4) == listOf("v1", "social", "calendar", "items") &&
        parts[4].matches(Regex("[a-f0-9]{40}")) && parts[5] == "image" &&
        (url.query == null || (url.queryParameterNames == setOf("destination") &&
            url.queryParameterValues("destination").size == 1 && url.queryParameter("destination") in setOf("feed", "story")))
}

internal fun privateArtKey(token: String, url: HttpUrl): String = MessageDigest.getInstance("SHA-256")
    .digest("private-art-v1\u0000$token\u0000$url".toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }

internal fun hasCompleteImageEnvelope(bytes: ByteArray, contentType: String): Boolean {
    if (bytes.isEmpty() || bytes.size > MAX_PRIVATE_ART_BYTES) return false
    fun at(index: Int) = bytes[index].toInt() and 255
    return when (contentType.substringBefore(';').trim().lowercase()) {
        "image/jpeg" -> bytes.size >= 4 && at(0) == 255 && at(1) == 216 &&
            at(bytes.size - 2) == 255 && at(bytes.size - 1) == 217
        "image/png" -> bytes.size >= 32 && bytes.take(8).toByteArray().contentEquals(
            byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)) &&
            bytes.copyOfRange(bytes.size - 8, bytes.size - 4).contentEquals("IEND".toByteArray())
        "image/webp" -> bytes.size >= 20 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" &&
            String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP" &&
            (at(4).toLong() or (at(5).toLong() shl 8) or (at(6).toLong() shl 16) or
                (at(7).toLong() shl 24)) + 8 == bytes.size.toLong()
        else -> false
    }
}

/** Reuses saved bytes immediately, then validates only ETag/date when the URL is mutable.
 * Exact representation URL is retained: watermarked preview, original and prepared JPEG
 * are intentionally different. A cache hit is never permission to publish or download.
 */
internal class PrivateArtRepository(
    private val cache: PrivateArtDiskStore,
    private val currentToken: () -> String,
    private val generation: () -> Long,
    private val client: OkHttpClient = privateArtHttpClient(),
    private val validateImage: (ByteArray, String) -> Boolean = ::hasCompleteImageEnvelope,
    origin: String = PRIVATE_ART_ORIGIN
) {
    private val originUrl = requireNotNull(origin.toHttpUrlOrNull())
    private val locks = Array(32) { Any() }
    private val completedReads = HashMap<String, Long>()

    init {
        require(originUrl.scheme == "https" || originUrl.host in setOf("127.0.0.1", "localhost", "::1"))
    }

    fun load(urlText: String, token: String, onSaved: (SavedPrivateArt) -> Unit = {}): PrivateArtResult {
        val url = urlText.toHttpUrlOrNull() ?: throw PrivateArtUnavailable()
        val owned = isPrivateArtUrl(url, originUrl)
        // Preserve HTTPS external previews without caching or forwarding IA4Tube credentials.
        val external = url.scheme == "https" && url.host != originUrl.host &&
            url.username.isEmpty() && url.password.isEmpty() && url.fragment == null
        if (!owned && !external) throw PrivateArtUnavailable()
        val ticket = generation()
        fun checkSession() {
            if (token.isBlank() || currentToken() != token || generation() != ticket) throw PrivateArtUnavailable()
        }
        checkSession()
        val key = privateArtKey(token, url)
        val started = System.nanoTime()
        synchronized(locks[(key.hashCode() and Int.MAX_VALUE) % locks.size]) {
            checkSession()
            val saved = if (owned) cache.get(key)?.let {
                if (validateImage(it.bytes, it.contentType)) it else { cache.remove(key); null }
            } else null
            if (saved != null) {
                checkSession()
                onSaved(saved)
                val alreadyChecked = synchronized(completedReads) {
                    // nanoTime has an arbitrary (possibly negative) origin; compare elapsed time.
                    completedReads[key]?.let { it - started >= 0L } ?: false
                }
                if (alreadyChecked) return PrivateArtResult(saved, true)
            }
            val request = Request.Builder().url(url).get()
            if (owned) request.header("Authorization", "Bearer $token")
            if (saved?.etag != null) request.header("If-None-Match", saved.etag)
            else if (saved?.lastModified != null) request.header("If-Modified-Since", saved.lastModified)
            val response = try { client.newCall(request.build()).execute() }
            catch (_: IOException) {
                checkSession()
                if (saved != null) return PrivateArtResult(saved, false)
                throw PrivateArtUnavailable()
            }
            response.use {
                checkSession()
                if (response.code == 304 && saved != null) {
                    rememberCompleted(key)
                    return PrivateArtResult(saved, true)
                }
                if (response.code in 500..599 && saved != null) return PrivateArtResult(saved, false)
                if (response.code != 200) {
                    if (owned) cache.remove(key)
                    throw PrivateArtUnavailable()
                }
                val body = response.body ?: throw PrivateArtUnavailable()
                val declaredLength = body.contentLength()
                if (declaredLength > MAX_PRIVATE_ART_BYTES) throw PrivateArtUnavailable()
                val bytes = try {
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    body.byteStream().use { input ->
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            if (output.size() + count > MAX_PRIVATE_ART_BYTES) throw PrivateArtUnavailable()
                            output.write(buffer, 0, count)
                        }
                    }
                    output.toByteArray()
                } catch (_: IOException) {
                    checkSession()
                    if (saved != null) return PrivateArtResult(saved, false)
                    throw PrivateArtUnavailable()
                }
                checkSession()
                val contentType = body.contentType()?.toString().orEmpty()
                if ((declaredLength >= 0 && declaredLength != bytes.size.toLong()) || !validateImage(bytes, contentType)) {
                    if (owned) cache.remove(key)
                    throw PrivateArtUnavailable()
                }
                fun validator(name: String) = response.header(name)?.takeIf {
                    it.isNotBlank() && it.length <= 1024 && it.none { char -> char.code < 32 || char.code == 127 }
                }
                val received = SavedPrivateArt(bytes, contentType, validator("ETag"), validator("Last-Modified"))
                if (owned) {
                    cache.put(key, received)
                    // A concurrent logout may have cleared the cache during disk I/O.
                    try { checkSession() } catch (error: PrivateArtUnavailable) { cache.remove(key); throw error }
                    rememberCompleted(key)
                }
                return PrivateArtResult(received, true)
            }
        }
    }

    private fun rememberCompleted(key: String) = synchronized(completedReads) {
        if (completedReads.size >= 512) completedReads.clear()
        completedReads[key] = System.nanoTime()
    }

    fun discardUndecodable(urlText: String, token: String, epoch: Long) {
        val url = urlText.toHttpUrlOrNull() ?: return
        if (isPrivateArtUrl(url, originUrl) && currentToken() == token && generation() == epoch) {
            val key = privateArtKey(token, url)
            cache.remove(key)
            synchronized(completedReads) { completedReads.remove(key) }
        }
    }
}
