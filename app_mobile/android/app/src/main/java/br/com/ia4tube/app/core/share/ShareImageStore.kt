package br.com.ia4tube.app.core.share

import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import br.com.ia4tube.app.data.models.CarouselImage
import br.com.ia4tube.app.data.models.DownloadedImage
import java.io.File
import java.io.FileOutputStream

class ShareImageStore(private val context: Context) {
    fun saveShareImage(pedidoId: String, image: DownloadedImage): Uri {
        return saveImage("ia4tube_${sanitize(pedidoId)}.${extensionFor(image.contentType)}", image)
    }

    fun saveGraphicMaterialImage(materialId: String, image: DownloadedImage): Uri {
        return saveImage("ia4tube_material_${sanitize(materialId)}.${extensionFor(image.contentType)}", image)
    }

    fun saveCarouselImages(carrosselId: String, images: List<CarouselImage>): List<Uri> {
        val directory = File(context.cacheDir, "share/carrosseis/${sanitize(carrosselId)}")
        if (!directory.exists()) directory.mkdirs()

        return images.mapIndexed { index, image ->
            val fileName = "ia4tube_carrossel_${sanitize(carrosselId)}_${(index + 1).toString().padStart(2, '0')}.${extensionFor(image.contentType)}"
            val file = File(directory, fileName)
            FileOutputStream(file).use { output ->
                output.write(image.bytes)
            }
            FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file
            )
        }
    }

    private fun saveImage(fileName: String, image: DownloadedImage): Uri {
        val directory = File(context.cacheDir, "share")
        if (!directory.exists()) directory.mkdirs()

        val file = File(directory, fileName)
        FileOutputStream(file).use { output ->
            output.write(image.bytes)
        }

        return FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file
        )
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
