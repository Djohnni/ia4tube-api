package br.com.ia4tube.app.feature.monthly_planning

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import br.com.ia4tube.app.data.api.PreviewUrlBuilder
import br.com.ia4tube.app.ui.components.ScreenScaffold
import coil.compose.AsyncImagePainter
import coil.compose.rememberAsyncImagePainter
import coil.request.ImageRequest

@Composable
fun MonthlyPlanningResultsScreen(
    planningId: String,
    viewModel: MonthlyPlanningViewModel,
    previewToken: String,
    onBack: () -> Unit,
    onOpenOrder: (String) -> Unit
) {
    val state by viewModel.uiState.collectAsState()
    val planning = state.detailPlanning?.takeIf { it.id == planningId }
        ?: state.planning.takeIf { it.id == planningId }
    var expandedPost by remember { mutableStateOf<MonthlyPlanningPost?>(null) }

    LaunchedEffect(planningId) {
        viewModel.loadResults(planningId)
    }

    DisposableEffect(planningId) {
        onDispose { viewModel.stopResultsPolling() }
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
                    text = "Suas imagens",
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.ExtraBold
                )
                TextButton(onClick = onBack) {
                    Text("Voltar")
                }
            }

            if (planning == null) {
                CircularProgressIndicator()
                state.uploadError?.let { error ->
                    Text(
                        text = error,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
                return@Column
            }

            MonthlyPlanningResultsHeader(planning = planning)

            if (state.loading && planning.posts.isEmpty()) {
                CircularProgressIndicator()
            }

            if (planning.posts.isEmpty()) {
                Text(
                    text = "Estamos carregando as imagens deste pedido.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                planning.posts.sortedBy { it.number }.forEach { post ->
                    MonthlyPlanningResultPostCard(
                        post = post,
                        previewToken = previewToken,
                        onOpenOrder = onOpenOrder,
                        onExpand = { expandedPost = post }
                    )
                }
            }

            Spacer(modifier = Modifier.height(12.dp))
        }
    }

    expandedPost?.let { post ->
        MonthlyPlanningResultImageDialog(
            post = post,
            previewToken = previewToken,
            onDismiss = { expandedPost = null },
            onOpenOrder = onOpenOrder
        )
    }
}

@Composable
private fun MonthlyPlanningResultsHeader(planning: MonthlyPlanningSummary) {
    val readyCount = planning.readyResultPosts.size
    val totalCount = planning.effectiveTotalPosts
    val message = if (planning.isFullyReadyForViewing()) {
        "Seu pedido foi concluído."
    } else {
        "Seu pedido já possui imagens prontas para visualizar."
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = Color(0xFFF6E8C9)),
        shape = RoundedCornerShape(18.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(
                text = "Resultado do pedido",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.ExtraBold,
                color = Color(0xFF4A2A00)
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF5A4630)
            )
            if (totalCount > 0) {
                Text(
                    text = "$readyCount de $totalCount prontas",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFF5A4630),
                    fontWeight = FontWeight.SemiBold
                )
            }
        }
    }
}

@Composable
private fun MonthlyPlanningResultPostCard(
    post: MonthlyPlanningPost,
    previewToken: String,
    onOpenOrder: (String) -> Unit,
    onExpand: () -> Unit
) {
    val canOpen = post.imageReady && post.pedidoId.isNotBlank()

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(18.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Arte ${post.number}",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = if (canOpen) "Pronta" else "Em produção",
                    color = if (canOpen) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    fontWeight = FontWeight.SemiBold
                )
            }

            if (post.objective.isNotBlank()) {
                Text(
                    text = post.objective,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            if (canOpen) {
                MonthlyPlanningResultImage(
                    post = post,
                    previewToken = previewToken,
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(9f / 16f)
                        .clip(RoundedCornerShape(14.dp))
                        .clickable(onClick = onExpand)
                )
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { onOpenOrder(post.pedidoId) }
                ) {
                    Text("Ver arte")
                }
            } else {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(9f / 16f)
                        .clip(RoundedCornerShape(14.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f)),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(modifier = Modifier.size(28.dp))
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = "Em produção",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MonthlyPlanningResultImageDialog(
    post: MonthlyPlanningPost,
    previewToken: String,
    onDismiss: () -> Unit,
    onOpenOrder: (String) -> Unit
) {
    Dialog(onDismissRequest = onDismiss) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(18.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            Column(
                modifier = Modifier.padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                MonthlyPlanningResultImage(
                    post = post,
                    previewToken = previewToken,
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(9f / 16f)
                        .clip(RoundedCornerShape(14.dp))
                )
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { onOpenOrder(post.pedidoId) }
                ) {
                    Text("Abrir arte")
                }
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = onDismiss
                ) {
                    Text("Fechar")
                }
            }
        }
    }
}

@Composable
private fun MonthlyPlanningResultImage(
    post: MonthlyPlanningPost,
    previewToken: String,
    modifier: Modifier = Modifier
) {
    val previewUrl = post.resultImageUrl()
    val context = LocalContext.current
    val imageRequest = remember(previewUrl, previewToken) {
        ImageRequest.Builder(context)
            .data(previewUrl)
            .crossfade(true)
            .apply {
                if (previewToken.isNotBlank() && PreviewUrlBuilder.shouldSendAuthorization(previewUrl)) {
                    addHeader("Authorization", "Bearer $previewToken")
                }
            }
            .build()
    }
    val painter = rememberAsyncImagePainter(model = imageRequest)
    val painterState = painter.state

    Box(
        modifier = modifier.background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f)),
        contentAlignment = Alignment.Center
    ) {
        if (previewUrl.isNotBlank() && painterState !is AsyncImagePainter.State.Error) {
            Image(
                painter = painter,
                contentDescription = "Arte ${post.number}",
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop
            )
        } else {
            Text(
                text = "Imagem pronta",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium
            )
        }
    }
}

private fun MonthlyPlanningPost.resultImageUrl(): String {
    return thumbnailUrl.ifBlank {
        if (pedidoId.isNotBlank()) PreviewUrlBuilder.build(pedidoId) else ""
    }
}
