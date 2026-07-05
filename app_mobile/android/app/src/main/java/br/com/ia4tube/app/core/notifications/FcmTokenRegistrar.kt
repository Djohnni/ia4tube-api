package br.com.ia4tube.app.core.notifications

import android.content.Context
import android.util.Log
import br.com.ia4tube.app.core.session.SessionStore
import br.com.ia4tube.app.data.api.IA4TubeApiClient
import br.com.ia4tube.app.data.models.ApiResult
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class FcmTokenRegistrar(
    context: Context,
    private val apiClient: IA4TubeApiClient,
    private val sessionStore: SessionStore
) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun syncCurrentToken() {
        if (!isFirebaseConfigured()) return

        runCatching {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { token -> syncToken(token) }
                .addOnFailureListener { error ->
                    Log.w(TAG, "Nao foi possivel obter token FCM.", error)
                }
        }.onFailure { error ->
            Log.w(TAG, "Firebase Messaging ainda nao esta configurado.", error)
        }
    }

    fun syncToken(token: String) {
        val cleanToken = token.trim()
        if (cleanToken.isBlank()) return

        saveLastToken(cleanToken)

        val authToken = sessionStore.getToken()
        if (authToken.isBlank()) {
            Log.d(TAG, "Token FCM salvo localmente; usuario ainda nao esta logado.")
            return
        }

        scope.launch {
            when (val result = apiClient.saveFcmToken(authToken, cleanToken)) {
                is ApiResult.Success -> Log.d(TAG, "Token FCM enviado ao backend.")
                is ApiResult.Failure -> Log.w(TAG, "Falha ao enviar token FCM: ${result.message}")
            }
        }
    }

    private fun saveLastToken(token: String) {
        preferences.edit()
            .putString(KEY_LAST_FCM_TOKEN, token)
            .apply()
    }

    private fun isFirebaseConfigured(): Boolean {
        return runCatching { FirebaseApp.getApps(appContext).isNotEmpty() }.getOrDefault(false)
    }

    private companion object {
        const val TAG = "FcmTokenRegistrar"
        const val PREFERENCES_NAME = "ia4tube_fcm"
        const val KEY_LAST_FCM_TOKEN = "last_fcm_token"
    }
}
