package br.com.ia4tube.app.feature.plans

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.style.TextOverflow
import br.com.ia4tube.app.data.models.BillingPixResult
import br.com.ia4tube.app.feature.home.PremiumHomePalette
import br.com.ia4tube.app.feature.home.PremiumHomeTheme
import br.com.ia4tube.app.feature.home.premiumHomePalette
import br.com.ia4tube.app.ui.components.ScreenScaffold

@Composable
fun PlansScreen(viewModel: PlansViewModel, onBack: () -> Unit,
    palette: PremiumHomePalette = premiumHomePalette(PremiumHomeTheme.Black)) {
    val state by viewModel.uiState.collectAsState()
    state.pix?.let { PixPaymentDialog(pix = it, onDismiss = viewModel::clearPix) }
    ComboPlansContent(state, palette, onBack, viewModel::assinarPlano)
}

/** Lightweight native presentation; reuses the existing Pix callback and the Home palette. */
@Composable
internal fun ComboPlansContent(state: PlansUiState, palette: PremiumHomePalette,
    onBack: () -> Unit, onChoose: (String) -> Unit) {
    ScreenScaffold(containerColor = palette.screenBackground) {
        Column(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(
            palette.panelGradient.first(), palette.screenBackground, palette.screenBackground
        ))).verticalScroll(rememberScrollState()).padding(vertical = 12.dp)
            .testTag("combo_page"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack, modifier = Modifier.testTag("combo_back")) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "Voltar", tint = palette.primaryBorder)
                }
                Column(Modifier.weight(1f).padding(start = 4.dp)) {
                    Text("Combos", color = palette.textPrimary, fontSize = 25.sp, lineHeight = 31.sp, fontWeight = FontWeight.Bold)
                    Text("Escolha seu plano mensal", color = palette.textSecondary, fontSize = 13.sp, lineHeight = 19.sp)
                }
            }
            if (state.errorMessage.isNotBlank()) {
                Text(state.errorMessage, color = palette.textPrimary, fontSize = 14.sp, lineHeight = 21.sp,
                    modifier = Modifier.fillMaxWidth().background(palette.cameraBackground, RoundedCornerShape(14.dp))
                        .border(1.dp, palette.panelBorder, RoundedCornerShape(14.dp)).padding(14.dp).testTag("combo_error"))
            }
            mediaCombos.forEach { offer ->
                ComboOfferCard(offer, state.loadingAction, palette, onChoose)
            }
            Text("Conecte seu Instagram e escolha data e horário.", color = palette.textSecondary, fontSize = 12.sp, lineHeight = 18.sp,
                modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 2.dp, bottom = 16.dp))
        }
    }
}

@Composable
private fun ComboOfferCard(offer: ComboOffer, loadingAction: String, palette: PremiumHomePalette,
    onChoose: (String) -> Unit) {
    val shape = RoundedCornerShape(22.dp)
    Column(Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(
        palette.cameraBackground, palette.screenBackground
    )), shape).border(1.dp, palette.primaryBorder.copy(alpha = 0.35f), shape)
        .padding(18.dp).testTag("combo_card_${offer.id}"),
        verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Text(offer.title, color = palette.textPrimary, fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold)
        Text(offer.allowance, color = palette.textSecondary, fontSize = 15.sp, lineHeight = 22.sp,
            modifier = Modifier.testTag("combo_allowance_${offer.id}"))
        Text("+ Postagem automática no Instagram", color = palette.textSecondary, fontSize = 12.sp, lineHeight = 18.sp,
            modifier = Modifier.testTag("combo_auto_${offer.id}"))
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val stack = maxWidth < 270.dp || LocalDensity.current.fontScale > 1.25f
            if (stack) Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                ComboPrice(offer, palette)
                ComboChooseButton(offer, loadingAction, palette, onChoose, Modifier.fillMaxWidth())
            } else Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically) {
                ComboPrice(offer, palette)
                ComboChooseButton(offer, loadingAction, palette, onChoose)
            }
        }
    }
}

@Composable
private fun ComboPrice(offer: ComboOffer, palette: PremiumHomePalette) {
    val amount: @Composable () -> Unit = {
        Text("R$ ${offer.priceReais}", color = palette.primaryBorder, fontSize = 29.sp, lineHeight = 36.sp,
            fontWeight = FontWeight.ExtraBold, maxLines = 1, modifier = Modifier.testTag("combo_price_${offer.id}"))
    }
    val cycle: @Composable () -> Unit = {
        Text("/mês", color = palette.textSecondary, fontSize = 12.sp, lineHeight = 18.sp, maxLines = 1,
            modifier = Modifier.padding(bottom = 4.dp))
    }
    if (LocalDensity.current.fontScale >= 1.75f) Column { amount(); cycle() }
    else Row(verticalAlignment = Alignment.Bottom) { amount(); Spacer(Modifier.width(4.dp)); cycle() }
}

@Composable
private fun ComboChooseButton(offer: ComboOffer, loadingAction: String, palette: PremiumHomePalette,
    onChoose: (String) -> Unit, modifier: Modifier = Modifier) {
    val accent = palette.primaryBorder
    val buttonText = if (accent.luminance() > 0.45f) Color(0xFF21170A) else Color.White
    Button(onClick = { onChoose(offer.id) }, enabled = loadingAction.isBlank(),
        modifier = modifier.heightIn(min = 48.dp).testTag("combo_choose_${offer.id}"), shape = RoundedCornerShape(13.dp),
        colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = buttonText,
            disabledContainerColor = accent.copy(alpha = 0.45f), disabledContentColor = palette.textSecondary)) {
        if (loadingAction == offer.id) CircularProgressIndicator(Modifier.size(17.dp), strokeWidth = 2.dp, color = palette.textPrimary)
        else Text("Escolher", fontSize = 14.sp, lineHeight = 21.sp, fontWeight = FontWeight.Bold)
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
        pix.planName.isNotBlank() -> "Pix do combo ${pix.planName}"
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
