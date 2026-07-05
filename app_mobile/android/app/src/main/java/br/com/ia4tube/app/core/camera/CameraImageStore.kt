package br.com.ia4tube.app.core.camera

import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

class CameraImageStore(private val context: Context) {
    fun createImageUri(): Uri {
        val directory = File(context.cacheDir, "camera")
        if (!directory.exists()) directory.mkdirs()

        val file = File(directory, "ia4tube_camera_${System.currentTimeMillis()}.jpg")

        return FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file
        )
    }
}
