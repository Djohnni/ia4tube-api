package br.com.ia4tube.app.feature.auth

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextFieldColors
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.R
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
    val authColors = authSheetColors(isSystemInDarkTheme())

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = authColors.container,
        contentColor = authColors.content,
        dragHandle = {
            BottomSheetDefaults.DragHandle(color = authColors.outline)
        }
    ) {
        AuthRequiredSheetContent(
            colors = authColors,
            onLogin = onLogin,
            onRegister = onRegister,
            onAuthenticated = onAuthenticated
        )
    }
}

@Composable
private fun AuthRequiredSheetContent(
    colors: AuthSheetColors,
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
    val focusManager = LocalFocusManager.current
    val scrollState = rememberScrollState()

    fun submitLogin() {
        if (loading) return
        if (whatsapp.isBlank() || senha.isBlank()) {
            error = "Informe WhatsApp e senha."
            return
        }
        focusManager.clearFocus()
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

    fun submitRegister() {
        if (loading) return
        when {
            whatsapp.isBlank() || senha.isBlank() || confirmarSenha.isBlank() -> {
                error = "Informe WhatsApp, senha e confirmação."
                return
            }
            senha.length < 3 -> {
                error = "A senha deve ter pelo menos 3 caracteres."
                return
            }
            senha != confirmarSenha -> {
                error = "As senhas não conferem."
                return
            }
        }
        focusManager.clearFocus()
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

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .imePadding()
            .verticalScroll(scrollState)
            .padding(horizontal = 24.dp)
            .padding(bottom = 28.dp)
    ) {
        Text(
            text = "Entre ou crie sua conta para continuar",
            color = colors.content,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold
        )

        Spacer(modifier = Modifier.height(18.dp))

        when (mode) {
            AuthSheetMode.Choice -> {
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    colors = authButtonColors(colors),
                    onClick = {
                        error = ""
                        mode = AuthSheetMode.Login
                    }
                ) {
                    Text("Entrar", color = colors.onAccent)
                }
                Spacer(modifier = Modifier.height(10.dp))
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = colors.accent,
                        disabledContentColor = colors.disabledContent
                    ),
                    border = BorderStroke(1.5.dp, colors.accent),
                    onClick = {
                        error = ""
                        mode = AuthSheetMode.Register
                    }
                ) {
                    Text("Criar conta", color = colors.accent)
                }
            }

            AuthSheetMode.Login -> {
                AuthFields(
                    colors = colors,
                    whatsapp = whatsapp,
                    senha = senha,
                    confirmarSenha = confirmarSenha,
                    showConfirmPassword = false,
                    enabled = !loading,
                    onSubmit = ::submitLogin,
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
                ErrorText(error = error, color = colors.error)
                Spacer(modifier = Modifier.height(14.dp))
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !loading,
                    colors = authButtonColors(colors),
                    onClick = ::submitLogin
                ) {
                    LoadingButtonContent(
                        loading = loading,
                        label = "Entrar",
                        loadingLabel = "Entrando...",
                        contentColor = if (loading) colors.disabledContent else colors.onAccent
                    )
                }
                BackToChoiceButton(enabled = !loading, colors = colors) {
                    mode = AuthSheetMode.Choice
                    error = ""
                }
            }

            AuthSheetMode.Register -> {
                AuthFields(
                    colors = colors,
                    whatsapp = whatsapp,
                    senha = senha,
                    confirmarSenha = confirmarSenha,
                    showConfirmPassword = true,
                    enabled = !loading,
                    onSubmit = ::submitRegister,
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
                ErrorText(error = error, color = colors.error)
                Spacer(modifier = Modifier.height(14.dp))
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !loading,
                    colors = authButtonColors(colors),
                    onClick = ::submitRegister
                ) {
                    LoadingButtonContent(
                        loading = loading,
                        label = "Criar conta",
                        loadingLabel = "Criando conta...",
                        contentColor = if (loading) colors.disabledContent else colors.onAccent
                    )
                }
                BackToChoiceButton(enabled = !loading, colors = colors) {
                    mode = AuthSheetMode.Choice
                    error = ""
                }
            }
        }
    }
}

@Composable
private fun AuthFields(
    colors: AuthSheetColors,
    whatsapp: String,
    senha: String,
    confirmarSenha: String,
    showConfirmPassword: Boolean,
    enabled: Boolean,
    onSubmit: () -> Unit,
    onWhatsappChange: (String) -> Unit,
    onSenhaChange: (String) -> Unit,
    onConfirmarSenhaChange: (String) -> Unit
) {
    var senhaVisivel by rememberSaveable { mutableStateOf(false) }
    var confirmarSenhaVisivel by rememberSaveable { mutableStateOf(false) }
    val whatsappFocusRequester = remember { FocusRequester() }
    val senhaFocusRequester = remember { FocusRequester() }
    val confirmarSenhaFocusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val fieldColors = authTextFieldColors(colors)

    LaunchedEffect(Unit) {
        whatsappFocusRequester.requestFocus()
    }

    OutlinedTextField(
        modifier = Modifier
            .fillMaxWidth()
            .focusRequester(whatsappFocusRequester),
        value = whatsapp,
        enabled = enabled,
        colors = fieldColors,
        onValueChange = onWhatsappChange,
        label = { Text("WhatsApp") },
        placeholder = { Text("Digite seu WhatsApp") },
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Phone,
            imeAction = ImeAction.Next
        ),
        keyboardActions = KeyboardActions(
            onNext = { senhaFocusRequester.requestFocus() }
        ),
        singleLine = true
    )
    Spacer(modifier = Modifier.height(10.dp))
    OutlinedTextField(
        modifier = Modifier
            .fillMaxWidth()
            .focusRequester(senhaFocusRequester),
        value = senha,
        enabled = enabled,
        colors = fieldColors,
        onValueChange = onSenhaChange,
        label = { Text("Senha") },
        placeholder = { Text("Digite sua senha") },
        visualTransformation = if (senhaVisivel) {
            VisualTransformation.None
        } else {
            PasswordVisualTransformation()
        },
        trailingIcon = {
            PasswordVisibilityButton(
                visible = senhaVisivel,
                enabled = enabled,
                onToggle = { senhaVisivel = !senhaVisivel }
            )
        },
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Password,
            imeAction = if (showConfirmPassword) ImeAction.Next else ImeAction.Done
        ),
        keyboardActions = if (showConfirmPassword) {
            KeyboardActions(
                onNext = { confirmarSenhaFocusRequester.requestFocus() }
            )
        } else {
            KeyboardActions(
                onDone = {
                    focusManager.clearFocus()
                    onSubmit()
                }
            )
        },
        singleLine = true
    )
    if (showConfirmPassword) {
        Spacer(modifier = Modifier.height(10.dp))
        OutlinedTextField(
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(confirmarSenhaFocusRequester),
            value = confirmarSenha,
            enabled = enabled,
            colors = fieldColors,
            onValueChange = onConfirmarSenhaChange,
            label = { Text("Confirmar senha") },
            placeholder = { Text("Digite novamente") },
            visualTransformation = if (confirmarSenhaVisivel) {
                VisualTransformation.None
            } else {
                PasswordVisualTransformation()
            },
            trailingIcon = {
                PasswordVisibilityButton(
                    visible = confirmarSenhaVisivel,
                    enabled = enabled,
                    onToggle = { confirmarSenhaVisivel = !confirmarSenhaVisivel }
                )
            },
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done
            ),
            keyboardActions = KeyboardActions(
                onDone = {
                    focusManager.clearFocus()
                    onSubmit()
                }
            ),
            singleLine = true
        )
    }
}

@Composable
internal fun PasswordVisibilityButton(
    visible: Boolean,
    enabled: Boolean,
    onToggle: () -> Unit
) {
    IconButton(
        enabled = enabled,
        onClick = onToggle
    ) {
        Icon(
            painter = painterResource(
                if (visible) R.drawable.ic_visibility_off else R.drawable.ic_visibility
            ),
            contentDescription = if (visible) "Ocultar senha" else "Mostrar senha"
        )
    }
}

@Composable
private fun authTextFieldColors(colors: AuthSheetColors): TextFieldColors =
    OutlinedTextFieldDefaults.colors(
        focusedTextColor = colors.content,
        unfocusedTextColor = colors.content,
        disabledTextColor = colors.disabledContent,
        errorTextColor = colors.content,
        focusedContainerColor = Color.Transparent,
        unfocusedContainerColor = Color.Transparent,
        disabledContainerColor = colors.disabledContainer,
        errorContainerColor = Color.Transparent,
        cursorColor = colors.accent,
        errorCursorColor = colors.error,
        focusedBorderColor = colors.accent,
        unfocusedBorderColor = colors.outline,
        disabledBorderColor = colors.disabledOutline,
        errorBorderColor = colors.error,
        focusedLeadingIconColor = colors.accent,
        unfocusedLeadingIconColor = colors.secondaryContent,
        disabledLeadingIconColor = colors.disabledContent,
        errorLeadingIconColor = colors.error,
        focusedTrailingIconColor = colors.accent,
        unfocusedTrailingIconColor = colors.secondaryContent,
        disabledTrailingIconColor = colors.disabledContent,
        errorTrailingIconColor = colors.error,
        focusedLabelColor = colors.accent,
        unfocusedLabelColor = colors.secondaryContent,
        disabledLabelColor = colors.disabledContent,
        errorLabelColor = colors.error,
        focusedPlaceholderColor = colors.secondaryContent,
        unfocusedPlaceholderColor = colors.secondaryContent,
        disabledPlaceholderColor = colors.disabledContent,
        errorPlaceholderColor = colors.secondaryContent,
        focusedSupportingTextColor = colors.secondaryContent,
        unfocusedSupportingTextColor = colors.secondaryContent,
        disabledSupportingTextColor = colors.disabledContent,
        errorSupportingTextColor = colors.error
    )

@Composable
private fun authButtonColors(colors: AuthSheetColors) = ButtonDefaults.buttonColors(
    containerColor = colors.accent,
    contentColor = colors.onAccent,
    disabledContainerColor = colors.disabledContainer,
    disabledContentColor = colors.disabledContent
)

@Composable
private fun ErrorText(error: String, color: Color) {
    if (error.isNotBlank()) {
        Spacer(modifier = Modifier.height(10.dp))
        Text(error, color = color)
    }
}

@Composable
private fun LoadingButtonContent(
    loading: Boolean,
    label: String,
    loadingLabel: String,
    contentColor: Color
) {
    if (loading) {
        Row(
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                color = contentColor,
                strokeWidth = 2.dp
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(loadingLabel, color = contentColor)
        }
    } else {
        Text(label, color = contentColor)
    }
}

@Composable
private fun BackToChoiceButton(
    enabled: Boolean,
    colors: AuthSheetColors,
    onClick: () -> Unit
) {
    Spacer(modifier = Modifier.height(8.dp))
    TextButton(
        enabled = enabled,
        colors = ButtonDefaults.textButtonColors(
            contentColor = colors.accent,
            disabledContentColor = colors.disabledContent
        ),
        onClick = onClick
    ) {
        Text("Voltar")
    }
}

private fun authSheetColors(darkTheme: Boolean): AuthSheetColors = if (darkTheme) {
    AuthSheetColors(
        container = Color(0xFF111827),
        content = Color(0xFFF8FAFC),
        secondaryContent = Color(0xFFCBD5E1),
        accent = Color(0xFFF6C453),
        onAccent = Color(0xFF211500),
        outline = Color(0xFF94A3B8),
        disabledContent = Color(0xFFCBD5E1),
        disabledContainer = Color(0xFF1F2937),
        disabledOutline = Color(0xFF64748B),
        error = Color(0xFFFFB4AB)
    )
} else {
    AuthSheetColors(
        container = Color(0xFFFFF9EE),
        content = Color(0xFF111827),
        secondaryContent = Color(0xFF374151),
        accent = Color(0xFF7A4B00),
        onAccent = Color.White,
        outline = Color(0xFF6B7280),
        disabledContent = Color(0xFF6B7280),
        disabledContainer = Color(0xFFF3F4F6),
        disabledOutline = Color(0xFF6B7280),
        error = Color(0xFFB42318)
    )
}

private data class AuthSheetColors(
    val container: Color,
    val content: Color,
    val secondaryContent: Color,
    val accent: Color,
    val onAccent: Color,
    val outline: Color,
    val disabledContent: Color,
    val disabledContainer: Color,
    val disabledOutline: Color,
    val error: Color
)

private enum class AuthSheetMode {
    Choice,
    Login,
    Register
}
