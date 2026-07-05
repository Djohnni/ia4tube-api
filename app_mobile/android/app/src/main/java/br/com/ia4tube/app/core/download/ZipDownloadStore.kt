package br.com.ia4tube.app.core.download

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import br.com.ia4tube.app.R
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.CarouselImage
import br.com.ia4tube.app.data.models.DownloadedCarousel
import br.com.ia4tube.app.data.models.DownloadedFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

class ZipDownloadStore(private val context: Context) {
    suspend fun saveCarouselImages(carrosselId: String, file: DownloadedFile): ApiResult<DownloadedCarousel> = withContext(Dispatchers.IO) {
        try {
            val images = extractCarouselImagesFromZip(file)
            if (images.isEmpty()) {
                return@withContext ApiResult.Failure(context.getString(R.string.carousel_images_empty_error))
            }

            val savedPaths = images.mapIndexed { index, image ->
                val fileName = carouselImageFileName(carrosselId, index, image)
                when (val saved = saveImage(fileName, image, CAROUSEL_RELATIVE_FOLDER)) {
                    is ApiResult.Failure -> return@withContext saved
                    is ApiResult.Success -> saved.value
                }
            }

            ApiResult.Success(
                DownloadedCarousel(
                    carrosselId = carrosselId,
                    savedPath = "Pictures/$CAROUSEL_RELATIVE_FOLDER",
                    savedPaths = savedPaths,
                    imageCount = savedPaths.size
                )
            )
        } catch (error: Exception) {
            ApiResult.Failure(error.message ?: context.getString(R.string.carousel_download_error))
        }
    }

    suspend fun extractCarouselImages(carrosselId: String, file: DownloadedFile): ApiResult<List<CarouselImage>> = withContext(Dispatchers.IO) {
        try {
            val images = extractCarouselImagesFromZip(file)
            if (images.isEmpty()) {
                ApiResult.Failure(context.getString(R.string.carousel_images_empty_error))
            } else {
                ApiResult.Success(
                    images.mapIndexed { index, image ->
                        image.copy(fileName = carouselImageFileName(carrosselId, index, image))
                    }
                )
            }
        } catch (error: Exception) {
            ApiResult.Failure(error.message ?: context.getString(R.string.carousel_download_error))
        }
    }

    suspend fun saveCarouselZip(carrosselId: String, file: DownloadedFile): ApiResult<String> = withContext(Dispatchers.IO) {
        try {
            val fileName = "ia4tube_carrossel_${sanitize(carrosselId)}_${System.currentTimeMillis()}.zip"
            saveZip(fileName, file, "IA4Tube/Carrosseis")
        } catch (error: Exception) {
            ApiResult.Failure(error.message ?: context.getString(R.string.carousel_download_error))
        }
    }

    private fun extractCarouselImagesFromZip(file: DownloadedFile): List<CarouselImage> {
        val images = mutableListOf<CarouselImage>()

        ZipInputStream(ByteArrayInputStream(file.bytes)).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                val name = entry.name.substringAfterLast("/")

                if (!entry.isDirectory && isImageFile(name) && !name.startsWith(".")) {
                    val output = ByteArrayOutputStream()
                    zip.copyTo(output)
                    images += CarouselImage(
                        fileName = name,
                        bytes = output.toByteArray(),
                        contentType = contentTypeFor(name)
                    )
                }

                zip.closeEntry()
            }
        }

        return images.sortedBy { it.fileName.lowercase() }
    }

    private fun saveZip(fileName: String, file: DownloadedFile, relativeFolder: String): ApiResult<String> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveZipWithMediaStore(fileName, file, relativeFolder)
        } else {
            saveZipInAppDownloads(fileName, file, relativeFolder)
        }
    }

    private fun saveZipWithMediaStore(fileName: String, file: DownloadedFile, relativeFolder: String): ApiResult<String> {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, fileName)
            put(MediaStore.Downloads.MIME_TYPE, ZIP_MIME)
            put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$relativeFolder")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }

        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: return ApiResult.Failure(context.getString(R.string.download_create_file_error))

        resolver.openOutputStream(uri)?.use { output ->
            output.write(file.bytes)
        } ?: return ApiResult.Failure(context.getString(R.string.download_write_image_error))

        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)

        return ApiResult.Success("Downloads/$relativeFolder/$fileName")
    }

    private fun saveZipInAppDownloads(fileName: String, file: DownloadedFile, relativeFolder: String): ApiResult<String> {
        val directory = File(
            context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
            relativeFolder
        )
        if (!directory.exists()) directory.mkdirs()

        val outputFile = File(directory, fileName)
        FileOutputStream(outputFile).use { output ->
            output.write(file.bytes)
        }

        MediaScannerConnection.scanFile(
            context,
            arrayOf(outputFile.absolutePath),
            arrayOf(ZIP_MIME),
            null
        )

        return ApiResult.Success(outputFile.absolutePath)
    }

    private fun saveImage(fileName: String, image: CarouselImage, relativeFolder: String): ApiResult<String> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveImageWithMediaStore(fileName, image, relativeFolder)
        } else {
            saveImageInAppPictures(fileName, image, relativeFolder)
        }
    }

    private fun saveImageWithMediaStore(fileName: String, image: CarouselImage, relativeFolder: String): ApiResult<String> {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
            put(MediaStore.Images.Media.MIME_TYPE, image.contentType)
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

    private fun saveImageInAppPictures(fileName: String, image: CarouselImage, relativeFolder: String): ApiResult<String> {
        val directory = File(
            context.getExternalFilesDir(Environment.DIRECTORY_PICTURES),
            relativeFolder
        )
        if (!directory.exists()) directory.mkdirs()

        val outputFile = File(directory, fileName)
        FileOutputStream(outputFile).use { output ->
            output.write(image.bytes)
        }

        MediaScannerConnection.scanFile(
            context,
            arrayOf(outputFile.absolutePath),
            arrayOf(image.contentType),
            null
        )

        return ApiResult.Success(outputFile.absolutePath)
    }

    private fun carouselImageFileName(carrosselId: String, index: Int, image: CarouselImage): String {
        val extension = extensionFor(image.contentType, image.fileName)
        return "ia4tube_carrossel_${sanitize(carrosselId)}_${(index + 1).toString().padStart(2, '0')}.$extension"
    }

    private fun isImageFile(fileName: String): Boolean {
        val lower = fileName.lowercase()
        return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp")
    }

    private fun contentTypeFor(fileName: String): String {
        val lower = fileName.lowercase()
        return when {
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".webp") -> "image/webp"
            else -> "image/png"
        }
    }

    private fun extensionFor(contentType: String, fileName: String): String {
        return when {
            contentType.contains("jpeg", ignoreCase = true) -> "jpg"
            contentType.contains("jpg", ignoreCase = true) -> "jpg"
            contentType.contains("webp", ignoreCase = true) -> "webp"
            fileName.endsWith(".jpg", ignoreCase = true) || fileName.endsWith(".jpeg", ignoreCase = true) -> "jpg"
            fileName.endsWith(".webp", ignoreCase = true) -> "webp"
            else -> "png"
        }
    }

    private fun sanitize(value: String): String {
        return value.replace(Regex("[^A-Za-z0-9_-]"), "_")
    }

    private companion object {
        const val ZIP_MIME = "application/zip"
        const val CAROUSEL_RELATIVE_FOLDER = "IA4Tube/Carrosseis"
    }
}
