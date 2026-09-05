package br.com.ia4tube.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import br.com.ia4tube.app.core.notifications.IA4TubeNotificationHelper
import br.com.ia4tube.app.core.notifications.NotificationNavigationTarget
import br.com.ia4tube.app.core.notifications.autoCancelOnNotificationTap
import br.com.ia4tube.app.core.notifications.toNotificationNavigationTarget
import br.com.ia4tube.app.data.api.IA4TubeApiClient
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.AppVersionInfo
import br.com.ia4tube.app.navigation.IA4TubeNavHost
import br.com.ia4tube.app.ui.theme.IA4TubeTheme

class MainActivity : ComponentActivity() {
    private var notificationTarget by mutableStateOf<NotificationNavigationTarget?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleNotificationIntent(intent)
        setContent {
            IA4TubeTheme {
                AppUpdateGate {
                    IA4TubeNavHost(
                        notificationTarget = notificationTarget,
                        onNotificationTargetHandled = ::consumeNotificationTarget
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleNotificationIntent(intent)
    }

    private fun handleNotificationIntent(intent: Intent?) {
        notificationTarget = autoCancelOnNotificationTap(
            target = intent.toNotificationNavigationTarget(),
            cancelByEventId = { eventId ->
                IA4TubeNotificationHelper.cancel(this, eventId)
            }
        )
    }

    private fun consumeNotificationTarget() {
        notificationTarget = null
        setIntent(Intent(this, MainActivity::class.java))
    }
}

@Composable
private fun AppUpdateGate(
    apiClient: IA4TubeApiClient = remember { IA4TubeApiClient() },
    content: @Composable () -> Unit
) {
    val context = LocalContext.current
    var updateInfo by remember { mutableStateOf<AppVersionInfo?>(null) }

    LaunchedEffect(Unit) {
        when (val result = apiClient.appVersion()) {
            is ApiResult.Success -> {
                val info = result.value
                val hasUpdate = info.latestVersionCode > BuildConfig.VERSION_CODE ||
                    info.minimumVersionCode > BuildConfig.VERSION_CODE
                if (hasUpdate) {
                    updateInfo = info
                }
            }
            is ApiResult.Failure -> Unit
        }
    }

    content()

    updateInfo?.let { info ->
        val required = info.updateRequired || info.minimumVersionCode > BuildConfig.VERSION_CODE
        AlertDialog(
            onDismissRequest = {
                if (!required) updateInfo = null
            },
            title = {
                Text(info.title.ifBlank { "Nova vers\u00e3o dispon\u00edvel" })
            },
            text = {
                Text(info.message)
            },
            confirmButton = {
                Button(
                    onClick = {
                        openPlayStore(context, info.playStoreUrl)
                    }
                ) {
                    Text("Atualizar na Play Store")
                }
            },
            dismissButton = if (required) {
                null
            } else {
                {
                    TextButton(onClick = { updateInfo = null }) {
                        Text("Agora n\u00e3o")
                    }
                }
            }
        )
    }
}

private fun openPlayStore(context: Context, playStoreUrl: String) {
    val safeUrl = playStoreUrl.ifBlank {
        "https://play.google.com/store/apps/details?id=com.ia4tube.app"
    }
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(safeUrl)).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    try {
        context.startActivity(intent)
    } catch (_: Exception) {
    }
}
