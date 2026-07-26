package br.com.ia4tube.app.core.notifications

import br.com.ia4tube.app.core.config.AppConfig
import br.com.ia4tube.app.core.session.SessionStore
import br.com.ia4tube.app.data.api.IA4TubeApiClient
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class IA4TubeFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        if (!AppConfig.fcmRegistrationEnabled) return
        FcmTokenRegistrar(
            context = applicationContext,
            apiClient = IA4TubeApiClient(),
            sessionStore = SessionStore(applicationContext)
        ).syncToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        if (!AppConfig.notificationsEnabled) return

        val title = message.notification?.title
            ?: message.data["title"]
            ?: "iA4tube"
        val body = message.notification?.body
            ?: message.data["body"]
            ?: "Voce tem uma novidade no app."

        IA4TubeNotificationHelper.show(
            context = applicationContext,
            title = title,
            body = body,
            imageUrl = message.notification?.imageUrl?.toString()
                ?: message.data["image_url"]
                ?: message.data["imageUrl"]
                ?: message.data["image"]
                ?: message.data["picture"],
            data = message.data
        )
    }
}
