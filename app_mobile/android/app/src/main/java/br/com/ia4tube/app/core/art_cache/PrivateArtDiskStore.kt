package br.com.ia4tube.app.core.art_cache

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.charset.CodingErrorAction
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.attribute.FileTime
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

data class SavedPrivateArt(
    val bytes: ByteArray,
    val contentType: String,
    val etag: String?,
    val lastModified: String?
)

/** Implementations must authenticate the cache key (for example, as AES-GCM AAD). */
interface ArtCacheCipher {
    fun encrypt(key: String, plain: ByteArray): ByteArray
    fun decrypt(key: String, sealed: ByteArray): ByteArray
}

/** Best-effort, app-private image storage. No token, URL or plaintext metadata is written to disk. */
class PrivateArtDiskStore(
    root: File,
    private val cipher: ArtCacheCipher,
    private val maxBytes: Long = 96L * 1024 * 1024,
    private val maxEntries: Int = 256,
    private val maxImageBytes: Int = 20 * 1024 * 1024
) {
    private val directory = root.toPath().toAbsolutePath().normalize()
    private val lock = locks.computeIfAbsent(directory.toString()) { Any() }
    private val maxPlainBytes = maxImageBytes.toLong() + METADATA_BYTES * 3L + 64
    private val maxSealedBytes = maxPlainBytes + MAX_CIPHER_OVERHEAD

    fun get(key: String): SavedPrivateArt? = synchronized(lock) {
        if (!validKey(key) || !validLimits() || !safeDirectory(create = false)) return@synchronized null
        val path = entry(key)
        try {
            if (!Files.exists(path, NOFOLLOW_LINKS)) return@synchronized null
            if (!Files.isRegularFile(path, NOFOLLOW_LINKS)) {
                removeOwned(path)
                return@synchronized null
            }
            val sealed = readBounded(path, maxSealedBytes)
            val plain = cipher.decrypt(key, sealed)
            try {
                require(plain.size.toLong() <= maxPlainBytes)
                val art = deserialize(plain)
                touch(path)
                art
            } finally {
                plain.fill(0)
            }
        } catch (_: Exception) {
            removeOwned(path)
            null
        }
    }

    fun put(key: String, art: SavedPrivateArt) = synchronized(lock) {
        if (!validKey(key) || !validLimits() || !validArt(art)) return@synchronized
        if (!safeDirectory(create = true)) return@synchronized
        var temporary: Path? = null
        try {
            val plain = serialize(art)
            val sealed = try { cipher.encrypt(key, plain) } finally { plain.fill(0) }
            if (sealed.isEmpty() || sealed.size.toLong() > maxSealedBytes || sealed.size.toLong() > maxBytes) {
                return@synchronized
            }
            val candidate = directory.resolve("$key.${UUID.randomUUID().toString().replace("-", "")}.tmp")
            temporary = candidate
            FileChannel.open(candidate, CREATE_NEW, WRITE, NOFOLLOW_LINKS).use { channel ->
                val buffer = ByteBuffer.wrap(sealed)
                while (buffer.hasRemaining()) channel.write(buffer)
                channel.force(true)
            }
            // Closed, complete ciphertext is the only data ever moved over a previous entry.
            try {
                Files.move(candidate, entry(key), ATOMIC_MOVE, REPLACE_EXISTING)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(candidate, entry(key), REPLACE_EXISTING)
            }
            temporary = null
            touch(entry(key))
            trim()
        } catch (_: Exception) {
            // Image delivery must still succeed when storage is full, locked, or unavailable.
        } finally {
            temporary?.let(::removeOwned)
        }
    }

    fun remove(key: String) = synchronized(lock) {
        if (validKey(key) && safeDirectory(create = false)) removeOwned(entry(key))
    }

    fun clear() = synchronized(lock) {
        if (safeDirectory(create = false)) ownedFiles().forEach(::removeOwned)
    }

    private fun validLimits() = maxBytes > 0 && maxEntries > 0 && maxImageBytes > 0 &&
        maxSealedBytes <= Int.MAX_VALUE

    private fun validKey(key: String) = KEY.matches(key)
    private fun entry(key: String) = directory.resolve("$key.art")

    private fun validMetadata(value: String?) = value == null ||
        (value.length <= MAX_METADATA_CHARS && value.none { it.code < 32 || it.code == 127 } &&
            value.toByteArray(Charsets.UTF_8).size <= METADATA_BYTES)

    private fun validArt(art: SavedPrivateArt) = art.bytes.isNotEmpty() && art.bytes.size <= maxImageBytes &&
        art.contentType.isNotBlank() && validMetadata(art.contentType) && validMetadata(art.etag) &&
        validMetadata(art.lastModified)

    private fun serialize(art: SavedPrivateArt): ByteArray {
        val output = ByteArrayOutputStream()
        DataOutputStream(output).use { stream ->
            stream.writeInt(MAGIC)
            stream.writeInt(VERSION)
            writeText(stream, art.contentType)
            writeText(stream, art.etag)
            writeText(stream, art.lastModified)
            stream.writeInt(art.bytes.size)
            stream.write(art.bytes)
        }
        return output.toByteArray()
    }

    private fun deserialize(plain: ByteArray): SavedPrivateArt =
        DataInputStream(ByteArrayInputStream(plain)).use { stream ->
            require(stream.readInt() == MAGIC && stream.readInt() == VERSION)
            val contentType = requireNotNull(readText(stream))
            val etag = readText(stream)
            val lastModified = readText(stream)
            val length = stream.readInt()
            require(length in 1..maxImageBytes && length == stream.available())
            val bytes = ByteArray(length)
            stream.readFully(bytes)
            SavedPrivateArt(bytes, contentType, etag, lastModified).also { require(validArt(it)) }
        }

    private fun writeText(stream: DataOutputStream, value: String?) {
        if (value == null) {
            stream.writeInt(-1)
        } else {
            val encoded = value.toByteArray(Charsets.UTF_8)
            stream.writeInt(encoded.size)
            stream.write(encoded)
        }
    }

    private fun readText(stream: DataInputStream): String? {
        val length = stream.readInt()
        if (length == -1) return null
        require(length in 0..METADATA_BYTES && length <= stream.available())
        val encoded = ByteArray(length)
        stream.readFully(encoded)
        val decoded = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(encoded)).toString()
        require(validMetadata(decoded))
        return decoded
    }

    private fun readBounded(path: Path, limit: Long): ByteArray {
        val length = Files.size(path)
        require(length in 1..limit)
        // Do not use readAllBytes: a file changed concurrently must not escape the size limit.
        Files.newInputStream(path, NOFOLLOW_LINKS).use { input ->
            val output = ByteArrayOutputStream(length.toInt())
            val buffer = ByteArray(8192)
            var total = 0L
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                require(total <= limit)
                output.write(buffer, 0, count)
            }
            require(total == length)
            return output.toByteArray()
        }
    }

    private fun safeDirectory(create: Boolean): Boolean = try {
        // No directory or ancestor symlink is followed, including for clear/eviction.
        var ancestor: Path? = directory
        var safe = true
        while (ancestor != null) {
            if (Files.isSymbolicLink(ancestor)) { safe = false; break }
            ancestor = ancestor.parent
        }
        if (safe && create) Files.createDirectories(directory)
        safe && Files.isDirectory(directory, NOFOLLOW_LINKS) && !Files.isSymbolicLink(directory)
    } catch (_: Exception) {
        false
    }

    private fun ownedFiles(): List<Path> = try {
        Files.newDirectoryStream(directory).use { paths ->
            paths.filter { isOwnedName(it.fileName.toString()) }.toList()
        }
    } catch (_: Exception) {
        emptyList()
    }

    private fun isOwnedName(name: String) = ENTRY.matches(name) || TEMPORARY.matches(name)

    private fun removeOwned(path: Path) {
        if (path.parent != directory || !isOwnedName(path.fileName.toString())) return
        try {
            if (safeDirectory(create = false) && !Files.isDirectory(path, NOFOLLOW_LINKS)) {
                Files.deleteIfExists(path)
            }
        } catch (_: Exception) {
            // Never delete a parent directory or recurse through an unexpected child.
        }
    }

    private fun touch(path: Path) {
        try {
            val newest = ownedFiles().filter { ENTRY.matches(it.fileName.toString()) }
                .maxOfOrNull { Files.getLastModifiedTime(it, NOFOLLOW_LINKS).toMillis() } ?: 0L
            val next = if (newest < Long.MAX_VALUE) newest + 1 else newest
            Files.setLastModifiedTime(path, FileTime.fromMillis(maxOf(System.currentTimeMillis(), next)))
        } catch (_: Exception) { /* LRU bookkeeping is not required to display the image. */ }
    }

    private fun trim() {
        val files = ownedFiles()
        // Interrupted writes contain ciphertext only and are not valid cache records.
        files.filter { TEMPORARY.matches(it.fileName.toString()) }.forEach(::removeOwned)
        val entries = files.filter { ENTRY.matches(it.fileName.toString()) }
            .filter { path ->
                if (Files.isRegularFile(path, NOFOLLOW_LINKS)) true else { removeOwned(path); false }
            }
            .sortedWith(compareBy<Path> { Files.getLastModifiedTime(it, NOFOLLOW_LINKS).toMillis() }
                .thenBy { it.fileName.toString() })
        var bytes = entries.sumOf { Files.size(it) }
        var count = entries.size
        for (path in entries) {
            if (bytes <= maxBytes && count <= maxEntries) break
            val size = Files.size(path)
            removeOwned(path)
            if (!Files.exists(path, NOFOLLOW_LINKS)) { bytes -= size; count-- }
        }
    }

    private companion object {
        const val MAGIC = 0x49413441
        const val VERSION = 1
        const val MAX_METADATA_CHARS = 1024
        const val METADATA_BYTES = MAX_METADATA_CHARS * 4
        const val MAX_CIPHER_OVERHEAD = 64L * 1024
        val KEY = Regex("^[a-f0-9]{64}$")
        val ENTRY = Regex("^[a-f0-9]{64}\\.art$")
        val TEMPORARY = Regex("^[a-f0-9]{64}\\.[a-f0-9]{32}\\.tmp$")
        val locks = ConcurrentHashMap<String, Any>()
    }
}
