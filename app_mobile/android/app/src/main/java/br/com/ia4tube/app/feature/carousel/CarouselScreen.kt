package br.com.ia4tube.app.feature.carousel

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.R
import br.com.ia4tube.app.core.share.ShareImageStore
import br.com.ia4tube.app.core.upload.AndroidFileReader
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.CarouselStatus
import br.com.ia4tube.app.data.models.UploadFile
import br.com.ia4tube.app.ui.components.ScreenScaffold
import br.com.ia4tube.app.ui.text.asString
import kotlinx.coroutines.launch

@Composable
fun CarouselScreen(
    viewModel: CarouselViewModel,
    onBack: () -> Unit
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val shareImageStore = ShareImageStore(context)
    val fileReader = remember(context) { AndroidFileReader(context) }
    val scope = rememberCoroutineScope()
    var loadingLogo by remember { mutableStateOf(false) }
    var loadingFotos by remember { mutableStateOf(false) }

    val logoPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            loadingLogo = true
            when (val result = fileReader.readUploadFile(uri)) {
                is ApiResult.Success -> viewModel.setLogo(result.value)
                is ApiResult.Failure -> viewModel.setUploadError(result.message)
            }
            loadingLogo = false
        }
    }

    val photosPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            loadingFotos = true
            handleCarouselPhotos(
                uris = uris,
                currentCount = state.fotos.size,
                fileReader = fileReader,
                onError = viewModel::setUploadError,
                onSuccess = viewModel::addFotos
            )
            loadingFotos = false
        }
    }

    LaunchedEffect(state.downloaded) {
        state.downloaded?.let {
            Toast.makeText(
                context,
                context.getString(R.string.carousel_images_saved, it.imageCount, it.savedPath),
                Toast.LENGTH_LONG
            ).show()
            viewModel.clearDownloaded()
        }
    }

    LaunchedEffect(state.sharePayload) {
        state.sharePayload?.let { payload ->
            try {
                val uris = ArrayList<Uri>(shareImageStore.saveCarouselImages(payload.carrosselId, payload.images))
                if (uris.isNotEmpty()) {
                    val shareClipData = ClipData.newRawUri("Post Deslizante iA4tube", uris.first())
                    uris.drop(1).forEach { uri ->
                        shareClipData.addItem(ClipData.Item(uri))
                    }
                    val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
                        type = "image/*"
                        putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                        if (payload.descricaoInstagram.isNotBlank()) {
                            putExtra(Intent.EXTRA_TEXT, payload.descricaoInstagram)
                        }
                        clipData = shareClipData
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    context.startActivity(Intent.createChooser(intent, context.getString(R.string.carousel_share)))
                } else {
                    Toast.makeText(context, context.getString(R.string.carousel_images_empty_error), Toast.LENGTH_LONG).show()
                }
            } finally {
                viewModel.clearSharePayload()
            }
        }
    }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = stringResource(R.string.carousel_title),
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.ExtraBold
                )
                TextButton(onClick = onBack) {
                    Text(stringResource(R.string.common_back))
                }
            }

            Text(
                text = stringResource(R.string.carousel_subtitle),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.tema,
                onValueChange = viewModel::onTemaChange,
                label = { Text(stringResource(R.string.carousel_theme_required_label)) },
                singleLine = true
            )

            OutlinedTextField(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(160.dp),
                value = state.briefing,
                onValueChange = viewModel::onBriefingChange,
                label = { Text(stringResource(R.string.carousel_briefing_required_label)) },
                placeholder = { Text(stringResource(R.string.carousel_briefing_hint)) }
            )

            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.quantidadeTelas,
                onValueChange = viewModel::onQuantidadeTelasChange,
                label = { Text(stringResource(R.string.carousel_screen_count_required_label)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
            )

            CarouselContentLevelSelector(
                selectedLevel = state.nivelConteudo,
                onSelect = viewModel::onNivelConteudoChange
            )

            CarouselLogoUploadCard(
                logo = state.logo,
                loading = loadingLogo,
                onSelect = { logoPicker.launch("image/*") },
                onRemove = viewModel::removeLogo
            )

            CarouselPhotosUploadCard(
                fotos = state.fotos,
                loading = loadingFotos,
                onSelect = { photosPicker.launch("image/*") },
                onRemove = viewModel::removeFoto
            )

            Button(
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.requesting,
                onClick = viewModel::submit
            ) {
                if (state.requesting) {
                    CircularProgressIndicator(
                        modifier = Modifier.padding(end = 10.dp),
                        strokeWidth = 2.dp
                    )
                }
                Text(
                    text = if (state.requesting) {
                        stringResource(R.string.carousel_sending)
                    } else {
                        stringResource(R.string.carousel_send_to_production)
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }

            state.message?.let { message ->
                Text(
                    text = message.asString(),
                    color = MaterialTheme.colorScheme.primary,
                    style = MaterialTheme.typography.bodyMedium
                )
            }

            state.error?.let { error ->
                Text(
                    text = error.asString(),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium
                )
            }

            CarouselHistorySection(
                state = state,
                onRefreshHistory = { viewModel.refreshHistory() },
                onRefresh = viewModel::refreshStatus,
                onSaveImages = viewModel::saveImages,
                onShareCarousel = viewModel::shareCarousel,
                onCopyDescription = { description ->
                    copyDescription(context, description)
                }
            )

            Spacer(modifier = Modifier.height(18.dp))
        }
    }
}

@Composable
private fun CarouselContentLevelSelector(
    selectedLevel: Int,
    onSelect: (Int) -> Unit
) {
    val levels = listOf(
        Triple(1, stringResource(R.string.carousel_content_level_1_title), stringResource(R.string.carousel_content_level_1_description)),
        Triple(2, stringResource(R.string.carousel_content_level_2_title), stringResource(R.string.carousel_content_level_2_description)),
        Triple(3, stringResource(R.string.carousel_content_level_3_title), stringResource(R.string.carousel_content_level_3_description))
    )

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.45f)),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = stringResource(R.string.carousel_content_level_title),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold
            )
            levels.forEach { (level, title, description) ->
                if (selectedLevel == level) {
                    Button(
                        modifier = Modifier.fillMaxWidth(),
                        onClick = { onSelect(level) }
                    ) {
                        Column(
                            horizontalAlignment = Alignment.Start,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(title, fontWeight = FontWeight.Bold)
                            Text(
                                text = description,
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                    }
                } else {
                    OutlinedButton(
                        modifier = Modifier.fillMaxWidth(),
                        onClick = { onSelect(level) }
                    ) {
                        Column(
                            horizontalAlignment = Alignment.Start,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(title, fontWeight = FontWeight.Bold)
                            Text(
                                text = description,
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CarouselHistorySection(
    state: CarouselUiState,
    onRefreshHistory: () -> Unit,
    onRefresh: (String) -> Unit,
    onSaveImages: (String) -> Unit,
    onShareCarousel: (String, String) -> Unit,
    onCopyDescription: (String) -> Unit
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
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = stringResource(R.string.carousel_history_title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                TextButton(
                    enabled = !state.loadingHistory,
                    onClick = onRefreshHistory
                ) {
                    Text(
                        text = if (state.loadingHistory) {
                            stringResource(R.string.carousel_updating)
                        } else {
                            stringResource(R.string.common_update)
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }

            if (state.loadingHistory && state.carousels.isEmpty()) {
                CircularProgressIndicator(strokeWidth = 2.dp)
            } else if (state.carousels.isEmpty()) {
                Text(
                    text = stringResource(R.string.carousel_history_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                state.carousels.forEach { carousel ->
                    CarouselStatusCard(
                        carousel = carousel,
                        state = state,
                        onRefresh = onRefresh,
                        onSaveImages = onSaveImages,
                        onShareCarousel = onShareCarousel,
                        onCopyDescription = onCopyDescription
                    )
                }
            }
        }
    }
}

@Composable
private fun CarouselStatusCard(
    carousel: CarouselStatus,
    state: CarouselUiState,
    onRefresh: (String) -> Unit,
    onSaveImages: (String) -> Unit,
    onShareCarousel: (String, String) -> Unit,
    onCopyDescription: (String) -> Unit
) {
    val ready = carousel.ready
    val description = carousel.descricaoInstagram

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.25f)),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f))
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = carousel.tema.ifBlank { stringResource(R.string.carousel_status_title) },
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = stringResource(R.string.carousel_id, carousel.carrosselId),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (carousel.quantidadeTelas > 0) {
                Text(
                    text = stringResource(R.string.carousel_screen_count_summary, carousel.quantidadeTelas),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Text(
                text = stringResource(
                    R.string.carousel_status_value,
                    carousel.statusLabel.ifBlank { carousel.status.ifBlank { stringResource(R.string.carousel_status_waiting) } }
                ),
                style = MaterialTheme.typography.bodyMedium,
                color = if (ready) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                TextButton(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !state.checkingStatus,
                    onClick = { onRefresh(carousel.carrosselId) }
                ) {
                    Text(
                        text = if (state.checkingStatus) {
                            stringResource(R.string.carousel_updating)
                        } else {
                            stringResource(R.string.common_update)
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Button(
                    modifier = Modifier.weight(1f),
                    enabled = ready && !state.downloading && !state.sharing,
                    onClick = { onSaveImages(carousel.carrosselId) }
                ) {
                    Text(
                        text = if (state.downloading) {
                            stringResource(R.string.carousel_saving_images)
                        } else {
                            stringResource(R.string.carousel_save_images)
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Button(
                    modifier = Modifier.weight(1f),
                    enabled = ready && !state.sharing && !state.downloading,
                    onClick = { onShareCarousel(carousel.carrosselId, description) }
                ) {
                    Text(
                        text = if (state.sharing) {
                            stringResource(R.string.carousel_sharing)
                        } else {
                            stringResource(R.string.carousel_share)
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }

            if (description.isNotBlank()) {
                Text(
                    text = stringResource(R.string.carousel_description_title),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 8,
                    overflow = TextOverflow.Ellipsis
                )
                TextButton(onClick = { onCopyDescription(description) }) {
                    Text(stringResource(R.string.carousel_copy_description))
                }
            }
        }
    }
}

private fun copyDescription(context: Context, description: String) {
    if (description.isBlank()) return
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("Descricao do Post Deslizante", description))
    Toast.makeText(context, context.getString(R.string.carousel_description_copied), Toast.LENGTH_SHORT).show()
}

@Composable
private fun CarouselLogoUploadCard(
    logo: UploadFile?,
    loading: Boolean,
    onSelect: () -> Unit,
    onRemove: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.45f)),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = stringResource(R.string.carousel_logo_optional),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold
            )
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = !loading,
                onClick = onSelect
            ) {
                Text(
                    text = if (loading) {
                        stringResource(R.string.carousel_loading_image)
                    } else {
                        stringResource(R.string.carousel_select_logo)
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            logo?.let { file ->
                CarouselUploadPreviewItem(
                    index = null,
                    file = file,
                    onRemove = onRemove
                )
            }
        }
    }
}

@Composable
private fun CarouselPhotosUploadCard(
    fotos: List<UploadFile>,
    loading: Boolean,
    onSelect: () -> Unit,
    onRemove: (Int) -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.45f)),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = stringResource(R.string.carousel_photos_optional),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = stringResource(R.string.carousel_photos_limit, CarouselViewModel.MAX_FOTOS_EMPRESA),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = !loading && fotos.size < CarouselViewModel.MAX_FOTOS_EMPRESA,
                onClick = onSelect
            ) {
                Text(
                    text = if (loading) {
                        stringResource(R.string.carousel_loading_image)
                    } else {
                        stringResource(R.string.carousel_select_photos)
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            if (fotos.isEmpty()) {
                Text(
                    text = stringResource(R.string.carousel_photos_empty),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                fotos.forEachIndexed { index, file ->
                    CarouselUploadPreviewItem(
                        index = index + 1,
                        file = file,
                        onRemove = { onRemove(index) }
                    )
                }
            }
        }
    }
}

@Composable
private fun CarouselUploadPreviewItem(
    index: Int?,
    file: UploadFile,
    onRemove: () -> Unit
) {
    val bitmap = remember(file.fileName, file.bytes.size) {
        BitmapFactory.decodeByteArray(file.bytes, 0, file.bytes.size)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (bitmap != null) {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = file.fileName,
                modifier = Modifier
                    .width(72.dp)
                    .aspectRatio(1f),
                contentScale = ContentScale.Crop
            )
            Spacer(modifier = Modifier.width(12.dp))
        }

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = index?.let { stringResource(R.string.carousel_photo_selected, it) }
                    ?: stringResource(R.string.carousel_logo_selected),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = file.fileName,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = stringResource(R.string.carousel_image_size, formatBytes(file.bytes.size)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (file.optimized) {
                Text(
                    text = stringResource(R.string.carousel_image_optimized, formatBytes(file.originalSizeBytes)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        TextButton(onClick = onRemove) {
            Text(stringResource(R.string.common_remove))
        }
    }
}

private suspend fun handleCarouselPhotos(
    uris: List<Uri>,
    currentCount: Int,
    fileReader: AndroidFileReader,
    onError: (String) -> Unit,
    onSuccess: (List<UploadFile>) -> Unit
) {
    val remaining = CarouselViewModel.MAX_FOTOS_EMPRESA - currentCount
    if (remaining <= 0) {
        onError("Você pode adicionar até ${CarouselViewModel.MAX_FOTOS_EMPRESA} fotos.")
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
        onError("Você pode adicionar até ${CarouselViewModel.MAX_FOTOS_EMPRESA} fotos.")
    } else if (errorMessage.isNotBlank()) {
        onError(errorMessage)
    }
}

private fun formatBytes(bytes: Int): String {
    val mb = bytes / (1024.0 * 1024.0)
    if (mb >= 1.0) return "%.2f MB".format(mb)
    val kb = bytes / 1024.0
    return "%.0f KB".format(kb)
}
