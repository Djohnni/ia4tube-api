package br.com.ia4tube.app.feature.company_profile

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import br.com.ia4tube.app.core.company.CompanyProfile
import br.com.ia4tube.app.core.upload.AndroidFileReader
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
        onBack = goBack, onAuthRequired = onAuthRequired)
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
    onAuthRequired: () -> Unit
) {
    val enabled = !state.saving && !state.readingLogo
    ScreenScaffold {
        Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState())
            .testTag("company_profile_editor"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { Text("Voltar") }
            Text("Perfil da empresa", style = MaterialTheme.typography.headlineSmall)
            Text("Tudo é opcional. Salve as informações que deseja usar nas suas artes.",
                style = MaterialTheme.typography.bodyMedium)
            if (state.loading || state.saving || state.readingLogo) {
                CircularProgressIndicator(Modifier.size(26.dp))
                Text(when { state.saving -> "Salvando perfil…"; state.readingLogo -> "Preparando logo…"; else -> "Carregando perfil…" })
            }
            state.message?.let { Text(it, modifier = Modifier.testTag("company_profile_message"),
                color = MaterialTheme.colorScheme.onSurface) }
            if (state.authRequired) {
                OutlinedButton(onClick = onAuthRequired, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text("Entrar novamente")
                }
            }
            val profile = state.profile
            ProfileOptionalField("Nome da empresa", "name", profile.nomeEmpresa, enabled) { value -> onEdit { it.copy(nomeEmpresa = value) } }
            ProfileOptionalField("Ramo de atividade", "business", profile.ramo, enabled) { value -> onEdit { it.copy(ramo = value) } }
            ProfileOptionalField("Informações sobre a empresa", "information", profile.historia, enabled, multiline = true) {
                value -> onEdit { it.copy(historia = value) }
            }
            ProfileOptionalField("WhatsApp / telefone de contato", "contact", profile.whatsapp, enabled) { value -> onEdit { it.copy(whatsapp = value) } }
            ProfileOptionalField("Site", "website", profile.site, enabled) { value -> onEdit { it.copy(site = value) } }
            ProfileOptionalField("Instagram", "instagram", profile.instagram, enabled) { value -> onEdit { it.copy(instagram = value) } }
            ProfileOptionalField("Facebook", "facebook", profile.facebook, enabled) { value -> onEdit { it.copy(facebook = value) } }
            ProfileOptionalField("Outros links", "other_links", profile.outrosLinks, enabled, multiline = true) { value -> onEdit { it.copy(outrosLinks = value) } }
            ProfileOptionalField("Endereço", "address", profile.endereco, enabled) { value -> onEdit { it.copy(endereco = value) } }
            ProfileOptionalField("Cidade", "city", profile.cidade, enabled) { value -> onEdit { it.copy(cidade = value) } }
            ProfileOptionalField("Estado / UF", "state", profile.estado, enabled) { value -> onEdit { it.copy(estado = value) } }
            ProfileOptionalField("CEP", "zip", profile.cep, enabled) { value -> onEdit { it.copy(cep = value) } }
            ProfileOptionalField("E-mail", "email", profile.email, enabled) { value -> onEdit { it.copy(email = value) } }
            Text("Logo (opcional)", style = MaterialTheme.typography.titleMedium)
            if (profile.logoUri.isNotBlank()) {
                AsyncImage(model = profile.logoUri, contentDescription = "Logo da empresa",
                    modifier = Modifier.fillMaxWidth().height(140.dp).testTag("company_profile_logo"),
                    contentScale = ContentScale.Fit)
            }
            if (state.hasLogo) TextButton(onClick = onRemoveLogo, enabled = enabled,
                modifier = Modifier.heightIn(min = 48.dp)) { Text("Remover logo") }
            OutlinedButton(onClick = onChooseLogo, enabled = enabled,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("company_profile_choose_logo")) {
                Text("Escolher logo")
            }
            Button(onClick = onSave, enabled = enabled && !state.authRequired,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("company_profile_save")) {
                Text("Salvar perfil")
            }
            TextButton(onClick = onRefresh, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text("Atualizar perfil")
            }
            Spacer(Modifier.height(12.dp))
        }
    }
}

@Composable
private fun ProfileOptionalField(
    label: String, tag: String, value: String, enabled: Boolean, multiline: Boolean = false,
    onChange: (String) -> Unit
) {
    OutlinedTextField(value = value, onValueChange = onChange, enabled = enabled,
        label = { Text(label + " (opcional)") }, singleLine = !multiline, minLines = if (multiline) 3 else 1,
        modifier = Modifier.fillMaxWidth().testTag("company_profile_" + tag))
}
