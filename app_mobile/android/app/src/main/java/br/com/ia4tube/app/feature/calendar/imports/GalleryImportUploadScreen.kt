package br.com.ia4tube.app.feature.calendar.imports

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

private class PendingGalleryImportPicker(val presenter: GalleryImportUploadPresenter, val kind: ImportMediaKind?, val reselect: Boolean)

/** Deliberately not registered in NavHost/calendar. No scheduling, publishing or music catalogue UI. */
@Composable
fun GalleryImportUploadScreen(owner: ImportOwner?, token: String, checkpointStore: PrivateImportCheckpointStore, onBack: () -> Unit) {
    val context = LocalContext.current.applicationContext
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val currentOwner = rememberUpdatedState(owner)
    val currentToken = rememberUpdatedState(token)
    val presenter = remember(owner, token, checkpointStore, context, lifecycle) {
        owner?.takeIf { token.isNotBlank() }?.let { selectedOwner ->
            GalleryImportUploadPresenter(selectedOwner, token, { currentOwner.value }, { currentToken.value }, scope) { changed ->
                CoordinatedGalleryImportUpload(GalleryImportUploadCoordinator({ currentOwner.value }, { currentToken.value },
                    AndroidImportSource(context), checkpointStore, onChanged = changed))
            }
        }
    }
    DisposableEffect(presenter, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> presenter?.onStart()
                Lifecycle.Event.ON_STOP -> presenter?.onStop()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); presenter?.dispose() }
    }
    var pendingPicker by remember { mutableStateOf<PendingGalleryImportPicker?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val pending = pendingPicker; pendingPicker = null
        if (uri != null && pending != null && pending.presenter === presenter) {
            if (pending.reselect) pending.presenter.reselect(uri.toString())
            else pending.kind?.let { pending.presenter.select(uri.toString(), it) }
        }
    }
    val back = { presenter?.onStop(); onBack() }
    BackHandler(onBack = back)
    if (presenter == null) {
        GalleryImportUploadContent(GalleryImportUploadUiState("Entre na iA4tube", "Selecione sua empresa para importar um arquivo."), back, {})
        return
    }
    val state by presenter.state.collectAsState()
    key(presenter) { GalleryImportUploadContent(state, back) { action ->
        when (action) {
            GalleryImportUploadAction.SELECT_PHOTO, GalleryImportUploadAction.SELECT_VIDEO, GalleryImportUploadAction.RESELECT_SOURCE -> {
                if (action in state.actions && pendingPicker == null) {
                    val kind = when (action) {
                        GalleryImportUploadAction.SELECT_PHOTO -> ImportMediaKind.IMAGE
                        GalleryImportUploadAction.SELECT_VIDEO -> ImportMediaKind.VIDEO
                        else -> null
                    }
                    pendingPicker = PendingGalleryImportPicker(presenter, kind, action == GalleryImportUploadAction.RESELECT_SOURCE)
                    val types = when (kind) {
                        ImportMediaKind.IMAGE -> arrayOf("image/jpeg", "image/png", "image/webp")
                        ImportMediaKind.VIDEO -> arrayOf("video/mp4", "video/quicktime")
                        null -> arrayOf("image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime")
                    }
                    try { picker.launch(types) } catch (_: Exception) { pendingPicker = null }
                }
            }
            else -> presenter.runAction(action)
        }
    } }
}

@Composable
internal fun GalleryImportUploadContent(state: GalleryImportUploadUiState, onBack: () -> Unit,
                                        onAction: (GalleryImportUploadAction) -> Unit) {
    var confirmCancel by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().background(Color(0xFF101218)).padding(horizontal = 12.dp, vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Voltar ao calendário", tint = Color.White) }
            Text("Adicionar foto ou vídeo", color = Color.White, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        }
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(state.title, color = Color.White, style = MaterialTheme.typography.titleMedium)
            Text(state.detail, color = Color(0xFFD3D6DF))
            state.selectedSummary?.let { Text(it, color = Color.White) }
            if (state.busy && state.confirmedProgress == null) LinearProgressIndicator(Modifier.fillMaxWidth())
            state.confirmedProgress?.let { confirmed ->
                LinearProgressIndicator(progress = { confirmed }, modifier = Modifier.fillMaxWidth())
                Text("Recebimento confirmado: ${(confirmed * 100).toInt()}%", color = Color(0xFFB8BDC9), style = MaterialTheme.typography.bodySmall)
            }
            state.currentPartProgress?.let { part ->
                Text("Parte em trânsito: ${(part * 100).toInt()}% — ainda aguardando confirmação", color = Color(0xFFB8BDC9), style = MaterialTheme.typography.bodySmall)
            }
            state.error?.let { Text(it, color = Color(0xFFFFB4AB)) }
            for (action in state.actions) {
                val label = when (action) {
                    GalleryImportUploadAction.SELECT_PHOTO -> "Escolher foto"
                    GalleryImportUploadAction.SELECT_VIDEO -> "Escolher vídeo"
                    GalleryImportUploadAction.RESELECT_SOURCE -> "Selecionar novamente o original"
                    GalleryImportUploadAction.SEND_FILE -> "Enviar arquivo"
                    GalleryImportUploadAction.PAUSE -> "Pausar envio"
                    GalleryImportUploadAction.CANCEL -> "Cancelar envio"
                    GalleryImportUploadAction.RECONCILE -> "Conferir envio"
                    GalleryImportUploadAction.DISCARD_CANCELLED -> "Retirar rascunho cancelado"
                }
                val click = { if (action == GalleryImportUploadAction.CANCEL) confirmCancel = true else onAction(action) }
                if (action == GalleryImportUploadAction.SEND_FILE) Button(onClick = click, modifier = Modifier.fillMaxWidth()) { Text(label) }
                else OutlinedButton(onClick = click, modifier = Modifier.fillMaxWidth()) { Text(label, color = Color.White) }
            }
            Text("Foto: JPEG, PNG ou WebP, até 32 MiB. Vídeo: MP4 ou MOV, até 100 MiB e 60 segundos. A compatibilidade será conferida.",
                color = Color(0xFFB8BDC9), style = MaterialTheme.typography.bodySmall)
            Text("Esta etapa não gera uma arte nem consome crédito de geração. Preparo, prévia, áudio e agendamento são etapas posteriores.",
                color = Color(0xFFB8BDC9), style = MaterialTheme.typography.bodySmall)
        }
    }
    if (confirmCancel && GalleryImportUploadAction.CANCEL in state.actions) AlertDialog(
        onDismissRequest = { confirmCancel = false }, title = { Text("Cancelar este envio?") },
        text = { Text("O arquivo original do celular será preservado. Se algum resultado estiver pendente, primeiro vamos conferir o mesmo envio antes de permitir escolher outro.") },
        confirmButton = { TextButton(onClick = { confirmCancel = false; onAction(GalleryImportUploadAction.CANCEL) }) { Text("Cancelar envio") } },
        dismissButton = { TextButton(onClick = { confirmCancel = false }) { Text("Voltar") } })
}
