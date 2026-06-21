package br.com.ia4tube.app.feature.monthly_planning

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.core.upload.AndroidFileReader
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.MonthlyPlanningPhotoInput
import br.com.ia4tube.app.data.models.UploadFile
import br.com.ia4tube.app.ui.components.ScreenScaffold
import kotlinx.coroutines.launch

@Composable
fun MonthlyPlanningScreen(
    viewModel: MonthlyPlanningViewModel,
    onBack: () -> Unit,
    onOpenDetail: (String) -> Unit
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val fileReader = remember(context) { AndroidFileReader(context) }
    val scope = rememberCoroutineScope()
    var loadingPhotos by remember { mutableStateOf(false) }

    val photosPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            loadingPhotos = true
            val files = readPlanningPhotos(uris, fileReader, viewModel::setUploadError)
            viewModel.addPhotos(files)
            loadingPhotos = false
        }
    }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            MonthlyPlanningHeader(onBack = onBack)

            when (state.step) {
                MonthlyPlanningStep.Entry -> MonthlyPlanningEntryStep(
                    state = state,
                    onReservedChange = viewModel::onReservedInputChange,
                    onContinue = viewModel::goToUpload,
                    onOpenDetail = onOpenDetail
                )

                MonthlyPlanningStep.Upload -> MonthlyPlanningUploadStep(
                    state = state,
                    loadingPhotos = loadingPhotos,
                    onSelectPhotos = { photosPicker.launch("image/*") },
                    onPhotoOrientationChange = viewModel::updatePhotoOrientation,
                    onRemovePhoto = viewModel::removePhoto,
                    onBack = viewModel::backToEntry,
                    onContinue = viewModel::goToConfirmation
                )

                MonthlyPlanningStep.Confirmation -> MonthlyPlanningConfirmationStep(
                    state = state,
                    onBack = viewModel::backToUpload,
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

@Composable
private fun MonthlyPlanningHeader(onBack: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = "Planejamento Mensal",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.ExtraBold
        )
        TextButton(onClick = onBack) {
            Text("Voltar")
        }
    }
    Text(
        text = "A iA4tube monta um mês de postagens para sua empresa usando suas fotos e seus dados.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
}

@Composable
private fun MonthlyPlanningEntryStep(
    state: MonthlyPlanningUiState,
    onReservedChange: (String) -> Unit,
    onContinue: () -> Unit,
    onOpenDetail: (String) -> Unit
) {
    val planningPreviewText = if (state.reservedArts > 0) {
        "Você vai reservar ${state.reservedArts} artes.\n${state.freeArts} continuarão livres para Criar Arte."
    } else {
        "${state.freeArts} artes livres para Criar Arte agora."
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        MonthlyPlanningNumbersCard(
            cycleArts = state.cycleArts,
            reservedArts = state.reservedArts,
            freeArts = state.freeArts
        )

        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(18.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text(
                    text = "Quantas artes deseja reservar para o planejamento?",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                OutlinedTextField(
                    modifier = Modifier.fillMaxWidth(),
                    value = state.reservedInput,
                    onValueChange = onReservedChange,
                    label = { Text("Artes para reservar") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
                )
                Text(
                    text = "As artes reservadas serão usadas neste planejamento.\nAs demais continuam livres para Criar Arte.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = planningPreviewText,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold
                )
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = onContinue
                ) {
                    Text("Continuar")
                }
            }
        }

        MonthlyPlanningListStep(
            plannings = state.plannings,
            loading = state.loading,
            onOpenDetail = onOpenDetail
        )
    }
}

@Composable
private fun MonthlyPlanningUploadStep(
    state: MonthlyPlanningUiState,
    loadingPhotos: Boolean,
    onSelectPhotos: () -> Unit,
    onPhotoOrientationChange: (Int, String) -> Unit,
    onRemovePhoto: (Int) -> Unit,
    onBack: () -> Unit,
    onContinue: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.32f))
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                text = "Envie fotos da sua empresa",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.ExtraBold
            )
            Text(
                text = "Pode ser foto de produto, ambiente, fachada, equipe ou serviço.\nEnvie o que tiver. A iA4tube analisa e monta o planejamento para você.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = !loadingPhotos,
                onClick = onSelectPhotos
            ) {
                Text(if (loadingPhotos) "Carregando fotos..." else "Selecionar fotos")
            }
            if (state.photos.isEmpty()) {
                Text(
                    text = "Nenhuma foto selecionada ainda.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                state.photos.forEachIndexed { index, photo ->
                    PlanningPhotoRow(
                        index = index + 1,
                        photo = photo,
                        onOrientationChange = { value -> onPhotoOrientationChange(index, value) },
                        onRemove = { onRemovePhoto(index) }
                    )
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                OutlinedButton(
                    modifier = Modifier.weight(1f),
                    onClick = onBack
                ) {
                    Text("Voltar")
                }
                Button(
                    modifier = Modifier.weight(1f),
                    onClick = onContinue
                ) {
                    Text("Continuar")
                }
            }
        }
    }
}

@Composable
private fun MonthlyPlanningConfirmationStep(
    state: MonthlyPlanningUiState,
    onBack: () -> Unit,
    onConfirm: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                text = "Confirmar planejamento",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.ExtraBold
            )
            Text(
                text = "Você vai reservar ${state.reservedArts} artes para o Planejamento Mensal.",
                style = MaterialTheme.typography.bodyMedium
            )
            MonthlyPlanningNumbersCard(
                cycleArts = state.cycleArts,
                reservedArts = state.reservedArts,
                freeArts = state.freeArts
            )
            Text(
                text = "${state.photos.size} fotos selecionadas para orientar o planejamento.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                OutlinedButton(
                    modifier = Modifier.weight(1f),
                    onClick = onBack
                ) {
                    Text("Voltar")
                }
                Button(
                    modifier = Modifier.weight(1f),
                    onClick = onConfirm
                ) {
                    Text("Confirmar")
                }
            }
        }
    }
}

@Composable
private fun MonthlyPlanningProcessingStep(onShowPlans: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                text = "Seu planejamento está sendo criado",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.ExtraBold
            )
            Text("Analisando suas fotos...")
            Text("Entendendo seu ramo...")
            Text("Montando temas e datas...")
            Button(
                modifier = Modifier.fillMaxWidth(),
                onClick = onShowPlans
            ) {
                Text("Ver Meus Planejamentos")
            }
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
            text = "Meus Planejamentos",
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
                    text = planning.title,
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

@Composable
private fun MonthlyPlanningNumbersCard(
    cycleArts: Int,
    reservedArts: Int,
    freeArts: Int
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f))
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            PlanningNumberLine(label = "Artes deste ciclo", value = cycleArts.toString())
            HorizontalDivider()
            PlanningNumberLine(label = "Reservadas no Planejamento", value = reservedArts.toString())
            PlanningNumberLine(label = "Livres para Criar Arte", value = freeArts.toString())
        }
    }
}

@Composable
private fun PlanningNumberLine(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = value,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.ExtraBold
        )
    }
}

@Composable
private fun PlanningPhotoRow(
    index: Int,
    photo: MonthlyPlanningPhotoInput,
    onOrientationChange: (String) -> Unit,
    onRemove: () -> Unit
) {
    val file = photo.file
    val bitmap = remember(file.fileName, file.bytes.size) {
        BitmapFactory.decodeByteArray(file.bytes, 0, file.bytes.size)
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.42f))
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = "Foto $index",
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Bold
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (bitmap != null) {
                    Image(
                        bitmap = bitmap.asImageBitmap(),
                        contentDescription = "Foto $index do Planejamento Mensal",
                        modifier = Modifier
                            .width(96.dp)
                            .aspectRatio(1f),
                        contentScale = ContentScale.Crop
                    )
                }

                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = file.fileName,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = "${file.bytes.size / 1024} KB",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            Text(
                text = "Quer adicionar alguma informação ou direcionar a publicação?",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold
            )
            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = photo.orientacao,
                onValueChange = onOrientationChange,
                placeholder = { Text("Ex: usar essa foto para promoção") },
                minLines = 2,
                maxLines = 4
            )
            TextButton(
                onClick = onRemove,
                modifier = Modifier.align(Alignment.End)
            ) {
                Text("Remover")
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
