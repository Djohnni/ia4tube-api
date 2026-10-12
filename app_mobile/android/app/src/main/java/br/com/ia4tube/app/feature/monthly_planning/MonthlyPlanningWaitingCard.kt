package br.com.ia4tube.app.feature.monthly_planning

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.feature.instagram.instagramReadableForeground

// Presentation only: no timer, percentage, request, retry or production state is created here.
@Composable
internal fun MonthlyPlanningWaitingCard(awaitingConfirmation: Boolean) {
    val scheme = MaterialTheme.colorScheme
    val background = scheme.surface
    val foreground = instagramReadableForeground(scheme.onSurface, background)
    val accent = instagramReadableForeground(scheme.primary, background)
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = background, contentColor = foreground)
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = if (awaitingConfirmation) "Aguardando confirmação do pedido" else "Acompanhando seu pedido",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            Text(if (awaitingConfirmation)
                "Aguarde a confirmação e a consulta dos dados do pedido. Não envie novamente."
                else "Aguardando imagens prontas. O andamento depende da produção.")
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth(),
                color = accent,
                trackColor = foreground.copy(alpha = 0.12f)
            )
            Text("Esta indicação é de espera, não uma porcentagem de conclusão.",
                style = MaterialTheme.typography.bodySmall)
        }
    }
}
