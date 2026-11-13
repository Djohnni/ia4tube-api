package br.com.ia4tube.app.feature.auth

import android.content.Context
import android.content.MutableContextWrapper
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import br.com.ia4tube.app.R
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.repository.AuthRepository
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

internal suspend fun clearGoogleSignInState(context: Context) {
    CredentialManager.create(context.applicationContext).clearCredentialState(ClearCredentialStateRequest())
}

@Composable
internal fun GoogleSignInAction(repository: AuthRepository, otherAuthBusy: Boolean,
    onBusyChange: (Boolean) -> Unit, onAuthenticated: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    GoogleSignInButton(busy, otherAuthBusy, error) {
        if (!busy && !otherAuthBusy) {
            busy = true
            error = null
            onBusyChange(true)
            scope.launch {
                try {
                    val config = repository.googleClientId()
                    if (config !is ApiResult.Success) {
                        error = "Não foi possível abrir o Google. Tente novamente."
                        return@launch
                    }
                    val request = GetCredentialRequest.Builder().addCredentialOption(
                        GetSignInWithGoogleOption.Builder(config.value).build()).build()
                    // The account chooser opens only after this explicit button tap. No automatic sign-in.
                    val credential = CredentialManager.create(context).getCredential(
                        MutableContextWrapper(context), request).credential
                    if (credential !is CustomCredential ||
                        credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                        error = "Não foi possível confirmar sua conta Google."
                        return@launch
                    }
                    val idToken = GoogleIdTokenCredential.createFrom(credential.data).idToken
                    when (repository.loginWithGoogle(idToken)) {
                        is ApiResult.Success -> onAuthenticated()
                        is ApiResult.Failure -> error = "Não foi possível entrar com Google. Tente novamente."
                    }
                } catch (_: GetCredentialCancellationException) {
                    // Cancelling the chooser keeps the existing WhatsApp/password form intact.
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    error = "Não foi possível entrar com Google. Tente novamente."
                } finally {
                    busy = false
                    onBusyChange(false)
                }
            }
        }
    }
}

@Composable
internal fun GoogleSignInButton(busy: Boolean, otherAuthBusy: Boolean, error: String?, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = onClick, enabled = !busy && !otherAuthBusy,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("auth_google"),
            border = BorderStroke(1.dp, Color(0xFF747775)),
            colors = ButtonDefaults.outlinedButtonColors(containerColor = Color.White,
                contentColor = Color(0xFF1F1F1F), disabledContainerColor = Color(0xFFE3E3E3),
                disabledContentColor = Color(0xFF5F6368))) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Color(0xFF1F1F1F))
                else Icon(painterResource(R.drawable.google_g), null, Modifier.size(18.dp), tint = Color.Unspecified)
                Text(if (busy) "Entrando…" else "Continuar com Google")
            }
        }
        if (error != null) Text(error, color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("auth_google_error"))
    }
}
