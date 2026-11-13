package br.com.ia4tube.app.feature.company_profile

import android.content.Intent
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import br.com.ia4tube.app.core.company.CompanyProfile
import br.com.ia4tube.app.core.upload.AndroidFileReader
import br.com.ia4tube.app.feature.home.PremiumHomePalette
import br.com.ia4tube.app.feature.home.PremiumHomeTheme
import br.com.ia4tube.app.feature.home.premiumHomePalette
import br.com.ia4tube.app.ui.components.ScreenScaffold
import coil.compose.AsyncImage

@Composable
internal fun CompanyProfileEditorScreen(
    viewModel: CompanyProfileEditorViewModel,
    onBack: () -> Unit,
    onAuthRequired: () -> Unit
) {
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val fileReader = remember { AndroidFileReader(context.applicationContext) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            // Some providers do not grant persistable access. We copy the bytes into private storage.
            runCatching { context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            viewModel.selectLogo { fileReader.readUploadFile(uri) }
        }
    }
    LaunchedEffect(viewModel) { viewModel.open() }
    DisposableEffect(lifecycle, viewModel) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) viewModel.open()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val goBack: () -> Unit = { if (viewModel.keepDraft()) onBack() }
    BackHandler(onBack = goBack)
    CompanyProfileEditorContent(state, viewModel::edit, viewModel::save,
        onChooseLogo = { picker.launch(arrayOf("image/png", "image/jpeg", "image/webp")) },
        onRemoveLogo = viewModel::removeLogo, onRefresh = { viewModel.open(force = true) },
        onBack = goBack, onAuthRequired = onAuthRequired,
        onCopyLogin = { login ->
            clipboard.setText(AnnotatedString(login))
            Toast.makeText(context, "Login copiado", Toast.LENGTH_SHORT).show()
        })
}

@Composable
internal fun CompanyProfileEditorContent(
    state: CompanyProfileEditorState,
    onEdit: ((CompanyProfile) -> CompanyProfile) -> Unit,
    onSave: () -> Unit,
    onChooseLogo: () -> Unit,
    onRemoveLogo: () -> Unit,
    onRefresh: () -> Unit,
    onBack: () -> Unit,
    onAuthRequired: () -> Unit,
    onCopyLogin: (String) -> Unit = {}
) {
    val enabled = !state.saving && !state.readingLogo
    val palette = remember { premiumHomePalette(PremiumHomeTheme.Black) }
    val textButtonColors = ButtonDefaults.textButtonColors(contentColor = palette.primaryBorder,
        disabledContentColor = palette.textSecondary.copy(alpha = 0.55f))
    val outlineColors = ButtonDefaults.outlinedButtonColors(contentColor = palette.primaryBorder,
        disabledContentColor = palette.textSecondary.copy(alpha = 0.55f))
    ScreenScaffold(containerColor = palette.screenBackground) {
        Box(Modifier.fillMaxSize().drawWithCache {
            val glow = Brush.radialGradient(
                listOf(palette.primaryBorder.copy(alpha = 0.10f), Color.Transparent),
                center = Offset(-size.width * 0.12f, 0f), radius = size.width * 1.25f)
            onDrawBehind { drawRect(glow) }
        }) {
        Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState())
            .testTag("company_profile_editor"), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            TextButton(onClick = onBack, colors = textButtonColors,
                modifier = Modifier.heightIn(min = 48.dp)) { Text("Voltar") }
            Text("Perfil da empresa", color = palette.textPrimary,
                style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            if (!state.authRequired) ProfileEditorSection("Minha conta", "account", palette) {
                val account = state.account
                if (account != null) {
                    Text(if (account.provider == "google") "Google" else "WhatsApp",
                        color = palette.textSecondary, style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.testTag("company_account_provider"))
                    Text("Login", color = palette.textSecondary, style = MaterialTheme.typography.labelMedium)
                    Text(account.login, color = palette.textPrimary, style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.fillMaxWidth().testTag("company_account_login"))
                    OutlinedButton(onClick = { onCopyLogin(account.login) }, colors = outlineColors,
                        border = BorderStroke(1.dp, palette.primaryBorder.copy(alpha = 0.6f)),
                        modifier = Modifier.heightIn(min = 48.dp).testTag("company_account_copy")) {
                        Text("Copiar login")
                    }
                } else Text(if (state.loading) "Carregando sua conta…" else "Não foi possível consultar o login. Toque em Atualizar.",
                    color = palette.textSecondary, style = MaterialTheme.typography.bodyMedium)
            }
            if (state.loading || state.saving || state.readingLogo) {
                CircularProgressIndicator(Modifier.size(26.dp), color = palette.primaryBorder)
                Text(when { state.saving -> "Salvando perfil…"; state.readingLogo -> "Preparando logo…"; else -> "Carregando perfil…" },
                    color = palette.textSecondary)
            }
            state.message?.let { Text(it, modifier = Modifier.testTag("company_profile_message"),
                color = palette.textPrimary, style = MaterialTheme.typography.bodyMedium) }
            if (state.authRequired) {
                OutlinedButton(onClick = onAuthRequired, colors = outlineColors,
                    border = BorderStroke(1.dp, palette.primaryBorder.copy(alpha = 0.6f)),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("company_profile_auth")) {
                    Text("Entrar novamente")
                }
            }
            val profile = state.profile
            ProfileEditorSection("Marca", "brand", palette) {
                ProfileEditorField("Nome da empresa", "name", profile.nomeEmpresa, enabled, palette) { value ->
                    onEdit { it.copy(nomeEmpresa = value) }
                }
                Text("Logo", color = palette.textSecondary, style = MaterialTheme.typography.titleSmall)
                if (profile.logoUri.isNotBlank()) {
                    AsyncImage(model = profile.logoUri, contentDescription = "Logo da empresa",
                        modifier = Modifier.fillMaxWidth().height(140.dp)
                            .background(palette.primaryInnerBackground, RoundedCornerShape(12.dp))
                            .testTag("company_profile_logo"), contentScale = ContentScale.Fit)
                }
                if (state.hasLogo) TextButton(onClick = onRemoveLogo, enabled = enabled,
                    colors = textButtonColors, modifier = Modifier.heightIn(min = 48.dp)) { Text("Remover logo") }
                OutlinedButton(onClick = onChooseLogo, enabled = enabled, colors = outlineColors,
                    border = BorderStroke(1.dp, palette.primaryBorder.copy(alpha = 0.6f)),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("company_profile_choose_logo")) {
                    Text("Escolher logo")
                }
            }
            ProfileEditorSection("Informações", "information", palette) {
                ProfileEditorField("Ramo de atividade", "business", profile.ramo, enabled, palette) { value ->
                    onEdit { it.copy(ramo = value) }
                }
                ProfileEditorField("Informações sobre a empresa", "information", profile.historia, enabled, palette, multiline = true) {
                    value -> onEdit { it.copy(historia = value) }
                }
            }
            ProfileEditorSection("Links e contato", "links", palette) {
                ProfileEditorField("WhatsApp / telefone de contato", "contact", profile.whatsapp, enabled, palette) { value -> onEdit { it.copy(whatsapp = value) } }
                ProfileEditorField("Site", "website", profile.site, enabled, palette) { value -> onEdit { it.copy(site = value) } }
                ProfileEditorField("Instagram", "instagram", profile.instagram, enabled, palette) { value -> onEdit { it.copy(instagram = value) } }
                ProfileEditorField("Facebook", "facebook", profile.facebook, enabled, palette) { value -> onEdit { it.copy(facebook = value) } }
                ProfileEditorField("Outros links", "other_links", profile.outrosLinks, enabled, palette, multiline = true) { value -> onEdit { it.copy(outrosLinks = value) } }
                ProfileEditorField("E-mail", "email", profile.email, enabled, palette) { value -> onEdit { it.copy(email = value) } }
            }
            ProfileEditorSection("Endereço", "address", palette) {
                ProfileEditorField("Endereço", "address", profile.endereco, enabled, palette) { value -> onEdit { it.copy(endereco = value) } }
                ProfileEditorField("Cidade", "city", profile.cidade, enabled, palette) { value -> onEdit { it.copy(cidade = value) } }
                ProfileEditorField("Estado / UF", "state", profile.estado, enabled, palette) { value -> onEdit { it.copy(estado = value) } }
                ProfileEditorField("CEP", "zip", profile.cep, enabled, palette) { value -> onEdit { it.copy(cep = value) } }
            }
            Button(onClick = onSave, enabled = enabled && !state.authRequired,
                colors = ButtonDefaults.buttonColors(containerColor = palette.primaryBorder,
                    contentColor = palette.screenBackground,
                    disabledContainerColor = palette.primaryBorder.copy(alpha = 0.32f),
                    disabledContentColor = palette.textPrimary.copy(alpha = 0.65f)),
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("company_profile_save")) {
                Text("Salvar perfil", fontWeight = FontWeight.Bold)
            }
            TextButton(onClick = onRefresh, enabled = enabled, colors = textButtonColors,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text("Atualizar perfil")
            }
            Spacer(Modifier.height(12.dp))
        }
        }
    }
}

@Composable
private fun ProfileEditorSection(
    title: String, tag: String, palette: PremiumHomePalette, content: @Composable ColumnScope.() -> Unit
) {
    Card(modifier = Modifier.fillMaxWidth().testTag("company_profile_section_" + tag),
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, palette.panelBorder),
        colors = CardDefaults.cardColors(containerColor = palette.cameraBackground)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, color = palette.primaryBorder, style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

@Composable
private fun ProfileEditorField(
    label: String, tag: String, value: String, enabled: Boolean, palette: PremiumHomePalette, multiline: Boolean = false,
    onChange: (String) -> Unit
) {
    OutlinedTextField(value = value, onValueChange = onChange, enabled = enabled,
        label = { Text(label) }, singleLine = !multiline, minLines = if (multiline) 3 else 1,
        shape = RoundedCornerShape(12.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = palette.textPrimary, unfocusedTextColor = palette.textPrimary,
            disabledTextColor = palette.textPrimary.copy(alpha = 0.55f),
            focusedContainerColor = palette.screenBackground, unfocusedContainerColor = palette.screenBackground,
            disabledContainerColor = palette.screenBackground,
            focusedBorderColor = palette.primaryBorder, unfocusedBorderColor = palette.primaryBorder.copy(alpha = 0.32f),
            disabledBorderColor = palette.primaryBorder.copy(alpha = 0.15f),
            focusedLabelColor = palette.primaryBorder, unfocusedLabelColor = palette.textSecondary,
            disabledLabelColor = palette.textSecondary.copy(alpha = 0.55f), cursorColor = palette.primaryBorder),
        modifier = Modifier.fillMaxWidth().testTag("company_profile_" + tag))
}
