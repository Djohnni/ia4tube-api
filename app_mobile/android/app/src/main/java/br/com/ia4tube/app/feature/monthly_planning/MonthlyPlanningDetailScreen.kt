package br.com.ia4tube.app.feature.monthly_planning

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.ui.components.ScreenScaffold

@Composable
fun MonthlyPlanningDetailScreen(
    planningId: String,
    viewModel: MonthlyPlanningViewModel,
    onBack: () -> Unit,
    onOpenOrder: (String) -> Unit
) {
    val state by viewModel.uiState.collectAsState()
    LaunchedEffect(planningId) {
        viewModel.loadDetail(planningId)
    }

    val planning = state.detailPlanning
        ?: MonthlyPlanningMockData.summary.takeIf { it.id == planningId }
        ?: state.planning
    var selectedTab by remember { mutableStateOf(MonthlyPlanningDetailTab.List) }

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
                    text = planning.title,
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.ExtraBold
                )
                TextButton(onClick = onBack) {
                    Text("Voltar")
                }
            }

            if (state.loading) {
                CircularProgressIndicator()
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                PlanningTabButton(
                    text = "Lista",
                    selected = selectedTab == MonthlyPlanningDetailTab.List,
                    onClick = { selectedTab = MonthlyPlanningDetailTab.List },
                    modifier = Modifier.weight(1f)
                )
                PlanningTabButton(
                    text = "Calendário",
                    selected = selectedTab == MonthlyPlanningDetailTab.Calendar,
                    onClick = { selectedTab = MonthlyPlanningDetailTab.Calendar },
                    modifier = Modifier.weight(1f)
                )
            }

            when (selectedTab) {
                MonthlyPlanningDetailTab.List -> MonthlyPlanningPostsList(
                    posts = planning.posts,
                    onOpenOrder = onOpenOrder
                )
                MonthlyPlanningDetailTab.Calendar -> MonthlyPlanningCalendar(planning.posts)
            }

            Spacer(modifier = Modifier.height(18.dp))
        }
    }
}

private enum class MonthlyPlanningDetailTab {
    List,
    Calendar
}

@Composable
private fun PlanningTabButton(
    text: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    if (selected) {
        Button(
            modifier = modifier,
            onClick = onClick
        ) {
            Text(text)
        }
    } else {
        OutlinedButton(
            modifier = modifier,
            onClick = onClick
        ) {
            Text(text)
        }
    }
}

@Composable
private fun MonthlyPlanningPostsList(
    posts: List<MonthlyPlanningPost>,
    onOpenOrder: (String) -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        posts.forEach { post ->
            MonthlyPlanningPostCard(
                post = post,
                onOpenOrder = onOpenOrder
            )
        }
    }
}

@Composable
private fun MonthlyPlanningCalendar(posts: List<MonthlyPlanningPost>) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            text = "Calendário mensal",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.ExtraBold
        )
        posts.chunked(2).forEach { rowPosts ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                rowPosts.forEach { post ->
                    CalendarPostCard(
                        post = post,
                        modifier = Modifier.weight(1f)
                    )
                }
                if (rowPosts.size == 1) {
                    Spacer(modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun MonthlyPlanningPostCard(
    post: MonthlyPlanningPost,
    onOpenOrder: (String) -> Unit
) {
    val clipboardManager = LocalClipboardManager.current
    val canOpenOrder = post.imageReady && post.pedidoId.isNotBlank()
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(
                text = "Postagem ${post.number}",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            Text(post.dateLabel)
            if (post.theme.isNotBlank()) {
                Text("Tema: ${post.theme}")
            }
            Text("Objetivo: ${post.objective}")
            Text(
                text = "Status: ${post.status}",
                color = if (post.status == "Pronta") {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                fontWeight = FontWeight.SemiBold
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedButton(
                    modifier = Modifier.weight(1f),
                    enabled = canOpenOrder,
                    onClick = { onOpenOrder(post.pedidoId) }
                ) {
                    Text("Ver arte", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                OutlinedButton(
                    modifier = Modifier.weight(1f),
                    enabled = canOpenOrder,
                    onClick = { onOpenOrder(post.pedidoId) }
                ) {
                    Text("Baixar", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = post.caption.isNotBlank(),
                onClick = { clipboardManager.setText(AnnotatedString(post.caption)) }
            ) {
                Text("Copiar legenda")
            }
        }
    }
}

@Composable
private fun CalendarPostCard(
    post: MonthlyPlanningPost,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier,
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f))
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(
                text = post.dateLabel,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Bold
            )
            Text(
                text = "Postagem ${post.number}",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = post.status,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
