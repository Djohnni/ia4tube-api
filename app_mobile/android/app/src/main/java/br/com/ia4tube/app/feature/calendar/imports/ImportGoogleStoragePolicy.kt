package br.com.ia4tube.app.feature.calendar.imports

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import kotlin.math.abs

/** Only a profile supplied by authenticated iA4tube metadata, never a user-selected host. */
class ImportGoogleStorageProfile internal constructor(val bucket: String, val objectPrefix: String,
    val singleRequestVideo: Boolean = false) {
    override fun toString() = "ImportGoogleStorageProfile(redacted)"
}

/** Short-lived and memory-only. It is deliberately not part of the durable checkpoint. */
internal class ImportGoogleDownloadGrant(val url: HttpUrl, val expiresAtEpochMs: Long, val generation: String,
    val profile: ImportGoogleStorageProfile) {
    override fun toString() = "ImportGoogleDownloadGrant(redacted)"
}

internal object ImportGoogleStoragePolicy {
    const val TRANSPORT = "gcs-parts-v1"
    const val HEADER = "X-IA4Tube-Media-Transport"
    private val dateFormat = DateTimeFormatter.ofPattern("uuuuMMdd'T'HHmmss'Z'").withResolverStyle(ResolverStyle.STRICT)
    private val fields = setOf("X-Goog-Algorithm", "X-Goog-Credential", "X-Goog-Date", "X-Goog-Expires",
        "X-Goog-SignedHeaders", "X-Goog-Signature")
    private val putHeaders = setOf("host", "content-length", "content-md5", "content-type", "x-goog-if-generation-match")

    fun parseProfile(json: JSONObject): ImportGoogleStorageProfile {
        val bucket = json.getString("bucket")
        require(bucket.matches(Regex("[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]")) && !bucket.matches(Regex("[0-9.]+")))
        require(json.getString("objectPrefix") == "ready-video/")
        val single = if (json.has("singleRequestVideo")) json.get("singleRequestVideo").also { require(it is Boolean) } as Boolean else false
        return ImportGoogleStorageProfile(bucket, "ready-video/", single)
    }

    fun parseDownload(json: JSONObject, profile: ImportGoogleStorageProfile?, nowEpochMs: Long = System.currentTimeMillis()): ImportGoogleDownloadGrant = try {
        require(profile != null)
        val rawExpiry = json.get("expiresAt")
        require(rawExpiry is Number && rawExpiry.toDouble().isFinite() && rawExpiry.toDouble() == rawExpiry.toLong().toDouble())
        val expires = rawExpiry.toLong()
        val url = json.getString("url").toHttpUrl()
        val generation = json.get("generation").also { require(it is String) } as String
        require(generation.matches(Regex("[1-9][0-9]{0,24}")) && url.queryParameter("generation") == generation)
        validateSignedUrl(url, profile, expires, nowEpochMs, "GET")
        ImportGoogleDownloadGrant(url, expires, generation, profile)
    } catch (_: Exception) {
        // URL/JSON parsers may include their input in exception messages. Do not
        // let a signed grant escape through calendar errors or their causes.
        throw IllegalArgumentException("Invalid Google media grant")
    }

    fun validateSignedUrl(url: HttpUrl, profile: ImportGoogleStorageProfile, expiresAtEpochMs: Long,
        nowEpochMs: Long, method: String, signedRequestHeaders: Set<String> = emptySet()) {
        require(method in setOf("PUT", "GET"))
        require(url.isHttps && url.host == "storage.googleapis.com" && url.port == 443 &&
            url.username.isEmpty() && url.password.isEmpty() && url.fragment == null)
        val path = url.encodedPath
        val prefix = "/${profile.bucket}/${profile.objectPrefix}"
        require(path.startsWith(prefix) && path.length > prefix.length &&
            path.matches(Regex("/[A-Za-z0-9._/-]+")) && path.split('/').drop(1).none { it.isEmpty() || it == "." || it == ".." })
        val names = url.queryParameterNames
        require(names.containsAll(fields) && names.all { it in fields || method == "GET" && it == "generation" })
        require(names.all { url.queryParameterValues(it).size == 1 })
        require(url.queryParameter("X-Goog-Algorithm") == "GOOG4-RSA-SHA256")
        val signedDate = url.queryParameter("X-Goog-Date")!!
        require(signedDate.matches(Regex("[0-9]{8}T[0-9]{6}Z")))
        val issued = LocalDateTime.parse(signedDate, dateFormat).toInstant(ZoneOffset.UTC).toEpochMilli()
        val seconds = url.queryParameter("X-Goog-Expires")!!
        require(seconds.matches(Regex("[1-9][0-9]{0,2}")) && seconds.toLong() <= 900)
        val expires = issued + seconds.toLong() * 1000
        require(issued <= nowEpochMs + 60_000 && expiresAtEpochMs > nowEpochMs &&
            expiresAtEpochMs <= nowEpochMs + 900_000 && abs(expires - expiresAtEpochMs) <= 1000)
        val credential = url.queryParameter("X-Goog-Credential")!!
        require(credential.matches(Regex("[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\\.gserviceaccount\\.com/${signedDate.take(8)}/auto/storage/goog4_request")))
        val signature = url.queryParameter("X-Goog-Signature")!!
        require(signature.length in 256..2048 && signature.length % 2 == 0 && signature.matches(Regex("[a-f0-9]+")))
        val signed = url.queryParameter("X-Goog-SignedHeaders")!!.split(';')
        require(signed == signed.distinct().sorted() && "host" in signed)
        if (method == "GET") {
            require(signed == listOf("host"))
            url.queryParameter("generation")?.let { require(it.matches(Regex("[1-9][0-9]{0,24}"))) }
        } else {
            require(signed.all { it in putHeaders } && signed.containsAll(setOf("host", "content-md5", "content-type")) &&
                signed.containsAll(signedRequestHeaders.map { it.lowercase() }))
        }
    }
}
