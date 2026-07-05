package br.com.ia4tube.app.feature.company_profile

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import br.com.ia4tube.app.R
import br.com.ia4tube.app.core.share.ShareImageStore
import br.com.ia4tube.app.core.upload.AndroidFileReader
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.CompanyGraphicMaterial
import br.com.ia4tube.app.data.models.CompanyGraphicMaterialProfileRequest
import br.com.ia4tube.app.feature.create_art.CreateArtCatalog
import br.com.ia4tube.app.feature.create_art.CreateArtEmpresaViewModel
import br.com.ia4tube.app.ui.components.ScreenScaffold
import br.com.ia4tube.app.ui.text.asString
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun CompanyProfileScreen(
    viewModel: CompanyProfileViewModel,
    graphicMaterialsViewModel: CompanyGraphicMaterialsViewModel,
    isLoggedIn: Boolean,
    onProfileSaved: () -> Unit,
    onAuthRequired: () -> Unit,
    onLogout: () -> Unit
) {
    val state by viewModel.uiState.collectAsState()
    val materialsState by graphicMaterialsViewModel.uiState.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val fileReader = remember { AndroidFileReader(context.applicationContext) }
    val shareImageStore = remember { ShareImageStore(context.applicationContext) }
    val logoPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        context.contentResolver.takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION
        )
        viewModel.updateLogoUri(uri.toString())
    }

    LaunchedEffect(materialsState.generated?.materialId, materialsState.shareAfterDownload) {
        val generated = materialsState.generated
        if (generated != null && materialsState.shareAfterDownload) {
            val uri = shareImageStore.saveGraphicMaterialImage(generated.materialId, generated.image)
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = generated.image.contentType.ifBlank { "image/png" }
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(
                Intent.createChooser(
                    shareIntent,
                    context.getString(R.string.company_graphic_materials_share)
                )
            )
            graphicMaterialsViewModel.consumeShareRequest()
        }
    }

    LaunchedEffect(isLoggedIn) {
        if (isLoggedIn) {
            graphicMaterialsViewModel.load(state.ramo)
        }
    }

    var optionalFieldsExpanded by remember { mutableStateOf(false) }
    val saveProfile = {
        val savedRamo = state.ramo.trim()
        if (viewModel.save()) {
            Toast.makeText(
                context,
                context.getString(R.string.company_profile_saved),
                Toast.LENGTH_SHORT
            ).show()
            if (isLoggedIn) {
                graphicMaterialsViewModel.load(savedRamo)
            }
        }
    }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
        ) {
            Text(stringResource(R.string.company_profile_title), style = MaterialTheme.typography.headlineSmall)

            Spacer(modifier = Modifier.height(16.dp))
            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.nomeEmpresa,
                onValueChange = viewModel::updateNomeEmpresa,
                label = { Text(stringResource(R.string.company_profile_required_company_name)) },
                singleLine = true
            )
            Spacer(modifier = Modifier.height(8.dp))
            CompanyProfileRamoSearchField(
                value = state.ramo,
                onValueChange = viewModel::updateRamo,
                onRamoSelected = viewModel::selectRamo,
                onContinueTyping = viewModel::continueRamoTyping,
                freeTyping = state.ramoDigitacaoLivre
            )

            state.message?.let { message ->
                Spacer(modifier = Modifier.height(12.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Text(
                        modifier = Modifier.padding(14.dp),
                        text = message.asString(),
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))
            OutlinedButton(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFFD6A84F)),
                colors = ButtonDefaults.outlinedButtonColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f),
                    contentColor = MaterialTheme.colorScheme.onSurface
                ),
                onClick = { optionalFieldsExpanded = !optionalFieldsExpanded }
            ) {
                Text(
                    text = stringResource(
                        if (optionalFieldsExpanded) {
                            R.string.company_profile_more_info_expanded
                        } else {
                            R.string.company_profile_more_info_collapsed
                        }
                    ),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
            }

            if (optionalFieldsExpanded) {
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.whatsapp,
                onValueChange = viewModel::updateWhatsapp,
                label = { Text(stringResource(R.string.create_art_field_whatsapp)) },
                singleLine = true
            )
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.instagram,
                onValueChange = viewModel::updateInstagram,
                label = { Text(stringResource(R.string.create_art_field_instagram)) },
                singleLine = true
            )
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.endereco,
                onValueChange = viewModel::updateEndereco,
                label = { Text(stringResource(R.string.company_profile_address)) },
                singleLine = true
            )
            Spacer(modifier = Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedTextField(
                    modifier = Modifier.weight(1f),
                    value = state.cidade,
                    onValueChange = viewModel::updateCidade,
                    label = { Text(stringResource(R.string.company_profile_city)) },
                    singleLine = true
                )
                OutlinedTextField(
                    modifier = Modifier.width(96.dp),
                    value = state.estado,
                    onValueChange = viewModel::updateEstado,
                    label = { Text(stringResource(R.string.company_profile_state)) },
                    singleLine = true
                )
            }
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.cep,
                onValueChange = viewModel::updateCep,
                label = { Text(stringResource(R.string.company_profile_zip_code)) },
                singleLine = true
            )
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.email,
                onValueChange = viewModel::updateEmail,
                label = { Text(stringResource(R.string.company_profile_email)) },
                singleLine = true
            )
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.site,
                onValueChange = viewModel::updateSite,
                label = { Text(stringResource(R.string.company_profile_site)) },
                singleLine = true
            )
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.historia,
                onValueChange = viewModel::updateHistoria,
                label = { Text(stringResource(R.string.company_profile_history)) },
                placeholder = { Text(stringResource(R.string.company_profile_history_hint)) },
                minLines = 3
            )

            Spacer(modifier = Modifier.height(16.dp))
            DefaultLogoUploadCard(
                logoUri = state.logoUri,
                onSelectLogo = { logoPicker.launch(arrayOf("image/*")) },
                onRemoveLogo = viewModel::removeLogo
            )
            }

            Spacer(modifier = Modifier.height(16.dp))
            Button(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
                onClick = saveProfile
            ) {
                Text(stringResource(R.string.company_profile_save))
            }

            Spacer(modifier = Modifier.height(24.dp))
            CompanyGraphicMaterialsSection(
                state = state,
                materialsState = materialsState,
                isLoggedIn = isLoggedIn,
                onAuthRequired = onAuthRequired,
                onRetry = { graphicMaterialsViewModel.load(state.ramo) },
                onCreate = { material ->
                    if (viewModel.save()) {
                        scope.launch {
                            val logo = if (state.logoUri.isNotBlank()) {
                                when (val result = fileReader.readUploadFile(Uri.parse(state.logoUri))) {
                                    is ApiResult.Success -> result.value
                                    is ApiResult.Failure -> {
                                        Toast.makeText(
                                            context,
                                            result.message.ifBlank { context.getString(R.string.upload_read_image_error) },
                                            Toast.LENGTH_SHORT
                                        ).show()
                                        return@launch
                                    }
                                }
                            } else {
                                null
                            }

                            graphicMaterialsViewModel.create(
                                material,
                                CompanyGraphicMaterialProfileRequest(
                                    nomeEmpresa = state.nomeEmpresa.trim(),
                                    ramo = state.ramo.trim(),
                                    whatsapp = state.whatsapp.trim(),
                                    instagram = state.instagram.trim(),
                                    historia = state.historia.trim(),
                                    endereco = state.endereco.trim(),
                                    cidade = state.cidade.trim(),
                                    estado = state.estado.trim(),
                                    cep = state.cep.trim(),
                                    email = state.email.trim(),
                                    site = state.site.trim(),
                                    logo = logo
                                )
                            )
                        }
                    }
                },
                onDownload = { material ->
                    graphicMaterialsViewModel.download(material, shareAfterDownload = false)
                },
                onShare = { material ->
                    graphicMaterialsViewModel.download(material, shareAfterDownload = true)
                },
                onOpenGenerated = {
                    val generated = materialsState.generated
                    if (generated != null) {
                        val uri = shareImageStore.saveGraphicMaterialImage(generated.materialId, generated.image)
                        val intent = Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(uri, generated.image.contentType.ifBlank { "image/png" })
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        runCatching { context.startActivity(intent) }
                            .onFailure {
                                Toast.makeText(
                                    context,
                                    context.getString(R.string.company_graphic_materials_open_error),
                                    Toast.LENGTH_SHORT
                                ).show()
                            }
                    }
                },
                onShareGenerated = {
                    val generated = materialsState.generated
                    if (generated != null) {
                        val uri = shareImageStore.saveGraphicMaterialImage(generated.materialId, generated.image)
                        val shareIntent = Intent(Intent.ACTION_SEND).apply {
                            type = generated.image.contentType.ifBlank { "image/png" }
                            putExtra(Intent.EXTRA_STREAM, uri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        context.startActivity(
                            Intent.createChooser(
                                shareIntent,
                                context.getString(R.string.company_graphic_materials_share)
                            )
                        )
                    }
                },
                onDismissGenerated = graphicMaterialsViewModel::clearGenerated
            )
            Spacer(modifier = Modifier.height(24.dp))
        }
    }
}

@Composable
private fun CompanyGraphicMaterialsSection(
    state: CompanyProfileUiState,
    materialsState: CompanyGraphicMaterialsUiState,
    isLoggedIn: Boolean,
    onAuthRequired: () -> Unit,
    onRetry: () -> Unit,
    onCreate: (CompanyGraphicMaterial) -> Unit,
    onDownload: (CompanyGraphicMaterial) -> Unit,
    onShare: (CompanyGraphicMaterial) -> Unit,
    onOpenGenerated: () -> Unit,
    onShareGenerated: () -> Unit,
    onDismissGenerated: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(22.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = stringResource(R.string.company_graphic_materials_title),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold
            )
            if (!isLoggedIn) {
                Spacer(modifier = Modifier.height(12.dp))
                CompanyGraphicMaterialsAuthPrompt(onAuthRequired = onAuthRequired)
            } else {
                if (materialsState.planName.isNotBlank()) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = stringResource(R.string.company_graphic_materials_plan, materialsState.planName),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

            materialsState.message?.let { message ->
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = message.asString(),
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.SemiBold
                )
            }

            materialsState.error?.let { error ->
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = error.asString(),
                    color = MaterialTheme.colorScheme.error,
                    fontWeight = FontWeight.SemiBold
                )
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = onRetry
                ) {
                    Text(stringResource(R.string.common_retry))
                }
            }

            materialsState.generated?.let { generated ->
                Spacer(modifier = Modifier.height(12.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Column(modifier = Modifier.padding(14.dp)) {
                        Text(
                            text = generated.title,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onPrimaryContainer
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = stringResource(R.string.company_graphic_materials_saved_path, generated.savedPath),
                            color = MaterialTheme.colorScheme.onPrimaryContainer
                        )
                        Spacer(modifier = Modifier.height(10.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = onOpenGenerated) {
                                Text(stringResource(R.string.company_graphic_materials_open))
                            }
                            Button(onClick = onShareGenerated) {
                                Text(stringResource(R.string.company_graphic_materials_share))
                            }
                            TextButton(onClick = onDismissGenerated) {
                                Text(stringResource(R.string.company_graphic_materials_close))
                            }
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(14.dp))

            when {
                materialsState.loading -> {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        CircularProgressIndicator(modifier = Modifier.width(28.dp))
                        Spacer(modifier = Modifier.width(12.dp))
                        Text(stringResource(R.string.company_graphic_materials_loading))
                    }
                }
                materialsState.materials.isEmpty() && materialsState.error == null -> {
                    Text(
                        text = stringResource(R.string.company_graphic_materials_empty),
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                else -> {
                    val general = materialsState.materials.filter { it.scope != "ramo" }
                    val branch = materialsState.materials.filter { it.scope == "ramo" }

                    GraphicMaterialGroup(
                        title = stringResource(R.string.company_graphic_materials_general),
                        materials = general,
                        generatingMaterialId = materialsState.generatingMaterialId,
                        downloadingMaterialId = materialsState.downloadingMaterialId,
                        onCreate = onCreate,
                        onDownload = onDownload,
                        onShare = onShare
                    )

                    if (branch.isNotEmpty()) {
                        Spacer(modifier = Modifier.height(12.dp))
                        val branchName = if (state.ramo.isBlank()) {
                            stringResource(R.string.create_art_field_business)
                        } else {
                            state.ramo
                        }
                        GraphicMaterialGroup(
                            title = stringResource(R.string.company_graphic_materials_branch, branchName),
                            materials = branch,
                            generatingMaterialId = materialsState.generatingMaterialId,
                            downloadingMaterialId = materialsState.downloadingMaterialId,
                            onCreate = onCreate,
                            onDownload = onDownload,
                            onShare = onShare
                        )
                    }
                }
            }
            }
        }
    }
}

@Composable
private fun CompanyGraphicMaterialsAuthPrompt(
    onAuthRequired: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(
                text = stringResource(R.string.company_graphic_materials_auth_required),
                color = MaterialTheme.colorScheme.onPrimaryContainer,
                fontWeight = FontWeight.SemiBold
            )
            Spacer(modifier = Modifier.height(10.dp))
            Button(
                modifier = Modifier.fillMaxWidth(),
                onClick = onAuthRequired
            ) {
                Text(stringResource(R.string.company_graphic_materials_auth_button))
            }
        }
    }
}

@Composable
private fun GraphicMaterialGroup(
    title: String,
    materials: List<CompanyGraphicMaterial>,
    generatingMaterialId: String,
    downloadingMaterialId: String,
    onCreate: (CompanyGraphicMaterial) -> Unit,
    onDownload: (CompanyGraphicMaterial) -> Unit,
    onShare: (CompanyGraphicMaterial) -> Unit
) {
    if (materials.isEmpty()) return

    Text(
        text = title,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.Bold
    )
    Spacer(modifier = Modifier.height(8.dp))
    materials.forEach { material ->
        GraphicMaterialRow(
            material = material,
            isGenerating = generatingMaterialId == material.id,
            isDownloading = downloadingMaterialId == material.id,
            actionsLocked = generatingMaterialId.isNotBlank() || downloadingMaterialId.isNotBlank(),
            onCreate = { onCreate(material) },
            onDownload = { onDownload(material) },
            onShare = { onShare(material) }
        )
        Spacer(modifier = Modifier.height(8.dp))
    }
}

@Composable
private fun GraphicMaterialRow(
    material: CompanyGraphicMaterial,
    isGenerating: Boolean,
    isDownloading: Boolean,
    actionsLocked: Boolean,
    onCreate: () -> Unit,
    onDownload: () -> Unit,
    onShare: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = material.title,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                if (material.createdInCycle) {
                    Text(
                        text = stringResource(R.string.company_graphic_materials_created_cycle),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            Spacer(modifier = Modifier.width(12.dp))
            Column(
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                when {
                    isGenerating -> {
                        Button(enabled = false, onClick = {}) {
                            Text(stringResource(R.string.company_graphic_materials_creating))
                        }
                    }
                    material.status == "available" -> {
                        Button(
                            enabled = !actionsLocked,
                            onClick = onCreate
                        ) {
                            Text(stringResource(R.string.company_graphic_materials_create))
                        }
                    }
                    material.status == "processing" -> {
                        Text(
                            modifier = Modifier.width(132.dp),
                            text = stringResource(R.string.company_graphic_materials_processing),
                            textAlign = TextAlign.End,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                    material.status == "created" || material.ready -> {
                        Text(
                            text = stringResource(R.string.company_graphic_materials_created),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontWeight = FontWeight.SemiBold
                        )
                        OutlinedButton(
                            enabled = !actionsLocked,
                            onClick = onDownload
                        ) {
                            Text(
                                if (isDownloading) {
                                    stringResource(R.string.company_graphic_materials_downloading)
                                } else {
                                    stringResource(R.string.company_graphic_materials_download)
                                }
                            )
                        }
                        Button(
                            enabled = !actionsLocked,
                            onClick = onShare
                        ) {
                            Text(stringResource(R.string.company_graphic_materials_share))
                        }
                    }
                    else -> {
                        Text(
                            modifier = Modifier.width(132.dp),
                            text = stringResource(R.string.company_graphic_materials_locked),
                            textAlign = TextAlign.End,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun DefaultLogoUploadCard(
    logoUri: String,
    onSelectLogo: () -> Unit,
    onRemoveLogo: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onSelectLogo),
        shape = RoundedCornerShape(22.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            if (logoUri.isNotBlank()) {
                AsyncImage(
                    model = logoUri,
                    contentDescription = stringResource(R.string.company_profile_logo_selected),
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(16f / 9f),
                    contentScale = ContentScale.Fit
                )
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = stringResource(R.string.company_profile_logo_selected),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
            } else {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(96.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "+",
                        style = MaterialTheme.typography.displayMedium,
                        color = MaterialTheme.colorScheme.primary,
                        fontWeight = FontWeight.Bold
                    )
                }
                Text(
                    text = stringResource(R.string.company_profile_add_default_logo),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold
                )
            }

            Spacer(modifier = Modifier.height(6.dp))
            Text(
                text = stringResource(R.string.company_profile_default_logo_subtitle),
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            if (logoUri.isNotBlank()) {
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = onRemoveLogo
                ) {
                    Text(stringResource(R.string.company_profile_remove_logo))
                }
            }
        }
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
fun CompanyProfileRamoSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    onRamoSelected: (String) -> Unit,
    onContinueTyping: () -> Unit,
    freeTyping: Boolean
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
            label = { Text(stringResource(R.string.company_profile_required_business)) },
            singleLine = true
        )

        if (showSuggestions) {
            Spacer(modifier = Modifier.height(8.dp))
            Column {
                Text(
                    text = stringResource(R.string.ramo_select_suggestion_help),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall
                )
                Spacer(modifier = Modifier.height(6.dp))
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
                    Spacer(modifier = Modifier.height(6.dp))
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
    }
}
