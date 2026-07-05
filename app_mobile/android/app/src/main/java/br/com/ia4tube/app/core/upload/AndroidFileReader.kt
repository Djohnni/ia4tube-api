package br.com.ia4tube.app.core.upload

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import br.com.ia4tube.app.R
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.UploadFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class AndroidFileReader(
    private val context: Context,
    private val imageUploadOptimizer: ImageUploadOptimizer = ImageUploadOptimizer(context)
) {
    suspend fun readUploadFile(uri: Uri): ApiResult<UploadFile> = withContext(Dispatchers.IO) {
        try {
            val resolver = context.contentResolver
            val fileName = readDisplayName(uri).ifBlank { "logo.png" }
            val contentType = resolver.getType(uri).orEmpty().ifBlank { guessContentType(fileName) }
            val bytes = resolver.openInputStream(uri)?.use { input ->
                input.readBytes()
            } ?: return@withContext ApiResult.Failure(context.getString(R.string.upload_read_image_error))

            imageUploadOptimizer.optimizeLogo(fileName, contentType, bytes)
        } catch (error: Exception) {
            ApiResult.Failure(error.message ?: context.getString(R.string.upload_load_image_error))
        }
    }

    private fun readDisplayName(uri: Uri): String {
        val resolver = context.contentResolver
        return resolver.query(uri, null, null, null, null)?.use { cursor ->
            val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (index >= 0 && cursor.moveToFirst()) cursor.getString(index).orEmpty() else ""
        }.orEmpty()
    }

    private fun guessContentType(fileName: String): String {
        return when (fileName.substringAfterLast('.', "").lowercase()) {
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            else -> "application/octet-stream"
        }
    }
}
