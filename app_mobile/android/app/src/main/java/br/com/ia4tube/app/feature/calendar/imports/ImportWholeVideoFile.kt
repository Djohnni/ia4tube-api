package br.com.ia4tube.app.feature.calendar.imports

import java.io.InputStream
import java.security.MessageDigest
import java.util.Base64

/** Reopenable selected content only. No URI, signed URL, or entire-video byte array is retained. */
internal class ImportWholeVideoFile(
    val sizeBytes: Int,
    val checksums: ImportPartChecksums,
    private val openSource: () -> InputStream
) {
    init { require(sizeBytes.toLong() in 1..GalleryImportPolicy.VIDEO_MAX_BYTES) }
    fun open(): InputStream = openSource()
    override fun toString() = "ImportWholeVideoFile(content=redacted)"

    companion object {
        /** Hash before authorization with a 64 KiB buffer; the PUT reads the selected content again. */
        fun inspect(sizeBytes: Int, expectedSha256: String, open: () -> InputStream, checkActive: () -> Unit): ImportWholeVideoFile {
            require(sizeBytes.toLong() in 1..GalleryImportPolicy.VIDEO_MAX_BYTES)
            val sha = MessageDigest.getInstance("SHA-256")
            val md5 = MessageDigest.getInstance("MD5")
            val buffer = ByteArray(64 * 1024)
            try {
                open().use { input ->
                    var total = 0
                    while (total < sizeBytes) {
                        checkActive()
                        val count = input.read(buffer, 0, minOf(buffer.size, sizeBytes - total))
                        if (count <= 0) throw ImportSourceFailure()
                        sha.update(buffer, 0, count); md5.update(buffer, 0, count); total += count
                    }
                    checkActive()
                    if (input.read() != -1) throw ImportSourceFailure()
                }
                val digest = sha.digest()
                val hex = digest.joinToString("") { "%02x".format(it) }
                if (!hex.equals(expectedSha256, true)) throw ImportSourceFailure()
                return ImportWholeVideoFile(sizeBytes, ImportPartChecksums(hex, Base64.getEncoder().encodeToString(md5.digest()),
                    Base64.getEncoder().encodeToString(digest)), open)
            } finally { buffer.fill(0) }
        }
    }
}
