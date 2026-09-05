package br.com.ia4tube.app.feature.instagram

import android.content.ContentResolver
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import br.com.ia4tube.app.ui.components.ScreenScaffold
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun InstagramScreen(viewModel: InstagramViewModel, onBack: () -> Unit) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    var pendingPickerSession by remember { mutableStateOf<String?>(null) }
    var readingImage by remember { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        val pickerSession = pendingPickerSession
        pendingPickerSession = null
        if (uri != null && pickerSession != null) {
            readingImage = true
            scope.launch {
                try {
                    val bytes = withContext(Dispatchers.IO) { readInstagramJpeg(context.contentResolver, uri) }
                    if (bytes == null) viewModel.showSelectionError(
                        "Escolha uma imagem JPEG válida de 1080 × 1080 pixels, com até 8 MB."
                    ) else viewModel.acceptJpeg(bytes, pickerSession)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    viewModel.showSelectionError()
                } finally {
                    readingImage = false
                }
            }
        }
    }

    DisposableEffect(lifecycleOwner, viewModel) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) viewModel.onResume()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(viewModel) { viewModel.onResume() }

    LaunchedEffect(state.authorizationUrlToOpen) {
        val url = viewModel.takeAuthorizationUrl()
        if (url != null && InstagramPolicies.isOfficialAuthorizationUrl(url)) {
            try {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                })
            } catch (_: Exception) {
                viewModel.browserUnavailable()
            }
        }
    }

    ScreenScaffold {
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically) {
                Text("Instagram", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                TextButton(onClick = onBack) { Text("Voltar") }
            }
            Text("Conecte sua conta profissional e publique uma imagem após revisar e confirmar.")
            OutlinedButton(onClick = viewModel::refresh, enabled = !state.busy && !readingImage) {
                Text(if (state.hasUnresolvedIntent) "Consultar resultado e histórico" else "Atualizar")
            }
            if (state.busy || readingImage) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                    Text(if (readingImage) "Conferindo a imagem…" else "Aguarde a confirmação do serviço…")
                }
            }
            if (state.availability == InstagramAvailability.SESSION_REQUIRED) {
                InstagramSection("Entre na IA4Tube") {
                    Text("Sua sessão precisa ser confirmada. Volte à tela inicial e entre novamente na sua conta.")
                }
            } else if (state.availability == InstagramAvailability.UNAVAILABLE) {
                InstagramSection("Recurso indisponível") {
                    Text("Não foi possível disponibilizar o Instagram para esta conta no aplicativo oficial. Você pode consultar novamente mais tarde.")
                }
            }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            state.message?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }

            InstagramSection("1. Conta profissional") {
                Text(connectionLabel(state.connection, state.availability), fontWeight = FontWeight.SemiBold)
                state.connection?.username?.let { Text(instagramUsernameLabel(it), style = MaterialTheme.typography.titleLarge) }
                state.connection?.accountType?.let { Text("Tipo de conta: ${accountTypeLabel(it)}") }
                Text("Permissões solicitadas", style = MaterialTheme.typography.titleSmall)
                Text("Dados básicos da conta profissional · instagram_business_basic", style = MaterialTheme.typography.bodySmall)
                Text("Publicar conteúdo · instagram_business_content_publish", style = MaterialTheme.typography.bodySmall)
                Text("A senha do Instagram é informada somente na autorização oficial.", style = MaterialTheme.typography.bodySmall)
                state.authorizationStatus?.let { Text(authorizationLabel(it), style = MaterialTheme.typography.bodyMedium) }
                if (state.connection?.canPublish != true) {
                    Button(onClick = viewModel::connect, enabled = state.canAuthorize && !readingImage) {
                        Text(if (state.connection == null) "Conectar Instagram" else "Reconectar Instagram")
                    }
                }
            }

            if (state.hasUnresolvedIntent) {
                InstagramSection("Publicação aguardando confirmação") {
                    Text("Existe um envio registrado para esta conexão. Consulte o resultado e o histórico. O aplicativo não repetirá a publicação nem iniciará outra enquanto o resultado estiver pendente.")
                    if (state.intent?.publicationId == null) {
                        Text(if (state.intent?.binding != null)
                            "A referência ainda não foi confirmada. Atualize a consulta para buscar pelo identificador original; uma resposta vazia não cancela nem repete o envio."
                            else "Este registro antigo não tem vínculo estável verificável. A recuperação precisa ser verificada pelo suporte; nenhuma conta atual será atribuída à tentativa antiga.",
                            style = MaterialTheme.typography.bodySmall)
                    }
                    if (state.pendingPublication?.state == "provider_confirming") {
                        Text("Você pode continuar a confirmação do envio que já aprovou. Essa ação pode concluir a mesma publicação no Instagram.")
                        Button(onClick = viewModel::requestContinuationConfirmation,
                            enabled = state.canContinueConfirmation && !readingImage) {
                            Text("Continuar confirmação desta publicação")
                        }
                    }
                }
            }

            InstagramSection("2. Imagem e legenda") {
                Text("JPEG · 1080 × 1080 pixels · até 8 MB", style = MaterialTheme.typography.bodySmall)
                OutlinedButton(enabled = state.canEditDraft && !readingImage, onClick = {
                    viewModel.pickerSessionKey()?.let {
                        pendingPickerSession = it
                        picker.launch("image/jpeg")
                    }
                }) { Text("Escolher imagem JPEG") }
                state.draftJpeg?.let { InstagramLocalPreview(it) }
                OutlinedTextField(
                    value = state.draftCaption,
                    onValueChange = viewModel::updateCaption,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = state.canEditDraft && !readingImage,
                    minLines = 3,
                    label = { Text("Legenda") },
                    supportingText = { Text("A prévia da legenda será exibida antes da publicação.") }
                )
                Button(onClick = viewModel::upload, enabled = state.canUpload && !readingImage) { Text("Enviar imagem para revisão") }
            }

            state.selectedMedia?.let { selected ->
                InstagramSection("3. Revisar publicação") {
                    Text("Destino: ${instagramUsernameLabel(state.connection?.username.orEmpty())}", fontWeight = FontWeight.SemiBold)
                    Text("${selected.width} × ${selected.height} · JPEG")
                    Text("Prévia da legenda", style = MaterialTheme.typography.titleSmall)
                    Text(selected.caption)
                    Text("O serviço pode acrescentar ou atualizar uma identificação ao final da legenda. A legenda definitiva será exibida no histórico.", style = MaterialTheme.typography.bodySmall)
                    Text("A publicação só será solicitada após sua confirmação.", style = MaterialTheme.typography.bodySmall)
                    Button(onClick = viewModel::requestPublicationConfirmation,
                        enabled = state.canPublish && !readingImage) { Text("Revisar e publicar no Instagram") }
                    if (state.historyLoaded && !state.freshPublicationAvailable && state.intent == null) {
                        Text("O serviço não liberou uma nova publicação para esta conta.", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }

            InstagramSection("Histórico de publicações") {
                if (!state.historyLoaded) Text("O histórico ainda não foi confirmado.")
                else if (state.history.isEmpty()) Text("Nenhuma publicação encontrada nesta conta.")
                state.history.forEach { publication ->
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                        Text(publicationLabel(publication), fontWeight = FontWeight.Bold)
                        publication.username?.let { Text(instagramUsernameLabel(it)) }
                        Text(publication.caption, style = MaterialTheme.typography.bodyMedium)
                        Text("Imagem: ${publication.mediaId}", style = MaterialTheme.typography.bodySmall)
                        Text("Referência: ${publication.publicationId}", style = MaterialTheme.typography.bodySmall)
                        Text("Última atualização: ${publication.updatedAt}", style = MaterialTheme.typography.bodySmall)
                        publication.publishedAt?.let { Text("Publicado em: $it", style = MaterialTheme.typography.bodySmall) }
                        val permalink = publication.permalink
                        if (publication.confirmed && permalink != null && InstagramPolicies.isOfficialPermalink(permalink)) {
                            OutlinedButton(onClick = {
                                if (InstagramPolicies.isOfficialPermalink(permalink)) {
                                    try {
                                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(permalink)).apply {
                                            addCategory(Intent.CATEGORY_BROWSABLE)
                                        })
                                    } catch (_: Exception) { viewModel.showSelectionError("Não foi possível abrir a publicação no navegador.") }
                                }
                            }) { Text("Ver publicação no Instagram") }
                        }
                    }
                }
                if (state.intent?.confirmed == true) {
                    OutlinedButton(onClick = viewModel::startNewDraft,
                        enabled = !state.busy && !readingImage && state.storageAvailable && state.freshPublicationAvailable) {
                        Text("Preparar outra publicação")
                    }
                    if (!state.freshPublicationAvailable) Text("Consulte o serviço para saber se uma nova publicação está disponível.", style = MaterialTheme.typography.bodySmall)
                }
            }
            Spacer(modifier = Modifier.height(20.dp))
        }
    }

    if (state.confirmationOpen && state.selectedMedia != null) {
        AlertDialog(
            onDismissRequest = viewModel::dismissPublicationConfirmation,
            title = { Text("Publicar agora no Instagram?") },
            text = {
                Column(modifier = Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Destino: ${instagramUsernameLabel(state.connection?.username.orEmpty())}", fontWeight = FontWeight.Bold)
                    Text("Prévia da legenda da imagem selecionada:")
                    Text(state.selectedMedia!!.caption)
                    Text("O serviço pode acrescentar ou atualizar uma identificação ao final. Confira a legenda definitiva no histórico.")
                    Text("Confirme apenas uma vez. O aplicativo acompanhará o resultado deste envio.")
                }
            },
            confirmButton = {
                Button(enabled = state.canPublish, onClick = viewModel::confirmPublish) { Text("Confirmar publicação") }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissPublicationConfirmation) { Text("Voltar à revisão") }
            }
        )
    }
    if (state.reconciliationConfirmationOpen) {
        AlertDialog(
            onDismissRequest = viewModel::dismissContinuationConfirmation,
            title = { Text("Continuar a publicação já aprovada?") },
            text = { Text("O serviço continuará a confirmação deste mesmo envio e poderá concluir a publicação no Instagram. A referência e a intenção do envio serão preservadas.") },
            confirmButton = {
                Button(enabled = state.canContinueConfirmation, onClick = viewModel::continuePublicationConfirmation) {
                    Text("Confirmar continuação")
                }
            },
            dismissButton = { TextButton(onClick = viewModel::dismissContinuationConfirmation) { Text("Voltar") } }
        )
    }
}

@Composable
private fun InstagramSection(title: String, content: @Composable () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            content()
        }
    }
}

@Composable
private fun InstagramLocalPreview(jpeg: ByteArray) {
    val bitmap = remember(jpeg) { BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) }
    bitmap?.let {
        Image(bitmap = it.asImageBitmap(), contentDescription = "Prévia da imagem selecionada para o Instagram",
            modifier = Modifier.fillMaxWidth().height(240.dp), contentScale = ContentScale.Fit)
    }
}

/** Read only the chosen document, with a hard size bound and a full local decoder check. */
private fun readInstagramJpeg(resolver: ContentResolver, uri: Uri): ByteArray? {
    if (uri.scheme != "content") return null
    val bytes = resolver.openInputStream(uri)?.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
            val read = input.read(buffer, 0, minOf(buffer.size, InstagramPolicies.MAX_JPEG_BYTES - output.size() + 1))
            if (read < 0) break
            if (read == 0) return@use null
            if (output.size() + read > InstagramPolicies.MAX_JPEG_BYTES) return@use null
            output.write(buffer, 0, read)
        }
        output.toByteArray()
    } ?: return null
    if (!InstagramPolicies.validateJpeg(bytes)) { bytes.fill(0); return null }
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    if (bitmap == null) { bytes.fill(0); return null }
    val valid = bitmap.width == 1080 && bitmap.height == 1080
    bitmap.recycle()
    if (!valid) { bytes.fill(0); return null }
    return bytes
}

private fun connectionLabel(connection: InstagramConnection?, availability: InstagramAvailability): String = when {
    availability == InstagramAvailability.CHECKING -> "Verificando conexão"
    availability != InstagramAvailability.AVAILABLE -> "Conexão não confirmada"
    connection == null -> "Instagram não conectado"
    connection.canPublish -> "Conta conectada"
    connection.health == "authorization_pending" -> "Autorização pendente"
    connection.health == "reconnect_required" -> "É necessário reconectar a conta"
    connection.state == "disconnected" -> "Conta desconectada"
    else -> "A conexão ainda não está pronta para publicar"
}

private fun accountTypeLabel(type: String): String = when (type) {
    "business" -> "Empresa (Business)"
    "creator" -> "Criador de conteúdo (Creator)"
    else -> "Tipo não confirmado"
}

private fun authorizationLabel(status: String): String = when (status) {
    "authorization_pending" -> "Aguardando a autorização. Volte ao aplicativo após concluir no Instagram."
    "authorization_processing" -> "A autorização está sendo conferida pelo serviço."
    "authorization_completed" -> "Autorização concluída."
    "authorization_cancelled" -> "A autorização foi cancelada no Instagram."
    "authorization_expired" -> "A autorização expirou. Você pode iniciar uma nova conexão."
    "authorization_failed" -> "A autorização não foi concluída. Consulte o estado antes de tentar novamente."
    else -> "A autorização ainda não foi confirmada."
}

private fun publicationLabel(publication: InstagramPublication): String = when {
    publication.confirmed -> "Publicação confirmada"
    publication.pending -> "Aguardando confirmação"
    publication.state == "failed" -> "Publicação não confirmada pelo serviço"
    else -> "Resultado não confirmado"
}
