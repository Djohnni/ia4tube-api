package br.com.ia4tube.app.feature.instagram

import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest

/** Pure policies shared by the native flow and JVM tests. No environment fallbacks. */
object InstagramPolicies {
    const val OFFICIAL_API_ORIGIN = "https://ia4tube-api.onrender.com"
    const val MAX_JPEG_BYTES = 8 * 1024 * 1024
    const val MAX_SOURCE_CAPTION_LENGTH = 2150
    val REQUIRED_SCOPES: Set<String> = setOf(
        "instagram_business_basic", "instagram_business_content_publish"
    )
    private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
    private val media = Regex("^[A-Za-z0-9:_-]{20,200}$")
    private val forbiddenText = Regex("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]")

    fun validUuid(value: String): Boolean = uuid.matches(value)
    fun validMediaId(value: String): Boolean = media.matches(value)
    fun validCaption(value: String): Boolean = value == value.trim() &&
        value.length in 1..MAX_SOURCE_CAPTION_LENGTH && !forbiddenText.containsMatchIn(value)
    internal fun validPublishedCaption(value: String): Boolean = value.length in 1..2200 &&
        !forbiddenText.containsMatchIn(value)

    fun isOfficialApiBase(value: String): Boolean {
        val uri = secureUri(value) ?: return false
        return uri.scheme == "https" && uri.host == "ia4tube-api.onrender.com" &&
            uri.port == -1 && uri.rawQuery == null && uri.rawPath in listOf("", "/")
    }

    fun isOfficialAuthorizationUrl(value: String): Boolean {
        val uri = secureUri(value) ?: return false
        if (uri.scheme != "https" || uri.host != "www.instagram.com" || uri.port != -1 ||
            uri.rawPath != "/oauth/authorize") return false
        val query = parseQuery(uri.rawQuery ?: return false) ?: return false
        if (query.keys != setOf("client_id", "enable_fb_login", "redirect_uri", "response_type", "scope", "state")) return false
        val scopeList = query.getValue("scope").split(',')
        return Regex("^[0-9]{5,32}$").matches(query.getValue("client_id")) &&
            query["enable_fb_login"] == "0" && query["response_type"] == "code" &&
            scopeList.size == 2 && scopeList.toSet() == REQUIRED_SCOPES &&
            Regex("^[A-Za-z0-9._~-]{32,2048}$").matches(query.getValue("state")) &&
            query["redirect_uri"] == "$OFFICIAL_API_ORIGIN/v1/social/oauth/callback"
    }

    fun isOfficialPermalink(value: String): Boolean {
        val uri = secureUri(value) ?: return false
        return uri.scheme == "https" && uri.host == "www.instagram.com" && uri.port == -1 &&
            uri.rawQuery == null && Regex("^/p/[A-Za-z0-9_-]{3,100}/$").matches(uri.rawPath.orEmpty())
    }

    internal fun isOfficialThumbnail(value: String): Boolean {
        val uri = secureUri(value) ?: return false
        return uri.scheme == "https" && uri.host == "ia4tube-api.onrender.com" && uri.port == -1 &&
            uri.rawQuery == null && uri.rawPath.orEmpty().startsWith("/v1/social/reviewer/media-capability/") &&
            !uri.rawPath.orEmpty().contains("..")
    }

    /** A local storage partition identifier, never authentication or server tenant authority. */
    fun sessionKey(token: String): String = if (token.isBlank()) "" else
        MessageDigest.getInstance("SHA-256")
            .digest(("ia4tube-instagram-local-session-v1\u0000" + token).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun secureUri(value: String): URI? = try {
        if (value.length !in 1..8192 || value != value.trim() ||
            value.any { it <= ' ' || it == '\\' || it == '\u007f' }) null
        else URI(value).takeIf { !it.isOpaque && it.rawUserInfo == null && it.rawFragment == null && it.host != null }
    } catch (_: Exception) { null }

    private fun parseQuery(value: String): Map<String, String>? = try {
        val result = mutableMapOf<String, String>()
        var valid = true
        for (entry in value.split('&')) {
            val pair = entry.split('=', limit = 2)
            if (pair.size != 2) { valid = false; break }
            val name = URLDecoder.decode(pair[0], "UTF-8")
            val content = URLDecoder.decode(pair[1], "UTF-8")
            if (result.put(name, content) != null) { valid = false; break }
        }
        result.takeIf { valid }
    } catch (_: Exception) { null }

    /** Checks JPEG structure and dimensions; Android must also decode the selected image for preview. */
    fun validateJpeg(bytes: ByteArray): Boolean {
        if (bytes.size !in 16..MAX_JPEG_BYTES) return false
        fun u(index: Int) = bytes[index].toInt() and 0xff
        fun word(index: Int) = (u(index) shl 8) or u(index + 1)
        if (u(0) != 0xff || u(1) != 0xd8) return false
        var offset = 2
        var dimensionsFound = false
        var scanFound = false
        val sofMarkers = setOf(0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf)
        while (offset < bytes.size) {
            if (u(offset) != 0xff) return false
            while (offset < bytes.size && u(offset) == 0xff) offset++
            if (offset >= bytes.size) return false
            val marker = u(offset++)
            if (marker == 0xd9) return dimensionsFound && scanFound && offset == bytes.size
            if (marker == 0x00 || marker == 0xd8 || marker in 0xd0..0xd7 || marker == 0x01) return false
            if (offset + 2 > bytes.size) return false
            val length = word(offset)
            if (length < 2 || offset + length > bytes.size) return false
            if (marker in sofMarkers) {
                if (dimensionsFound || length < 8 || u(offset + 2) != 8 ||
                    word(offset + 3) != 1080 || word(offset + 5) != 1080) return false
                val components = u(offset + 7)
                if (components !in setOf(1, 3) || length != 8 + 3 * components) return false
                dimensionsFound = true
            }
            offset += length
            if (marker == 0xda) {
                if (!dimensionsFound || length < 6) return false
                scanFound = true
                while (offset < bytes.size) {
                    if (u(offset) != 0xff) { offset++; continue }
                    val start = offset
                    while (offset < bytes.size && u(offset) == 0xff) offset++
                    if (offset >= bytes.size) return false
                    if (u(offset) == 0x00 || u(offset) in 0xd0..0xd7) { offset++; continue }
                    offset = start
                    break
                }
            }
        }
        return false
    }
}
