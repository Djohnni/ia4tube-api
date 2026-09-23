package br.com.ia4tube.app.feature.calendar.imports

import android.app.DatePickerDialog
import android.app.TimePickerDialog
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
                              onBack: () -> Unit, onScheduled: (String) -> Unit) {
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
            Text("Adicionar foto ou vídeo", style = MaterialTheme.typography.titleLarge)
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
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val expected = pickerRuntime
        val requestId = pendingPickerRequest
        pickerRuntime = null
        pendingPickerRequest = 0L
        // ON_START may already be restoring when OpenDocument delivers its result. The session-bound runtime
        // owns that race and retains exactly one result until restore completes; selection still never sends.
        if (uri != null && expected === current && requestId > 0L && state.sessionValid) {
            if (reselecting) current.reselect(requestId, uri.toString())
            else pendingKind?.let { current.select(requestId, uri.toString(), it) }
        }
        pendingKind = null; reselecting = false
    }
    val choose: (ImportMediaKind?, Boolean) -> Unit = { kind, reselect ->
        if (pickerRuntime == null && !state.busy && !state.pickerResultPending) {
            pickerSequence++
            pendingPickerRequest = pickerSequence
            pendingKind = kind; reselecting = reselect; pickerRuntime = current
            try { picker.launch(when (kind) {
                ImportMediaKind.IMAGE -> arrayOf("image/jpeg", "image/png", "image/webp")
                ImportMediaKind.VIDEO -> arrayOf("video/mp4", "video/quicktime")
                null -> arrayOf("image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime")
            }) } catch (_: Exception) { pickerRuntime = null; pendingPickerRequest = 0L }
        }
    }
    GalleryImportWorkflowContent(state, current, { if (session.getToken() == token) latestToken() else "" },
        generatedArtId, generatedArtRevision, back, onScheduled, choose)
}

@Composable
internal fun GalleryImportWorkflowContent(view: ImportWorkflowView, runtime: GalleryImportWorkflowActions, tokenProvider: () -> String,
    generatedArtId: String?, generatedArtRevision: Long?, onBack: () -> Unit, onScheduled: (String) -> Unit,
    choose: (ImportMediaKind?, Boolean) -> Unit) {
    val context = LocalContext.current
    val draft = view.draft
    val preparation = view.preparation
    val immutableSchedule = draft?.phase in setOf(ImportPhase.SCHEDULING, ImportPhase.SCHEDULED)
    val uploadDone = draft?.upload?.serverVerified == true
    val operational = view.foreground && view.sessionValid && !view.busy
    var editedConfiguration by remember(draft?.draftId, draft?.configuration) { mutableStateOf(draft?.configuration) }
    val configuration = editedConfiguration ?: draft?.configuration
    val preview = preparation?.preview?.takeIf { it.currentRevision == it.mediaRevision && configuration == draft?.configuration }
    var target by remember(preview?.assetId, preview?.mediaRevision, preview?.previewDigest) {
        mutableStateOf(preview?.variants?.firstOrNull()?.target ?: "feed")
    }
    val review = remember(runtime) { ImportPreviewReview() }
    var reviewCounter by remember(runtime) { mutableIntStateOf(0) }
    val sessionToken = tokenProvider()
    review.bind(view.owner, sessionToken, preview)
    var caption by remember(draft?.draftId) { mutableStateOf(draft?.scheduleIntent?.caption.orEmpty()) }
    var date by remember(draft?.draftId) { mutableStateOf(LocalDate.now(ZoneId.of("America/Sao_Paulo")).plusDays(1).toString()) }
    var time by remember(draft?.draftId) { mutableStateOf("09:00") }
    val availability = preparation?.availability
    var automatic by remember(draft?.draftId, availability?.automaticPreference) {
        mutableStateOf(availability?.automaticPreference == true && availability.automaticAllowed)
    }
    // An old preference cannot lock a blocked checkbox on or revive consent after availability closes.
    LaunchedEffect(availability?.automaticAllowed) {
        if (availability?.automaticAllowed != true) automatic = false
    }
    var confirmSchedule by remember(runtime) { mutableStateOf(false) }
    var confirmCancel by remember(runtime) { mutableStateOf(false) }
    val confirmed = preparation?.confirmation?.let { it.assetId == preview?.assetId && it.mediaRevision == preview.mediaRevision &&
        it.previewDigest == preview.previewDigest } == true
    val at = importScheduledAt(date, time)
    val currentlyReviewed = reviewCounter.let { review.complete() }
    val captionRequired = preview?.variants?.any { it.target in setOf("feed", "reel") } == true
    val canSchedule = operational && confirmed && currentlyReviewed && at != null && caption.length <= 2200 &&
        (!captionRequired || caption.isNotBlank()) && availability?.enabled == true &&
        (!automatic || availability.automaticAllowed) && (!preview!!.testOnly || availability.localSimulation) && !immutableSchedule
    val uploadUi = galleryImportUploadPresentation(view.upload, view.busy, view.foreground, view.initialized, view.sessionValid)
    Column(Modifier.fillMaxSize().background(Color(0xFF101218)).padding(horizontal = 12.dp, vertical = 8.dp)) {
        CompositionLocalProvider(LocalContentColor provides Color.White) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Voltar ao calendário") }
                Text("Adicionar foto ou vídeo", fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            }
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Arquivo → preparo → prévia → Programar", style = MaterialTheme.typography.titleMedium)
                if (view.capabilities.localSimulation) Text("AMBIENTE LOCAL DE TESTE — nenhuma publicação real ao Instagram.", color = Color(0xFFFFD59C))
                if (view.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                view.error?.let { Text(it, color = Color(0xFFFFB4AB)) }
                if (!view.sessionValid) Text("Nenhum arquivo da sessão anterior será exibido.")
                if (generatedArtId != null && generatedArtRevision != null && draft == null) {
                    Text("Usar a arte já criada", style = MaterialTheme.typography.titleMedium)
                    Text("Vamos conferir a arte desta conta, sem criar um pedido nem debitar crédito de geração. Escolher música não autoriza publicação.")
                    Button(enabled = operational, colors = importWorkflowButtonColors(), onClick = { runtime.adoptGenerated(generatedArtId, generatedArtRevision) }) { Text("Usar esta arte") }
                }
                val pendingGenerated = preparation?.generatedSourceIntent
                if (preparation?.status == ImportPreparationRunStatus.SOURCE_RECONCILIATION && pendingGenerated != null) {
                    Text("A seleção desta arte precisa ser conferida. Vamos recuperar a mesma origem, sem criar outra arte.")
                    OutlinedButton(enabled = operational, onClick = { runtime.adoptGenerated(pendingGenerated.calendarItemId, pendingGenerated.revision) }) {
                        Text("Conferir a mesma arte existente")
                    }
                }
                if (!uploadDone && !immutableSchedule && pendingGenerated == null) {
                    Text(uploadUi.title, style = MaterialTheme.typography.titleMedium)
                    Text(uploadUi.detail)
                    uploadUi.selectedSummary?.let { Text(it) }
                    uploadUi.confirmedProgress?.let { LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth())
                        Text("Recebimento confirmado: ${(it * 100).toInt()}%") }
                    uploadUi.error?.let { Text(it, color = Color(0xFFFFB4AB)) }
                    if (view.pickerResultPending) Text(
                        "O arquivo escolhido está preservado enquanto conferimos o rascunho desta conta.",
                        color = Color(0xFFFFD59C))
                    for (action in uploadUi.actions) {
                        val label = when (action) {
                            GalleryImportUploadAction.SELECT_PHOTO -> "Escolher foto"
                            GalleryImportUploadAction.SELECT_VIDEO -> "Escolher vídeo"
                            GalleryImportUploadAction.RESELECT_SOURCE -> "Selecionar novamente o original"
                            GalleryImportUploadAction.SEND_FILE -> "Enviar / retomar arquivo"
                            GalleryImportUploadAction.PAUSE -> "Pausar envio"
                            GalleryImportUploadAction.CANCEL -> "Cancelar envio"
                            GalleryImportUploadAction.RECONCILE -> "Conferir envio existente"
                            GalleryImportUploadAction.DISCARD_CANCELLED -> "Retirar rascunho cancelado"
                        }
                        val pickerAction = action in setOf(GalleryImportUploadAction.SELECT_PHOTO,
                            GalleryImportUploadAction.SELECT_VIDEO, GalleryImportUploadAction.RESELECT_SOURCE)
                        OutlinedButton(onClick = { when (action) {
                            GalleryImportUploadAction.SELECT_PHOTO -> choose(ImportMediaKind.IMAGE, false)
                            GalleryImportUploadAction.SELECT_VIDEO -> choose(ImportMediaKind.VIDEO, false)
                            GalleryImportUploadAction.RESELECT_SOURCE -> choose(null, true)
                            GalleryImportUploadAction.SEND_FILE -> runtime.transfer()
                            GalleryImportUploadAction.PAUSE -> runtime.pauseTransfer()
                            GalleryImportUploadAction.CANCEL -> { confirmCancel = true }
                            GalleryImportUploadAction.RECONCILE -> if (view.initialized) runtime.reconcileUpload() else runtime.restore()
                            GalleryImportUploadAction.DISCARD_CANCELLED -> runtime.discardCancelled()
                        } }, enabled = (operational && !(view.pickerResultPending && pickerAction)) ||
                            action == GalleryImportUploadAction.PAUSE, modifier = Modifier.fillMaxWidth()) { Text(label) }
                    }
                    Text("Fotos: JPEG, PNG ou WebP até 32 MiB. Vídeos: MP4 ou MOV até 100 MiB e 60 segundos.", style = MaterialTheme.typography.bodySmall)
                }
                if (uploadDone && configuration != null && !immutableSchedule) {
                    Text("Formato e Música/Áudio", style = MaterialTheme.typography.titleMedium)
                    Text(importFinalAudioLabel(configuration))
                    if (draft.selection.kind == ImportMediaKind.VIDEO) {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            for (audio in listOf(ImportAudioMode.ORIGINAL, ImportAudioMode.MUTED)) FilterChip(
                                selected = configuration.audioMode == audio, enabled = operational,
                                colors = importWorkflowChipColors(),
                                onClick = { val next = configuration.copy(audioMode = audio); editedConfiguration = next; runtime.configure(next) },
                                label = { Text(if (audio == ImportAudioMode.ORIGINAL) "Manter áudio original" else "Remover áudio final") })
                        }
                    } else {
                        OutlinedButton(enabled = operational, onClick = {
                            val next = importFormatChoices(ImportMediaKind.IMAGE, ImportAudioMode.NONE).first().configuration
                            editedConfiguration = next; runtime.configure(next)
                        }) { Text("Sem música") }
                        val tracks = view.capabilities.musicTracks
                        if (tracks.isEmpty()) Text("Catálogo comercial vazio: nenhuma faixa com direitos comprovados está disponível. Música de teste só aparece em ambiente local autorizado.")
                        for (track in tracks) OutlinedButton(enabled = operational, onClick = {
                            val next = importFormatChoices(ImportMediaKind.IMAGE, ImportAudioMode.MUSIC, track.id).first().configuration
                            editedConfiguration = next; runtime.configure(next)
                        }) { Text(if (track.testOnly) "Áudio sintético — somente teste local" else track.displayName) }
                    }
                    val formatChoices = importFormatChoices(draft.selection.kind, configuration.audioMode, configuration.musicTrackId,
                        reelShareToFeed = if (ImportTarget.REEL in configuration.targets) configuration.shareToFeed else true)
                    for (choice in formatChoices) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = choice.configuration == configuration, enabled = operational,
                                onClick = { editedConfiguration = choice.configuration; runtime.configure(choice.configuration) })
                            Column { Text(choice.title); Text(choice.detail, style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                    if (ImportTarget.REEL in configuration.targets) {
                        FilterChip(selected = configuration.shareToFeed, enabled = operational,
                            colors = importWorkflowChipColors(),
                            onClick = {
                                val next = configuration.copy(shareToFeed = !configuration.shareToFeed)
                                editedConfiguration = next; runtime.configure(next)
                            }, label = { Text("Exibir também no Feed") })
                        importReelFeedLabel(configuration)?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    }
                    Text("Mudar formato ou áudio exige nova preparação e nova conferência. A legenda não será queimada no Story, nem há seletor de música nativo do Instagram.", style = MaterialTheme.typography.bodySmall)
                    Button(enabled = operational && view.capabilities.preparationEnabled, colors = importWorkflowButtonColors(), onClick = runtime::prepare,
                        modifier = Modifier.fillMaxWidth()) { Text(if (preparation?.preparation == null) "Preparar arquivo" else "Conferir / preparar esta versão") }
                    if (!view.capabilities.preparationEnabled) Text("O preparo ainda está indisponível neste servidor; o envio existente está preservado.")
                    if (preparation?.preparation != null) OutlinedButton(enabled = operational, onClick = runtime::refreshPreparation) { Text("Atualizar preparo e prévia") }
                }
                if (preparation?.status in setOf(ImportPreparationRunStatus.PREPARING, ImportPreparationRunStatus.RECONCILIATION_REQUIRED))
                    Text("Preparação em andamento ou aguardando conferência. O arquivo ainda não está pronto para programar.")
                preparation?.errorCode?.let { Text(importPreparationDiagnostic(preparation.diagnosticStage, it), color = Color(0xFFFFB4AB)) }
                if (preview != null && !immutableSchedule) {
                    Text("Prévia do arquivo final", style = MaterialTheme.typography.titleMedium)
                    if (preview.testOnly) Text("SIMULAÇÃO LOCAL — áudio sintético de teste. Não representa licença comercial nem publicação real.", color = Color(0xFFFFD59C))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { for (part in preview.variants) FilterChip(
                        selected = target == part.target, colors = importWorkflowChipColors(),
                        onClick = { target = part.target }, label = { Text(importTargetLabel(part.target)) }) }
                    val previewModifier = Modifier.fillMaxWidth().height(430.dp)
                    val testRenderer = LocalImportWorkflowPreviewRenderer.current
                    if (testRenderer != null) testRenderer(preview.variants.single { it.target == target }, previewModifier,
                        { review.rendered(target); reviewCounter++ }, { review.failed(target); reviewCounter++ })
                    else PrivateImportPreviewSurface(view.owner, tokenProvider, preview, target, view.foreground && view.sessionValid && !confirmSchedule && !confirmCancel,
                        previewModifier, onVerified = { review.rendered(it); reviewCounter++ }, onFailure = { review.failed(it); reviewCounter++ })
                    Text("Confira enquadramento, rotação, duração e áudio de cada destino antes de confirmar.")
                    configuration?.let(::importReelFeedLabel)?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    val allReviewed = reviewCounter.let { review.complete() }
                    Button(enabled = operational && allReviewed && !confirmed, colors = importWorkflowButtonColors(), onClick = { runtime.confirm(ImportPreviewConfirmation(
                        preview.assetId, preview.mediaRevision, preview.previewDigest, review.verifiedTargets())) }, modifier = Modifier.fillMaxWidth()) {
                        Text(if (confirmed) "Prévia conferida" else "Conferi as prévias e o áudio")
                    }
                    if (!allReviewed) Text("Abra e confira cada destino para habilitar a confirmação.", style = MaterialTheme.typography.bodySmall)
                    Text("Legenda, data e horário", style = MaterialTheme.typography.titleMedium)
                    if (captionRequired) OutlinedTextField(value = caption,
                        onValueChange = { if (it.length <= 2200) caption = it }, label = { Text("Legenda para Feed / Reel") },
                        supportingText = { Text("${caption.length}/2200 — legenda obrigatória para Feed / Reel; Story não recebe legenda sobreposta") },
                        colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Color.White, unfocusedTextColor = Color.White,
                            disabledTextColor = Color(0xFFC8CEDA), focusedLabelColor = Color.White, unfocusedLabelColor = Color(0xFFD3D6DF),
                            disabledLabelColor = Color(0xFFC8CEDA), focusedPlaceholderColor = Color(0xFFD3D6DF), unfocusedPlaceholderColor = Color(0xFFD3D6DF),
                            focusedSupportingTextColor = Color(0xFFD3D6DF), unfocusedSupportingTextColor = Color(0xFFD3D6DF),
                            disabledSupportingTextColor = Color(0xFFC8CEDA), cursorColor = Color(0xFF72D995), focusedBorderColor = Color(0xFF72D995),
                            unfocusedBorderColor = Color(0xFF919BAC), disabledBorderColor = Color(0xFF6A7484)),
                        modifier = Modifier.fillMaxWidth(), enabled = operational, minLines = 3)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(enabled = operational, onClick = { val chosen = LocalDate.parse(date)
                            DatePickerDialog(context, { _, year, month, day -> date = LocalDate.of(year, month + 1, day).toString() },
                                chosen.year, chosen.monthValue - 1, chosen.dayOfMonth).show() }) { Text("Data: $date") }
                        OutlinedButton(enabled = operational, onClick = { val chosen = LocalTime.parse(time)
                            TimePickerDialog(context, { _, hour, minute -> time = "%02d:%02d".format(hour, minute) }, chosen.hour, chosen.minute, true).show()
                        }) { Text("Horário: $time") }
                    }
                    Text("Horário de Brasília. Escolha um horário futuro, até 180 dias.", style = MaterialTheme.typography.bodySmall)
                    Text("Conta / destino: ${availability?.accountLabel ?: "conferindo a conta conectada"} · ${preview.variants.joinToString { importTargetLabel(it.target) }}")
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = automatic, enabled = operational && availability?.automaticAllowed == true, onCheckedChange = { automatic = it })
                        Text("Publicar automaticamente na data escolhida")
                    }
                    if (availability?.automaticAllowed != true) Text("Publicação automática indisponível: conexão, autorização da conta ou restrição operacional precisam ser conferidas. Nenhuma autorização antiga será presumida.")
                    if (!automatic) Text("Será salvo no mesmo calendário, sem autorização de envio automático.")
                    Button(enabled = canSchedule, colors = importWorkflowButtonColors(), onClick = { confirmSchedule = true }, modifier = Modifier.fillMaxWidth()) { Text("Programar") }
                    Text("Selecionar, enviar e preparar não autorizam publicação. Programar exige sua confirmação abaixo e respeita a preferência válida desta conta.", style = MaterialTheme.typography.bodySmall)
                }
                if (immutableSchedule) {
                    val receipt = preparation?.scheduleReceipt
                    Text(when {
                        receipt?.phase == "cancelled" -> "Esta programação foi cancelada"
                        receipt?.phase == "paused" || receipt?.automaticEnabled == false -> "Registro salvo, sem envio automático ativo"
                        draft?.phase == ImportPhase.SCHEDULED -> "Programação registrada no calendário"
                        else -> "Conferindo a mesma programação"
                    })
                    if (receipt?.localSimulation == true) Text("Simulação local; nenhum envio real foi autorizado.")
                    if (draft?.phase == ImportPhase.SCHEDULED && draft.calendarItemId != null)
                        Column {
                            Button(colors = importWorkflowButtonColors(), onClick = { onScheduled(draft.calendarItemId) }) { Text(if (receipt?.phase == "cancelled") "Voltar ao calendário" else "Ver no calendário e na galeria") }
                            OutlinedButton(enabled = operational, onClick = runtime::finishScheduledDraft) { Text("Concluir rascunho e adicionar outro arquivo") }
                        }
                    else OutlinedButton(enabled = operational, onClick = runtime::reconcileSchedule) { Text("Conferir programação existente") }
                }
                Text("Seu original é preservado. Este fluxo não gera uma nova arte nem consome crédito de geração.", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
    if (confirmCancel) AlertDialog(onDismissRequest = { confirmCancel = false }, title = { Text("Cancelar este envio?") },
        text = { Text("O original do celular será mantido. Um resultado pendente será conferido antes de permitir um novo arquivo.") },
        confirmButton = { TextButton(onClick = { confirmCancel = false; runtime.cancelUpload() }) { Text("Cancelar envio") } },
        dismissButton = { TextButton(onClick = { confirmCancel = false }) { Text("Voltar") } })
    if (confirmSchedule && preview != null) AlertDialog(onDismissRequest = { confirmSchedule = false }, title = { Text("Confirmar Programar?") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("${availability?.accountLabel ?: "Conta não confirmada"} · ${preview.variants.joinToString { importTargetLabel(it.target) }}")
            Text("$date às $time · Brasília")
            configuration?.let {
                Text(importFinalAudioLabel(it))
                importReelFeedLabel(it)?.let { label -> Text(label) }
            }
            if (caption.isNotBlank()) Text(caption)
            Text(if (automatic) "Autorizo a publicação deste arquivo preparado nesta conta e data, conforme as condições disponíveis."
                else "Salvar no calendário sem publicar automaticamente.")
            if (preview.testOnly || view.capabilities.localSimulation) Text("Somente simulação local, sem publicação real.")
        } }, confirmButton = { TextButton(enabled = canSchedule, onClick = {
            confirmSchedule = false; at?.let { runtime.schedule(caption, it, automatic) }
        }) { Text("Confirmar Programar") } }, dismissButton = { TextButton(onClick = { confirmSchedule = false }) { Text("Voltar à prévia") } })
}

@Composable
private fun importWorkflowButtonColors() = ButtonDefaults.buttonColors(disabledContainerColor = Color(0xFF343A46),
    disabledContentColor = Color(0xFFC8CEDA))

@Composable
private fun importWorkflowChipColors() = FilterChipDefaults.filterChipColors(labelColor = Color.White,
    selectedLabelColor = Color(0xFF211A31), selectedContainerColor = Color(0xFFEADDFF), disabledLabelColor = Color(0xFFC8CEDA))
