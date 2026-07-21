package br.com.ia4tube.app.core.upload

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.OpenableColumns
import br.com.ia4tube.app.R
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.UploadFile
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class AndroidFileReader(
    private val context: Context,
    private val imageUploadOptimizer: ImageUploadOptimizer = ImageUploadOptimizer(context)
) {
    suspend fun readUploadFile(uri: Uri): ApiResult<UploadFile> = readUploadFile(
        uri = uri,
        normalizeOrientation = true
    )

    suspend fun readProductDiscoveryUploadFile(uri: Uri): ApiResult<UploadFile> = readUploadFile(
        uri = uri,
        normalizeOrientation = true
    )

    private suspend fun readUploadFile(
        uri: Uri,
        normalizeOrientation: Boolean
    ): ApiResult<UploadFile> = withContext(Dispatchers.IO) {
        try {
            val resolver = context.contentResolver
            val fileName = readDisplayName(uri).ifBlank { "logo.png" }
            val contentType = resolver.getType(uri).orEmpty().ifBlank { guessContentType(fileName) }
            val bytes = resolver.openInputStream(uri)?.use { input ->
                input.readBytes()
            } ?: return@withContext ApiResult.Failure(context.getString(R.string.upload_read_image_error))

            val source = if (normalizeOrientation) {
                normalizeExifOrientation(fileName, contentType, bytes)
            } else {
                OrientedImage(fileName, contentType, bytes)
            }
            imageUploadOptimizer.optimizeLogo(source.fileName, source.contentType, source.bytes)
        } catch (error: Exception) {
            ApiResult.Failure(error.message ?: context.getString(R.string.upload_load_image_error))
        }
    }

    private fun normalizeExifOrientation(
        fileName: String,
        contentType: String,
        bytes: ByteArray
    ): OrientedImage {
        val orientation = runCatching {
            ByteArrayInputStream(bytes).use { input ->
                ExifInterface(input).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_NORMAL
                )
            }
        }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
        if (orientation == ExifInterface.ORIENTATION_NORMAL ||
            orientation == ExifInterface.ORIENTATION_UNDEFINED
        ) {
            return OrientedImage(fileName, contentType, bytes)
        }

        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: return OrientedImage(fileName, contentType, bytes)
        val matrix = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
                    setRotate(180f)
                    postScale(-1f, 1f)
                }
                ExifInterface.ORIENTATION_TRANSPOSE -> {
                    setRotate(90f)
                    postScale(-1f, 1f)
                }
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> {
                    setRotate(-90f)
                    postScale(-1f, 1f)
                }
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
            }
        }
        val oriented = runCatching {
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        }.getOrNull() ?: return OrientedImage(fileName, contentType, bytes).also { bitmap.recycle() }
        return try {
            val output = ByteArrayOutputStream()
            if (!oriented.compress(Bitmap.CompressFormat.JPEG, 94, output)) {
                OrientedImage(fileName, contentType, bytes)
            } else {
                OrientedImage(
                    fileName = "${fileName.substringBeforeLast('.', fileName)}_oriented.jpg",
                    contentType = "image/jpeg",
                    bytes = output.toByteArray()
                )
            }
        } finally {
            if (oriented !== bitmap) oriented.recycle()
            bitmap.recycle()
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

    private data class OrientedImage(
        val fileName: String,
        val contentType: String,
        val bytes: ByteArray
    )
}
