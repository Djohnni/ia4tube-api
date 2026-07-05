package br.com.ia4tube.app.feature.monthly_planning

import android.graphics.BitmapFactory
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.core.camera.CameraImageStore
import br.com.ia4tube.app.core.upload.AndroidFileReader
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.UploadFile
import br.com.ia4tube.app.feature.company_profile.CompanyProfileRamoSearchField
import br.com.ia4tube.app.feature.company_profile.DefaultLogoUploadCard
import br.com.ia4tube.app.feature.create_art.CompanyCharacteristic
import br.com.ia4tube.app.feature.create_art.CreateArtCatalog
import br.com.ia4tube.app.feature.create_art.CreateArtObjective
import br.com.ia4tube.app.ui.components.EstimatedCreationProgressCard
import br.com.ia4tube.app.ui.components.ScreenScaffold
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.launch

@Composable
fun MonthlyPlanningScreen(
    viewModel: MonthlyPlanningViewModel,
    onBack: () -> Unit,
    onOpenDetail: (String) -> Unit,
    onOpenOrder: (String) -> Unit
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val fileReader = remember(context) { AndroidFileReader(context) }
    val cameraImageStore = remember(context) { CameraImageStore(context.applicationContext) }
    val scope = rememberCoroutineScope()
    val screenScrollState = rememberScrollState()
    var loadingPhotos by remember { mutableStateOf(false) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }
    var showGeneralCalendar by remember { mutableStateOf(false) }

    val photosPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            loadingPhotos = true
            val files = readPlanningPhotos(uris, fileReader, viewModel::setUploadError)
            viewModel.addPhotos(files)
            loadingPhotos = false
        }
    }
    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val uri = pendingCameraUri
        pendingCameraUri = null
        if (!saved || uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            loadingPhotos = true
            when (val result = fileReader.readUploadFile(uri)) {
                is ApiResult.Success -> viewModel.addPhotos(listOf(result.value))
                is ApiResult.Failure -> viewModel.setUploadError(result.message)
            }
            loadingPhotos = false
        }
    }
    val logoPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        runCatching {
            context.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
        }
        scope.launch {
            when (val result = fileReader.readUploadFile(uri)) {
                is ApiResult.Success -> viewModel.updateCompanyLogo(uri.toString(), result.value)
                is ApiResult.Failure -> {
                    viewModel.updateCompanyLogoUri(uri.toString())
                    viewModel.setUploadError(result.message)
                }
            }
        }
    }

    LaunchedEffect(state.companyProfile.logoUri, state.companyProfile.logoFile) {
        val logoUri = state.companyProfile.logoUri
        if (logoUri.isNotBlank() && state.companyProfile.logoFile == null) {
            when (val result = fileReader.readUploadFile(Uri.parse(logoUri))) {
                is ApiResult.Success -> viewModel.updateCompanyLogo(logoUri, result.value)
                is ApiResult.Failure -> Unit
            }
        }
    }

    LaunchedEffect(state.step, showGeneralCalendar) {
        screenScrollState.scrollTo(0)
    }

    LaunchedEffect(showGeneralCalendar) {
        if (showGeneralCalendar) {
            viewModel.loadGeneralCalendar()
        }
    }

    BackHandler(enabled = showGeneralCalendar) {
        showGeneralCalendar = false
    }
    BackHandler(enabled = !showGeneralCalendar && state.step == MonthlyPlanningStep.Upload) {
        onBack()
    }
    BackHandler(enabled = !showGeneralCalendar && state.step == MonthlyPlanningStep.Confirmation) {
        viewModel.backToUpload()
    }

    ScreenScaffold {
        if (showGeneralCalendar) {
            MonthlyPlanningGeneralCalendarContent(
                state = state,
                onBack = { showGeneralCalendar = false },
                onRefresh = viewModel::loadGeneralCalendar,
                onOpenOrder = onOpenOrder,
                onRemove = { item -> viewModel.removeFromGeneralCalendar(item.key) },
                onReschedule = viewModel::rescheduleGeneralCalendarItem,
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(screenScrollState)
            )
        } else {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(screenScrollState),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                MonthlyPlanningHeader(
                    step = state.step,
                    onBack = onBack
                )

                if (state.step == MonthlyPlanningStep.Upload) {
                    MonthlyPlanningCalendarShortcut(
                        onClick = { showGeneralCalendar = true }
                    )
                }

                when (state.step) {
                    MonthlyPlanningStep.Upload -> MonthlyPlanningUploadContent(
                        state = state,
                        loadingPhotos = loadingPhotos,
                        onSelectPhotos = { photosPicker.launch("image/*") },
                        onTakePhoto = {
                            val uri = cameraImageStore.createImageUri()
                            pendingCameraUri = uri
                            cameraLauncher.launch(uri)
                        },
                        onRemovePhoto = viewModel::removePhoto,
                        onObjectiveSelected = { index, objective ->
                            viewModel.selectPhotoObjective(index, objective.id, objective.label)
                        },
                        onManualObjectiveChange = viewModel::updatePhotoManualObjective,
                        onTextChange = viewModel::updatePhotoText,
                        onDecreaseLevel = viewModel::decreasePhotoEditLevel,
                        onIncreaseLevel = viewModel::increasePhotoEditLevel,
                        onToggleLevelInfo = viewModel::togglePhotoEditLevelInfo,
                        onBack = onBack,
                        onContinue = viewModel::goToConfirmation
                    )

                    MonthlyPlanningStep.Confirmation -> MonthlyPlanningConfirmationStep(
                        state = state,
                        onBack = viewModel::backToUpload,
                        onCompanyNameChange = viewModel::updateCompanyName,
                        onCompanyRamoChange = viewModel::updateCompanyRamo,
                        onCompanyRamoSelected = viewModel::selectCompanyRamo,
                        onContinueRamoTyping = viewModel::continueCompanyRamoTyping,
                        onCompanyWhatsappChange = viewModel::updateCompanyWhatsapp,
                        onCompanyInstagramChange = viewModel::updateCompanyInstagram,
                        onCompanyCharacteristicToggle = viewModel::toggleCompanyCharacteristic,
                        onToggleOtherInfo = viewModel::toggleCompanyOtherInfo,
                        onCompanyImportantInfoChange = viewModel::updateCompanyImportantInfo,
                        onSelectLogo = { logoPicker.launch(arrayOf("image/*")) },
                        onRemoveLogo = viewModel::removeCompanyLogo,
                        onConfirm = viewModel::confirmPlanning
                    )

                    MonthlyPlanningStep.Processing -> MonthlyPlanningProcessingStep(
                        onShowPlans = viewModel::showMyPlannings
                    )

                    MonthlyPlanningStep.MyPlannings -> MonthlyPlanningListStep(
                        plannings = state.plannings,
                        loading = state.loading,
                        onOpenDetail = onOpenDetail
                    )
                }

                state.uploadError?.let { error ->
                    Text(
                        text = error,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium
                    )
                }

                state.successMessage?.let { message ->
                    Text(
                        text = message,
                        color = MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                }

                Spacer(modifier = Modifier.height(18.dp))
            }
        }
    }
}

@Composable
private fun MonthlyPlanningHeader(
    step: MonthlyPlanningStep,
    onBack: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = "Criar Arte",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.ExtraBold
        )
        TextButton(onClick = onBack) {
            Icon(
                imageVector = Icons.Default.Close,
                contentDescription = "Fechar"
            )
        }
    }
    MonthlyPlanningStepTrail(step = step)
}

@Composable
private fun MonthlyPlanningStepTrail(step: MonthlyPlanningStep) {
    val activeIndex = when (step) {
        MonthlyPlanningStep.Upload -> 0
        MonthlyPlanningStep.Confirmation -> 1
        MonthlyPlanningStep.Processing,
        MonthlyPlanningStep.MyPlannings -> 2
    }
    val labels = listOf("Fotos", "Revisar", "Enviar")

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        labels.forEachIndexed { index, label ->
            val active = index <= activeIndex
            Column(
                modifier = Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(30.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(
                            if (active) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.surfaceVariant
                            }
                        ),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = (index + 1).toString(),
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.ExtraBold,
                        color = if (active) {
                            MaterialTheme.colorScheme.onPrimary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        }
                    )
                }
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = if (index == activeIndex) FontWeight.Bold else FontWeight.Medium,
                    color = if (active) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    }
                )
            }
            if (index < labels.lastIndex) {
                Box(
                    modifier = Modifier
                        .weight(0.42f)
                        .height(2.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(
                            if (index < activeIndex) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.outline.copy(alpha = 0.32f)
                            }
                        )
                )
            }
        }
    }
}

@Composable
private fun MonthlyPlanningCalendarShortcut(onClick: () -> Unit) {
    OutlinedButton(
        modifier = Modifier
            .fillMaxWidth()
            .height(54.dp),
        shape = RoundedCornerShape(14.dp),
        contentPadding = PaddingValues(horizontal = 16.dp),
        onClick = onClick
    ) {
        PlanningCalendarGlyph(
            color = MaterialTheme.colorScheme.primary,
            background = MaterialTheme.colorScheme.surface,
            modifier = Modifier.size(28.dp)
        )
        Spacer(modifier = Modifier.width(10.dp))
        Text(
            text = "Calendário geral",
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun MonthlyPlanningGeneralCalendarContent(
    state: MonthlyPlanningUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onOpenOrder: (String) -> Unit,
    onRemove: (MonthlyPlanningCalendarListItem) -> Unit,
    onReschedule: (MonthlyPlanningCalendarListItem, String) -> Unit,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "Calendário geral",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.ExtraBold,
                modifier = Modifier.weight(1f)
            )
            TextButton(onClick = onBack) {
                Text("Voltar")
            }
        }
        Text(
            text = "Todas as artes planejadas dos seus planejamentos mensais.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        OutlinedButton(
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.calendarLoading,
            onClick = onRefresh
        ) {
            Text(if (state.calendarLoading) "Atualizando..." else "Atualizar calendário")
        }
        state.calendarError?.let { error ->
            Text(
                text = error,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error
            )
        }
        MonthlyPlanningCalendarList(
            title = "Postagens planejadas",
            items = state.visibleGeneralCalendarPosts,
            loading = state.calendarLoading,
            emptyText = "Nenhuma arte encontrada no calendário.",
            onOpenOrder = onOpenOrder,
            onRemove = onRemove,
            onReschedule = onReschedule,
            showNextThirtyDays = true
        )
        Spacer(modifier = Modifier.height(18.dp))
    }
}

@Composable
private fun MonthlyPlanningUploadContent(
    state: MonthlyPlanningUiState,
    loadingPhotos: Boolean,
    onSelectPhotos: () -> Unit,
    onTakePhoto: () -> Unit,
    onRemovePhoto: (Int) -> Unit,
    onObjectiveSelected: (Int, CreateArtObjective) -> Unit,
    onManualObjectiveChange: (Int, String) -> Unit,
    onTextChange: (Int, String) -> Unit,
    onDecreaseLevel: (Int) -> Unit,
    onIncreaseLevel: (Int) -> Unit,
    onToggleLevelInfo: (Int) -> Unit,
    onBack: () -> Unit,
    onContinue: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (state.photos.isEmpty()) {
            PlanningPhotoPlaceholderCard(
                loadingPhotos = loadingPhotos,
                onSelectPhotos = onSelectPhotos,
                onTakePhoto = onTakePhoto
            )
        } else {
            state.photos.forEachIndexed { index, photo ->
                PlanningPhotoCard(
                    index = index + 1,
                    photo = photo,
                    ramo = state.companyProfile.ramo,
                    onObjectiveSelected = { objective ->
                        onObjectiveSelected(index, objective)
                    },
                    onManualObjectiveChange = { value ->
                        onManualObjectiveChange(index, value)
                    },
                    onTextChange = { value ->
                        onTextChange(index, value)
                    },
                    onDecreaseLevel = {
                        onDecreaseLevel(index)
                    },
                    onIncreaseLevel = {
                        onIncreaseLevel(index)
                    },
                    onToggleLevelInfo = {
                        onToggleLevelInfo(index)
                    },
                    onRemove = { onRemovePhoto(index) }
                )
            }
            AddPhotoCard(
                loadingPhotos = loadingPhotos,
                hasPhotos = true,
                onClick = onSelectPhotos
            )
        }

        MonthlyPlanningFooter(
            secondaryText = "Voltar",
            primaryText = "Continuar",
            onSecondaryClick = onBack,
            onPrimaryClick = onContinue
        )
    }
}

@Composable
private fun PlanningPhotoPlaceholderCard(
    loadingPhotos: Boolean,
    onSelectPhotos: () -> Unit,
    onTakePhoto: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.24f))
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(
                text = "Foto 1",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.ExtraBold
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                PhotoOptionCard(
                    modifier = Modifier
                        .weight(1f)
                        .height(144.dp),
                    enabled = !loadingPhotos,
                    label = if (loadingPhotos) "Carregando..." else "Adicionar foto",
                    onClick = onSelectPhotos,
                    icon = {
                        Icon(
                            imageVector = Icons.Filled.AddCircle,
                            contentDescription = null,
                            modifier = Modifier.size(32.dp),
                            tint = MaterialTheme.colorScheme.primary
                        )
                    }
                )
                PhotoOptionCard(
                    modifier = Modifier
                        .weight(1f)
                        .height(144.dp),
                    enabled = !loadingPhotos,
                    label = "Câmera",
                    onClick = onTakePhoto,
                    icon = {
                        CameraSourceGlyph(
                            color = MaterialTheme.colorScheme.primary,
                            background = MaterialTheme.colorScheme.surface,
                            modifier = Modifier.size(34.dp)
                        )
                    }
                )
            }
            Text(
                text = "Comece sua nova arte",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun PhotoOptionCard(
    modifier: Modifier = Modifier,
    enabled: Boolean,
    label: String,
    onClick: () -> Unit,
    icon: @Composable () -> Unit
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.30f))
            .border(
                width = 1.dp,
                color = MaterialTheme.colorScheme.primary.copy(alpha = 0.28f),
                shape = RoundedCornerShape(12.dp)
            )
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            icon()
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = if (enabled) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
private fun PlanningPhotoCard(
    index: Int,
    photo: MonthlyPlanningPhotoDraft,
    ramo: String,
    onObjectiveSelected: (CreateArtObjective) -> Unit,
    onManualObjectiveChange: (String) -> Unit,
    onTextChange: (String) -> Unit,
    onDecreaseLevel: () -> Unit,
    onIncreaseLevel: () -> Unit,
    onToggleLevelInfo: () -> Unit,
    onRemove: () -> Unit
) {
    var objectiveExpanded by remember(photo.file.fileName, photo.file.bytes.size) { mutableStateOf(false) }
    var textExpanded by remember(photo.file.fileName, photo.file.bytes.size) { mutableStateOf(false) }
    val objectiveSummary = photo.objetivo.ifBlank { "Nenhum objetivo selecionado" }
    val textSummary = photo.escritaImagem.ifBlank { "Nenhuma escrita adicionada" }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.24f))
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            PlanningPhotoHeader(index = index, onRemove = onRemove)
            PlanningPhotoPreview(index = index, photo = photo)
            PlanningPhotoAccordionSection(
                title = "Objetivo para esta foto",
                summary = objectiveSummary,
                expanded = objectiveExpanded,
                onToggle = { objectiveExpanded = !objectiveExpanded }
            ) {
                PlanningPhotoObjectiveSection(
                    ramo = ramo,
                    selectedObjective = photo.objetivo,
                    selectedObjectiveId = photo.objetivoId,
                    onObjectiveSelected = { objective ->
                        onObjectiveSelected(objective)
                        objectiveExpanded = false
                    },
                    onManualObjectiveChange = onManualObjectiveChange
                )
            }
            PlanningPhotoAccordionSection(
                title = "Escrita da imagem",
                summary = textSummary,
                expanded = textExpanded,
                onToggle = { textExpanded = !textExpanded }
            ) {
                PlanningPhotoTextField(
                    value = photo.escritaImagem,
                    onValueChange = onTextChange
                )
            }
            PlanningPhotoLevelSelector(
                level = photo.nivelEdicao,
                showInfo = photo.showNivelInfo,
                onDecrease = onDecreaseLevel,
                onIncrease = onIncreaseLevel,
                onToggleInfo = onToggleLevelInfo
            )
        }
    }
}

@Composable
private fun PlanningPhotoAccordionSection(
    title: String,
    summary: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    content: @Composable () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.24f)
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.18f))
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onToggle)
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(3.dp)
                ) {
                    Text(
                        text = title,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = summary,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Icon(
                    imageVector = if (expanded) {
                        Icons.Filled.KeyboardArrowDown
                    } else {
                        Icons.AutoMirrored.Filled.KeyboardArrowRight
                    },
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            if (expanded) {
                Column(
                    modifier = Modifier.padding(start = 14.dp, end = 14.dp, bottom = 14.dp)
                ) {
                    content()
                }
            }
        }
    }
}

@Composable
private fun PlanningPhotoHeader(
    index: Int,
    onRemove: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = "Foto $index",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.ExtraBold
        )
        TextButton(
            onClick = onRemove,
            modifier = Modifier.height(32.dp),
            contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
            colors = ButtonDefaults.textButtonColors(
                contentColor = MaterialTheme.colorScheme.onSurfaceVariant
            )
        ) {
            Icon(
                imageVector = Icons.Filled.Delete,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f)
            )
            Spacer(modifier = Modifier.width(4.dp))
            Text(
                text = "Remover",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.78f)
            )
        }
    }
}

@Composable
private fun PlanningPhotoPreview(
    index: Int,
    photo: MonthlyPlanningPhotoDraft
) {
    val file = photo.file
    val bitmap = remember(file.fileName, file.bytes.size) {
        BitmapFactory.decodeByteArray(file.bytes, 0, file.bytes.size)
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (bitmap != null) {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = "Foto $index do pedido",
                modifier = Modifier
                    .width(108.dp)
                    .height(144.dp)
                    .clip(RoundedCornerShape(12.dp)),
                contentScale = ContentScale.Crop
            )
        } else {
            Box(
                modifier = Modifier
                    .width(108.dp)
                    .height(144.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "Foto",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            Text(
                text = file.fileName,
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = formatUploadFileSize(file.bytes.size),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.78f)
            )
        }
    }
}

@Composable
private fun PlanningPhotoObjectiveSection(
    ramo: String,
    selectedObjective: String,
    selectedObjectiveId: String,
    onObjectiveSelected: (CreateArtObjective) -> Unit,
    onManualObjectiveChange: (String) -> Unit
) {
    val objectives = remember(ramo) { CreateArtCatalog.objectivesForRamo(ramo) }
    val manualObjective = selectedObjective.takeIf { selectedObjectiveId.isBlank() }.orEmpty()

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "Objetivo para esta foto",
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Bold
        )

        if (objectives.isEmpty()) {
            Text(
                text = "Nenhum objetivo sugerido para este ramo.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        } else {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 260.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                objectives.forEach { objective ->
                    PlanningObjectiveOption(
                        label = objective.label,
                        selected = selectedObjectiveId == objective.id || selectedObjective == objective.label,
                        onClick = { onObjectiveSelected(objective) }
                    )
                }
            }
        }

        OutlinedTextField(
            modifier = Modifier.fillMaxWidth(),
            value = manualObjective,
            onValueChange = onManualObjectiveChange,
            label = { Text("Ou escreva um objetivo") },
            singleLine = false,
            minLines = 2,
            maxLines = 3
        )
    }
}

@Composable
private fun PlanningObjectiveOption(
    label: String,
    selected: Boolean,
    onClick: () -> Unit
) {
    val container = if (selected) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.surface
    }
    val content = if (selected) {
        MaterialTheme.colorScheme.onPrimary
    } else {
        MaterialTheme.colorScheme.onSurface
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = container),
        border = BorderStroke(
            1.dp,
            if (selected) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.outline.copy(alpha = 0.28f)
            }
        )
    ) {
        Text(
            text = label,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 11.dp),
            color = content,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal
        )
    }
}

@Composable
private fun PlanningPhotoTextField(
    value: String,
    onValueChange: (String) -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(
            modifier = Modifier.fillMaxWidth(),
            value = value,
            onValueChange = onValueChange,
            label = { Text("Qual escrita você quer que apareça na imagem?") },
            placeholder = {
                Text("Ex.: X-salada R$ 19,90, combo família, box para banheiro, atendimento odontológico")
            },
            minLines = 3,
            maxLines = 5
        )
        Text(
            text = "${value.length}/$PHOTO_TEXT_MAX_LENGTH",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.align(Alignment.End)
        )
    }
}

@Composable
private fun PlanningPhotoLevelSelector(
    level: Int,
    showInfo: Boolean,
    onDecrease: () -> Unit,
    onIncrease: () -> Unit,
    onToggleInfo: () -> Unit
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "Nível de edição",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Bold
            )
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .border(
                        width = 1.dp,
                        color = MaterialTheme.colorScheme.primary,
                        shape = RoundedCornerShape(999.dp)
                    )
                    .clickable(onClick = onToggleInfo),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "?",
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.ExtraBold,
                    color = MaterialTheme.colorScheme.primary
                )
            }
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(22.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            LevelArrowBox(
                icon = Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                enabled = level > 1,
                onClick = onDecrease
            )
            Text(
                text = level.toString(),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.ExtraBold
            )
            LevelArrowBox(
                icon = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                enabled = level < 3,
                onClick = onIncrease
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            repeat(3) { dotIndex ->
                val selected = dotIndex + 1 == level
                Box(
                    modifier = Modifier
                        .size(if (selected) 8.dp else 7.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(
                            if (selected) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)
                            }
                        )
                )
            }
        }

        if (showInfo) {
            Text(
                text = editLevelDescription(level),
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.35f))
                    .padding(12.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface
            )
        }
    }
}

@Composable
private fun LevelArrowBox(
    icon: ImageVector,
    enabled: Boolean,
    onClick: () -> Unit
) {
    Box(
        modifier = Modifier
            .size(width = 52.dp, height = 44.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(
                if (enabled) {
                    MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.55f)
                } else {
                    MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)
                }
            )
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (enabled) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f)
            }
        )
    }
}

@Composable
private fun CameraSourceGlyph(
    color: androidx.compose.ui.graphics.Color,
    background: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier
) {
    Canvas(modifier = modifier) {
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.04f, size.height * 0.22f),
            size = Size(size.width * 0.92f, size.height * 0.66f),
            cornerRadius = CornerRadius(size.width * 0.14f, size.width * 0.14f)
        )
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.26f, size.height * 0.08f),
            size = Size(size.width * 0.34f, size.height * 0.18f),
            cornerRadius = CornerRadius(size.width * 0.06f, size.width * 0.06f)
        )
        drawCircle(
            color = background,
            radius = size.minDimension * 0.24f,
            center = Offset(size.width * 0.50f, size.height * 0.56f)
        )
        drawCircle(
            color = color.copy(alpha = 0.95f),
            radius = size.minDimension * 0.12f,
            center = Offset(size.width * 0.50f, size.height * 0.56f)
        )
    }
}

@Composable
private fun PlanningCalendarGlyph(
    color: androidx.compose.ui.graphics.Color,
    background: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier
) {
    Canvas(modifier = modifier) {
        val stroke = size.minDimension * 0.08f
        val radius = size.minDimension * 0.14f
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.08f, size.height * 0.16f),
            size = Size(size.width * 0.84f, size.height * 0.76f),
            cornerRadius = CornerRadius(radius, radius),
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke)
        )
        drawRoundRect(
            color = color.copy(alpha = 0.18f),
            topLeft = Offset(size.width * 0.08f, size.height * 0.16f),
            size = Size(size.width * 0.84f, size.height * 0.22f),
            cornerRadius = CornerRadius(radius, radius)
        )
        drawRoundRect(
            color = background,
            topLeft = Offset(size.width * 0.15f, size.height * 0.38f),
            size = Size(size.width * 0.70f, size.height * 0.44f),
            cornerRadius = CornerRadius(size.minDimension * 0.06f, size.minDimension * 0.06f)
        )
        repeat(2) { index ->
            val x = size.width * (0.33f + index * 0.24f)
            drawRoundRect(
                color = color,
                topLeft = Offset(x, size.height * 0.08f),
                size = Size(size.width * 0.08f, size.height * 0.20f),
                cornerRadius = CornerRadius(stroke, stroke)
            )
        }
        repeat(2) { row ->
            repeat(3) { column ->
                drawCircle(
                    color = color.copy(alpha = 0.84f),
                    radius = size.minDimension * 0.035f,
                    center = Offset(
                        size.width * (0.28f + column * 0.22f),
                        size.height * (0.52f + row * 0.18f)
                    )
                )
            }
        }
    }
}

@Composable
private fun AddPhotoCard(
    loadingPhotos: Boolean,
    hasPhotos: Boolean,
    onClick: () -> Unit
) {
    val title = if (hasPhotos) {
        "Criar + imagens no mesmo pedido"
    } else {
        "Adicionar foto"
    }
    val subtitle = if (hasPhotos) {
        "Você pode adicionar várias fotos e criar várias artes no mesmo pedido."
    } else {
        "Comece sua nova arte"
    }
    val containerColor = if (hasPhotos) {
        MaterialTheme.colorScheme.surface
    } else {
        MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.22f)
    }
    val borderColor = if (hasPhotos) {
        MaterialTheme.colorScheme.outline.copy(alpha = 0.24f)
    } else {
        MaterialTheme.colorScheme.primary.copy(alpha = 0.48f)
    }
    val iconSize = if (hasPhotos) 36.dp else 44.dp

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !loadingPhotos, onClick = onClick),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = containerColor),
        elevation = CardDefaults.cardElevation(defaultElevation = if (hasPhotos) 0.dp else 1.dp),
        border = BorderStroke(1.dp, borderColor)
    ) {
        Row(
            modifier = Modifier.padding(18.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp)
            ) {
                Text(
                    text = if (loadingPhotos) "Carregando fotos..." else title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.ExtraBold,
                    color = MaterialTheme.colorScheme.primary
                )
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Icon(
                imageVector = Icons.Filled.AddCircle,
                contentDescription = null,
                modifier = Modifier.size(iconSize),
                tint = MaterialTheme.colorScheme.primary
            )
        }
    }
}

@Composable
private fun MonthlyPlanningFooter(
    secondaryText: String,
    primaryText: String,
    onSecondaryClick: () -> Unit,
    onPrimaryClick: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        OutlinedButton(
            modifier = Modifier
                .weight(1f)
                .height(54.dp),
            shape = RoundedCornerShape(12.dp),
            onClick = onSecondaryClick
        ) {
            Text(secondaryText)
        }
        Button(
            modifier = Modifier
                .weight(1f)
                .height(54.dp),
            shape = RoundedCornerShape(12.dp),
            onClick = onPrimaryClick
        ) {
            Text(primaryText)
        }
    }
}
@Composable
private fun MonthlyPlanningConfirmationStep(
    state: MonthlyPlanningUiState,
    onBack: () -> Unit,
    onCompanyNameChange: (String) -> Unit,
    onCompanyRamoChange: (String) -> Unit,
    onCompanyRamoSelected: (String) -> Unit,
    onContinueRamoTyping: () -> Unit,
    onCompanyWhatsappChange: (String) -> Unit,
    onCompanyInstagramChange: (String) -> Unit,
    onCompanyCharacteristicToggle: (String) -> Unit,
    onToggleOtherInfo: () -> Unit,
    onCompanyImportantInfoChange: (String) -> Unit,
    onSelectLogo: () -> Unit,
    onRemoveLogo: () -> Unit,
    onConfirm: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(18.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.18f))
        ) {
            Column(
                modifier = Modifier.padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(
                    text = "Revisar pedido",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.ExtraBold
                )
                Text(
                    text = "Confira a empresa, a logo e as fotos antes de enviar.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        MonthlyPlanningCompanyReviewCard(
            profile = state.companyProfile,
            onNameChange = onCompanyNameChange,
            onRamoChange = onCompanyRamoChange,
            onRamoSelected = onCompanyRamoSelected,
            onContinueRamoTyping = onContinueRamoTyping,
            onWhatsappChange = onCompanyWhatsappChange,
            onInstagramChange = onCompanyInstagramChange,
            onSelectLogo = onSelectLogo,
            onRemoveLogo = onRemoveLogo
        )
        MonthlyPlanningCompanyCharacteristicsCard(
            profile = state.companyProfile,
            onCharacteristicToggle = onCompanyCharacteristicToggle,
            onToggleOtherInfo = onToggleOtherInfo,
            onValueChange = onCompanyImportantInfoChange
        )
        MonthlyPlanningPhotosReviewCard(photos = state.photos)

        MonthlyPlanningFooter(
            secondaryText = "Voltar",
            primaryText = "Enviar",
            onSecondaryClick = onBack,
            onPrimaryClick = onConfirm
        )
    }
}

@Composable
private fun MonthlyPlanningCompanyCharacteristicsCard(
    profile: MonthlyPlanningCompanyProfile,
    onCharacteristicToggle: (String) -> Unit,
    onToggleOtherInfo: () -> Unit,
    onValueChange: (String) -> Unit
) {
    val characteristics = remember(profile.ramo) {
        CreateArtCatalog.characteristicsForRamo(profile.ramo)
    }
    val showOtherInfo = profile.showOtherInfo || profile.informacoesEmpresa.isNotBlank()

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.24f))
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = "Características da empresa",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.ExtraBold
            )
            Text(
                text = "Marque apenas o que a empresa realmente oferece. O que não for marcado não será inventado pela IA.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            if (characteristics.isEmpty()) {
                Text(
                    text = "Nenhuma característica sugerida para este ramo.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                CompanyCharacteristicsGrid(
                    characteristics = characteristics,
                    selected = profile.caracteristicasEmpresa,
                    onToggle = onCharacteristicToggle
                )
            }

            TextButton(onClick = onToggleOtherInfo) {
                Text(if (showOtherInfo) "Ocultar outras informações" else "Outras informações")
            }

            if (showOtherInfo) {
                OutlinedTextField(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 132.dp),
                    value = profile.informacoesEmpresa,
                    onValueChange = onValueChange,
                    label = { Text("Outras informações") },
                    placeholder = {
                        Text(
                            "Ex.:\n" +
                                "Não abrimos aos domingos.\n" +
                                "Atendemos somente no local.\n" +
                                "Não aceitamos cartão."
                        )
                    },
                    minLines = 4,
                    maxLines = 8
                )
            }
        }
    }
}

@Composable
private fun CompanyCharacteristicsGrid(
    characteristics: List<CompanyCharacteristic>,
    selected: List<String>,
    onToggle: (String) -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        characteristics.chunked(2).forEach { rowItems ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                rowItems.forEach { item ->
                    CompanyCharacteristicOption(
                        characteristic = item,
                        checked = selected.contains(item.label),
                        onToggle = { onToggle(item.label) },
                        modifier = Modifier.weight(1f)
                    )
                }
                if (rowItems.size == 1) {
                    Spacer(modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun CompanyCharacteristicOption(
    characteristic: CompanyCharacteristic,
    checked: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .border(
                width = 1.dp,
                color = if (checked) {
                    MaterialTheme.colorScheme.primary.copy(alpha = 0.55f)
                } else {
                    MaterialTheme.colorScheme.outline.copy(alpha = 0.24f)
                },
                shape = RoundedCornerShape(12.dp)
            )
            .clickable(onClick = onToggle)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Checkbox(
            checked = checked,
            onCheckedChange = { onToggle() }
        )
        Text(
            text = characteristic.label,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = if (checked) FontWeight.SemiBold else FontWeight.Normal,
            modifier = Modifier.weight(1f)
        )
    }
}

@Composable
private fun MonthlyPlanningCompanyInfoCard(
    value: String,
    onValueChange: (String) -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.24f))
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = "Informações importantes sobre sua empresa",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.ExtraBold
            )
            Text(
                text = "Opcional. Use para informar regras reais que a IA não deve contradizer.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedTextField(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 168.dp),
                value = value,
                onValueChange = onValueChange,
                placeholder = {
                    Text(
                        "Ex.:\n\n" +
                            "• Não temos delivery.\n" +
                            "• Temos delivery.\n" +
                            "• Atendemos somente no local.\n" +
                            "• Temos estacionamento gratuito.\n" +
                            "• Aceitamos Pix.\n" +
                            "• Parcelamos em até 10x.\n" +
                            "• Não abrimos aos domingos.\n" +
                            "• Atendimento 24 horas."
                    )
                },
                minLines = 7,
                maxLines = 10
            )
        }
    }
}

@Composable
private fun MonthlyPlanningCompanyReviewCard(
    profile: MonthlyPlanningCompanyProfile,
    onNameChange: (String) -> Unit,
    onRamoChange: (String) -> Unit,
    onRamoSelected: (String) -> Unit,
    onContinueRamoTyping: () -> Unit,
    onWhatsappChange: (String) -> Unit,
    onInstagramChange: (String) -> Unit,
    onSelectLogo: () -> Unit,
    onRemoveLogo: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.24f))
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                text = "Empresa",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.ExtraBold
            )
            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = profile.nomeEmpresa,
                onValueChange = onNameChange,
                label = { Text("Nome da empresa") },
                singleLine = true
            )
            CompanyProfileRamoSearchField(
                value = profile.ramo,
                onValueChange = onRamoChange,
                onRamoSelected = onRamoSelected,
                onContinueTyping = onContinueRamoTyping,
                freeTyping = profile.ramoDigitacaoLivre
            )
            OutlinedTextField(
                modifier = Modifier
                    .fillMaxWidth(),
                value = profile.whatsapp,
                onValueChange = onWhatsappChange,
                label = { Text("WhatsApp") },
                singleLine = true
            )
            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = profile.instagram,
                onValueChange = onInstagramChange,
                label = { Text("Instagram") },
                singleLine = true
            )
            DefaultLogoUploadCard(
                logoUri = profile.logoUri,
                onSelectLogo = onSelectLogo,
                onRemoveLogo = onRemoveLogo
            )
        }
    }
}

@Composable
private fun MonthlyPlanningPhotosReviewCard(photos: List<MonthlyPlanningPhotoDraft>) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.24f))
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                text = "Fotos",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.ExtraBold
            )
            Text(
                text = "${photos.size} ${if (photos.size == 1) "foto selecionada" else "fotos selecionadas"}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (photos.isEmpty()) {
                Text(
                    text = "Nenhuma foto selecionada.",
                    style = MaterialTheme.typography.bodyMedium
                )
            } else {
                photos.forEachIndexed { index, photo ->
                    ReviewPhotoLine(index = index + 1, photo = photo)
                }
            }
        }
    }
}

@Composable
private fun ReviewPhotoLine(
    index: Int,
    photo: MonthlyPlanningPhotoDraft
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "Foto $index",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = photo.file.fileName,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(start = 14.dp)
            )
        }
        PhotoReviewDetail(label = "Objetivo", value = photo.objetivo.ifBlank { "-" })
        PhotoReviewDetail(label = "Escrita", value = photo.escritaImagem.ifBlank { "-" })
        PhotoReviewDetail(label = "Nível", value = photo.nivelEdicao.toString())
    }
}

@Composable
private fun PhotoReviewDetail(label: String, value: String) {
    Text(
        text = "$label: $value",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis
    )
}

private fun MonthlyPlanningSummary.isCreatingImages(): Boolean {
    if (totalPosts <= 0 || readyPosts >= totalPosts) return false
    val normalizedStatus = status.lowercase(Locale.ROOT)
    return !normalizedStatus.contains("erro") && !normalizedStatus.contains("cancel")
}

private fun formatPlanningCreatedAt(createdAt: String): String? {
    val date = parsePlanningCreatedAt(createdAt) ?: return null
    val timeZone = TimeZone.getTimeZone("America/Sao_Paulo")
    val locale = Locale("pt", "BR")
    val dateText = SimpleDateFormat("dd/MM/yyyy", locale).apply {
        this.timeZone = timeZone
    }.format(date)
    val timeText = SimpleDateFormat("HH:mm", locale).apply {
        this.timeZone = timeZone
    }.format(date)
    return "$dateText às $timeText"
}

private fun parsePlanningCreatedAt(createdAt: String): Date? {
    val value = createdAt.trim()
    if (value.isBlank()) return null
    val patterns = listOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        "yyyy-MM-dd'T'HH:mm:ssXXX"
    )
    return patterns.firstNotNullOfOrNull { pattern ->
        runCatching {
            SimpleDateFormat(pattern, Locale.US).apply {
                isLenient = false
                if (pattern.endsWith("'Z'")) {
                    timeZone = TimeZone.getTimeZone("UTC")
                }
            }.parse(value)
        }.getOrNull()
    }
}

@Composable
private fun MonthlyPlanningProcessingStep(onShowPlans: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        EstimatedCreationProgressCard(
            progressKey = "monthly-planning-submit",
            running = true,
            title = "Estamos criando suas imagens",
            subtitle = "Seu planejamento foi enviado para produção.",
            explanation = "As imagens aparecerão em Minhas imagens conforme ficarem prontas."
        )
        Button(
            modifier = Modifier.fillMaxWidth(),
            onClick = onShowPlans
        ) {
            Text("Ver Minhas imagens")
        }
    }
}

@Composable
private fun MonthlyPlanningListStep(
    plannings: List<MonthlyPlanningSummary>,
    loading: Boolean,
    onOpenDetail: (String) -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(
            text = "Minhas imagens",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.ExtraBold
        )
        if (loading) {
            CircularProgressIndicator()
            return@Column
        }

        if (plannings.isEmpty()) {
            Text(
                text = "Nenhum planejamento criado ainda.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            return@Column
        }

        plannings.firstOrNull { it.isCreatingImages() }?.let { planning ->
            EstimatedCreationProgressCard(
                progressKey = "monthly-planning-${planning.id}",
                running = true,
                title = "Estamos criando suas imagens",
                subtitle = "Seu planejamento foi enviado para produção.",
                explanation = "As imagens aparecerão em Minhas imagens conforme ficarem prontas."
            )
        }

        plannings.forEach { planning ->
            MonthlyPlanningSummaryCard(
                planning = planning,
                onOpenDetail = onOpenDetail
            )
        }
    }
}

@Composable
private fun MonthlyPlanningSummaryCard(
    planning: MonthlyPlanningSummary,
    onOpenDetail: (String) -> Unit
) {
    val displayTitle = formatPlanningCreatedAt(planning.createdAt) ?: planning.title
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = displayTitle,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            if (planning.status.isNotBlank()) {
                Text("Status: ${planning.status}")
            }
            Text("${planning.totalPosts} postagens")
            Text("Já produzidas: ${planning.readyPosts}")
            Text("${planning.productionPosts} em produção")
            Text("${planning.plannedPosts} planejadas")
            Button(
                modifier = Modifier.fillMaxWidth(),
                onClick = { onOpenDetail(planning.id) }
            ) {
                Text("Abrir detalhes")
            }
        }
    }
}

private suspend fun readPlanningPhotos(
    uris: List<Uri>,
    fileReader: AndroidFileReader,
    onError: (String) -> Unit
): List<UploadFile> {
    val files = mutableListOf<UploadFile>()
    for (uri in uris) {
        when (val result = fileReader.readUploadFile(uri)) {
            is ApiResult.Success -> files.add(result.value)
            is ApiResult.Failure -> onError(result.message)
        }
    }
    return files
}

private fun formatUploadFileSize(bytes: Int): String {
    if (bytes < 1024) return "$bytes B"
    val kilobytes = bytes / 1024
    if (kilobytes < 1024) return "$kilobytes KB"
    val megabytes = kilobytes / 1024.0
    return "%.1f MB".format(megabytes)
}

private fun editLevelDescription(level: Int): String {
    return when (level) {
        1 -> "Nível 1: só adiciona pequenos detalhes na foto enviada."
        2 -> "Nível 2: melhora a foto e adiciona elementos moderados."
        else -> "Nível 3: a IA pode adicionar informações e elementos que achar importantes para vender melhor."
    }
}
