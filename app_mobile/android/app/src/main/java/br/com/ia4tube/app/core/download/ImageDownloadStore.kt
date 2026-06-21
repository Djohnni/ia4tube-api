package br.com.ia4tube.app.core.download

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import br.com.ia4tube.app.R
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.DownloadedImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream

class ImageDownloadStore(private val context: Context) {
    suspend fun savePedidoImage(pedidoId: String, image: DownloadedImage): ApiResult<String> = withContext(Dispatchers.IO) {
        try {
            val extension = extensionFor(image.contentType)
            val fileName = "ia4tube_${sanitize(pedidoId)}.$extension"

            saveImage(fileName, image, "IA4Tube")
        } catch (error: Exception) {
            ApiResult.Failure(error.message ?: context.getString(R.string.download_save_image_error))
        }
    }

    suspend fun saveGraphicMaterialImage(materialId: String, image: DownloadedImage): ApiResult<String> = withContext(Dispatchers.IO) {
        try {
            val extension = extensionFor(image.contentType)
            val fileName = "ia4tube_material_${sanitize(materialId)}_${System.currentTimeMillis()}.$extension"

            saveImage(fileName, image, "IA4Tube/Materiais Graficos")
        } catch (error: Exception) {
            ApiResult.Failure(error.message ?: context.getString(R.string.download_save_image_error))
        }
    }

    private fun saveImage(fileName: String, image: DownloadedImage, relativeFolder: String): ApiResult<String> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveWithMediaStore(fileName, image, relativeFolder)
        } else {
            saveInAppDownloads(fileName, image, relativeFolder)
        }
    }

    private fun saveWithMediaStore(fileName: String, image: DownloadedImage, relativeFolder: String): ApiResult<String> {
        val resolver = context.contentResolver
        val mimeType = mimeTypeFor(image.contentType)
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
            put(MediaStore.Images.Media.MIME_TYPE, mimeType)
            put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$relativeFolder")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }

        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: return ApiResult.Failure(context.getString(R.string.download_create_file_error))

        resolver.openOutputStream(uri)?.use { output ->
            output.write(image.bytes)
        } ?: return ApiResult.Failure(context.getString(R.string.download_write_image_error))

        values.clear()
        values.put(MediaStore.Images.Media.IS_PENDING, 0)
        resolver.update(uri, values, null, null)

        return ApiResult.Success("Pictures/$relativeFolder/$fileName")
    }

    private fun saveInAppDownloads(fileName: String, image: DownloadedImage, relativeFolder: String): ApiResult<String> {
        val mimeType = mimeTypeFor(image.contentType)
        val directory = File(
            context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
            relativeFolder
        )
        if (!directory.exists()) directory.mkdirs()

        val file = File(directory, fileName)
        FileOutputStream(file).use { output ->
            output.write(image.bytes)
        }

        MediaScannerConnection.scanFile(
            context,
            arrayOf(file.absolutePath),
            arrayOf(mimeType),
            null
        )

        return ApiResult.Success(file.absolutePath)
    }

    private fun mimeTypeFor(contentType: String): String {
        val raw = contentType.substringBefore(";").trim().lowercase()
        return when {
            raw == "image/jpeg" || raw == "image/jpg" -> "image/jpeg"
            raw == "image/webp" -> "image/webp"
            raw == "image/png" -> "image/png"
            contentType.contains("jpeg", ignoreCase = true) -> "image/jpeg"
            contentType.contains("jpg", ignoreCase = true) -> "image/jpeg"
            contentType.contains("webp", ignoreCase = true) -> "image/webp"
            else -> "image/png"
        }
    }

    private fun extensionFor(contentType: String): String {
        return when {
            contentType.contains("jpeg", ignoreCase = true) -> "jpg"
            contentType.contains("jpg", ignoreCase = true) -> "jpg"
            contentType.contains("webp", ignoreCase = true) -> "webp"
            else -> "png"
        }
    }

    private fun sanitize(value: String): String {
        return value.replace(Regex("[^A-Za-z0-9_-]"), "_")
    }
}
