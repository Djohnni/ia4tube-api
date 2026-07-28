package br.com.ia4tube.app.core.notifications

import br.com.ia4tube.app.core.session.SessionStore
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class IA4TubeFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        FcmTokenRegistrar(
            context = applicationContext,
            sessionStore = SessionStore(applicationContext)
        ).syncToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)

        if (message.from.orEmpty().startsWith("/topics/")) return
        val payload = ArtReadyNotificationPayload.parse(
            hasNotificationBlock = message.notification != null,
            data = message.data
        ) ?: return
        val registrar = FcmTokenRegistrar(
            context = applicationContext,
            sessionStore = SessionStore(applicationContext)
        )
        registrar.showArtReadyIfAllowed(payload)
    }
}
