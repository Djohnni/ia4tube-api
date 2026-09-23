package br.com.ia4tube.app.feature.calendar.imports

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
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
import br.com.ia4tube.app.core.art_cache.AndroidPrivateArts
import br.com.ia4tube.app.core.session.SessionStore
import kotlinx.coroutines.CancellationException
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/** Deterministic Compose render tests only; production always uses authenticated, verified private media. */
internal val LocalImportWorkflowPreviewRenderer = staticCompositionLocalOf<(@Composable (ImportPrivatePreviewPart, Modifier, () -> Unit, () -> Unit) -> Unit)?> { null }

/** Shared by the existing calendar and planned-art gallery. No publication consent is inferred from entry or selection. */
@Composable
fun GalleryImportWorkflowHost(tokenProvider: () -> String, generatedArtId: String? = null, generatedArtRevision: Long? = null,
                              onBack: () -> Unit, onScheduled: (String) -> Unit,
                              autoOpenPicker: Boolean = false, generatedDestination: String? = null) {
    val context = LocalContext.current.applicationContext
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val session = remember(context) { SessionStore(context) }
    val sessionEpoch by AndroidPrivateArts.sessionChanges.collectAsState()
    val latestToken by rememberUpdatedState(tokenProvider)
    val token = tokenProvider()
    var runtime by remember(token, sessionEpoch) { mutableStateOf<GalleryImportWorkflowRuntime?>(null) }
    var loading by remember(token, sessionEpoch) { mutableStateOf(true) }
    var error by remember(token, sessionEpoch) { mutableStateOf<String?>(null) }
    LaunchedEffect(token, sessionEpoch) {
        try {
            require(token.isNotBlank() && session.getToken() == token)
            val guardedToken = { if (session.getToken() == token && latestToken() == token) token else "" }
            val capabilities = GalleryImportHttpApi(guardedToken).capabilities()
            require(guardedToken() == token)
            val owner = capabilities.identity
            if (!capabilities.enabled || owner == null) error = "Adicionar foto ou vídeo ainda não está disponível para esta conta. Nenhum arquivo foi enviado."
            else runtime = GalleryImportWorkflowRuntime(context, owner, token, guardedToken, capabilities,
                androidImportCheckpointStore(context), scope)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { error = "Não foi possível conferir a conta. Volte e abra novamente com a sessão atual." }
        finally { loading = false }
    }
    DisposableEffect(runtime, lifecycle) {
        val value = runtime
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) value?.start()
            if (event == Lifecycle.Event.ON_STOP) { value?.pause(); AndroidImportPreviews.cache(context).clear() }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); value?.dispose(); AndroidImportPreviews.cache(context).clear() }
    }
    val back = { runtime?.pause(); AndroidImportPreviews.cache(context).clear(); onBack() }
    BackHandler(onBack = back)
    val current = runtime
    if (current == null) {
        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton(onClick = back) { Text("Voltar ao calendário") }
            Text(if (generatedArtId != null) "Escolher música" else "Adicionar foto ou vídeo", style = MaterialTheme.typography.titleLarge)
            if (loading) CircularProgressIndicator() else Text(error ?: "A sessão mudou. Abra novamente para continuar.")
        }
        return
    }
    val state by current.state.collectAsState()
    var pendingKind by remember(current) { mutableStateOf<ImportMediaKind?>(null) }
    var reselecting by remember(current) { mutableStateOf(false) }
    var pickerRuntime by remember { mutableStateOf<GalleryImportWorkflowRuntime?>(null) }
    var pickerSequence by remember(current) { mutableLongStateOf(0L) }
    var pendingPickerRequest by remember(current) { mutableLongStateOf(0L) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        val expected = pickerRuntime
        val requestId = pendingPickerRequest
        pickerRuntime = null
        pendingPickerRequest = 0L
        // ON_START may already be restoring when OpenDocument delivers its result. The session-bound runtime
        // owns that race and retains exactly one result until restore completes; selection still never sends.
        if (uri != null && expected === current && requestId > 0L && state.sessionValid) {
            if (reselecting) current.reselect(requestId, uri.toString())
            else {
                val mime = runCatching { context.contentResolver.getType(uri)?.lowercase() }.getOrNull()
                val kind = pendingKind ?: if (mime?.startsWith("video/") == true) ImportMediaKind.VIDEO else ImportMediaKind.IMAGE
                current.select(requestId, uri.toString(), kind)
            }
        }
        pendingKind = null; reselecting = false
        if (uri == null && autoOpenPicker && state.draft == null) back()
    }
    val choose: (ImportMediaKind?, Boolean) -> Unit = { kind, reselect ->
        if (pickerRuntime == null && !state.busy && !state.pickerResultPending) {
            pickerSequence++
            pendingPickerRequest = pickerSequence
            pendingKind = kind; reselecting = reselect; pickerRuntime = current
            try { picker.launch(PickVisualMediaRequest(when (kind) {
                ImportMediaKind.IMAGE -> ActivityResultContracts.PickVisualMedia.ImageOnly
                ImportMediaKind.VIDEO -> ActivityResultContracts.PickVisualMedia.VideoOnly
                null -> ActivityResultContracts.PickVisualMedia.ImageAndVideo
            })) } catch (_: Exception) { pickerRuntime = null; pendingPickerRequest = 0L }
        }
    }
    var pickerOpened by remember(current) { mutableStateOf(false) }
    LaunchedEffect(current, state.foreground, state.initialized, state.busy) {
        if (autoOpenPicker && !pickerOpened && state.foreground && state.initialized && state.sessionValid &&
            !state.busy && state.error == null && state.upload.status == ImportUploadRunStatus.EMPTY &&
            state.preparation?.status == ImportPreparationRunStatus.EMPTY &&
            state.draft == null && state.preparation?.generatedSourceIntent == null &&
            state.preparation?.calendarSubmissionReceipt == null) {
            pickerOpened = true
            choose(null, false)
        }
    }
    GalleryImportWorkflowContent(state, current, { if (session.getToken() == token) latestToken() else "" },
        generatedArtId, generatedArtRevision, back, onScheduled, choose, generatedDestination)
}

@Composable
internal fun GalleryImportWorkflowContent(view: ImportWorkflowView, runtime: GalleryImportWorkflowActions, tokenProvider: () -> String,
    generatedArtId: String?, generatedArtRevision: Long?, onBack: () -> Unit, onScheduled: (String) -> Unit,
    choose: (ImportMediaKind?, Boolean) -> Unit, generatedDestination: String? = null) {
    val context = LocalContext.current
    val draft = view.draft
    val preparation = view.preparation
    val legacySchedule = draft?.phase in setOf(ImportPhase.SCHEDULING, ImportPhase.SCHEDULED)
    val submitted = preparation?.calendarSubmissionIntent != null
    val operational = view.foreground && view.sessionValid && view.initialized && !view.busy && !view.pickerResultPending
    val configuration = draft?.configuration
    var caption by remember(draft?.draftId) { mutableStateOf(preparation?.calendarSubmissionIntent?.caption.orEmpty()) }
    val musicOnly = generatedArtId != null
    val sourceMatches = !musicOnly || preparation?.generatedSourceIntent?.let {
        it.calendarItemId == generatedArtId && it.revision == generatedArtRevision
    } == true
    var date by remember(draft?.draftId) { mutableStateOf(preparation?.calendarSubmissionIntent?.schedule?.date
        ?: LocalDate.now(ZoneId.of("America/Sao_Paulo")).plusDays(1).toString()) }
    var time by remember(draft?.draftId) { mutableStateOf(preparation?.calendarSubmissionIntent?.schedule?.time ?: "09:00") }
    var musicExpanded by remember(draft?.draftId) { mutableStateOf(musicOnly) }
    var detailsExpanded by remember(draft?.draftId) { mutableStateOf(false) }
    var confirmCancel by remember(runtime) { mutableStateOf(false) }
    var generatedAdoptionStarted by remember(runtime, generatedArtId, generatedArtRevision) { mutableStateOf(false) }
    val receipt = preparation?.calendarSubmissionReceipt
    LaunchedEffect(receipt?.id) {
        if (receipt != null && view.sessionValid && tokenProvider().isNotBlank()) {
            val notice = when (receipt.state) {
                "scheduled" -> "Arquivo adicionado. Confira no calendário."
                "attention" -> "Arquivo recebido. Confira no calendário o que precisa de atenção."
                "cancelled" -> "Este arquivo foi cancelado. Confira no calendário."
                else -> "Arquivo recebido. Estamos preparando. Confira no calendário."
            }
            android.widget.Toast.makeText(context, notice, android.widget.Toast.LENGTH_LONG).show()
            onScheduled(receipt.calendarItemId ?: receipt.id)
        }
    }
    // Choosing an existing art in the gallery already selected its source; no second selection screen.
    LaunchedEffect(generatedArtId, generatedArtRevision, operational, draft?.draftId, preparation?.generatedSourceIntent) {
        if (generatedArtId != null && generatedArtRevision != null && operational && draft == null && receipt == null &&
            preparation?.generatedSourceIntent == null && !generatedAdoptionStarted) {
            generatedAdoptionStarted = true
            runtime.adoptGenerated(generatedArtId, generatedArtRevision)
        }
    }
    val uploadUi = galleryImportUploadPresentation(view.upload, view.busy, view.foreground, view.initialized, view.sessionValid)
    Column(Modifier.fillMaxWidth().heightIn(max = 620.dp).background(Color(0xFF101218)).padding(horizontal = 12.dp, vertical = 8.dp)) {
        CompositionLocalProvider(LocalContentColor provides Color.White) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Voltar ao calendário") }
                Text(if (musicOnly) "Escolher música" else "Adicionar foto ou vídeo", fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            }
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (view.capabilities.localSimulation) Text("AMBIENTE LOCAL DE TESTE — nenhuma publicação real ao Instagram.", color = Color(0xFFFFD59C))
                if (view.busy) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text(if (view.upload.status == ImportUploadRunStatus.TRANSFERRING) "Enviando arquivo…" else "Conferindo o recebimento…")
                }
                view.error?.let { Text(it, color = Color(0xFFFFB4AB)) }
                if (!view.sessionValid) Text("A sessão mudou. Reabra na empresa correta.")
                if (!view.initialized && !view.busy && view.sessionValid) {
                    OutlinedButton(onClick = runtime::restore, enabled = view.foreground) { Text("Recuperar arquivo") }
                }
                if (view.pickerResultPending) Text("O arquivo escolhido está preservado enquanto recuperamos o rascunho desta conta.")
                val pendingGenerated = preparation?.generatedSourceIntent
                if (draft == null && pendingGenerated != null && receipt == null) {
                    Text("Estamos recuperando a mesma arte existente.")
                    OutlinedButton(enabled = operational, onClick = {
                        runtime.adoptGenerated(pendingGenerated.calendarItemId, pendingGenerated.revision)
                    }) { Text("Continuar com esta arte") }
                }
                if (draft == null && pendingGenerated == null && generatedArtId != null && generatedArtRevision != null &&
                    generatedAdoptionStarted && operational && preparation?.errorCode != null) {
                    OutlinedButton(onClick = { runtime.adoptGenerated(generatedArtId, generatedArtRevision) }) { Text("Continuar com esta arte") }
                }
                if (draft == null && pendingGenerated == null && generatedArtId == null && receipt == null) {
                    OutlinedButton(enabled = operational, onClick = { choose(null, false) },
                        modifier = Modifier.fillMaxWidth()) { Text("Escolher foto ou vídeo") }
                    Text("Fotos: JPEG, PNG ou WebP até 32 MiB. Vídeos: MP4 ou MOV até 100 MiB e 60 segundos.", style = MaterialTheme.typography.bodySmall)
                }
                uploadUi.selectedSummary?.takeIf { draft != null && !musicOnly }?.let { Text(it) }
                uploadUi.confirmedProgress?.takeIf { draft?.upload?.serverVerified != true }?.let {
                    LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth())
                }
                if (draft?.upload?.serverVerified != true) uploadUi.error?.let { Text(it, color = Color(0xFFFFB4AB)) }
                preparation?.errorCode?.let { Text(importPreparationDiagnostic(preparation.diagnosticStage, it, preparation.diagnosticHttpStatus), color = Color(0xFFFFB4AB)) }
                when {
                    legacySchedule -> {
                        Text(if (draft?.phase == ImportPhase.SCHEDULED) "Arquivo já registrado no calendário." else "Recuperando a programação existente.")
                        if (draft?.phase == ImportPhase.SCHEDULED && draft.calendarItemId != null) {
                            Button(enabled = operational, colors = importWorkflowButtonColors(), onClick = {
                                onScheduled(draft.calendarItemId)
                            }) { Text("Voltar ao calendário") }
                            OutlinedButton(enabled = operational, onClick = runtime::finishScheduledDraft) { Text("Adicionar outro arquivo") }
                        } else OutlinedButton(enabled = operational, onClick = runtime::reconcileSchedule) { Text("Recuperar programação") }
                    }
                    draft?.phase == ImportPhase.CANCELLED -> {
                        Text("Envio cancelado. Seu original foi mantido.")
                        OutlinedButton(enabled = operational, onClick = runtime::discardCancelled) { Text("Escolher outro arquivo") }
                    }
                    draft?.phase == ImportPhase.CANCEL_PENDING -> {
                        Text("O cancelamento está sendo conferido.")
                        OutlinedButton(enabled = operational, onClick = runtime::reconcileUpload) { Text("Conferir cancelamento") }
                    }
                    !sourceMatches && draft != null -> {
                        Text("Há outro arquivo em andamento. Volte e conclua esse envio em Adicionar foto ou vídeo antes de usar música nesta arte.")
                    }
                    submitted -> {
                        Text("Estamos conferindo se o servidor recebeu este arquivo. O mesmo pedido será recuperado.")
                        Button(enabled = operational, colors = importWorkflowButtonColors(),
                            onClick = { runtime.addToCalendar(preparation.calendarSubmissionIntent!!.caption,
                                preparation.calendarSubmissionIntent!!.schedule) },
                            modifier = Modifier.fillMaxWidth()) { Text("Continuar adição ao calendário") }
                    }
                    draft != null && configuration != null -> {
                        if (!musicOnly) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(enabled = operational, onClick = {
                                    val initial = LocalDate.parse(date)
                                    DatePickerDialog(context, { _, year, month, day -> date = LocalDate.of(year, month + 1, day).toString() },
                                        initial.year, initial.monthValue - 1, initial.dayOfMonth).show()
                                }) { Text("Dia: ${LocalDate.parse(date).format(java.time.format.DateTimeFormatter.ofPattern("dd/MM/yyyy"))}") }
                                OutlinedButton(enabled = operational, onClick = {
                                    val initial = LocalTime.parse(time)
                                    TimePickerDialog(context, { _, hour, minute -> time = "%02d:%02d".format(java.util.Locale.ROOT, hour, minute) },
                                        initial.hour, initial.minute, true).show()
                                }) { Text("Hora: $time") }
                            }
                            Text("Horário de Brasília", style = MaterialTheme.typography.bodySmall)
                        }
                        if (!musicOnly && draft.selection.kind == ImportMediaKind.VIDEO) {
                            for (audio in listOf(ImportAudioMode.ORIGINAL, ImportAudioMode.MUTED)) FilterChip(
                                selected = configuration.audioMode == audio, enabled = operational,
                                colors = importWorkflowChipColors(),
                                onClick = { runtime.configure(configuration.copy(audioMode = audio)) },
                                label = { Text(if (audio == ImportAudioMode.ORIGINAL) "Manter áudio original" else "Remover áudio") })
                        } else if (draft.selection.kind == ImportMediaKind.IMAGE) {
                            if (!musicOnly) TextButton(onClick = { musicExpanded = !musicExpanded }) {
                                Text(if (configuration.audioMode == ImportAudioMode.MUSIC) "Música escolhida · Alterar" else "Adicionar música (opcional)")
                            }
                            if (musicExpanded) {
                            if (!musicOnly)
                            OutlinedButton(enabled = operational, onClick = {
                                runtime.configure(importFormatChoices(ImportMediaKind.IMAGE, ImportAudioMode.NONE).first().configuration)
                            }) { Text("Sem música") }
                            Column(Modifier.fillMaxWidth().heightIn(max = 240.dp).verticalScroll(rememberScrollState())) {
                            for (track in view.capabilities.musicTracks) FilterChip(
                                selected = configuration.musicTrackId == track.id, enabled = operational,
                                colors = importWorkflowChipColors(), onClick = {
                                    runtime.configure(importMusicConfiguration(configuration, track.id, generatedDestination))
                                }, label = { Text(if (track.testOnly) "Áudio sintético — somente teste local" else track.displayName) })
                            }
                            if (view.capabilities.musicTracks.isEmpty()) Text("Nenhuma música está disponível para esta conta.", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        if (musicOnly && configuration.audioMode == ImportAudioMode.MUSIC) Text(
                            if (ImportTarget.REEL in configuration.targets) "A foto com música será um Reel, também exibido no Feed."
                            else "A música será incorporada ao Story.", style = MaterialTheme.typography.bodySmall)
                        if (!musicOnly) TextButton(onClick = { detailsExpanded = !detailsExpanded }) { Text("Formato e legenda (opcional)") }
                        if (!musicOnly && detailsExpanded) {
                        for (choice in importFormatChoices(draft.selection.kind, configuration.audioMode, configuration.musicTrackId,
                            if (ImportTarget.REEL in configuration.targets) configuration.shareToFeed else true)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                RadioButton(selected = choice.configuration == configuration, enabled = operational,
                                    onClick = { runtime.configure(choice.configuration) })
                                Column { Text(choice.title); Text(choice.detail, style = MaterialTheme.typography.bodySmall) }
                            }
                        }
                        if (ImportTarget.REEL in configuration.targets) FilterChip(
                            selected = configuration.shareToFeed, enabled = operational, colors = importWorkflowChipColors(),
                            onClick = { runtime.configure(configuration.copy(shareToFeed = !configuration.shareToFeed)) },
                            label = { Text("Exibir também no Feed") })
                        importReelFeedLabel(configuration)?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        if (configuration.targets.any { it != ImportTarget.STORY }) OutlinedTextField(
                            value = caption, onValueChange = { if (it.length <= 2200) caption = it },
                            label = { Text("Legenda (opcional)") }, enabled = operational, minLines = 2,
                            colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Color.White, unfocusedTextColor = Color.White,
                                focusedLabelColor = Color.White, unfocusedLabelColor = Color(0xFFD3D6DF),
                                cursorColor = Color(0xFF72D995), focusedBorderColor = Color(0xFF72D995),
                                unfocusedBorderColor = Color(0xFF919BAC)), modifier = Modifier.fillMaxWidth())
                        }
                        val scheduleValid = musicOnly || importScheduledAt(date, time) != null
                        val musicChosen = !musicOnly || configuration.audioMode == ImportAudioMode.MUSIC &&
                            view.capabilities.musicTracks.any { it.id == configuration.musicTrackId }
                        if (!scheduleValid) Text("Escolha uma data e hora futuras, em até 180 dias.", color = Color(0xFFFFB4AB))
                        Text("Depois do envio, confira no calendário.", style = MaterialTheme.typography.bodyMedium)
                        if (musicChosen) Button(enabled = operational && scheduleValid && view.capabilities.preparationEnabled && view.capabilities.calendarSubmissionEnabled,
                            colors = importWorkflowButtonColors(), onClick = { runtime.addToCalendar(caption,
                                if (musicOnly) null else ImportCalendarSchedule(date, time)) },
                            modifier = Modifier.fillMaxWidth()) { Text("Enviar") }
                        if (!view.capabilities.preparationEnabled || !view.capabilities.calendarSubmissionEnabled)
                            Text("Adicionar ao calendário ainda não está disponível. Seu arquivo foi preservado.")
                        if (GalleryImportUploadAction.RESELECT_SOURCE in uploadUi.actions)
                            OutlinedButton(enabled = operational, onClick = { choose(null, true) }) { Text("Selecionar novamente o original") }
                        if (draft.phase in setOf(ImportPhase.EDITING, ImportPhase.INITIALIZING, ImportPhase.UPLOADING))
                            OutlinedButton(enabled = operational, onClick = { confirmCancel = true }) { Text("Cancelar envio") }
                    }
                }
                if (view.busy && view.upload.status == ImportUploadRunStatus.TRANSFERRING)
                    OutlinedButton(onClick = runtime::pauseTransfer) { Text("Pausar envio") }
            }
        }
    }
    if (confirmCancel) AlertDialog(onDismissRequest = { confirmCancel = false }, title = { Text("Cancelar este envio?") },
        text = { Text("O original do celular será mantido.") },
        confirmButton = { TextButton(onClick = { confirmCancel = false; runtime.cancelUpload() }) { Text("Cancelar envio") } },
        dismissButton = { TextButton(onClick = { confirmCancel = false }) { Text("Voltar") } })
}

@Composable
private fun importWorkflowButtonColors() = ButtonDefaults.buttonColors(disabledContainerColor = Color(0xFF343A46),
    disabledContentColor = Color(0xFFC8CEDA))

@Composable
private fun importWorkflowChipColors() = FilterChipDefaults.filterChipColors(labelColor = Color.White,
    selectedLabelColor = Color(0xFF211A31), selectedContainerColor = Color(0xFFEADDFF), disabledLabelColor = Color(0xFFC8CEDA))
