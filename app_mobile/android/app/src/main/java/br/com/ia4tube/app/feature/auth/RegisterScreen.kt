package br.com.ia4tube.app.feature.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.ui.components.ScreenScaffold

@Composable
fun RegisterScreen(
    viewModel: RegisterViewModel,
    onRegisteredIn: () -> Unit,
    onBack: () -> Unit,
    googleAuthRepository: br.com.ia4tube.app.data.repository.AuthRepository? = null
) {
    val state by viewModel.uiState.collectAsState()
    var googleBusy by remember { mutableStateOf(false) }

    LaunchedEffect(state.registeredIn) {
        if (state.registeredIn) onRegisteredIn()
    }

    ScreenScaffold {
        Column(
            modifier = Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.Start
        ) {
            Text("Criar conta", style = MaterialTheme.typography.headlineLarge)
            if (googleAuthRepository != null) {
                Spacer(modifier = Modifier.height(20.dp))
                GoogleSignInAction(googleAuthRepository, state.loading, { googleBusy = it }, onRegisteredIn)
                Spacer(modifier = Modifier.height(16.dp))
                Text("ou use WhatsApp e senha", style = MaterialTheme.typography.bodyMedium)
            }
            else Text("Use WhatsApp e senha para acessar suas artes.", style = MaterialTheme.typography.bodyLarge)
            Spacer(modifier = Modifier.height(24.dp))

            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.whatsapp,
                enabled = !state.loading && !googleBusy,
                onValueChange = viewModel::onWhatsappChange,
                label = { Text("WhatsApp") },
                singleLine = true
            )

            Spacer(modifier = Modifier.height(12.dp))

            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.senha,
                enabled = !state.loading && !googleBusy,
                onValueChange = viewModel::onSenhaChange,
                label = { Text("Senha") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true
            )

            Spacer(modifier = Modifier.height(12.dp))

            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.confirmarSenha,
                enabled = !state.loading && !googleBusy,
                onValueChange = viewModel::onConfirmarSenhaChange,
                label = { Text("Confirmar senha") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true
            )

            if (state.error.isNotBlank()) {
                Spacer(modifier = Modifier.height(12.dp))
                Text(state.error, color = MaterialTheme.colorScheme.error)
            }

            Spacer(modifier = Modifier.height(20.dp))

            Button(
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.loading && !googleBusy,
                onClick = viewModel::submit
            ) {
                if (state.loading) {
                    CircularProgressIndicator()
                } else {
                    Text("Criar conta")
                }
            }

            Spacer(modifier = Modifier.height(8.dp))
            TextButton(onClick = onBack) {
                Text("Voltar")
            }
        }
    }
}
