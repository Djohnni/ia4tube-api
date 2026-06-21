package br.com.ia4tube.app.feature.plans

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.data.models.BillingPixResult
import br.com.ia4tube.app.ui.components.ScreenScaffold

private val planExampleAssets = listOf(
    "exemplo_plano_1.jpeg",
    "exemplo_plano_2.jpeg",
    "exemplo_plano_3.jpeg",
    "exemplo_plano_4.jpeg",
    "exemplo_plano_5.jpeg",
    "exemplo_plano_6.jpeg"
)

@Composable
fun PlansScreen(
    viewModel: PlansViewModel,
    onBack: () -> Unit
) {
    val state by viewModel.uiState.collectAsState()
    val accent = MaterialTheme.colorScheme.primary
    val buttonTextColor = if (accent.luminance() < 0.45f) Color.White else Color(0xFF11100A)
    val background = Color(0xFFFFFCF6)
    val cardColor = Color.White
    val softCardColor = Color(0xFFFFFAEF)
    val primaryText = Color(0xFF151515)
    val secondaryText = Color(0xFF4B5563)

    state.pix?.let { pix ->
        PixPaymentDialog(
            pix = pix,
            onDismiss = viewModel::clearPix
        )
    }

    ScreenScaffold(containerColor = background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(background)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Escolha como deseja criar suas artes",
                        color = primaryText,
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.ExtraBold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = "Compre 1 arte avulsa ou escolha um plano mensal com beneficios completos.",
                        color = secondaryText,
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
                TextButton(onClick = onBack) {
                    Text("Voltar")
                }
            }

            if (state.errorMessage.isNotBlank()) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFFFFEDEA))
                ) {
                    Text(
                        text = state.errorMessage,
                        color = Color(0xFF991B1B),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(12.dp)
                    )
                }
            }

            StandaloneArtCard(
                accent = accent,
                buttonTextColor = buttonTextColor,
                cardColor = cardColor,
                softCardColor = softCardColor,
                primaryText = primaryText,
                secondaryText = secondaryText,
                loading = state.loadingAction == "arte_avulsa",
                onBuyArt = { viewModel.comprarArteAvulsa() }
            )

            Text(
                text = "Planos iA4tube",
                color = primaryText,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.ExtraBold,
                modifier = Modifier.padding(top = 4.dp)
            )

            PlanCard(
                planId = "i4_essencial",
                name = "i4 Essencial",
                price = "R$ 39,90",
                arts = "6 artes para postar por mês",
                benefit = "3 Materiais Gráficos da Empresa por mês",
                description = "Inclui:",
                options = listOf(
                    "1 Post Deslizante por mês",
                    "Suporte via WhatsApp"
                ),
                accent = accent,
                buttonTextColor = buttonTextColor,
                cardColor = cardColor,
                softCardColor = softCardColor,
                primaryText = primaryText,
                secondaryText = secondaryText,
                loading = state.loadingAction == "i4_essencial",
                onSubscribe = viewModel::assinarPlano
            )
            PlanCard(
                planId = "i4_profissional",
                name = "i4 Profissional",
                price = "R$ 79,90",
                arts = "16 artes para postar por mês",
                benefit = "5 Materiais Gráficos da Empresa por mês",
                description = "Inclui:",
                options = listOf(
                    "1 Material Gráfico de Nicho por mês",
                    "2 Posts Deslizantes por mês",
                    "Suporte via WhatsApp"
                ),
                accent = accent,
                buttonTextColor = buttonTextColor,
                cardColor = cardColor,
                softCardColor = softCardColor,
                primaryText = primaryText,
                secondaryText = secondaryText,
                loading = state.loadingAction == "i4_profissional",
                onSubscribe = viewModel::assinarPlano
            )
            PlanCard(
                planId = "i4_empresarial",
                name = "i4 Empresarial",
                price = "R$ 149,90",
                arts = "36 artes para postar por mês",
                benefit = "Todos os Materiais Gráficos Gerais liberados",
                description = "Inclui:",
                options = listOf(
                    "3 Materiais Gráficos de Nicho por mês",
                    "4 Posts Deslizantes por mês",
                    "Suporte via WhatsApp"
                ),
                accent = accent,
                buttonTextColor = buttonTextColor,
                cardColor = cardColor,
                softCardColor = softCardColor,
                primaryText = primaryText,
                secondaryText = secondaryText,
                loading = state.loadingAction == "i4_empresarial",
                onSubscribe = viewModel::assinarPlano
            )

            PlanExamplesSection(
                accent = accent,
                cardColor = cardColor,
                softCardColor = softCardColor,
                primaryText = primaryText,
                secondaryText = secondaryText
            )
        }
    }
}

@Composable
private fun PixPaymentDialog(
    pix: BillingPixResult,
    onDismiss: () -> Unit
) {
    val clipboard = LocalClipboardManager.current
    val qrBitmap = remember(pix.qrCodeBase64) {
        decodeQrCodeBase64(pix.qrCodeBase64)
    }
    val title = when {
        pix.planName.isNotBlank() -> "Pix do ${pix.planName}"
        pix.tipo == "arte_avulsa_pix" || pix.purchaseId.isNotBlank() -> "Pix da arte avulsa"
        else -> "Pix para adicionar saldo"
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = title,
                fontWeight = FontWeight.ExtraBold
            )
        },
        text = {
            Column(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                qrBitmap?.let { bitmap ->
                    Image(
                        bitmap = bitmap.asImageBitmap(),
                        contentDescription = "QR Code Pix",
                        modifier = Modifier.size(220.dp)
                    )
                }
                Text(
                    text = "Depois do pagamento, sua compra sera liberada automaticamente quando o Mercado Pago confirmar.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium
                )
                if (pix.pixCopiaCola.isNotBlank()) {
                    Text(
                        text = pix.pixCopiaCola,
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 4,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        },
        confirmButton = {
            Button(
                enabled = pix.pixCopiaCola.isNotBlank(),
                onClick = {
                    clipboard.setText(AnnotatedString(pix.pixCopiaCola))
                }
            ) {
                Text("Copiar Pix")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Fechar")
            }
        }
    )
}

private fun decodeQrCodeBase64(value: String) = runCatching {
    val cleanValue = value.substringAfter("base64,", value)
    val bytes = Base64.decode(cleanValue, Base64.DEFAULT)
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
}.getOrNull()

@Composable
private fun StandaloneArtCard(
    accent: Color,
    buttonTextColor: Color,
    cardColor: Color,
    softCardColor: Color,
    primaryText: Color,
    secondaryText: Color,
    loading: Boolean,
    onBuyArt: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.2.dp, accent.copy(alpha = 0.52f), RoundedCornerShape(18.dp)),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = cardColor),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    Brush.verticalGradient(
                        colors = listOf(
                            accent.copy(alpha = 0.08f),
                            softCardColor,
                            cardColor
                        )
                    )
                )
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = "Arte avulsa",
                color = primaryText,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.ExtraBold
            )
            Text(
                text = "Quer criar sem assinatura? Compre uma arte pronta para postar.",
                color = secondaryText,
                style = MaterialTheme.typography.bodyMedium
            )
            Text(
                text = "1 arte por R$ 1,99",
                color = accent,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.ExtraBold
            )
            Button(
                onClick = onBuyArt,
                enabled = !loading,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = accent,
                    contentColor = buttonTextColor
                ),
                shape = RoundedCornerShape(999.dp)
            ) {
                if (loading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = buttonTextColor
                    )
                } else {
                    Text(
                        text = "Comprar 1 arte por R$ 1,99",
                        fontWeight = FontWeight.ExtraBold
                    )
                }
            }
        }
    }
}

@Composable
private fun PlanCard(
    planId: String,
    name: String,
    price: String,
    arts: String,
    benefit: String,
    description: String,
    options: List<String>,
    accent: Color,
    buttonTextColor: Color,
    cardColor: Color,
    softCardColor: Color,
    primaryText: Color,
    secondaryText: Color,
    loading: Boolean,
    onSubscribe: (String) -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.2.dp, accent.copy(alpha = 0.46f), RoundedCornerShape(18.dp)),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = cardColor),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    Brush.verticalGradient(
                        colors = listOf(
                            accent.copy(alpha = 0.06f),
                            softCardColor,
                            cardColor
                        )
                    )
                )
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top
            ) {
                Text(
                    text = name,
                    color = primaryText,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.ExtraBold,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    text = price,
                    color = accent,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.ExtraBold
                )
            }

            Text(
                text = arts.uppercase(),
                color = primaryText,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Bold
            )
            Text(
                text = description,
                color = primaryText,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold
            )

            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(
                    text = "- $benefit",
                    color = secondaryText,
                    style = MaterialTheme.typography.bodyMedium
                )
                options.forEach { option ->
                    Text(
                        text = "- $option",
                        color = secondaryText,
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
            }

            Spacer(modifier = Modifier.height(2.dp))

            Button(
                onClick = { onSubscribe(planId) },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = accent,
                    contentColor = buttonTextColor
                ),
                shape = RoundedCornerShape(999.dp)
            ) {
                if (loading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = buttonTextColor
                    )
                } else {
                    Text(
                        text = "Assinar",
                        fontWeight = FontWeight.ExtraBold
                    )
                }
            }
        }
    }
}

@Composable
private fun PlanExamplesSection(
    accent: Color,
    cardColor: Color,
    softCardColor: Color,
    primaryText: Color,
    secondaryText: Color
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text(
            text = "Exemplos de artes",
            color = primaryText,
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.ExtraBold
        )
        Text(
            text = "Quando os arquivos JPEG estiverem no app, eles aparecem aqui automaticamente.",
            color = secondaryText,
            style = MaterialTheme.typography.bodyMedium
        )
        planExampleAssets.chunked(2).forEach { rowItems ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                rowItems.forEach { assetName ->
                    PlanExampleCard(
                        assetName = assetName,
                        accent = accent,
                        cardColor = cardColor,
                        softCardColor = softCardColor,
                        secondaryText = secondaryText,
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
private fun PlanExampleCard(
    assetName: String,
    accent: Color,
    cardColor: Color,
    softCardColor: Color,
    secondaryText: Color,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val bitmap = remember(assetName) {
        runCatching {
            context.assets.open(assetName).use { input ->
                BitmapFactory.decodeStream(input)?.asImageBitmap()
            }
        }.getOrNull()
    }

    Card(
        modifier = modifier
            .aspectRatio(0.78f)
            .border(1.dp, accent.copy(alpha = 0.28f), RoundedCornerShape(16.dp)),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = cardColor),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        if (bitmap != null) {
            Image(
                bitmap = bitmap,
                contentDescription = assetName,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop
            )
        } else {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(
                        Brush.verticalGradient(
                            colors = listOf(
                                accent.copy(alpha = 0.08f),
                                softCardColor,
                                cardColor
                            )
                        )
                    )
                    .padding(12.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = assetName,
                    color = secondaryText,
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Bold
                )
            }
        }
    }
}
