package br.com.ia4tube.app.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlin.math.pow

@Composable
fun EstimatedCreationProgressCard(
    progressKey: Any,
    running: Boolean,
    title: String,
    subtitle: String,
    explanation: String,
    modifier: Modifier = Modifier,
    hasError: Boolean = false,
    errorTitle: String = title,
    errorSubtitle: String = subtitle
) {
    val startTimeMs = remember(progressKey) { System.currentTimeMillis() }
    var progress by remember(progressKey) { mutableStateOf(0.12f) }

    LaunchedEffect(progressKey, running, hasError) {
        while (running && !hasError && progress < 0.92f) {
            delay(1000)
            val elapsedMs = System.currentTimeMillis() - startTimeMs
            progress = estimatedCreationProgress(elapsedMs)
        }
    }

    val percent = if (hasError) 0 else (progress * 100).toInt().coerceIn(12, 92)

    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = if (hasError) errorTitle else title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = if (hasError) errorSubtitle else subtitle,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (!hasError) {
                Spacer(modifier = Modifier.height(18.dp))
                Text(
                    text = "$percent%",
                    style = MaterialTheme.typography.headlineSmall,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.Bold
                )
                Spacer(modifier = Modifier.height(10.dp))
                LinearProgressIndicator(
                    progress = { progress },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(10.dp))
                Text(
                    text = explanation,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium
                )
            }
        }
    }
}

private fun estimatedCreationProgress(elapsedMs: Long): Float {
    val elapsedSeconds = elapsedMs / 1000f
    val targetSeconds = 105f
    val normalized = (elapsedSeconds / targetSeconds).coerceIn(0f, 1f)
    val eased = 1f - (1f - normalized).pow(2.4f)
    return (0.12f + eased * 0.80f).coerceIn(0.12f, 0.92f)
}
