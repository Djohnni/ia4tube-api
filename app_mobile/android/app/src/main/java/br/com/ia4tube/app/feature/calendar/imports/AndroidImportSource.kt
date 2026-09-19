package br.com.ia4tube.app.feature.calendar.imports

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.security.MessageDigest
import java.util.UUID

class ImportSourceFailure : Exception("Não foi possível ler este arquivo. Selecione novamente uma foto JPEG, PNG ou WebP, ou um vídeo MP4/MOV compatível.")

/** Access only to the one URI returned by Android's Photo Picker; never enumerates the gallery. */
class AndroidImportSource(context: Context) {
    private val application = context.applicationContext
    private val resolver = application.contentResolver

    fun retainReadPermission(uri: Uri): Boolean = try {
        requireUri(uri)
        resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        resolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }
    } catch (_: Exception) { false }

    suspend fun inspect(uri: Uri): ImportSelection = withContext(Dispatchers.IO) {
        try {
            requireUri(uri)
            val mime = resolver.getType(uri)?.lowercase() ?: throw ImportSourceFailure()
            val kind = when (mime) {
                "image/jpeg", "image/png", "image/webp" -> ImportMediaKind.IMAGE
                "video/mp4", "video/quicktime" -> ImportMediaKind.VIDEO
                else -> throw ImportSourceFailure()
            }
            val dimensions: Triple<Int, Int, Long?> = if (kind == ImportMediaKind.IMAGE) {
                val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options); Unit } ?: throw ImportSourceFailure()
                Triple(options.outWidth, options.outHeight, null)
            } else {
                val retriever = MediaMetadataRetriever()
                try {
                    retriever.setDataSource(application, uri)
                    Triple(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0,
                        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0,
                        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull())
                } finally { retriever.release() }
            }
            val maximum = if (kind == ImportMediaKind.IMAGE) GalleryImportPolicy.IMAGE_MAX_BYTES else GalleryImportPolicy.VIDEO_MAX_BYTES
            var bytes = 0L
            val digest = MessageDigest.getInstance("SHA-256")
            resolver.openInputStream(uri)?.use { input ->
                val buffer = ByteArray(256 * 1024)
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val count = input.read(buffer); if (count < 0) break
                    bytes += count; if (bytes > maximum) throw ImportSourceFailure()
                    digest.update(buffer, 0, count)
                }
            } ?: throw ImportSourceFailure()
            val selected = ImportSelection(UUID.randomUUID().toString(), kind, mime, bytes,
                dimensions.first, dimensions.second, dimensions.third, digest.digest().joinToString("") { "%02x".format(it) })
            if (GalleryImportPolicy.validateSelection(selected) != null) throw ImportSourceFailure()
            selected
        } catch (error: kotlinx.coroutines.CancellationException) { throw error }
        catch (_: Exception) { throw ImportSourceFailure() }
    }

    suspend fun part(uri: Uri, selected: ImportSelection, zeroBasedPart: Int): ByteArray = withContext(Dispatchers.IO) {
        try {
            requireUri(uri); require(GalleryImportPolicy.validateSelection(selected) == null)
            val offset = zeroBasedPart.toLong() * GalleryImportPolicy.CHUNK_BYTES
            require(zeroBasedPart >= 0 && offset < selected.byteCount)
            val expected = minOf(GalleryImportPolicy.CHUNK_BYTES.toLong(), selected.byteCount - offset).toInt()
            resolver.openInputStream(uri)?.use { input ->
                var skipped = 0L
                while (skipped < offset) {
                    currentCoroutineContext().ensureActive()
                    val count = input.skip(offset - skipped)
                    if (count > 0) skipped += count
                    else { if (input.read() < 0) throw ImportSourceFailure(); skipped++ }
                }
                val bytes = ByteArray(expected); var read = 0
                while (read < expected) {
                    currentCoroutineContext().ensureActive()
                    val count = input.read(bytes, read, expected - read)
                    if (count <= 0) throw ImportSourceFailure()
                    read += count
                }
                bytes
            } ?: throw ImportSourceFailure()
        } catch (error: kotlinx.coroutines.CancellationException) { throw error }
        catch (_: Exception) { throw ImportSourceFailure() }
    }

    private fun requireUri(uri: Uri) {
        require(uri.scheme == "content" && !uri.authority.isNullOrBlank() && uri.toString().length <= 8192 &&
            uri.toString().none { it == '\r' || it == '\n' || it == '\u0000' })
    }
}
