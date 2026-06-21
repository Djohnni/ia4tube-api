package br.com.ia4tube.app.core.upload

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import br.com.ia4tube.app.R
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.UploadFile
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

class ImageUploadOptimizer(private val context: Context) {
    fun optimizeLogo(fileName: String, contentType: String, bytes: ByteArray): ApiResult<UploadFile> {
        if (bytes.isEmpty()) {
            return ApiResult.Failure(context.getString(R.string.upload_empty_image_error))
        }

        val bounds = readBounds(bytes)
            ?: return ApiResult.Failure(context.getString(R.string.upload_process_image_error))

        if (isAlreadySafe(bytes, bounds)) {
            return ApiResult.Success(
                UploadFile(
                    fileName = fileName,
                    contentType = contentType,
                    bytes = bytes,
                    optimized = false,
                    originalSizeBytes = bytes.size,
                    originalWidth = bounds.width,
                    originalHeight = bounds.height
                )
            )
        }

        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: return ApiResult.Failure(context.getString(R.string.upload_open_image_error))

        val scaled = scaleBitmap(bitmap)
        if (scaled !== bitmap) bitmap.recycle()

        val format = if (scaled.hasAlpha()) Bitmap.CompressFormat.WEBP else Bitmap.CompressFormat.JPEG
        val extension = if (scaled.hasAlpha()) "webp" else "jpg"
        val optimizedBytes = compressToTarget(scaled, format)
        scaled.recycle()

        if (optimizedBytes == null) {
            return ApiResult.Failure(context.getString(R.string.upload_reduce_image_error))
        }

        return ApiResult.Success(
            UploadFile(
                fileName = safeOptimizedName(fileName, extension),
                contentType = if (extension == "webp") "image/webp" else "image/jpeg",
                bytes = optimizedBytes,
                optimized = true,
                originalSizeBytes = bytes.size,
                originalWidth = bounds.width,
                originalHeight = bounds.height
            )
        )
    }

    private fun isAlreadySafe(bytes: ByteArray, bounds: ImageBounds): Boolean {
        return bytes.size <= TARGET_BYTES &&
            bounds.width <= MAX_DIMENSION &&
            bounds.height <= MAX_DIMENSION
    }

    private fun readBounds(bytes: ByteArray): ImageBounds? {
        val options = BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        if (options.outWidth <= 0 || options.outHeight <= 0) return null
        return ImageBounds(options.outWidth, options.outHeight)
    }

    private fun scaleBitmap(bitmap: Bitmap): Bitmap {
        val largestSide = max(bitmap.width, bitmap.height)
        if (largestSide <= MAX_DIMENSION) return bitmap

        val scale = MAX_DIMENSION.toFloat() / largestSide.toFloat()
        val width = (bitmap.width * scale).roundToInt().coerceAtLeast(1)
        val height = (bitmap.height * scale).roundToInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, width, height, true)
    }

    private fun compressToTarget(bitmap: Bitmap, format: Bitmap.CompressFormat): ByteArray? {
        var currentBitmap = bitmap
        val qualities = listOf(85, 80, 75, 70)

        repeat(4) {
            for (quality in qualities) {
                val bytes = compress(currentBitmap, format, quality)
                if (bytes.size <= TARGET_BYTES) {
                    if (currentBitmap !== bitmap) currentBitmap.recycle()
                    return bytes
                }
            }

            val nextWidth = (currentBitmap.width * 0.85f).roundToInt().coerceAtLeast(1)
            val nextHeight = (currentBitmap.height * 0.85f).roundToInt().coerceAtLeast(1)
            val nextBitmap = Bitmap.createScaledBitmap(currentBitmap, nextWidth, nextHeight, true)
            if (currentBitmap !== bitmap) currentBitmap.recycle()
            currentBitmap = nextBitmap
        }

        if (currentBitmap !== bitmap) currentBitmap.recycle()
        return null
    }

    private fun compress(bitmap: Bitmap, format: Bitmap.CompressFormat, quality: Int): ByteArray {
        val output = ByteArrayOutputStream()
        bitmap.compress(format, quality, output)
        return output.toByteArray()
    }

    private fun safeOptimizedName(fileName: String, extension: String): String {
        val base = fileName.substringBeforeLast('.', fileName)
            .replace(Regex("[^A-Za-z0-9_-]"), "_")
            .ifBlank { "logo" }
        return "${base}_mobile.$extension"
    }

    private data class ImageBounds(
        val width: Int,
        val height: Int
    )

    companion object {
        const val MAX_DIMENSION = 1600
        const val TARGET_BYTES = 2 * 1024 * 1024
    }
}
