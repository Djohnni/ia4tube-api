package br.com.ia4tube.app.core.notifications

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.content.ContextCompat
import br.com.ia4tube.app.MainActivity
import br.com.ia4tube.app.R

internal object IA4TubeNotificationHelper {
    const val CHANNEL_ID = "ia4tube_updates"
    const val ACTION_OPEN_ART_READY = "com.ia4tube.app.action.OPEN_ART_READY"
    const val EXTRA_EVENT_ID = "ia4tube_notification_event_id"
    const val EXTRA_PEDIDO_ID = "ia4tube_notification_pedido_id"
    const val EXTRA_TYPE = "ia4tube_notification_type"
    private const val CHANNEL_NAME = "Atualizações da IA4Tube"

    fun ensureDefaultChannel(context: Context) {
        val manager = context.applicationContext.getSystemService(NotificationManager::class.java)
        ensureChannel(manager)
    }

    fun canPost(context: Context): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
    }

    fun cancelAll(context: Context) {
        context.applicationContext
            .getSystemService(NotificationManager::class.java)
            .cancelAll()
    }

    fun show(
        context: Context,
        payload: ArtReadyNotificationPayload
    ): Boolean {
        if (!canPost(context)) return false

        val appContext = context.applicationContext
        val manager = appContext.getSystemService(NotificationManager::class.java)
        ensureChannel(manager)
        val notificationId = payload.eventId.hashCode() and Int.MAX_VALUE
        val contentIntent = PendingIntent.getActivity(
            appContext,
            notificationId,
            buildOpenIntent(appContext, payload),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = Notification.Builder(appContext, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(ArtReadyNotificationPayload.TITLE)
            .setContentText(ArtReadyNotificationPayload.BODY)
            .setStyle(
                Notification.BigTextStyle()
                    .bigText(ArtReadyNotificationPayload.BODY)
            )
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .build()

        return runCatching {
            manager.notify(notificationId, notification)
            true
        }.getOrDefault(false)
    }

    private fun ensureChannel(manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Avisos de artes prontas da IA4Tube"
            }
        )
    }

    private fun buildOpenIntent(
        context: Context,
        payload: ArtReadyNotificationPayload
    ): Intent {
        return Intent(context, MainActivity::class.java).apply {
            action = ACTION_OPEN_ART_READY
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
            data = Uri.parse(
                "ia4tube://notification/${Uri.encode(payload.eventId)}"
            )
            putExtra(EXTRA_EVENT_ID, payload.eventId)
            putExtra(EXTRA_PEDIDO_ID, payload.pedidoId)
            putExtra(EXTRA_TYPE, ArtReadyNotificationPayload.TYPE)
        }
    }
}
