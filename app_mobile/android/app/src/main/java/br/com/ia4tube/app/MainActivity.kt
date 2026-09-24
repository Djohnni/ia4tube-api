package br.com.ia4tube.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.lifecycle.Lifecycle
import br.com.ia4tube.app.core.notifications.IA4TubeNotificationHelper
import br.com.ia4tube.app.core.notifications.NotificationNavigationTarget
import br.com.ia4tube.app.core.notifications.autoCancelOnNotificationTap
import br.com.ia4tube.app.core.notifications.toNotificationNavigationTarget
import br.com.ia4tube.app.data.api.IA4TubeApiClient
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.AppVersionInfo
import br.com.ia4tube.app.navigation.IA4TubeNavHost
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability

private enum class PlayUpdateState { NONE, AVAILABLE, DOWNLOADING, DOWNLOADED }

class MainActivity : ComponentActivity() {
    private var notificationTarget by mutableStateOf<NotificationNavigationTarget?>(null)
    private val updateManager by lazy { AppUpdateManagerFactory.create(this) }
    private var playUpdateState by mutableStateOf(PlayUpdateState.NONE)
    private var playAvailableVersionCode by mutableStateOf(0)
    private var dismissedPlayVersionCode = 0
    private var failedInAppFlowVersionCode = 0
    private var updateFlowLaunched = false
    private var updateStartRequested = false
    private var launchedMandatoryUpdate = false
    private val updateLauncher = registerForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        updateFlowLaunched = false
        if (result.resultCode == Activity.RESULT_OK) {
            playUpdateState = PlayUpdateState.DOWNLOADING
        } else if (launchedMandatoryUpdate) {
            playUpdateState = PlayUpdateState.AVAILABLE
        } else {
            dismissedPlayVersionCode = playAvailableVersionCode
            playUpdateState = PlayUpdateState.NONE
        }
    }
    private val installListener = InstallStateUpdatedListener { state ->
        runOnUiThread {
            when (state.installStatus()) {
                InstallStatus.DOWNLOADED -> playUpdateState = PlayUpdateState.DOWNLOADED
                InstallStatus.PENDING, InstallStatus.DOWNLOADING, InstallStatus.INSTALLING ->
                    playUpdateState = PlayUpdateState.DOWNLOADING
                InstallStatus.FAILED, InstallStatus.CANCELED -> checkForPlayUpdate()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleNotificationIntent(intent)
        updateManager.registerListener(installListener)
        setContent {
            IA4TubeTheme {
                AppUpdateGate(
                    playUpdateState = playUpdateState,
                    playAvailableVersionCode = playAvailableVersionCode,
                    failedInAppFlowVersionCode = failedInAppFlowVersionCode,
                    onStartUpdate = ::startPlayUpdate,
                    onCompleteUpdate = { updateManager.completeUpdate() },
                    onDismissUpdate = ::dismissPlayUpdate
                ) {
                    IA4TubeNavHost(
                        notificationTarget = notificationTarget,
                        onNotificationTargetHandled = ::consumeNotificationTarget
                    )
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        checkForPlayUpdate()
    }

    override fun onDestroy() {
        updateStartRequested = false
        updateManager.unregisterListener(installListener)
        super.onDestroy()
    }

    private fun checkForPlayUpdate() {
        updateManager.appUpdateInfo.addOnSuccessListener(this) { info ->
            when {
                info.installStatus() == InstallStatus.DOWNLOADED -> {
                    playAvailableVersionCode = info.availableVersionCode()
                    playUpdateState = PlayUpdateState.DOWNLOADED
                }
                info.installStatus() == InstallStatus.PENDING ||
                    info.installStatus() == InstallStatus.DOWNLOADING ||
                    info.installStatus() == InstallStatus.INSTALLING -> {
                    playAvailableVersionCode = info.availableVersionCode()
                    playUpdateState = PlayUpdateState.DOWNLOADING
                }
                updateFlowLaunched -> Unit
                else -> {
                    val updateAvailable =
                        info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE
                    val flexibleAllowed = info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE)
                    val offeredVersionCode = info.availableVersionCode()
                    val eligible = updateAvailable && flexibleAllowed &&
                        offeredVersionCode > BuildConfig.VERSION_CODE
                    playAvailableVersionCode = if (eligible) offeredVersionCode else 0
                    playUpdateState = if (shouldOfferPlayUpdate(
                            updateAvailable = updateAvailable,
                            flexibleAllowed = flexibleAllowed,
                            playVersionCode = offeredVersionCode,
                            installedVersionCode = BuildConfig.VERSION_CODE,
                            dismissedVersionCode = dismissedPlayVersionCode
                        )
                    ) PlayUpdateState.AVAILABLE else PlayUpdateState.NONE
                }
            }
        }
    }

    private fun startPlayUpdate(required: Boolean) {
        if (updateStartRequested || updateFlowLaunched) return
        updateStartRequested = true
        // Each AppUpdateInfo can start only one flow, so fetch a fresh one after the tap.
        updateManager.appUpdateInfo
            .addOnSuccessListener { info ->
                updateStartRequested = false
                if (isDestroyed || !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                    return@addOnSuccessListener
                }
                if (info.updateAvailability() != UpdateAvailability.UPDATE_AVAILABLE ||
                    !info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE)
                ) {
                    playAvailableVersionCode = 0
                    playUpdateState = PlayUpdateState.NONE
                    checkForPlayUpdate()
                    return@addOnSuccessListener
                }
                playAvailableVersionCode = info.availableVersionCode()
                launchedMandatoryUpdate = required
                updateFlowLaunched = true
                playUpdateState = PlayUpdateState.DOWNLOADING
                try {
                    if (!updateManager.startUpdateFlowForResult(
                            info,
                            updateLauncher,
                            AppUpdateOptions.defaultOptions(AppUpdateType.FLEXIBLE)
                        )
                    ) {
                        recoverFromFailedInAppFlow()
                    }
                } catch (_: Exception) {
                    recoverFromFailedInAppFlow()
                }
            }
            .addOnFailureListener {
                updateStartRequested = false
                if (!isDestroyed && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                    recoverFromFailedInAppFlow()
                }
            }
    }

    private fun recoverFromFailedInAppFlow() {
        updateFlowLaunched = false
        failedInAppFlowVersionCode = playAvailableVersionCode
        dismissedPlayVersionCode = playAvailableVersionCode
        playUpdateState = PlayUpdateState.NONE
        val packageId = "com.ia4tube.app"
        val storeUris = listOf(
            "market://details?id=$packageId",
            "https://play.google.com/store/apps/details?id=$packageId"
        )
        for (url in storeUris) {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                return
            } catch (_: Exception) {
                // Try the browser link if the Play Store app is unavailable.
            }
        }
    }

    private fun dismissPlayUpdate() {
        if (playUpdateState == PlayUpdateState.AVAILABLE) {
            dismissedPlayVersionCode = playAvailableVersionCode
        }
        playUpdateState = PlayUpdateState.NONE
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
    playUpdateState: PlayUpdateState,
    playAvailableVersionCode: Int,
    failedInAppFlowVersionCode: Int,
    onStartUpdate: (Boolean) -> Unit,
    onCompleteUpdate: () -> Unit,
    onDismissUpdate: () -> Unit,
    apiClient: IA4TubeApiClient = remember { IA4TubeApiClient() },
    content: @Composable () -> Unit
) {
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

    val required = updateInfo?.let {
        backendRequiresPlayUpdate(
            it,
            BuildConfig.VERSION_CODE,
            playAvailableVersionCode,
            failedInAppFlowVersionCode
        )
    } == true
    if (playUpdateState == PlayUpdateState.AVAILABLE ||
        playUpdateState == PlayUpdateState.DOWNLOADED ||
        (required && playUpdateState == PlayUpdateState.NONE)
    ) {
        val downloaded = playUpdateState == PlayUpdateState.DOWNLOADED
        AlertDialog(
            onDismissRequest = {
                if (!required) onDismissUpdate()
            },
            title = {
                Text(if (downloaded) "Atualização pronta" else if (required) {
                    updateInfo?.title.orEmpty().ifBlank { "Nova versão disponível" }
                } else "Nova versão disponível")
            },
            text = {
                Text(if (downloaded) {
                    "A atualização foi baixada. Reinicie o app para instalar."
                } else if (required) {
                    updateInfo?.message.orEmpty().ifBlank { "Atualize o app para continuar." }
                } else {
                    "Uma nova versão está disponível para sua conta na Play Store."
                })
            },
            confirmButton = {
                Button(
                    onClick = {
                        if (downloaded) onCompleteUpdate() else onStartUpdate(required)
                    }
                ) {
                    Text(if (downloaded) "Reiniciar e instalar" else "Atualizar")
                }
            },
            dismissButton = if (required) {
                null
            } else {
                {
                    TextButton(onClick = onDismissUpdate) {
                        Text("Agora não")
                    }
                }
            }
        )
    }
}
