package br.com.ia4tube.app.feature.orders

import android.content.Intent
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImagePainter
import coil.compose.rememberAsyncImagePainter
import coil.request.ImageRequest
import br.com.ia4tube.app.R
import br.com.ia4tube.app.core.analytics.MobileAnalytics
import br.com.ia4tube.app.core.share.ShareImageStore
import br.com.ia4tube.app.data.api.PreviewUrlBuilder
import br.com.ia4tube.app.data.models.OrderInfo
import br.com.ia4tube.app.data.models.PaymentInfo
import br.com.ia4tube.app.ui.components.EstimatedCreationProgressCard
import br.com.ia4tube.app.ui.components.ScreenScaffold
import br.com.ia4tube.app.ui.text.UiText
import br.com.ia4tube.app.ui.text.asString
import java.text.Normalizer

@Composable
fun OrderDetailScreen(
    viewModel: OrderDetailViewModel,
    onBack: () -> Unit
) {
    val state by viewModel.uiState.collectAsState()
    var showAdjustmentDialog by remember { mutableStateOf(false) }
    var adjustmentText by remember { mutableStateOf("") }
    val clipboardManager = LocalClipboardManager.current
    val uriHandler = LocalUriHandler.current
    val context = LocalContext.current
    val shareImageStore = remember { ShareImageStore(context.applicationContext) }

    LaunchedEffect(state.sharePayload) {
        val payload = state.sharePayload ?: return@LaunchedEffect
        val imageUri = shareImageStore.saveShareImage(payload.pedidoId, payload.image)
        val description = if (payload.description.isNotBlank() && !payload.description.isGenericPostDescription()) {
            payload.description
        } else {
            state.info?.let { finalPostDescription(it) }.orEmpty()
        }
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = payload.image.contentType.ifBlank { "image/png" }
            putExtra(Intent.EXTRA_STREAM, imageUri)
            putExtra(Intent.EXTRA_TEXT, description)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(shareIntent, context.getString(R.string.order_share_image)))
        viewModel.clearSharePayload()
    }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
        ) {
            Text(stringResource(R.string.order_detail_title), style = MaterialTheme.typography.headlineSmall)
            Spacer(modifier = Modifier.height(12.dp))
            OutlinedButton(onClick = onBack) {
                Text(stringResource(R.string.common_back))
            }
            Spacer(modifier = Modifier.height(16.dp))

            when {
                state.loading -> CircularProgressIndicator()
                state.info != null -> {
                    OrderInfoCard(
                        info = state.info,
                        paymentInfo = state.paymentInfo,
                        downloading = state.downloading,
                        sharing = state.sharing,
                        requestingAdjustment = state.requestingAdjustment,
                        generatingPix = state.generatingPix,
                        payingWithBalance = state.payingWithBalance,
                        polling = state.polling,
                        manualRefreshing = state.manualRefreshing,
                        previewToken = viewModel.previewToken,
                        errorMessage = state.error,
                        actionMessage = state.actionMessage,
                        onRefreshNow = viewModel::refreshNow,
                        onDownload = viewModel::downloadResult,
                        onShare = viewModel::shareResult,
                        onRequestAdjustment = {
                            adjustmentText = ""
                            showAdjustmentDialog = true
                        },
                        onGeneratePix = viewModel::generatePix,
                        onPayWithBalance = viewModel::payWithBalance,
                        onCopyPix = { pix ->
                            MobileAnalytics.track(
                                "mobile_copiou_pix",
                                tela = "detalhe_pedido",
                                pedidoId = state.info?.id.orEmpty(),
                                flushNow = true
                            )
                            clipboardManager.setText(AnnotatedString(pix))
                        },
                        onCopyDescription = { description ->
                            clipboardManager.setText(
                                AnnotatedString(description.sanitizeInstagramDescription(state.info))
                            )
                        },
                        onOpenTicket = { url ->
                            uriHandler.openUri(url)
                        }
                    )
                }
                state.error != null -> {
                    state.error?.let { error ->
                        Text(error.asString(), color = MaterialTheme.colorScheme.error)
                    }
                }
                else -> Text(stringResource(R.string.order_not_found))
            }
        }
    }

    if (showAdjustmentDialog) {
        AdjustmentDialog(
            text = adjustmentText,
            sending = state.requestingAdjustment,
            onTextChange = { adjustmentText = it },
            onDismiss = {
                if (!state.requestingAdjustment) showAdjustmentDialog = false
            },
            onConfirm = {
                viewModel.requestAdjustment(adjustmentText)
                showAdjustmentDialog = false
            }
        )
    }
}

@Composable
private fun OrderInfoCard(
    info: OrderInfo?,
    paymentInfo: PaymentInfo?,
    downloading: Boolean,
    sharing: Boolean,
    requestingAdjustment: Boolean,
    generatingPix: Boolean,
    payingWithBalance: Boolean,
    polling: Boolean,
    manualRefreshing: Boolean,
    previewToken: String,
    errorMessage: UiText?,
    actionMessage: UiText?,
    onRefreshNow: () -> Unit,
    onDownload: () -> Unit,
    onShare: () -> Unit,
    onRequestAdjustment: () -> Unit,
    onGeneratePix: () -> Unit,
    onPayWithBalance: () -> Unit,
    onCopyPix: (String) -> Unit,
    onCopyDescription: (String) -> Unit,
    onOpenTicket: (String) -> Unit
) {
    if (info == null) return
    val postDescription = finalPostDescription(info)
    val canDownloadResult = info.canDownloadResult()

    if (!info.imagemPronta) {
        ProductionSection(
            info = info,
            polling = polling,
            manualRefreshing = manualRefreshing,
            errorMessage = errorMessage,
            actionMessage = actionMessage,
            onRefreshNow = onRefreshNow
        )

        if (info.pagamentoPendente) {
            Spacer(modifier = Modifier.height(16.dp))
            PaymentCard(
                paymentInfo = paymentInfo,
                fallbackValorPendente = info.valorPendente,
                generatingPix = generatingPix,
                payingWithBalance = payingWithBalance,
                onGeneratePix = onGeneratePix,
                onPayWithBalance = onPayWithBalance,
                onCopyPix = onCopyPix,
                onOpenTicket = onOpenTicket
            )
        }
        return
    }

    if (info.imagemPronta) {
        DeliverySection(
            info = info,
            previewToken = previewToken,
            description = postDescription,
            canDownload = canDownloadResult,
            downloading = downloading,
            sharing = sharing,
            canRequestAdjustment = info.podePedirAjuste,
            requestingAdjustment = requestingAdjustment,
            errorMessage = errorMessage,
            actionMessage = actionMessage,
            onDownload = onDownload,
            onShare = onShare,
            onCopyDescription = { onCopyDescription(postDescription) },
            onRequestAdjustment = onRequestAdjustment
        )
        if (info.pagamentoPendente) {
            Spacer(modifier = Modifier.height(16.dp))
            PaymentCard(
                paymentInfo = paymentInfo,
                fallbackValorPendente = info.valorPendente,
                generatingPix = generatingPix,
                payingWithBalance = payingWithBalance,
                onGeneratePix = onGeneratePix,
                onPayWithBalance = onPayWithBalance,
                onCopyPix = onCopyPix,
                onOpenTicket = onOpenTicket
            )
        }
    }
}

@Composable
private fun ProductionSection(
    info: OrderInfo,
    polling: Boolean,
    manualRefreshing: Boolean,
    errorMessage: UiText?,
    actionMessage: UiText?,
    onRefreshNow: () -> Unit
) {
    CreatingPreviewProgressCard(info = info, polling = polling)
    Spacer(modifier = Modifier.height(12.dp))
    OutlinedButton(
        modifier = Modifier.fillMaxWidth(),
        enabled = !manualRefreshing,
        onClick = onRefreshNow
    ) {
        if (manualRefreshing) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp))
        } else {
            Text(stringResource(R.string.common_update_now))
        }
    }

    errorMessage?.let { message ->
        Spacer(modifier = Modifier.height(10.dp))
        Text(message.asString(), color = MaterialTheme.colorScheme.error)
    }

    actionMessage?.let { message ->
        Spacer(modifier = Modifier.height(10.dp))
        Text(message.asString(), color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun DeliverySection(
    info: OrderInfo,
    previewToken: String,
    description: String,
    canDownload: Boolean,
    downloading: Boolean,
    sharing: Boolean,
    canRequestAdjustment: Boolean,
    requestingAdjustment: Boolean,
    errorMessage: UiText?,
    actionMessage: UiText?,
    onDownload: () -> Unit,
    onShare: () -> Unit,
    onCopyDescription: () -> Unit,
    onRequestAdjustment: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = stringResource(R.string.order_delivery_title),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(14.dp))
            OrderPreviewImage(
                info = info,
                previewToken = previewToken,
                modifier = Modifier
                    .fillMaxWidth(0.92f)
                    .aspectRatio(9f / 16f)
            )
            Spacer(modifier = Modifier.height(10.dp))
            Text(
                text = stringResource(R.string.order_ready_image_explanation),
                modifier = Modifier.fillMaxWidth(),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium
            )

            Spacer(modifier = Modifier.height(16.dp))
            if (canDownload) {
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !downloading,
                    onClick = onDownload
                ) {
                    if (downloading) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp))
                    } else {
                        Text(stringResource(R.string.order_download_image))
                    }
                }
                Spacer(modifier = Modifier.height(10.dp))
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !sharing,
                    onClick = onShare
                ) {
                    if (sharing) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp))
                    } else {
                        Text(stringResource(R.string.order_share_image))
                    }
                }
            } else {
                Text(
                    text = info.mensagemDownloadBloqueado.ifBlank {
                        stringResource(R.string.order_download_not_available)
                    },
                    modifier = Modifier.fillMaxWidth(),
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            errorMessage?.let { message ->
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = message.asString(),
                    modifier = Modifier.fillMaxWidth(),
                    color = MaterialTheme.colorScheme.error
                )
            }

            actionMessage?.let { message ->
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = message.asString(),
                    modifier = Modifier.fillMaxWidth(),
                    color = MaterialTheme.colorScheme.primary
                )
            }

            if (description.isNotBlank()) {
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    text = stringResource(R.string.order_post_description_title),
                    modifier = Modifier.fillMaxWidth(),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = description,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(10.dp))
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = onCopyDescription
                ) {
                    Text(stringResource(R.string.order_copy_description))
                }
            }

            if (canRequestAdjustment) {
                Spacer(modifier = Modifier.height(18.dp))
                Text(
                    text = stringResource(R.string.order_adjustment_explanation),
                    modifier = Modifier.fillMaxWidth(),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall
                )
                Spacer(modifier = Modifier.height(8.dp))
                RequestAdjustmentButton(
                    requestingAdjustment = requestingAdjustment,
                    onRequestAdjustment = onRequestAdjustment
                )
            }
        }
    }
}

private fun OrderInfo.canDownloadResult(): Boolean {
    return !pagamentoPendente && podeBaixar
}

@Composable
private fun AdjustmentPrompt(
    requestingAdjustment: Boolean,
    onRequestAdjustment: () -> Unit
) {
    Text(
        text = stringResource(R.string.order_adjustment_hint),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall
    )
    Spacer(modifier = Modifier.height(8.dp))
    RequestAdjustmentButton(
        requestingAdjustment = requestingAdjustment,
        onRequestAdjustment = onRequestAdjustment
    )
}

@Composable
private fun RequestAdjustmentButton(
    requestingAdjustment: Boolean,
    onRequestAdjustment: () -> Unit
) {
    OutlinedButton(
        modifier = Modifier.fillMaxWidth(),
        enabled = !requestingAdjustment,
        onClick = onRequestAdjustment
    ) {
        if (requestingAdjustment) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp))
        } else {
            Text(stringResource(R.string.order_request_adjustment))
        }
    }
}

@Composable
private fun PostDescriptionCard(
    description: String,
    onCopy: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text("Descri\u00E7\u00E3o para Instagram", style = MaterialTheme.typography.titleMedium)
            Spacer(modifier = Modifier.height(8.dp))
            Text(description)
            Spacer(modifier = Modifier.height(10.dp))
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                onClick = onCopy
            ) {
                Text("Copiar descri\u00E7\u00E3o")
            }
        }
    }
}

private fun finalPostDescription(info: OrderInfo): String {
    val apiDescription = info.descricaoInstagram.sanitizeInstagramDescription(info)
    if (apiDescription.isNotBlank() && !apiDescription.isGenericPostDescription()) return apiDescription

    val nome = info.nomeEmpresa.ifBlank { info.ramo }.ifBlank { "sua marca" }.trim()
    val ramo = info.ramo.trim()
    val objetivo = info.objetivo.trim()
    val frase = info.fraseFoto.trim().ifBlank { objetivo }
    val cta = info.cta.trim()
    val historia = info.historiaEmpresa.trim()
    val whatsapp = info.whatsappContato.trim()
    val instagram = info.instagram.trim()
    val contexto = listOf(ramo, info.categoria, info.tipoArte, objetivo, frase)
        .joinToString(" ")
        .lowercase()

    val abertura = when {
        contexto.contains("marketing") ||
            contexto.contains("redes") ||
            contexto.contains("divulg") -> {
            "$nome: sua empresa precisa aparecer melhor para vender mais e ser lembrada pelo cliente certo."
        }
        contexto.contains("lava") ||
            contexto.contains("automot") ||
            contexto.contains("carro") -> {
            "$nome: carro limpo, cuidado no detalhe e atendimento caprichado para deixar seu veiculo com cara de novo."
        }
        contexto.contains("futebol") ||
            contexto.contains("jogo") ||
            contexto.contains("time") ||
            contexto.contains("torcida") ||
            contexto.contains("escala") -> {
            "$nome em campo com energia total. E dia de apoiar, vibrar e mostrar a forca da torcida."
        }
        frase.isNotBlank() -> "$nome apresenta: $frase"
        ramo.isNotBlank() -> "$nome traz uma novidade especial para quem procura ${ramo.lowercase()} com qualidade e atendimento de verdade."
        else -> "$nome preparou uma novidade especial para voce conhecer hoje."
    }

    return buildList {
        add(abertura)
        if (historia.isNotBlank()) {
            add(historia.take(180))
        }
        if (cta.isNotBlank()) {
            add(cta)
        } else {
            add("Chame agora e veja como podemos te atender.")
        }
        if (whatsapp.isNotBlank()) {
            add("WhatsApp: $whatsapp")
        }
        if (instagram.isNotBlank()) {
            add(if (instagram.startsWith("@")) instagram else "@$instagram")
        }
        add("#IA4Tube #ArteComIA")
    }.joinToString("\n").sanitizeInstagramDescription(info)
}

private fun String.sanitizeInstagramDescription(info: OrderInfo? = null): String {
    val labels = setOf(
        "descricao para instagram",
        "descricao para postagem",
        "legenda para instagram",
        "sugestao de descricao",
        "sugestao de legenda",
        "caption",
        "instagram caption",
        "resultado",
        "proximo jogo",
        "escalacao",
        "contratacao",
        "dia de treino"
    )
    val canUseSponsor = info?.isSponsorOrder() == true

    return lineSequence()
        .map { it.trim() }
        .filter { it.isNotBlank() }
        .filter { line ->
            val normalized = line.normalizedDescriptionLine()
            normalized !in labels && normalized != "patrocinador" && normalized != "patrocinadores"
        }
        .map { line ->
            if (canUseSponsor) line else line.removeSponsorHashtags()
        }
        .filter { it.isNotBlank() }
        .joinToString("\n")
        .trim()
}

private fun String.removeSponsorHashtags(): String {
    return split("\\s+".toRegex())
        .filter { token ->
            val normalized = token.trim(',', '.', ';', ':', '!', '?').normalizedDescriptionLine()
            normalized != "#patrocinador" && normalized != "#patrocinadores"
        }
        .joinToString(" ")
        .trim()
}

private fun String.normalizedDescriptionLine(): String {
    return Normalizer.normalize(this, Normalizer.Form.NFD)
        .replace("\\p{Mn}+".toRegex(), "")
        .trim()
        .lowercase()
        .trimEnd(':', '.', ';', '-', '–', '—')
        .trim()
}

private fun OrderInfo.isSponsorOrder(): Boolean {
    return listOf(categoria, tipoArte, objetivo, fraseFoto)
        .joinToString(" ")
        .lowercase()
        .contains("patrocin")
}

private fun String.isGenericPostDescription(): Boolean {
    val texto = normalizedDescriptionLine().replace("\\s+".toRegex(), " ")
    if (texto.isBlank()) return true
    return texto.contains("pedido ia4tube") ||
        texto.contains("arte pronta") ||
        texto.contains("arte profissional para sua marca") ||
        texto.contains("apresentamos novidades") ||
        texto.contains("fique de olho nas proximas") ||
        texto.contains("acompanhe para saber mais") ||
        texto == "#ia4tube #artecomia"
}

private fun OrderInfo.isCompanyArt(): Boolean {
    return categoria.equals("arte_empresa", ignoreCase = true) ||
        tipoArte.equals("arte_empresa", ignoreCase = true)
}

@Composable
private fun InfoRow(
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
private fun ProductionProgressCard(
    info: OrderInfo,
    polling: Boolean
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            val hasError = info.status.equals("erro", ignoreCase = true)
            Text(
                text = if (hasError) {
                    stringResource(R.string.order_needs_review)
                } else {
                    stringResource(R.string.order_received)
                },
                style = MaterialTheme.typography.titleMedium
            )
            Spacer(modifier = Modifier.height(6.dp))
            Text(if (hasError) {
                stringResource(R.string.order_processing_error)
            } else if (info.status.equals("novo", ignoreCase = true)) {
                stringResource(R.string.order_preparing)
            } else {
                stringResource(R.string.order_creating_art)
            })
            if (!hasError) {
                Text(stringResource(R.string.order_may_take_minutes))
            }
            if (polling && !hasError) {
                Spacer(modifier = Modifier.height(12.dp))
                CircularProgressIndicator(modifier = Modifier.size(24.dp))
            }
        }
    }
}

@Composable
private fun PaymentCard(
    paymentInfo: PaymentInfo?,
    fallbackValorPendente: Double,
    generatingPix: Boolean,
    payingWithBalance: Boolean,
    onGeneratePix: () -> Unit,
    onPayWithBalance: () -> Unit,
    onCopyPix: (String) -> Unit,
    onOpenTicket: (String) -> Unit
) {
    val valorPendente = paymentInfo?.valorPendente?.takeIf { it > 0.0 } ?: fallbackValorPendente
    val pix = paymentInfo?.pixCopiaCola.orEmpty()
    val qrCodeBase64 = paymentInfo?.qrCodeBase64.orEmpty()
    val ticketUrl = paymentInfo?.ticketUrl.orEmpty()

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(stringResource(R.string.home_status_payment_pending), style = MaterialTheme.typography.titleMedium)
            if (valorPendente > 0.0) {
                Text(stringResource(R.string.order_payment_value, formatMoney(valorPendente)))
            } else {
                Text(stringResource(R.string.order_payment_value_missing))
            }

            if (paymentInfo?.mpPaymentStatus?.isNotBlank() == true) {
                Text(stringResource(R.string.order_pix_status, paymentInfo.mpPaymentStatus))
            }

            Spacer(modifier = Modifier.height(12.dp))
            Button(
                modifier = Modifier.fillMaxWidth(),
                enabled = !generatingPix,
                onClick = onGeneratePix
            ) {
                if (generatingPix) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp))
                } else {
                    Text(stringResource(R.string.order_generate_pix))
                }
            }

            Spacer(modifier = Modifier.height(10.dp))
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = !payingWithBalance,
                onClick = onPayWithBalance
            ) {
                if (payingWithBalance) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp))
                } else {
                    Text(stringResource(R.string.order_pay_with_balance))
                }
            }

            if (pix.isNotBlank()) {
                Spacer(modifier = Modifier.height(14.dp))
                Text(stringResource(R.string.order_pix_copy_paste), style = MaterialTheme.typography.titleSmall)
                Text(pix)
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { onCopyPix(pix) }
                ) {
                    Text(stringResource(R.string.order_copy_pix))
                }
            }

            PixQrCode(qrCodeBase64 = qrCodeBase64)

            if (ticketUrl.isNotBlank()) {
                Spacer(modifier = Modifier.height(10.dp))
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { onOpenTicket(ticketUrl) }
                ) {
                    Text(stringResource(R.string.order_open_payment))
                }
            }
        }
    }
}

@Composable
private fun PixQrCode(qrCodeBase64: String) {
    val bitmap = remember(qrCodeBase64) {
        decodeQrCode(qrCodeBase64)
    } ?: return

    Spacer(modifier = Modifier.height(12.dp))
    Image(
        bitmap = bitmap.asImageBitmap(),
        contentDescription = "QR Code Pix",
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(1f),
        contentScale = ContentScale.Fit
    )
}

@Composable
private fun PreviewCard(info: OrderInfo, previewToken: String, polling: Boolean) {
    if (!info.imagemPronta) {
        CreatingPreviewProgressCard(info = info, polling = polling)
        return
    }

    val isCompanyArt = info.isCompanyArt()

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(
                stringResource(
                    if (isCompanyArt) R.string.order_visualization_title else R.string.order_preview_title
                ),
                style = MaterialTheme.typography.titleMedium
            )
            Spacer(modifier = Modifier.height(10.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(9f / 16f),
                contentAlignment = Alignment.Center
            ) {
                OrderPreviewImage(
                    info = info,
                    previewToken = previewToken,
                    modifier = Modifier.fillMaxSize()
                )
            }
        }
    }
}

@Composable
private fun OrderPreviewImage(
    info: OrderInfo,
    previewToken: String,
    modifier: Modifier = Modifier
) {
    val isCompanyArt = info.isCompanyArt()
    val previewUrl = PreviewUrlBuilder.build(info.id, info.previewUrl)
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
    val state = painter.state

    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center
    ) {
        Image(
            painter = painter,
            contentDescription = stringResource(
                if (isCompanyArt) {
                    R.string.order_visualization_content_description
                } else {
                    R.string.order_preview_content_description
                },
                info.id
            ),
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Fit
        )

        when (state) {
            is AsyncImagePainter.State.Loading -> CircularProgressIndicator()
            is AsyncImagePainter.State.Error -> Text(
                text = stringResource(
                    if (isCompanyArt) R.string.order_visualization_error else R.string.order_preview_error
                ),
                color = MaterialTheme.colorScheme.error
            )
            else -> Unit
        }
    }
}

@Composable
private fun CreatingPreviewProgressCard(info: OrderInfo, polling: Boolean) {
    val hasError = info.status.equals("erro", ignoreCase = true)
    EstimatedCreationProgressCard(
        progressKey = info.id,
        running = polling,
        hasError = hasError,
        title = stringResource(R.string.order_creation_progress_title),
        subtitle = stringResource(R.string.order_creation_progress_subtitle),
        explanation = stringResource(R.string.order_creation_progress_explanation),
        errorTitle = stringResource(R.string.order_processing_error),
        errorSubtitle = stringResource(R.string.order_status_error_check)
    )
}

@Composable
private fun yesNo(value: Boolean): String = stringResource(if (value) R.string.common_yes else R.string.common_no)

private fun formatMoney(value: Double): String = "R$ %.2f".format(value)

private fun decodeQrCode(qrCodeBase64: String) = try {
    val cleanBase64 = qrCodeBase64.substringAfter("base64,", qrCodeBase64)
    val bytes = Base64.decode(cleanBase64, Base64.DEFAULT)
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
} catch (_: Exception) {
    null
}

@Composable
private fun AdjustmentDialog(
    text: String,
    sending: Boolean,
    onTextChange: (String) -> Unit,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.order_request_adjustment)) },
        text = {
            Column {
                Text(stringResource(R.string.order_adjustment_description))
                Spacer(modifier = Modifier.height(10.dp))
                OutlinedTextField(
                    modifier = Modifier.fillMaxWidth(),
                    value = text,
                    onValueChange = onTextChange,
                    enabled = !sending,
                    minLines = 3,
                    label = { Text(stringResource(R.string.order_adjustment_reason)) }
                )
            }
        },
        confirmButton = {
            Button(
                enabled = !sending && text.trim().isNotBlank(),
                onClick = onConfirm
            ) {
                if (sending) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp))
                } else {
                    Text(stringResource(R.string.common_send))
                }
            }
        },
        dismissButton = {
            TextButton(
                enabled = !sending,
                onClick = onDismiss
            ) {
                Text(stringResource(R.string.common_cancel))
            }
        }
    )
}
