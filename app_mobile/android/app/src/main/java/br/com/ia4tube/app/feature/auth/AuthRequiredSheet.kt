package br.com.ia4tube.app.feature.auth

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.LoginResponse
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AuthRequiredSheet(
    onDismiss: () -> Unit,
    onLogin: suspend (String, String) -> ApiResult<LoginResponse>,
    onRegister: suspend (String, String) -> ApiResult<LoginResponse>,
    onAuthenticated: () -> Unit
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState
    ) {
        AuthRequiredSheetContent(
            onLogin = onLogin,
            onRegister = onRegister,
            onAuthenticated = onAuthenticated
        )
    }
}

@Composable
private fun AuthRequiredSheetContent(
    onLogin: suspend (String, String) -> ApiResult<LoginResponse>,
    onRegister: suspend (String, String) -> ApiResult<LoginResponse>,
    onAuthenticated: () -> Unit
) {
    var mode by rememberSaveable { mutableStateOf(AuthSheetMode.Choice) }
    var whatsapp by rememberSaveable { mutableStateOf("") }
    var senha by rememberSaveable { mutableStateOf("") }
    var confirmarSenha by rememberSaveable { mutableStateOf("") }
    var loading by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp)
            .padding(bottom = 28.dp)
    ) {
        Text(
            text = "Entre ou crie sua conta para continuar",
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold
        )

        Spacer(modifier = Modifier.height(18.dp))

        when (mode) {
            AuthSheetMode.Choice -> {
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = {
                        error = ""
                        mode = AuthSheetMode.Login
                    }
                ) {
                    Text("Entrar")
                }
                Spacer(modifier = Modifier.height(10.dp))
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = {
                        error = ""
                        mode = AuthSheetMode.Register
                    }
                ) {
                    Text("Criar conta")
                }
            }

            AuthSheetMode.Login -> {
                AuthFields(
                    whatsapp = whatsapp,
                    senha = senha,
                    confirmarSenha = confirmarSenha,
                    showConfirmPassword = false,
                    enabled = !loading,
                    onWhatsappChange = {
                        whatsapp = it
                        error = ""
                    },
                    onSenhaChange = {
                        senha = it
                        error = ""
                    },
                    onConfirmarSenhaChange = {}
                )
                ErrorText(error)
                Spacer(modifier = Modifier.height(14.dp))
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !loading,
                    onClick = {
                        if (whatsapp.isBlank() || senha.isBlank()) {
                            error = "Informe WhatsApp e senha."
                            return@Button
                        }
                        loading = true
                        error = ""
                        scope.launch {
                            when (val result = onLogin(whatsapp.trim(), senha)) {
                                is ApiResult.Success -> onAuthenticated()
                                is ApiResult.Failure -> {
                                    loading = false
                                    error = result.message
                                }
                            }
                        }
                    }
                ) {
                    LoadingButtonContent(loading = loading, label = "Entrar")
                }
                BackToChoiceButton(enabled = !loading) {
                    mode = AuthSheetMode.Choice
                    error = ""
                }
            }

            AuthSheetMode.Register -> {
                AuthFields(
                    whatsapp = whatsapp,
                    senha = senha,
                    confirmarSenha = confirmarSenha,
                    showConfirmPassword = true,
                    enabled = !loading,
                    onWhatsappChange = {
                        whatsapp = it
                        error = ""
                    },
                    onSenhaChange = {
                        senha = it
                        error = ""
                    },
                    onConfirmarSenhaChange = {
                        confirmarSenha = it
                        error = ""
                    }
                )
                ErrorText(error)
                Spacer(modifier = Modifier.height(14.dp))
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !loading,
                    onClick = {
                        when {
                            whatsapp.isBlank() || senha.isBlank() || confirmarSenha.isBlank() -> {
                                error = "Informe WhatsApp, senha e confirmação."
                                return@Button
                            }
                            senha.length < 3 -> {
                                error = "A senha deve ter pelo menos 3 caracteres."
                                return@Button
                            }
                            senha != confirmarSenha -> {
                                error = "As senhas não conferem."
                                return@Button
                            }
                        }
                        loading = true
                        error = ""
                        scope.launch {
                            when (val result = onRegister(whatsapp.trim(), senha)) {
                                is ApiResult.Success -> onAuthenticated()
                                is ApiResult.Failure -> {
                                    loading = false
                                    error = result.message
                                }
                            }
                        }
                    }
                ) {
                    LoadingButtonContent(loading = loading, label = "Criar conta")
                }
                BackToChoiceButton(enabled = !loading) {
                    mode = AuthSheetMode.Choice
                    error = ""
                }
            }
        }
    }
}

@Composable
private fun AuthFields(
    whatsapp: String,
    senha: String,
    confirmarSenha: String,
    showConfirmPassword: Boolean,
    enabled: Boolean,
    onWhatsappChange: (String) -> Unit,
    onSenhaChange: (String) -> Unit,
    onConfirmarSenhaChange: (String) -> Unit
) {
    OutlinedTextField(
        modifier = Modifier.fillMaxWidth(),
        value = whatsapp,
        enabled = enabled,
        onValueChange = onWhatsappChange,
        label = { Text("WhatsApp") },
        singleLine = true
    )
    Spacer(modifier = Modifier.height(10.dp))
    OutlinedTextField(
        modifier = Modifier.fillMaxWidth(),
        value = senha,
        enabled = enabled,
        onValueChange = onSenhaChange,
        label = { Text("Senha") },
        visualTransformation = PasswordVisualTransformation(),
        singleLine = true
    )
    if (showConfirmPassword) {
        Spacer(modifier = Modifier.height(10.dp))
        OutlinedTextField(
            modifier = Modifier.fillMaxWidth(),
            value = confirmarSenha,
            enabled = enabled,
            onValueChange = onConfirmarSenhaChange,
            label = { Text("Confirmar senha") },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true
        )
    }
}

@Composable
private fun ErrorText(error: String) {
    if (error.isNotBlank()) {
        Spacer(modifier = Modifier.height(10.dp))
        Text(error, color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun LoadingButtonContent(loading: Boolean, label: String) {
    if (loading) {
        CircularProgressIndicator(
            modifier = Modifier.size(18.dp),
            strokeWidth = 2.dp
        )
    } else {
        Text(label)
    }
}

@Composable
private fun BackToChoiceButton(enabled: Boolean, onClick: () -> Unit) {
    Spacer(modifier = Modifier.height(8.dp))
    TextButton(
        enabled = enabled,
        onClick = onClick
    ) {
        Text("Voltar")
    }
}

private enum class AuthSheetMode {
    Choice,
    Login,
    Register
}
