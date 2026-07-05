package br.com.ia4tube.app.feature.create_art

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.RoundedCornerShape
import br.com.ia4tube.app.R
import br.com.ia4tube.app.core.analytics.MobileAnalytics
import br.com.ia4tube.app.core.upload.AndroidFileReader
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.UploadFile
import br.com.ia4tube.app.ui.components.ScreenScaffold
import br.com.ia4tube.app.ui.text.asString
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun CreateArtEmpresaScreen(
    viewModel: CreateArtEmpresaViewModel,
    initialPhotoUri: String = "",
    onBack: () -> Unit,
    onOpenPlans: () -> Unit,
    onCreated: (String) -> Unit
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current.applicationContext
    val fileReader = remember { AndroidFileReader(context) }
    val scope = rememberCoroutineScope()
    val optionalImageLimitError: (String) -> String = { label ->
        context.getString(
            R.string.create_art_optional_limit_error,
            CreateArtEmpresaViewModel.MAX_IMAGENS_OPCIONAIS,
            label
        )
    }
    val optionalImageIgnoredError = context.getString(
        R.string.create_art_optional_ignored_error,
        CreateArtEmpresaViewModel.MAX_IMAGENS_OPCIONAIS
    )
    val logoPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            when (val result = fileReader.readUploadFile(uri)) {
                is ApiResult.Success -> viewModel.setLogo(result.value)
                is ApiResult.Failure -> viewModel.setLogoError(result.message)
            }
        }
    }
    val fotosPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            handleOptionalImages(
                uris = uris,
                currentCount = state.fotos.size,
                fileReader = fileReader,
                onError = viewModel::setLogoError,
                onSuccess = viewModel::addFotos,
                limitLabel = "fotos",
                limitErrorTemplate = optionalImageLimitError,
                ignoredError = optionalImageIgnoredError
            )
        }
    }
    val referenciasPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            handleOptionalImages(
                uris = uris,
                currentCount = state.referencias.size,
                fileReader = fileReader,
                onError = viewModel::setLogoError,
                onSuccess = viewModel::addReferencias,
                limitLabel = "referências visuais",
                limitErrorTemplate = optionalImageLimitError,
                ignoredError = optionalImageIgnoredError
            )
        }
    }
    val modeloExistentePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            when (val result = fileReader.readUploadFile(uri)) {
                is ApiResult.Success -> viewModel.setModeloExistente(result.value)
                is ApiResult.Failure -> viewModel.setLogoError(result.message)
            }
        }
    }
    var footballFileTarget by remember { mutableStateOf("") }
    val footballFilePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val target = footballFileTarget
        scope.launch {
            when (val result = fileReader.readUploadFile(uri)) {
                is ApiResult.Success -> when (target) {
                    "teamCrest" -> viewModel.setFootballTeamCrest(result.value)
                    "opponentCrest" -> viewModel.setFootballOpponentCrest(result.value)
                    "auxImage" -> viewModel.setFootballAuxImage(result.value)
                }
                is ApiResult.Failure -> viewModel.setFootballUploadError(result.message)
            }
        }
    }
    val footballSponsorsPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            val files = mutableListOf<UploadFile>()
            uris.forEach { uri ->
                when (val result = fileReader.readUploadFile(uri)) {
                    is ApiResult.Success -> files.add(result.value)
                    is ApiResult.Failure -> viewModel.setFootballUploadError(result.message)
                }
            }
            if (files.isNotEmpty()) viewModel.addFootballSponsorLogos(files)
        }
    }

    LaunchedEffect(state.createdPedidoId) {
        if (state.createdPedidoId.isNotBlank()) {
            onCreated(state.createdPedidoId)
        }
    }

    LaunchedEffect(state.currentStep) {
        MobileAnalytics.track(
            eventName = when (state.currentStep) {
                0 -> "mobile_etapa_empresa"
                1 -> "mobile_etapa_objetivo"
                2 -> "mobile_etapa_visual"
                else -> "mobile_etapa_revisao"
            },
            tela = "criar_arte",
            produto = "arte_empresa",
            etapa = when (state.currentStep) {
                0 -> "empresa"
                1 -> "objetivo"
                2 -> "visual"
                else -> "revisao"
            }
        )
    }

    LaunchedEffect(state.profileLogoUri, state.profileLogoLoaded) {
        if (state.profileLogoUri.isNotBlank() && !state.profileLogoLoaded && state.logo == null) {
            when (val result = fileReader.readUploadFile(Uri.parse(state.profileLogoUri))) {
                is ApiResult.Success -> {
                    viewModel.setLogo(result.value)
                    viewModel.markProfileLogoLoaded()
                }
                is ApiResult.Failure -> {
                    viewModel.markProfileLogoLoaded()
                }
            }
        }
    }

    LaunchedEffect(initialPhotoUri) {
        if (initialPhotoUri.isNotBlank() && !state.fromCameraPhoto) {
            when (val result = fileReader.readUploadFile(Uri.parse(initialPhotoUri))) {
                is ApiResult.Success -> viewModel.applyCameraPhoto(result.value)
                is ApiResult.Failure -> viewModel.setLogoError(result.message)
            }
        }
    }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
        ) {
            CreateArtHeader(onBack = onBack)
            Spacer(modifier = Modifier.height(14.dp))
            StepIndicator(currentStep = state.currentStep)
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = stringResource(R.string.create_art_ready_under_two_minutes),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold
            )

            if (state.reviewing) {
                Spacer(modifier = Modifier.height(16.dp))
                ReviewStep(
                    state = state,
                    onBackToEdit = {
                        viewModel.backToEdit()
                    },
                    onOpenPlans = onOpenPlans,
                    onConfirm = viewModel::submit
                )
                return@Column
            }

            Spacer(modifier = Modifier.height(16.dp))
            ProgressiveCreateArtForm(
                state = state,
                viewModel = viewModel,
                onSelectLogo = { logoPicker.launch("image/*") },
                onSelectFotos = { fotosPicker.launch("image/*") },
                onSelectReferencias = { referenciasPicker.launch("image/*") },
                onSelectModeloExistente = { modeloExistentePicker.launch("image/*") },
                onSelectFootballFile = { target ->
                    footballFileTarget = target
                    footballFilePicker.launch("image/*")
                },
                onSelectFootballSponsors = { footballSponsorsPicker.launch("image/*") },
                onRemoveFoto = viewModel::removeFoto,
                onRemoveReferencia = viewModel::removeReferencia,
                onRemoveModeloExistente = viewModel::removeModeloExistente,
                onRemoveFootballSponsor = viewModel::removeFootballSponsorLogo
            )

            state.error?.let { error ->
                Spacer(modifier = Modifier.height(12.dp))
                Text(error.asString(), color = MaterialTheme.colorScheme.error)
                BillingRequiredActions(
                    visible = state.billingRequired,
                    onOpenPlans = onOpenPlans
                )
            }

            Spacer(modifier = Modifier.height(18.dp))
            StepNavigation(
                currentStep = state.currentStep,
                loading = state.loading,
                onPrevious = viewModel::previousStep,
                onNext = viewModel::nextStep,
                onReview = viewModel::review
            )
            Spacer(modifier = Modifier.height(24.dp))
        }
    }
}

@Composable
private fun CreateArtHeader(onBack: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Top
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.create_art_new_title),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = stringResource(R.string.create_art_new_subtitle),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        IconButton(onClick = onBack) {
            Icon(
                imageVector = Icons.Default.Close,
                contentDescription = "Fechar"
            )
        }
    }
}

@Composable
private fun StepIndicator(currentStep: Int) {
    val labels = listOf(
        stringResource(R.string.create_art_step_company),
        stringResource(R.string.create_art_step_goal),
        stringResource(R.string.create_art_step_visual),
        stringResource(R.string.create_art_step_review)
    )

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        labels.forEachIndexed { index, label ->
            val selected = index == currentStep
            Column(modifier = Modifier.weight(1f)) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(5.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(
                            if (selected) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.outlineVariant
                            }
                        )
                )
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                    color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

@Composable
private fun BillingRequiredActions(
    visible: Boolean,
    onOpenPlans: () -> Unit
) {
    if (!visible) return

    Spacer(modifier = Modifier.height(12.dp))
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Button(
            modifier = Modifier.fillMaxWidth(),
            onClick = onOpenPlans
        ) {
            Text("Comprar 1 arte por R$ 1,99")
        }
        OutlinedButton(
            modifier = Modifier.fillMaxWidth(),
            onClick = onOpenPlans
        ) {
            Text("Ver planos")
        }
    }
}

@Composable
private fun SectionCard(
    title: String,
    content: @Composable ColumnScope.() -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(22.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.2.dp, MaterialTheme.colorScheme.outline),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface
            )
            Spacer(modifier = Modifier.height(14.dp))
            content()
        }
    }
}

@Composable
private fun SiteStepCard(
    number: Int,
    title: String,
    content: @Composable ColumnScope.() -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.4.dp, MaterialTheme.colorScheme.outline),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.Top
        ) {
            Box(
                modifier = Modifier
                    .width(34.dp)
                    .height(34.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(MaterialTheme.colorScheme.primary),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = number.toString(),
                    color = MaterialTheme.colorScheme.onPrimary,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Spacer(modifier = Modifier.height(10.dp))
                content()
            }
        }
    }
}

@Composable
private fun ProgressiveCreateArtForm(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel,
    onSelectLogo: () -> Unit,
    onSelectFotos: () -> Unit,
    onSelectReferencias: () -> Unit,
    onSelectModeloExistente: () -> Unit,
    onSelectFootballFile: (String) -> Unit,
    onSelectFootballSponsors: () -> Unit,
    onRemoveFoto: (Int) -> Unit,
    onRemoveReferencia: (Int) -> Unit,
    onRemoveModeloExistente: () -> Unit,
    onRemoveFootballSponsor: (Int) -> Unit
) {
    when (state.currentStep) {
        0 -> {
            RamoStep(state = state, viewModel = viewModel)
            Spacer(modifier = Modifier.height(10.dp))
            CompanyNameStep(state = state, viewModel = viewModel)
            Spacer(modifier = Modifier.height(10.dp))
            CompanyContactStep(state = state, viewModel = viewModel)
            if (state.fromCameraPhoto) {
                Spacer(modifier = Modifier.height(10.dp))
                PhotoPhraseStep(state = state, viewModel = viewModel)
            }
        }
        1 -> {
            GoalStep(state = state, viewModel = viewModel)
            Spacer(modifier = Modifier.height(12.dp))
            OptionalFieldsSection(state = state, viewModel = viewModel)
        }
        else -> {
            val footballProductKey = selectedFootballProductKey(state)
            if (footballProductKey.isNotBlank()) {
                FootballProductSection(
                    state = state,
                    productKey = footballProductKey,
                    onSelectFile = onSelectFootballFile,
                    onSelectSponsors = onSelectFootballSponsors,
                    onRemoveSponsor = onRemoveFootballSponsor,
                    viewModel = viewModel
                )
                return
            }
            VisualStyleSection(
                selected = state.estiloVisualCliente,
                onSelected = viewModel::updateEstiloVisual
            )
            if (state.fromCameraPhoto) {
                Spacer(modifier = Modifier.height(12.dp))
                CameraPhotoSummary(state = state)
                Spacer(modifier = Modifier.height(12.dp))
                ExistingModelSection(
                    state = state,
                    loading = state.loading,
                    onSelectModeloExistente = onSelectModeloExistente,
                    onRemoveModeloExistente = onRemoveModeloExistente
                )
                return
            }
            Spacer(modifier = Modifier.height(12.dp))
            LogoSection(
                state = state,
                loading = state.loading,
                onSelectLogo = onSelectLogo
            )
            Spacer(modifier = Modifier.height(12.dp))
            MediaSection(
                state = state,
                loading = state.loading,
                onSelectFotos = onSelectFotos,
                onSelectReferencias = onSelectReferencias,
                onSelectModeloExistente = onSelectModeloExistente,
                onRemoveFoto = onRemoveFoto,
                onRemoveReferencia = onRemoveReferencia,
                onRemoveModeloExistente = onRemoveModeloExistente
            )
        }
    }

}

@Composable
private fun PhotoPhraseStep(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel
) {
    SiteStepCard(number = 3, title = stringResource(R.string.create_art_photo_phrase_title)) {
        FormField(
            label = stringResource(R.string.create_art_photo_phrase_label),
            value = state.fotoFrase,
            onValueChange = viewModel::updateFotoFrase,
            placeholder = stringResource(R.string.create_art_photo_phrase_hint),
            minLines = 2
        )
    }
}

@Composable
private fun CameraPhotoSummary(state: CreateArtEmpresaUiState) {
    SectionCard(title = stringResource(R.string.create_art_camera_photo_title)) {
        OptionalImagesSection(
            description = stringResource(R.string.create_art_camera_photo_description),
            images = state.fotos.take(1),
            loading = state.loading,
            emptyText = stringResource(R.string.create_art_business_photos_empty),
            buttonText = stringResource(R.string.create_art_camera_photo_loaded),
            onSelect = {},
            onRemove = {}
        )
    }
}

@Composable
private fun RamoStep(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel
) {
    SiteStepCard(number = 1, title = stringResource(R.string.create_art_field_business)) {
        RamoSearchField(
            value = state.ramo,
            onValueChange = viewModel::updateRamo,
            onRamoSelected = viewModel::selectRamo,
            onContinueTyping = viewModel::continueRamoTyping,
            freeTyping = state.ramoDigitacaoLivre,
            showError = state.submitted && state.ramo.isBlank()
        )
    }
}

@Composable
private fun CompanyNameStep(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel
) {
    SiteStepCard(number = 2, title = stringResource(R.string.create_art_field_company_name)) {
        FormField(
            label = stringResource(R.string.create_art_field_company_name),
            value = state.nomeEmpresa,
            onValueChange = viewModel::updateNomeEmpresa,
            required = true,
            showError = state.submitted && state.nomeEmpresa.isBlank()
        )
    }
}

@Composable
private fun CompanyContactStep(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel
) {
    SiteStepCard(number = 3, title = "Contato da empresa") {
        Text(
            text = "Os contatos aparecem na imagem. Caso não queira, deixe em branco.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.height(10.dp))
        FormField(stringResource(R.string.create_art_field_whatsapp), state.whatsapp, viewModel::updateWhatsapp)
        FormField(stringResource(R.string.create_art_field_instagram), state.instagram, viewModel::updateInstagram)
    }
}

@Composable
private fun GoalStep(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel
) {
    SiteStepCard(number = 3, title = stringResource(R.string.create_art_field_goal)) {
        ObjectivePicker(
            ramo = state.ramo,
            selectedObjective = state.objetivo,
            selectedObjectiveId = state.objetivoId,
            onObjectiveSelected = viewModel::selectObjective,
            onManualObjectiveChange = viewModel::updateObjetivo,
            showError = state.submitted && state.objetivo.isBlank()
        )
        DynamicObjectiveFields(state = state, viewModel = viewModel)
    }
}

@Composable
private fun LogoSection(
    state: CreateArtEmpresaUiState,
    loading: Boolean,
    onSelectLogo: () -> Unit
) {
    SectionCard(title = stringResource(R.string.create_art_logo_label)) {
        LogoPreview(logo = state.logo)
        OutlinedButton(
            modifier = Modifier.fillMaxWidth(),
            enabled = !loading,
            onClick = onSelectLogo
        ) {
            Text(state.logo?.let { stringResource(R.string.create_art_logo_selected, it.fileName) } ?: stringResource(R.string.create_art_select_logo))
        }
        LogoOptimizationMessage(logo = state.logo)
        if (state.submitted && state.logo == null) {
            Spacer(modifier = Modifier.height(6.dp))
            Text(stringResource(R.string.create_art_logo_required), color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun FootballProductSection(
    state: CreateArtEmpresaUiState,
    productKey: String,
    onSelectFile: (String) -> Unit,
    onSelectSponsors: () -> Unit,
    onRemoveSponsor: (Int) -> Unit,
    viewModel: CreateArtEmpresaViewModel
) {
    SiteStepCard(number = 4, title = state.objetivo.ifBlank { "Produto Futebol" }) {
        when (productKey) {
            "mascote_uniforme" -> MascoteUniformeForm(state, viewModel, onSelectFile)
            "escudo3d" -> Escudo3dForm(state, onSelectFile)
            "resultado" -> ResultadoForm(state, viewModel, onSelectFile)
            "proximo_jogo" -> ProximoJogoForm(state, viewModel, onSelectFile)
            "treino" -> TreinoForm(state, viewModel, onSelectFile)
            "escalacao" -> EscalacaoForm(state, viewModel, onSelectFile)
            "contratacao" -> ContratacaoForm(state, viewModel, onSelectFile)
            "patrocinador" -> PatrocinadorForm(state, viewModel, onSelectFile, onSelectSponsors, onRemoveSponsor)
        }
    }
}

@Composable
private fun MascoteUniformeForm(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel,
    onSelectFile: (String) -> Unit
) {
    FormField("Animal que vai virar mascote", state.footballMascotAnimal, viewModel::updateFootballMascotAnimal, required = true)
    FootballUploadButton("Escudo ou brasão do time *", state.footballTeamCrest, state.loading) { onSelectFile("teamCrest") }
    FootballUploadButton("Camiseta / uniforme do time *", state.footballAuxImage, state.loading) { onSelectFile("auxImage") }
}

@Composable
private fun Escudo3dForm(
    state: CreateArtEmpresaUiState,
    onSelectFile: (String) -> Unit
) {
    FootballUploadButton("Escudo do time *", state.footballTeamCrest, state.loading) { onSelectFile("teamCrest") }
}

@Composable
private fun ResultadoForm(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel,
    onSelectFile: (String) -> Unit
) {
    FormField("Time A", state.footballHomeTeam, viewModel::updateFootballHomeTeam, required = true)
    FormField("Gols Time A", state.footballHomeScore, viewModel::updateFootballHomeScore, required = true)
    FormField("Gols Time B", state.footballAwayScore, viewModel::updateFootballAwayScore, required = true)
    FormField("Time B", state.footballAwayTeam, viewModel::updateFootballAwayTeam, required = true)
    FormField("Campeonato / competição", state.footballCompetition, viewModel::updateFootballCompetition)
    FormField("Frase na imagem", state.footballHeadline, viewModel::updateFootballHeadline)
    FootballUploadButton("Escudo Time A *", state.footballTeamCrest, state.loading) { onSelectFile("teamCrest") }
    FootballUploadButton("Escudo Time B", state.footballOpponentCrest, state.loading) { onSelectFile("opponentCrest") }
    FootballUploadButton("Foto do jogo", state.footballAuxImage, state.loading) { onSelectFile("auxImage") }
}

@Composable
private fun ProximoJogoForm(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel,
    onSelectFile: (String) -> Unit
) {
    FormField("Time A", state.footballHomeTeam, viewModel::updateFootballHomeTeam, required = true)
    FormField("Time B", state.footballAwayTeam, viewModel::updateFootballAwayTeam, required = true)
    FormField("Data e horário", state.footballMatchDatetime, viewModel::updateFootballMatchDatetime, required = true)
    FormField("Campeonato / competição", state.footballCompetition, viewModel::updateFootballCompetition, required = true)
    FormField("Arena / local", state.footballVenue, viewModel::updateFootballVenue)
    FootballUploadButton("Escudo Time A *", state.footballTeamCrest, state.loading) { onSelectFile("teamCrest") }
    FootballUploadButton("Escudo Time B *", state.footballOpponentCrest, state.loading) { onSelectFile("opponentCrest") }
    FootballUploadButton("Foto do jogo", state.footballAuxImage, state.loading) { onSelectFile("auxImage") }
}

@Composable
private fun TreinoForm(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel,
    onSelectFile: (String) -> Unit
) {
    FormField("Chamada do treino", state.footballTitle, viewModel::updateFootballTitle, required = true)
    FormField("Frase na imagem", state.footballHeadline, viewModel::updateFootballHeadline)
    FormField("Contexto / competicao", state.footballCompetition, viewModel::updateFootballCompetition)
    FormField("Local do treino", state.footballVenue, viewModel::updateFootballVenue)
    FootballUploadButton("Escudo do time *", state.footballTeamCrest, state.loading) { onSelectFile("teamCrest") }
    FootballUploadButton("Foto do treino ou equipe", state.footballAuxImage, state.loading) { onSelectFile("auxImage") }
}

@Composable
private fun EscalacaoForm(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel,
    onSelectFile: (String) -> Unit
) {
    FormField("Confronto", state.footballTitle, viewModel::updateFootballTitle, required = true)
    FormField("Data e horário", state.footballMatchDatetime, viewModel::updateFootballMatchDatetime, required = true)
    FormField("Campeonato / competição", state.footballCompetition, viewModel::updateFootballCompetition, required = true)
    FormField("Arena / local", state.footballVenue, viewModel::updateFootballVenue)
    FormField(
        label = "Jogadores",
        value = state.footballPlayersText,
        onValueChange = viewModel::updateFootballPlayersText,
        required = true,
        minLines = 5,
        placeholder = "Um por linha. Ex.: João - Goleiro"
    )
    FootballUploadButton("Escudo do time *", state.footballTeamCrest, state.loading) { onSelectFile("teamCrest") }
    FootballUploadButton("Escudo adversário", state.footballOpponentCrest, state.loading) { onSelectFile("opponentCrest") }
    FootballUploadButton("Foto do time", state.footballAuxImage, state.loading) { onSelectFile("auxImage") }
}

@Composable
private fun ContratacaoForm(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel,
    onSelectFile: (String) -> Unit
) {
    FormField("Título da arte", state.footballTitle, viewModel::updateFootballTitle, required = true)
    FormField("Nome do jogador", state.footballPlayerName, viewModel::updateFootballPlayerName, required = true)
    FormField("Informações do jogador", state.footballPlayerInfo, viewModel::updateFootballPlayerInfo)
    FootballUploadButton("Escudo do time *", state.footballTeamCrest, state.loading) { onSelectFile("teamCrest") }
    FootballUploadButton("Foto do jogador *", state.footballOpponentCrest, state.loading) { onSelectFile("opponentCrest") }
}

@Composable
private fun PatrocinadorForm(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel,
    onSelectFile: (String) -> Unit,
    onSelectSponsors: () -> Unit,
    onRemoveSponsor: (Int) -> Unit
) {
    FormField("Título da arte", state.footballTitle, viewModel::updateFootballTitle, required = true)
    FormField("Texto principal", state.footballHeadline, viewModel::updateFootballHeadline)
    FootballUploadButton("Escudo do time *", state.footballTeamCrest, state.loading) { onSelectFile("teamCrest") }
    OutlinedButton(
        modifier = Modifier.fillMaxWidth(),
        enabled = !state.loading,
        onClick = onSelectSponsors
    ) {
        Text("Selecionar patrocinadores *")
    }
    Spacer(modifier = Modifier.height(8.dp))
    if (state.footballSponsorLogos.isEmpty()) {
        Text("Nenhum patrocinador selecionado", color = MaterialTheme.colorScheme.onSurfaceVariant)
    } else {
        state.footballSponsorLogos.forEachIndexed { index, file ->
            ReferencePreviewItem(index = index, file = file, onRemove = { onRemoveSponsor(index) })
        }
    }
}

@Composable
private fun FootballUploadButton(
    label: String,
    file: UploadFile?,
    loading: Boolean,
    onSelect: () -> Unit
) {
    OutlinedButton(
        modifier = Modifier.fillMaxWidth(),
        enabled = !loading,
        onClick = onSelect
    ) {
        Text(file?.let { "$label: ${it.fileName}" } ?: label)
    }
    Spacer(modifier = Modifier.height(8.dp))
}

@Composable
private fun MediaSection(
    state: CreateArtEmpresaUiState,
    loading: Boolean,
    onSelectFotos: () -> Unit,
    onSelectReferencias: () -> Unit,
    onSelectModeloExistente: () -> Unit,
    onRemoveFoto: (Int) -> Unit,
    onRemoveReferencia: (Int) -> Unit,
    onRemoveModeloExistente: () -> Unit
) {
    SectionCard(title = "${stringResource(R.string.create_art_business_photos_title)} (opcional)") {
        OptionalImagesSection(
            description = stringResource(R.string.create_art_business_photos_description),
            images = state.fotos,
            loading = loading,
            emptyText = stringResource(R.string.create_art_business_photos_empty),
            buttonText = stringResource(R.string.create_art_select_business_photos),
            onSelect = onSelectFotos,
            onRemove = onRemoveFoto,
            showDescription = false
        )
    }

    Spacer(modifier = Modifier.height(12.dp))
    ExistingModelSection(
        state = state,
        loading = loading,
        onSelectModeloExistente = onSelectModeloExistente,
        onRemoveModeloExistente = onRemoveModeloExistente
    )
}

@Composable
private fun ExistingModelSection(
    state: CreateArtEmpresaUiState,
    loading: Boolean,
    onSelectModeloExistente: () -> Unit,
    onRemoveModeloExistente: () -> Unit
) {
    SectionCard(title = "${stringResource(R.string.create_art_existing_model_title)} (opcional)") {
        Text("Anexe uma arte antiga ou imagem de referência para guiar composição")
        Spacer(modifier = Modifier.height(10.dp))
        OutlinedButton(
            modifier = Modifier.fillMaxWidth(),
            enabled = !loading,
            onClick = onSelectModeloExistente
        ) {
            Text(
                state.modeloExistente?.let {
                    stringResource(R.string.create_art_existing_model_selected, it.fileName)
                } ?: stringResource(R.string.create_art_select_existing_model)
            )
        }
        if (state.modeloExistente == null) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(stringResource(R.string.create_art_existing_model_empty))
        } else {
            Spacer(modifier = Modifier.height(10.dp))
            ReferencePreviewItem(
                index = 0,
                file = state.modeloExistente,
                onRemove = onRemoveModeloExistente
            )
        }
    }
}

@Composable
private fun StepNavigation(
    currentStep: Int,
    loading: Boolean,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    onReview: () -> Unit
) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (currentStep > 0) {
            OutlinedButton(
                modifier = Modifier.weight(1f),
                enabled = !loading,
                onClick = onPrevious
            ) {
                Text(stringResource(R.string.common_back))
            }
        }
        Button(
            modifier = Modifier.weight(1f),
            enabled = !loading,
            shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
            onClick = if (currentStep == 2) onReview else onNext
        ) {
            Text(
                text = if (currentStep == 2) {
                    stringResource(R.string.create_art_review_order)
                } else {
                    stringResource(R.string.create_art_next_step)
                }
            )
        }
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
private fun RamoSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    onRamoSelected: (String) -> Unit,
    onContinueTyping: () -> Unit,
    freeTyping: Boolean,
    showError: Boolean
) {
    var expanded by remember { mutableStateOf(false) }
    val bringIntoViewRequester = remember { BringIntoViewRequester() }
    val scope = rememberCoroutineScope()
    val trimmedLength = value.trim().length
    val suggestions = remember(value) {
        if (value.trim().isBlank()) emptyList() else CreateArtCatalog.suggestions(value)
    }
    val reachedRamoPause = trimmedLength >= CreateArtEmpresaViewModel.RAMO_SUGGESTION_MIN_CHARS
    val showSuggestions = expanded && !freeTyping && (suggestions.isNotEmpty() || reachedRamoPause)

    LaunchedEffect(showSuggestions) {
        if (showSuggestions) {
            delay(250)
            bringIntoViewRequester.bringIntoView()
        }
    }

    Column(modifier = Modifier.bringIntoViewRequester(bringIntoViewRequester)) {
        OutlinedTextField(
            modifier = Modifier
                .fillMaxWidth()
                .onFocusChanged { focusState ->
                    if (focusState.isFocused) {
                        scope.launch {
                            delay(250)
                            bringIntoViewRequester.bringIntoView()
                        }
                    }
                },
            value = value,
            onValueChange = { newValue ->
                expanded = true
                val shouldPauseAtRamoLimit = !freeTyping &&
                    newValue.trim().length > CreateArtEmpresaViewModel.RAMO_SUGGESTION_MIN_CHARS

                if (shouldPauseAtRamoLimit) {
                    onValueChange(newValue.take(CreateArtEmpresaViewModel.RAMO_SUGGESTION_MIN_CHARS))
                } else {
                    onValueChange(newValue)
                }
            },
            isError = showError,
            label = { Text("${stringResource(R.string.create_art_field_business)} *") },
            colors = createArtFieldColors(),
            supportingText = {
                if (showError) Text(stringResource(R.string.create_art_required_field))
            }
        )

        if (showSuggestions) {
            Spacer(modifier = Modifier.height(8.dp))
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = stringResource(R.string.ramo_select_suggestion_help),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall
                )
                suggestions.forEach { ramo ->
                    OutlinedButton(
                        modifier = Modifier.fillMaxWidth(),
                        onClick = {
                            onRamoSelected(ramo)
                            expanded = false
                        }
                    ) {
                        Text(ramo, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (reachedRamoPause) {
                    OutlinedButton(
                        modifier = Modifier.fillMaxWidth(),
                        onClick = {
                            onContinueTyping()
                            expanded = false
                        }
                    ) {
                        Text(stringResource(R.string.ramo_continue_typing))
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(8.dp))
    }
}

@Composable
private fun ObjectivePicker(
    ramo: String,
    selectedObjective: String,
    selectedObjectiveId: String,
    onObjectiveSelected: (CreateArtObjective) -> Unit,
    onManualObjectiveChange: (String) -> Unit,
    showError: Boolean
) {
    val objectives = remember(ramo) { CreateArtCatalog.objectivesForRamo(ramo) }
    var expanded by remember(ramo) { mutableStateOf(false) }
    var manualOpen by remember { mutableStateOf(false) }
    val selectedLabel = selectedObjective.ifBlank { stringResource(R.string.create_art_select_goal) }
    val allowManualObjective = objectives.none { it.productKey.isNotBlank() }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable {
                    expanded = !expanded
                    manualOpen = false
                }
                .padding(horizontal = 14.dp, vertical = 15.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = selectedLabel,
                modifier = Modifier.weight(1f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (selectedObjective.isBlank()) FontWeight.Normal else FontWeight.SemiBold,
                color = if (selectedObjective.isBlank()) {
                    MaterialTheme.colorScheme.onSurfaceVariant
                } else {
                    MaterialTheme.colorScheme.onSurface
                }
            )
            Text(
                text = if (expanded) "^" else "v",
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Bold
            )
        }
    }

    if (expanded) {
        Spacer(modifier = Modifier.height(8.dp))
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
        ) {
            Column(
                modifier = Modifier.padding(8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
            objectives.forEach { objective ->
                val selected = selectedObjectiveId == objective.id || selectedObjective == objective.label
                ObjectiveListOption(
                    label = objective.label,
                    selected = selected,
                    onClick = {
                        expanded = false
                        manualOpen = false
                        onObjectiveSelected(objective)
                    }
                )
            }
                if (allowManualObjective) {
                    ObjectiveListOption(
                        label = stringResource(R.string.create_art_other_goal),
                        selected = manualOpen,
                        onClick = {
                            manualOpen = true
                            expanded = false
                            onManualObjectiveChange("")
                        }
                    )
                }
            }
        }
    }

    if (allowManualObjective && (manualOpen || (selectedObjective.isNotBlank() && objectives.none { it.label == selectedObjective }))) {
        Spacer(modifier = Modifier.height(8.dp))
        FormField(
            label = stringResource(R.string.create_art_other_goal_hint),
            value = selectedObjective,
            onValueChange = onManualObjectiveChange,
            required = true,
            showError = showError,
            minLines = 2
        )
    }

    if (showError) {
        Spacer(modifier = Modifier.height(6.dp))
        Text(stringResource(R.string.create_art_required_field), color = MaterialTheme.colorScheme.error)
    }

    Spacer(modifier = Modifier.height(10.dp))
}

@Composable
private fun ObjectiveListOption(
    label: String,
    selected: Boolean,
    onClick: () -> Unit
) {
    val container = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface
    val content = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = container),
        elevation = CardDefaults.cardElevation(defaultElevation = if (selected) 1.dp else 0.dp)
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
private fun DynamicObjectiveFields(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel
) {
    val selectedObjective = remember(state.ramo, state.objetivoId, state.objetivo) {
        selectedObjectiveForState(state)
    }
    val fields = remember(selectedObjective) {
        CreateArtCatalog.dynamicFieldsForObjective(selectedObjective)
    }
    if (fields.isEmpty()) return

    var expanded by remember(selectedObjective?.id) { mutableStateOf(false) }
    val visibleFields = if (expanded) fields else fields.take(2)

    visibleFields.forEach { field ->
        FormField(
            label = field.label,
            value = state.camposDinamicos[field.key].orEmpty(),
            onValueChange = { viewModel.updateDynamicField(field.key, it) },
            minLines = if (field.type == "textarea") 3 else 1,
            placeholder = field.placeholder
        )
    }

    if (!expanded && fields.size > 2) {
        Text(
            text = "Clique aqui caso queira adicionar mais informações",
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = true }
                .padding(vertical = 8.dp),
            color = MaterialTheme.colorScheme.primary,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold
        )
        Spacer(modifier = Modifier.height(4.dp))
    }
}

@Composable
private fun VisualStyleSection(
    selected: String,
    onSelected: (String) -> Unit
) {
    SiteStepCard(number = 4, title = stringResource(R.string.create_art_step_visual_title)) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            CompactVisualStyleOption(
                value = "foto_detalhes",
                title = stringResource(R.string.create_art_style_photo_title),
                description = stringResource(R.string.create_art_style_photo_description),
                selected = selected == "foto_detalhes",
                onSelected = onSelected
            )
            CompactVisualStyleOption(
                value = "leve",
                title = stringResource(R.string.create_art_style_light_title),
                description = stringResource(R.string.create_art_style_light_description),
                selected = selected == "leve",
                onSelected = onSelected
            )
            CompactVisualStyleOption(
                value = "normal",
                title = stringResource(R.string.create_art_style_normal_title),
                description = stringResource(R.string.create_art_style_normal_description),
                selected = selected == "normal",
                onSelected = onSelected
            )
        }
    }
}

@Composable
private fun CompactVisualStyleOption(
    value: String,
    title: String,
    description: String,
    selected: Boolean,
    onSelected: (String) -> Unit
) {
    val container = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onSelected(value) },
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = container),
        elevation = CardDefaults.cardElevation(defaultElevation = if (selected) 1.dp else 0.dp)
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.Top
        ) {
            Box(
                modifier = Modifier
                    .width(18.dp)
                    .height(18.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(
                        if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant
                    )
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Text(
                    description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

/*
 * Older visual helpers were kept below for now because review/summary still share
 * nearby helpers. The active create flow uses the compact site-like components above.
 */
@Suppress("unused")
@Composable
private fun LegacyObjectivePicker(
    ramo: String,
    selectedObjective: String,
    selectedObjectiveId: String,
    onObjectiveSelected: (CreateArtObjective) -> Unit,
    onManualObjectiveChange: (String) -> Unit,
    showError: Boolean
) {
    val objectives = remember(ramo) { CreateArtCatalog.objectivesForRamo(ramo) }
    var expanded by remember(ramo) { mutableStateOf(false) }
    var manualOpen by remember { mutableStateOf(false) }
    val selectedLabel = selectedObjective.ifBlank { stringResource(R.string.create_art_select_goal) }

    Text(
        text = "${stringResource(R.string.create_art_field_goal)} *",
        style = MaterialTheme.typography.titleSmall
    )
    Spacer(modifier = Modifier.height(8.dp))

    OutlinedButton(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        onClick = {
            expanded = !expanded
            manualOpen = false
        }
    ) {
        Text(selectedLabel, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }

    if (expanded) {
        Spacer(modifier = Modifier.height(8.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            objectives.forEach { objective ->
                val selected = selectedObjectiveId == objective.id || selectedObjective == objective.label
                if (selected) {
                    Button(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(14.dp),
                        onClick = {
                            expanded = false
                            manualOpen = false
                            onObjectiveSelected(objective)
                        }
                    ) {
                        Text(objective.label)
                    }
                } else {
                    OutlinedButton(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(14.dp),
                        onClick = {
                            expanded = false
                            manualOpen = false
                            onObjectiveSelected(objective)
                        }
                    ) {
                        Text(objective.label)
                    }
                }
            }
        }
    }

    Spacer(modifier = Modifier.height(8.dp))
    OutlinedButton(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        onClick = {
            manualOpen = !manualOpen
            expanded = false
            if (manualOpen && selectedObjective.isBlank()) onManualObjectiveChange("")
        }
    ) {
        Text(stringResource(R.string.create_art_other_goal))
    }

    if (manualOpen || (selectedObjective.isNotBlank() && objectives.none { it.label == selectedObjective })) {
        Spacer(modifier = Modifier.height(8.dp))
        FormField(
            label = stringResource(R.string.create_art_other_goal_hint),
            value = selectedObjective,
            onValueChange = onManualObjectiveChange,
            required = true,
            showError = showError,
            minLines = 2
        )
    }

    if (showError) {
        Spacer(modifier = Modifier.height(6.dp))
        Text(stringResource(R.string.create_art_required_field), color = MaterialTheme.colorScheme.error)
    }

    Spacer(modifier = Modifier.height(12.dp))
}

@Suppress("unused")
@Composable
private fun LegacyDynamicObjectiveFields(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel
) {
    val selectedObjective = remember(state.ramo, state.objetivoId, state.objetivo) {
        selectedObjectiveForState(state)
    }
    val fields = remember(selectedObjective) {
        CreateArtCatalog.dynamicFieldsForObjective(selectedObjective)
    }
    if (fields.isEmpty()) return

    Text(
        text = stringResource(R.string.create_art_dynamic_fields_title),
        style = MaterialTheme.typography.titleSmall
    )
    Spacer(modifier = Modifier.height(8.dp))
    fields.forEach { field ->
        FormField(
            label = field.label,
            value = state.camposDinamicos[field.key].orEmpty(),
            onValueChange = { viewModel.updateDynamicField(field.key, it) },
            minLines = if (field.type == "textarea") 3 else 1,
            placeholder = field.placeholder
        )
    }
}

@Suppress("unused")
@Composable
private fun LegacyVisualStyleSection(
    selected: String,
    onSelected: (String) -> Unit
) {
    SectionCard(title = stringResource(R.string.create_art_step_visual_title)) {
        VisualStyleOption(
            value = "foto_detalhes",
            title = stringResource(R.string.create_art_style_photo_title),
            description = stringResource(R.string.create_art_style_photo_description),
            selected = selected == "foto_detalhes",
            onSelected = onSelected
        )
        Spacer(modifier = Modifier.height(8.dp))
        VisualStyleOption(
            value = "leve",
            title = stringResource(R.string.create_art_style_light_title),
            description = stringResource(R.string.create_art_style_light_description),
            selected = selected == "leve",
            onSelected = onSelected
        )
        Spacer(modifier = Modifier.height(8.dp))
        VisualStyleOption(
            value = "normal",
            title = stringResource(R.string.create_art_style_normal_title),
            description = stringResource(R.string.create_art_style_normal_description),
            selected = selected == "normal",
            onSelected = onSelected
        )
    }
}

@Composable
private fun VisualStyleOption(
    value: String,
    title: String,
    description: String,
    selected: Boolean,
    onSelected: (String) -> Unit
) {
    val container = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onSelected(value) },
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = container),
        elevation = CardDefaults.cardElevation(defaultElevation = if (selected) 2.dp else 0.dp)
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

private fun selectedObjectiveForState(state: CreateArtEmpresaUiState): CreateArtObjective? {
    val objectives = CreateArtCatalog.objectivesForRamo(state.ramo)
    return objectives.firstOrNull { it.id == state.objetivoId }
        ?: objectives.firstOrNull { it.label == state.objetivo }
}

private fun selectedFootballProductKey(state: CreateArtEmpresaUiState): String {
    return selectedObjectiveForState(state)?.productKey.orEmpty()
}

private fun dynamicFieldLabel(state: CreateArtEmpresaUiState, key: String): String {
    val objective = selectedObjectiveForState(state)
    return CreateArtCatalog.dynamicFieldsForObjective(objective).firstOrNull { it.key == key }?.label ?: key
}

@Composable
private fun OptionalFieldsSection(
    state: CreateArtEmpresaUiState,
    viewModel: CreateArtEmpresaViewModel
) {
    var expanded by remember { mutableStateOf(false) }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable {
                val nextExpanded = !expanded
                expanded = nextExpanded
                if (nextExpanded) {
                    MobileAnalytics.track(
                        "mobile_abriu_campos_opcionais",
                        tela = "criar_arte",
                        produto = "arte_empresa",
                        etapa = "objetivo"
                    )
                }
            },
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = stringResource(R.string.create_art_optional_fields_title),
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = if (expanded) "-" else "+",
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Bold
            )
        }
    }

    if (expanded) {
        Spacer(modifier = Modifier.height(12.dp))
        FormField(stringResource(R.string.create_art_field_offer_friendly), state.oferta, viewModel::updateOferta)
        FormField(
            "Frase que deve aparecer na arte",
            state.cta,
            viewModel::updateCta,
            placeholder = "Peça seu orçamento\nAgende uma visita\nFale conosco\nChame no WhatsApp\nAproveite a promoção"
        )
        FormField(
            stringResource(R.string.create_art_field_notes_friendly),
            state.observacoes,
            viewModel::updateObservacoes,
            minLines = 3
        )
    }
}

@Composable
private fun FormField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    required: Boolean = false,
    showError: Boolean = false,
    minLines: Int = 1,
    placeholder: String = ""
) {
    OutlinedTextField(
        modifier = Modifier.fillMaxWidth(),
        value = value,
        onValueChange = onValueChange,
        isError = showError,
        minLines = minLines,
        label = { Text(if (required) "$label *" else label) },
        placeholder = {
            if (placeholder.isNotBlank()) Text(placeholder)
        },
        colors = createArtFieldColors(),
        supportingText = {
            if (showError) Text(stringResource(R.string.create_art_required_field))
        }
    )
    Spacer(modifier = Modifier.height(8.dp))
}

@Composable
private fun createArtFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = MaterialTheme.colorScheme.onSurface,
    unfocusedTextColor = MaterialTheme.colorScheme.onSurface,
    focusedLabelColor = MaterialTheme.colorScheme.onSurfaceVariant,
    unfocusedLabelColor = MaterialTheme.colorScheme.onSurfaceVariant,
    focusedPlaceholderColor = MaterialTheme.colorScheme.onSurfaceVariant,
    unfocusedPlaceholderColor = MaterialTheme.colorScheme.onSurfaceVariant,
    focusedContainerColor = Color.White,
    unfocusedContainerColor = Color.White,
    focusedBorderColor = MaterialTheme.colorScheme.primary,
    unfocusedBorderColor = MaterialTheme.colorScheme.outline,
    cursorColor = MaterialTheme.colorScheme.primary
)

@Composable
private fun LogoPreview(logo: UploadFile?) {
    if (logo == null) return
    val bitmap = remember(logo.fileName, logo.bytes.size) {
        BitmapFactory.decodeByteArray(logo.bytes, 0, logo.bytes.size)
    } ?: return

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Text(stringResource(R.string.create_art_logo_preview), style = MaterialTheme.typography.titleSmall)
            Spacer(modifier = Modifier.height(8.dp))
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = stringResource(R.string.create_art_logo_content_description),
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(16f / 9f),
                contentScale = ContentScale.Fit
            )
        }
    }
    Spacer(modifier = Modifier.height(10.dp))
}

@Composable
private fun SummaryCard(state: CreateArtEmpresaUiState) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Text(stringResource(R.string.create_art_summary_title), style = MaterialTheme.typography.titleMedium)
            Spacer(modifier = Modifier.height(8.dp))
            SummaryLine(stringResource(R.string.create_art_field_company_name), state.nomeEmpresa.ifBlank { "-" })
            SummaryLine(stringResource(R.string.create_art_field_business), state.ramo.ifBlank { "-" })
            SummaryLine(stringResource(R.string.create_art_field_goal), state.objetivo.ifBlank { "-" })
            SummaryLine(stringResource(R.string.create_art_field_visual_style), state.estiloVisualCliente.ifBlank { "-" })
            if (state.oferta.isNotBlank()) SummaryLine(stringResource(R.string.create_art_field_offer), state.oferta)
            if (state.cta.isNotBlank()) SummaryLine(stringResource(R.string.create_art_field_cta), state.cta)
            state.camposDinamicos.filterValues { it.isNotBlank() }.forEach { (key, value) ->
                SummaryLine(dynamicFieldLabel(state, key), value)
            }
            SummaryLine(
                stringResource(R.string.create_art_logo_label),
                state.logo?.fileName ?: stringResource(R.string.create_art_logo_not_selected)
            )
            state.logo?.let { logo ->
                SummaryLine(stringResource(R.string.create_art_upload_size), formatBytes(logo.bytes.size))
            }
            SummaryLine(
                stringResource(R.string.create_art_business_photos_title),
                "${state.fotos.size}/${CreateArtEmpresaViewModel.MAX_IMAGENS_OPCIONAIS}"
            )
            SummaryLine(
                stringResource(R.string.create_art_existing_model_title),
                state.modeloExistente?.fileName ?: stringResource(R.string.create_art_existing_model_empty)
            )
        }
    }
}

@Composable
private fun SummaryLine(
    label: String,
    value: String
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp)
    ) {
        Text(
            text = label,
            modifier = Modifier.weight(1f),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium
        )
        Text(
            text = value,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.bodyMedium
        )
    }
}

@Composable
private fun ReviewStep(
    state: CreateArtEmpresaUiState,
    onBackToEdit: () -> Unit,
    onOpenPlans: () -> Unit,
    onConfirm: () -> Unit
) {
    Spacer(modifier = Modifier.height(16.dp))
    Text(stringResource(R.string.create_art_review_notice))
    Spacer(modifier = Modifier.height(12.dp))

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Text(stringResource(R.string.create_art_review_title), style = MaterialTheme.typography.titleMedium)
            Spacer(modifier = Modifier.height(8.dp))
            val footballProductKey = selectedFootballProductKey(state)
            ReviewLine(stringResource(R.string.create_art_field_company_name), state.nomeEmpresa)
            ReviewLine(stringResource(R.string.create_art_field_business), state.ramo)
            ReviewLine(stringResource(R.string.create_art_field_goal), state.objetivo)
            if (state.fromCameraPhoto) {
                ReviewLine(stringResource(R.string.create_art_photo_phrase_title), state.fotoFrase)
            }
            if (footballProductKey.isNotBlank()) {
                FootballReviewLines(state, footballProductKey)
            } else {
                ReviewLine(stringResource(R.string.create_art_field_visual_style), state.estiloVisualCliente)
                if (state.oferta.isNotBlank()) {
                    ReviewLine(stringResource(R.string.create_art_field_offer), state.oferta)
                }
                if (state.cta.isNotBlank()) {
                    ReviewLine(stringResource(R.string.create_art_field_cta), state.cta)
                }
                if (state.observacoes.isNotBlank()) {
                    ReviewLine(stringResource(R.string.create_art_field_notes), state.observacoes)
                }
                state.camposDinamicos.filterValues { it.isNotBlank() }.forEach { (key, value) ->
                    ReviewLine(dynamicFieldLabel(state, key), value)
                }
                ReviewLine("Logo selecionado", state.logo?.fileName.orEmpty())
                ReviewLine(stringResource(R.string.create_art_business_photos_title), "${state.fotos.size}")
                state.modeloExistente?.let { modelo ->
                    ReviewLine(stringResource(R.string.create_art_existing_model_title), modelo.fileName)
                }
            }
        }
    }

    if (state.loading) {
        Spacer(modifier = Modifier.height(14.dp))
        UploadingCard()
    }

    state.error?.let { error ->
        Spacer(modifier = Modifier.height(10.dp))
        Text(error.asString(), color = MaterialTheme.colorScheme.error)
        BillingRequiredActions(
            visible = state.billingRequired,
            onOpenPlans = onOpenPlans
        )
    }

    Spacer(modifier = Modifier.height(16.dp))
    OutlinedButton(
        modifier = Modifier.fillMaxWidth(),
        enabled = !state.loading,
        onClick = onBackToEdit
    ) {
        Text(stringResource(R.string.create_art_back_to_edit))
    }

    Spacer(modifier = Modifier.height(10.dp))
    Button(
        modifier = Modifier.fillMaxWidth(),
        enabled = !state.loading,
        onClick = onConfirm
    ) {
        if (state.loading) {
            CircularProgressIndicator()
        } else {
            Text(stringResource(R.string.create_art_confirm_create))
        }
    }
    Spacer(modifier = Modifier.height(24.dp))
}

@Composable
private fun UploadingCard() {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Text(
                text = stringResource(R.string.create_art_uploading_title),
                style = MaterialTheme.typography.titleMedium
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(stringResource(R.string.create_art_uploading_subtitle))
            Spacer(modifier = Modifier.height(12.dp))
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun ReviewLine(label: String, value: String) {
    Text("$label: ${value.ifBlank { "-" }}")
}

@Composable
private fun FootballReviewLines(state: CreateArtEmpresaUiState, productKey: String) {
    when (productKey) {
        "mascote_uniforme" -> {
            ReviewLine("Mascote", state.footballMascotAnimal)
            ReviewLine("Escudo", state.footballTeamCrest?.fileName.orEmpty())
            ReviewLine("Uniforme", state.footballAuxImage?.fileName.orEmpty())
        }
        "escudo3d" -> ReviewLine("Escudo", state.footballTeamCrest?.fileName.orEmpty())
        "resultado" -> {
            ReviewLine("Time A", state.footballHomeTeam)
            ReviewLine("Placar", "${state.footballHomeScore} x ${state.footballAwayScore}")
            ReviewLine("Time B", state.footballAwayTeam)
            ReviewLine("Campeonato", state.footballCompetition)
            ReviewLine("Escudo Time A", state.footballTeamCrest?.fileName.orEmpty())
            ReviewLine("Escudo Time B", state.footballOpponentCrest?.fileName.orEmpty())
        }
        "proximo_jogo" -> {
            ReviewLine("Confronto", "${state.footballHomeTeam} x ${state.footballAwayTeam}")
            ReviewLine("Data e horário", state.footballMatchDatetime)
            ReviewLine("Campeonato", state.footballCompetition)
            ReviewLine("Arena", state.footballVenue)
            ReviewLine("Escudo Time A", state.footballTeamCrest?.fileName.orEmpty())
            ReviewLine("Escudo Time B", state.footballOpponentCrest?.fileName.orEmpty())
        }
        "treino" -> {
            ReviewLine("Chamada", state.footballTitle)
            ReviewLine("Frase", state.footballHeadline)
            ReviewLine("Contexto", state.footballCompetition)
            ReviewLine("Local", state.footballVenue)
            ReviewLine("Escudo", state.footballTeamCrest?.fileName.orEmpty())
            ReviewLine("Foto", state.footballAuxImage?.fileName.orEmpty())
        }
        "escalacao" -> {
            ReviewLine("Confronto", state.footballTitle)
            ReviewLine("Data e horário", state.footballMatchDatetime)
            ReviewLine("Campeonato", state.footballCompetition)
            ReviewLine("Jogadores", state.footballPlayersText)
            ReviewLine("Escudo", state.footballTeamCrest?.fileName.orEmpty())
        }
        "contratacao" -> {
            ReviewLine("Título", state.footballTitle)
            ReviewLine("Jogador", state.footballPlayerName)
            ReviewLine("Informações", state.footballPlayerInfo)
            ReviewLine("Escudo", state.footballTeamCrest?.fileName.orEmpty())
            ReviewLine("Foto do jogador", state.footballOpponentCrest?.fileName.orEmpty())
        }
        "patrocinador" -> {
            ReviewLine("Título", state.footballTitle)
            ReviewLine("Texto principal", state.footballHeadline)
            ReviewLine("Escudo", state.footballTeamCrest?.fileName.orEmpty())
            ReviewLine("Patrocinadores", state.footballSponsorLogos.joinToString { it.fileName })
        }
    }
}

@Composable
private fun OptionalImagesSection(
    description: String,
    images: List<UploadFile>,
    loading: Boolean,
    emptyText: String,
    buttonText: String,
    onSelect: () -> Unit,
    onRemove: (Int) -> Unit,
    showDescription: Boolean = true
) {
    if (showDescription) {
        Text(description)
    }
    Text(stringResource(R.string.create_art_limit_images, CreateArtEmpresaViewModel.MAX_IMAGENS_OPCIONAIS))
    Spacer(modifier = Modifier.height(10.dp))

    OutlinedButton(
        modifier = Modifier.fillMaxWidth(),
        enabled = !loading && images.size < CreateArtEmpresaViewModel.MAX_IMAGENS_OPCIONAIS,
        onClick = onSelect
    ) {
        Text(buttonText)
    }

    if (images.isEmpty()) {
        Spacer(modifier = Modifier.height(8.dp))
        Text(emptyText)
        return
    }

    Spacer(modifier = Modifier.height(10.dp))
    images.forEachIndexed { index, file ->
        ReferencePreviewItem(
            index = index,
            file = file,
            onRemove = { onRemove(index) }
        )
        Spacer(modifier = Modifier.height(8.dp))
    }
}

@Composable
private fun ReferencePreviewItem(
    index: Int,
    file: UploadFile,
    onRemove: () -> Unit
) {
    val bitmap = remember(file.fileName, file.bytes.size) {
        BitmapFactory.decodeByteArray(file.bytes, 0, file.bytes.size)
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(modifier = Modifier.padding(10.dp)) {
            if (bitmap != null) {
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = stringResource(R.string.create_art_image_content_description, index + 1),
                    modifier = Modifier
                        .width(96.dp)
                        .aspectRatio(1f),
                    contentScale = ContentScale.Crop
                )
                Spacer(modifier = Modifier.width(12.dp))
            }

            Column(modifier = Modifier.weight(1f)) {
                Text(stringResource(R.string.create_art_image_title, index + 1), style = MaterialTheme.typography.titleSmall)
                Text(file.fileName)
                Text("Envio: ${formatBytes(file.bytes.size)}")
                if (file.optimized) {
                    Text("Otimizada de ${formatBytes(file.originalSizeBytes)}")
                }
                Spacer(modifier = Modifier.height(6.dp))
                OutlinedButton(onClick = onRemove) {
                    Text(stringResource(R.string.common_remove))
                }
            }
        }
    }
}

@Composable
private fun LogoOptimizationMessage(logo: UploadFile?) {
    if (logo == null) return

    Spacer(modifier = Modifier.height(6.dp))
    val message = if (logo.optimized) {
        "Logo otimizado para envio: ${formatBytes(logo.originalSizeBytes)} -> ${formatBytes(logo.bytes.size)}."
    } else {
        "Logo pronto para envio: ${formatBytes(logo.bytes.size)}."
    }
    Text(message, style = MaterialTheme.typography.bodySmall)
}

private fun formatBytes(bytes: Int): String {
    val mb = bytes / (1024.0 * 1024.0)
    if (mb >= 1.0) return "%.2f MB".format(mb)
    val kb = bytes / 1024.0
    return "%.0f KB".format(kb)
}

private suspend fun handleOptionalImages(
    uris: List<Uri>,
    currentCount: Int,
    fileReader: AndroidFileReader,
    onError: (String) -> Unit,
    onSuccess: (List<UploadFile>) -> Unit,
    limitLabel: String,
    limitErrorTemplate: (String) -> String,
    ignoredError: String
) {
    val remaining = CreateArtEmpresaViewModel.MAX_IMAGENS_OPCIONAIS - currentCount
    if (remaining <= 0) {
        onError(limitErrorTemplate(limitLabel))
        return
    }

    val files = mutableListOf<UploadFile>()
    var errorMessage = ""
    uris.take(remaining).forEach { uri ->
        when (val result = fileReader.readUploadFile(uri)) {
            is ApiResult.Success -> files.add(result.value)
            is ApiResult.Failure -> if (errorMessage.isBlank()) errorMessage = result.message
        }
    }

    if (files.isNotEmpty()) onSuccess(files)
    if (uris.size > remaining) {
        onError(ignoredError)
    } else if (errorMessage.isNotBlank()) {
        onError(errorMessage)
    }
}
