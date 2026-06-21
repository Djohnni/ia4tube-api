package br.com.ia4tube.app.core.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import br.com.ia4tube.app.MainActivity
import br.com.ia4tube.app.R
import java.net.HttpURLConnection
import java.net.URL

object IA4TubeNotificationHelper {
    const val CHANNEL_ID = "ia4tube_updates"
    private const val CHANNEL_NAME = "Atualizacoes da iA4tube"

    fun ensureDefaultChannel(context: Context) {
        val manager = context.applicationContext.getSystemService(NotificationManager::class.java)
        ensureChannel(manager)
    }

    fun show(
        context: Context,
        title: String,
        body: String,
        imageUrl: String? = null,
        data: Map<String, String>
    ) {
        val appContext = context.applicationContext
        val manager = appContext.getSystemService(NotificationManager::class.java)
        ensureChannel(manager)

        val notificationId = (System.currentTimeMillis() % Int.MAX_VALUE).toInt()
        val contentIntent = PendingIntent.getActivity(
            appContext,
            notificationId,
            buildOpenIntent(appContext, data),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val safeTitle = title.ifBlank { "iA4tube" }
        val safeBody = body.ifBlank { "Voce tem uma novidade no app." }
        val imageBitmap = loadNotificationImage(imageUrl)

        val builder = Notification.Builder(appContext, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(safeTitle)
            .setContentText(safeBody)
            .setContentIntent(contentIntent)
            .setAutoCancel(true)

        if (imageBitmap != null) {
            builder
                .setLargeIcon(imageBitmap)
                .setStyle(
                    Notification.BigPictureStyle()
                        .bigPicture(imageBitmap)
                        .bigLargeIcon(null as Bitmap?)
                        .setBigContentTitle(safeTitle)
                        .setSummaryText(safeBody)
                )
        } else {
            builder.setStyle(Notification.BigTextStyle().bigText(safeBody))
        }

        val notification = builder.build()

        manager.notify(notificationId, notification)
    }

    private fun ensureChannel(manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Avisos de pedidos, planejamento e novidades da iA4tube"
        }

        manager.createNotificationChannel(channel)
    }

    private fun buildOpenIntent(context: Context, data: Map<String, String>): Intent {
        return Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
            this.data = Uri.parse("ia4tube://notification/${System.currentTimeMillis()}")
            data.forEach { (key, value) ->
                putExtra(key, value)
            }
        }
    }

    private fun loadNotificationImage(imageUrl: String?): Bitmap? {
        val normalizedUrl = imageUrl
            ?.trim()
            ?.takeIf { it.startsWith("https://") || it.startsWith("http://") }
            ?: return null

        return runCatching {
            val connection = (URL(normalizedUrl).openConnection() as HttpURLConnection).apply {
                connectTimeout = 5000
                readTimeout = 5000
                instanceFollowRedirects = true
            }

            connection.use {
                if (responseCode !in 200..299) return@runCatching null
                inputStream.use { stream ->
                    BitmapFactory.decodeStream(stream)
                }
            }
        }.getOrNull()
    }

    private inline fun <T> HttpURLConnection.use(block: HttpURLConnection.() -> T): T {
        return try {
            block()
        } finally {
            disconnect()
        }
    }
}
