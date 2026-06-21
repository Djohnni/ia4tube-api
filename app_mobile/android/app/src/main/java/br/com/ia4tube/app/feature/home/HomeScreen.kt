package br.com.ia4tube.app.feature.home

import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Warning
import br.com.ia4tube.app.R
import br.com.ia4tube.app.core.camera.CameraImageStore
import br.com.ia4tube.app.data.models.OrderSummary
import br.com.ia4tube.app.feature.orders.OrderListFilter
import br.com.ia4tube.app.ui.components.HelpHintText
import br.com.ia4tube.app.ui.components.ScreenScaffold
import br.com.ia4tube.app.ui.text.asString
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

@Composable
fun HomeScreen(
    viewModel: HomeViewModel,
    onOpenOrders: (OrderListFilter) -> Unit,
    onCreateArtEmpresa: () -> Unit,
    onCreateArtFromPhoto: (String) -> Unit,
    onOpenCarousel: () -> Unit,
    onOpenMonthlyPlanning: () -> Unit,
    onOpenPlans: () -> Unit,
    onCompanyProfile: () -> Unit,
    onSupport: () -> Unit,
    premiumTheme: PremiumHomeTheme,
    onPremiumThemeSelected: (PremiumHomeTheme) -> Unit,
    onLogout: () -> Unit,
    isLoggedIn: Boolean = true,
    cameraRequestKey: Int = 0,
    onCameraAuthRequired: () -> Unit = {}
) {
    val state by viewModel.uiState.collectAsState()
    val homePalette = premiumHomePalette(premiumTheme)
    val homeBackground = homePalette.screenBackground
    val context = LocalContext.current.applicationContext
    val lifecycleOwner = LocalLifecycleOwner.current
    val cameraImageStore = remember { CameraImageStore(context) }
    var showPhotoSourceDialog by remember { mutableStateOf(false) }
    var selectedHelp by remember { mutableStateOf<HomeHelpItem?>(null) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }
    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        if (saved) {
            pendingCameraUri?.let { uri ->
                onCreateArtFromPhoto(uri.toString())
            }
        }
        pendingCameraUri = null
    }
    val galleryLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            onCreateArtFromPhoto(uri.toString())
        }
    }
    LaunchedEffect(cameraRequestKey, isLoggedIn) {
        if (cameraRequestKey > 0 && isLoggedIn) {
            showPhotoSourceDialog = true
        }
    }
    DisposableEffect(lifecycleOwner, viewModel) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                viewModel.refresh()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    ScreenScaffold(containerColor = homeBackground) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(homeBackground)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .background(homeBackground)
                    .verticalScroll(rememberScrollState())
                .padding(top = 14.dp),
                verticalArrangement = Arrangement.Top
            ) {
                HelpHintText(modifier = Modifier.fillMaxWidth())
                Spacer(modifier = Modifier.height(12.dp))
                FuturisticHomePanel(
                    state = state,
                    palette = homePalette,
                    premiumTheme = premiumTheme,
                    onThemeSelected = onPremiumThemeSelected,
                    onOpenOrders = onOpenOrders,
                    onOpenPlans = onOpenPlans,
                    onCreateArtEmpresa = onCreateArtEmpresa,
                    onCameraClick = {
                        if (isLoggedIn) {
                            showPhotoSourceDialog = true
                        } else {
                            onCameraAuthRequired()
                        }
                    },
                    onCarouselClick = {
                        val remaining = state.carrosseisRestantes
                        if (remaining != null && remaining <= 0) {
                            Toast.makeText(
                                context,
                                context.getString(R.string.carousel_limit_reached),
                                Toast.LENGTH_LONG
                            ).show()
                        } else {
                            onOpenCarousel()
                        }
                    },
                    onMonthlyPlanningClick = onOpenMonthlyPlanning,
                    onCompanyProfile = onCompanyProfile,
                    onSupport = onSupport,
                    onLogout = onLogout,
                    onHelpSelected = { selectedHelp = it }
                )

                state.summaryError?.let { error ->
                    Spacer(modifier = Modifier.height(10.dp))
                    Text(error.asString(), color = MaterialTheme.colorScheme.error)
                }

                Spacer(modifier = Modifier.height(28.dp))
            }
        }
    }

    if (showPhotoSourceDialog) {
        AlertDialog(
            onDismissRequest = { showPhotoSourceDialog = false },
            title = { Text(stringResource(R.string.home_photo_source_title)) },
            text = { Text(stringResource(R.string.home_photo_source_description)) },
            confirmButton = {
                Button(
                    onClick = {
                        showPhotoSourceDialog = false
                        val uri = cameraImageStore.createImageUri()
                        pendingCameraUri = uri
                        cameraLauncher.launch(uri)
                    }
                ) {
                    Text(stringResource(R.string.home_take_photo))
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        showPhotoSourceDialog = false
                        galleryLauncher.launch("image/*")
                    }
                ) {
                    Text(stringResource(R.string.home_choose_photo))
                }
            }
        )
    }

    selectedHelp?.let { help ->
        HomeHelpDialog(
            item = help,
            onDismiss = { selectedHelp = null }
        )
    }
}

enum class PremiumHomeTheme(val label: String) {
    Black("Preto"),
    White("Branco"),
    Blue("Azul"),
    Pink("Rosa")
}

private enum class HomeHelpItem(
    val icon: String,
    val dialogTitle: String,
    val dialogMessage: String
) {
    Orders(
        "\uD83D\uDCE6",
        "Meus pedidos",
        "Acompanhe todas as suas artes em um s\u00f3 lugar. Quando estiver pronta, voc\u00ea recebe a imagem e a descri\u00e7\u00e3o pronta para publicar."
    ),
    CurrentPlan(
        "\u2B50",
        "Plano atual",
        "Veja quantas artes ainda pode criar este m\u00eas e aproveite o acesso aos especialistas da iA4tube para o seu ramo."
    ),
    Support(
        "\uD83D\uDCAC",
        "Suporte",
        "Precisa de ajuda? Nossa equipe pode orientar voc\u00ea sobre pedidos, planos e a melhor forma de usar a iA4tube para divulgar seu neg\u00f3cio."
    ),
    CreateArt(
        "\uD83C\uDFA8",
        "Criar arte",
        "Crie uma arte profissional em menos de 2 minutos. A iA4tube usa um especialista no seu ramo para criar a imagem e a descri\u00e7\u00e3o pronta para postar."
    ),
    Camera(
        "\uD83D\uDCF7",
        "C\u00e2mera",
        "Tire uma foto ou escolha uma da galeria. Em menos de 2 minutos a iA4tube transforma sua imagem em uma arte profissional com descri\u00e7\u00e3o pronta."
    ),
    PrintedMaterials(
        "\uD83D\uDCC4",
        "Mat. Impresso",
        "Crie materiais profissionais para sua empresa em poucos minutos. A iA4tube utiliza especialistas do seu ramo para gerar modelos prontos para uso e impress\u00e3o."
    ),
    Carousel(
        "\uD83D\uDCF1",
        "Post Deslizante",
        "Crie carross\u00e9is completos para Instagram. A iA4tube monta as imagens, escreve os textos e entrega a descri\u00e7\u00e3o pronta para publicar."
    ),
    MonthlyPlanning(
        "\uD83D\uDCC5",
        "Planejamento",
        "Escolha as fotos que quer postar durante o m\u00eas. A iA4tube usa especialistas no seu ramo para criar as artes, organizar as datas e avisar voc\u00ea quando chegar a hora de postar."
    )
}

@Composable
private fun HomeHelpDialog(
    item: HomeHelpItem,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp, start = 6.dp, end = 6.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = item.icon,
                    fontSize = 42.sp,
                    lineHeight = 46.sp,
                    textAlign = TextAlign.Center
                )
                Spacer(modifier = Modifier.height(10.dp))
                Text(
                    text = item.dialogTitle,
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.ExtraBold,
                    color = MaterialTheme.colorScheme.onSurface,
                    textAlign = TextAlign.Center
                )
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    text = item.dialogMessage,
                    style = MaterialTheme.typography.bodyLarge,
                    lineHeight = 23.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center
                )
            }
        },
        confirmButton = {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 4.dp),
                contentAlignment = Alignment.Center
            ) {
                TextButton(onClick = onDismiss) {
                    Text("Fechar")
                }
            }
        }
    )
}

@Composable
private fun HomeHelpButton(
    palette: PremiumHomePalette,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 22.dp,
    touchSize: Dp = size
) {
    val textSize = (size.value * 0.64f).sp
    Box(
        modifier = modifier
            .zIndex(4f)
            .size(touchSize)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Box(
            modifier = Modifier
                .size(size)
                .clip(CircleShape)
                .background(Color(0xFF050505).copy(alpha = 0.96f))
                .border(1.7.dp, palette.primaryBorder.copy(alpha = 0.96f), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = "?",
                color = palette.primaryBorder,
                fontSize = textSize,
                lineHeight = textSize,
                fontWeight = FontWeight.Black,
                textAlign = TextAlign.Center,
                maxLines = 1
            )
        }
    }
}

data class PremiumHomePalette(
    val screenBackground: Color,
    val panelGradient: List<Color>,
    val panelBorder: Color,
    val haloPrimary: Color,
    val haloSecondary: Color,
    val haloSoft: Color,
    val linePrimary: Color,
    val lineSecondary: Color,
    val lineWarm: Color,
    val circleMiddle: Color,
    val circleEnd: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val metricNumber: Color,
    val primaryHalo: Color,
    val primaryMiddle: Color,
    val primaryEnd: Color,
    val primaryBorder: Color,
    val primaryInnerBorder: Color,
    val primaryInnerBackground: Color,
    val primaryPlus: Color,
    val cameraBackground: Color,
    val toggleBackground: Color,
    val toggleSelected: Color,
    val toggleText: Color,
    val toggleMutedText: Color
)

fun premiumHomePalette(theme: PremiumHomeTheme): PremiumHomePalette {
    return when (theme) {
        PremiumHomeTheme.White -> PremiumHomePalette(
            screenBackground = Color(0xFFECE0C7),
            panelGradient = listOf(
                Color(0xFFFFFCF4),
                Color(0xFFF5E3BE),
                Color(0xFFE0BD78),
                Color(0xFFD2A654)
            ),
            panelBorder = Color(0xFF8A5D08).copy(alpha = 0.78f),
            haloPrimary = Color(0xFF9B6A08),
            haloSecondary = Color(0xFFB77A00),
            haloSoft = Color(0xFF1E1A12),
            linePrimary = Color(0xFF8A5D08),
            lineSecondary = Color(0xFFB77A00),
            lineWarm = Color(0xFF6D4804),
            circleMiddle = Color(0xFFFFF3D4),
            circleEnd = Color(0xFFE4C17B),
            textPrimary = Color(0xFF120E06),
            textSecondary = Color(0xFF4F380A),
            metricNumber = Color(0xFF120E06),
            primaryHalo = Color(0xFFFFC233),
            primaryMiddle = Color(0xFFFFE49A),
            primaryEnd = Color(0xFFE2B853),
            primaryBorder = Color(0xFF8A5D08),
            primaryInnerBorder = Color(0xFF8A5D08).copy(alpha = 0.46f),
            primaryInnerBackground = Color(0xFFFFF3CE).copy(alpha = 0.95f),
            primaryPlus = Color(0xFF5E3C00),
            cameraBackground = Color(0xFFFFF3D4),
            toggleBackground = Color(0xFFE4C17B),
            toggleSelected = Color(0xFF8A5D08),
            toggleText = Color(0xFF120E06),
            toggleMutedText = Color(0xFF4F380A)
        )
        PremiumHomeTheme.Blue -> PremiumHomePalette(
            screenBackground = Color(0xFF020817),
            panelGradient = listOf(
                Color(0xFF092452),
                Color(0xFF061B3A),
                Color(0xFF030A19),
                Color(0xFF020817)
            ),
            panelBorder = Color(0xFFFFD76A).copy(alpha = 0.34f),
            haloPrimary = Color(0xFFFFC233),
            haloSecondary = Color(0xFF8EC5FF),
            haloSoft = Color(0xFFDCEBFF),
            linePrimary = Color(0xFFFFC233),
            lineSecondary = Color(0xFF7DB7FF),
            lineWarm = Color(0xFFD69B22),
            circleMiddle = Color(0xFF071A36),
            circleEnd = Color(0xFF020817),
            textPrimary = Color(0xFFF3F8FF),
            textSecondary = Color(0xFFC7D7F2),
            metricNumber = Color.White,
            primaryHalo = Color(0xFFFFC233),
            primaryMiddle = Color(0xFF10264B),
            primaryEnd = Color(0xFF020817),
            primaryBorder = Color(0xFFFFD76A),
            primaryInnerBorder = Color(0xFFFFE6A3).copy(alpha = 0.28f),
            primaryInnerBackground = Color(0xFF061226).copy(alpha = 0.90f),
            primaryPlus = Color(0xFFFFF1B8),
            cameraBackground = Color(0xFF041126),
            toggleBackground = Color(0xFF071A36),
            toggleSelected = Color(0xFFFFD76A),
            toggleText = Color(0xFFF3F8FF),
            toggleMutedText = Color(0xFFC7D7F2)
        )
        PremiumHomeTheme.Pink -> PremiumHomePalette(
            screenBackground = Color(0xFF17040F),
            panelGradient = listOf(
                Color(0xFF4A1231),
                Color(0xFF2B0B20),
                Color(0xFF12030C),
                Color(0xFF17040F)
            ),
            panelBorder = Color(0xFFFFD76A).copy(alpha = 0.34f),
            haloPrimary = Color(0xFFFFC233),
            haloSecondary = Color(0xFFFF9AD5),
            haloSoft = Color(0xFFFFE7F6),
            linePrimary = Color(0xFFFFC233),
            lineSecondary = Color(0xFFFF8BCB),
            lineWarm = Color(0xFFD69B22),
            circleMiddle = Color(0xFF2A0A1F),
            circleEnd = Color(0xFF12030C),
            textPrimary = Color(0xFFFFF3FA),
            textSecondary = Color(0xFFF0BEDA),
            metricNumber = Color.White,
            primaryHalo = Color(0xFFFFC233),
            primaryMiddle = Color(0xFF3A1029),
            primaryEnd = Color(0xFF12030C),
            primaryBorder = Color(0xFFFFD76A),
            primaryInnerBorder = Color(0xFFFFE6A3).copy(alpha = 0.28f),
            primaryInnerBackground = Color(0xFF1A0713).copy(alpha = 0.90f),
            primaryPlus = Color(0xFFFFF1B8),
            cameraBackground = Color(0xFF190713),
            toggleBackground = Color(0xFF2A0A1F),
            toggleSelected = Color(0xFFFFD76A),
            toggleText = Color(0xFFFFF3FA),
            toggleMutedText = Color(0xFFF0BEDA)
        )
        PremiumHomeTheme.Black -> PremiumHomePalette(
            screenBackground = Color(0xFF020202),
            panelGradient = listOf(
                Color(0xFF2A1A05),
                Color(0xFF11100C),
                Color(0xFF050505),
                Color(0xFF020202)
            ),
            panelBorder = Color(0xFFFFD76A).copy(alpha = 0.30f),
            haloPrimary = Color(0xFFFFC233),
            haloSecondary = Color(0xFFFFE6A3),
            haloSoft = Color.White,
            linePrimary = Color(0xFFFFC233),
            lineSecondary = Color(0xFFFFE6A3),
            lineWarm = Color(0xFFD69B22),
            circleMiddle = Color(0xFF15110A),
            circleEnd = Color(0xFF050505),
            textPrimary = Color(0xFFFFF8E7),
            textSecondary = Color(0xFFD8C28A),
            metricNumber = Color.White,
            primaryHalo = Color(0xFFFFC233),
            primaryMiddle = Color(0xFF241605),
            primaryEnd = Color(0xFF050505),
            primaryBorder = Color(0xFFFFD76A),
            primaryInnerBorder = Color(0xFFFFE6A3).copy(alpha = 0.28f),
            primaryInnerBackground = Color(0xFF120D05).copy(alpha = 0.90f),
            primaryPlus = Color(0xFFFFF1B8),
            cameraBackground = Color(0xFF090704),
            toggleBackground = Color(0xFF15110A),
            toggleSelected = Color(0xFFFFD76A),
            toggleText = Color(0xFFFFF8E7),
            toggleMutedText = Color(0xFFD8C28A)
        )
    }
}

@Composable
private fun FuturisticHomePanel(
    state: HomeUiState,
    palette: PremiumHomePalette,
    premiumTheme: PremiumHomeTheme,
    onThemeSelected: (PremiumHomeTheme) -> Unit,
    onOpenOrders: (OrderListFilter) -> Unit,
    onOpenPlans: () -> Unit,
    onCreateArtEmpresa: () -> Unit,
    onCameraClick: () -> Unit,
    onCarouselClick: () -> Unit,
    onMonthlyPlanningClick: () -> Unit,
    onCompanyProfile: () -> Unit,
    onSupport: () -> Unit,
    onLogout: () -> Unit,
    onHelpSelected: (HomeHelpItem) -> Unit
) {
    val normalizedPlanStatus = state.planoStatus.trim().lowercase()
    val hasActivePlan = normalizedPlanStatus in setOf("active", "ativo") && state.planoNome.isNotBlank()
    val standaloneArts = state.artesAvulsasRestantes.coerceAtLeast(0)
    val totalAvailableArts = (if (hasActivePlan) state.artesMensaisRestantes else 0) + standaloneArts
    val planCircleLabel = when {
        hasActivePlan -> displayPlanName(state.planoNome)
        standaloneArts > 0 -> "Arte avulsa"
        else -> "Sem plano"
    }
    val planCircleNumber = if (totalAvailableArts > 0) {
        totalAvailableArts.toString()
    } else {
        "Ver planos"
    }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(760.dp)
            .clip(RoundedCornerShape(28.dp))
            .background(
                Brush.radialGradient(
                    colors = palette.panelGradient,
                    radius = 920f
                )
            )
            .border(1.dp, palette.panelBorder, RoundedCornerShape(28.dp))
            .padding(horizontal = 12.dp, vertical = 20.dp)
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val centerX = size.width / 2f
            val hubY = size.height * 0.77f
            val topY = size.height * 0.15f
            val midY = size.height * 0.40f
            val neon = palette.linePrimary
            val blue = palette.lineSecondary
            val amber = palette.lineWarm

            drawCircle(neon.copy(alpha = 0.10f), radius = size.width * 0.62f, center = Offset(centerX, hubY))
            drawCircle(blue.copy(alpha = 0.08f), radius = size.width * 0.42f, center = Offset(centerX, topY))
            drawCircle(palette.haloSoft.copy(alpha = 0.035f), radius = size.width * 0.86f, center = Offset(centerX, size.height * 0.58f))

            val topPoints = listOf(
                Offset(size.width * 0.18f, topY),
                Offset(size.width * 0.50f, topY - 6f),
                Offset(size.width * 0.82f, topY)
            )
            val midPoints = listOf(
                Offset(size.width * 0.12f, midY),
                Offset(size.width * 0.37f, midY + 8f),
                Offset(size.width * 0.63f, midY + 8f),
                Offset(size.width * 0.88f, midY)
            )
            val hub = Offset(centerX, hubY - 56f)

        }

        Column(
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Box(
                modifier = Modifier.fillMaxWidth(),
                contentAlignment = Alignment.TopEnd
            ) {
                PremiumHomeThemeToggle(
                    premiumTheme = premiumTheme,
                    palette = palette,
                    onThemeSelected = onThemeSelected
                )
            }

            Spacer(modifier = Modifier.height(10.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.Top
            ) {
                OrbitActionCircle(
                    title = stringResource(R.string.home_my_orders),
                    value = "",
                    accent = palette.haloSecondary,
                    palette = palette,
                    icon = Icons.AutoMirrored.Filled.List,
                    compact = true,
                    badgeStart = state.emProducao,
                    badgeEnd = state.artesProntas,
                    onHelpClick = { onHelpSelected(HomeHelpItem.Orders) },
                    onClick = { onOpenOrders(OrderListFilter.All) }
                )
                OrbitActionCircle(
                    title = planCircleLabel,
                    value = "",
                    accent = palette.haloPrimary,
                    palette = palette,
                    centerSubtitle = planCircleNumber,
                    compact = true,
                    onHelpClick = { onHelpSelected(HomeHelpItem.CurrentPlan) },
                    onClick = onOpenPlans
                )
                OrbitActionCircle(
                    title = stringResource(R.string.home_open_support),
                    value = "",
                    accent = palette.haloSecondary,
                    palette = palette,
                    compact = true,
                    customIcon = { HeadsetGlyph(palette.haloSecondary, Modifier.size(30.dp)) },
                    onHelpClick = { onHelpSelected(HomeHelpItem.Support) },
                    onClick = onSupport
                )
            }

            Spacer(modifier = Modifier.weight(1f))

            PrimaryCreateArtAction(
                palette = palette,
                onClick = onCreateArtEmpresa,
                onCameraClick = onCameraClick,
                onCarouselClick = onCarouselClick,
                onMonthlyPlanningClick = onMonthlyPlanningClick,
                onCompanyProfile = onCompanyProfile,
                carouselRemainingText = carouselRemainingText(state.carrosseisRestantes),
                onLogout = onLogout,
                onHelpSelected = onHelpSelected
            )

            Spacer(modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun PremiumHomeThemeToggle(
    premiumTheme: PremiumHomeTheme,
    palette: PremiumHomePalette,
    onThemeSelected: (PremiumHomeTheme) -> Unit
) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(palette.toggleBackground.copy(alpha = 0.92f))
            .border(1.dp, palette.panelBorder, RoundedCornerShape(999.dp))
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        PremiumHomeTheme.values().forEach { theme ->
            ThemeToggleLabel(
                text = theme.label,
                selected = premiumTheme == theme,
                palette = palette,
                onClick = { onThemeSelected(theme) }
            )
        }
    }
}

@Composable
private fun ThemeToggleLabel(
    text: String,
    selected: Boolean,
    palette: PremiumHomePalette,
    onClick: () -> Unit
) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (selected) palette.toggleSelected.copy(alpha = 0.92f) else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 5.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = text,
            color = if (selected) Color(0xFF11100A) else palette.toggleMutedText,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            maxLines = 1
        )
    }
}

@Composable
private fun OrbitActionCircle(
    title: String,
    value: String,
    accent: Color,
    palette: PremiumHomePalette,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    customIcon: (@Composable () -> Unit)? = null,
    centerText: String = "",
    centerTitle: String = "",
    centerSubtitle: String = "",
    compact: Boolean = false,
    badgeStart: Int = 0,
    badgeEnd: Int = 0,
    badgeLegend: String = "",
    onHelpClick: (() -> Unit)? = null,
    onClick: () -> Unit
) {
    val circleSize = if (compact) 74.dp else 92.dp
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(if (compact) 5.dp else 7.dp)
    ) {
        Box(
            modifier = Modifier
                .size(circleSize),
            contentAlignment = Alignment.Center
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .clip(CircleShape)
                    .background(
                        Brush.radialGradient(
                            colors = listOf(
                                accent.copy(alpha = 0.22f),
                                palette.circleMiddle,
                                palette.circleEnd
                            )
                        )
                    )
                    .border(1.6.dp, accent.copy(alpha = 0.78f), CircleShape)
                    .clickable(onClick = onClick),
                contentAlignment = Alignment.Center
            ) {
                if (centerTitle.isNotBlank() || centerSubtitle.isNotBlank()) {
                    Column(
                        modifier = Modifier.padding(horizontal = 8.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        if (centerTitle.isNotBlank()) {
                            Text(
                                text = centerTitle,
                                color = palette.metricNumber,
                                fontSize = if (compact) 10.sp else 11.sp,
                                lineHeight = if (compact) 11.sp else 12.sp,
                                fontWeight = FontWeight.ExtraBold,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                        if (centerSubtitle.isNotBlank()) {
                            val subtitleIsNumber = centerSubtitle.all { it.isDigit() }
                            Text(
                                text = centerSubtitle,
                                color = if (subtitleIsNumber) palette.metricNumber else palette.textSecondary,
                                fontSize = when {
                                    subtitleIsNumber && compact -> 19.sp
                                    subtitleIsNumber -> 23.sp
                                    compact -> 9.sp
                                    else -> 10.sp
                                },
                                lineHeight = when {
                                    subtitleIsNumber && compact -> 20.sp
                                    subtitleIsNumber -> 24.sp
                                    compact -> 10.sp
                                    else -> 11.sp
                                },
                                fontWeight = if (subtitleIsNumber) FontWeight.ExtraBold else FontWeight.Bold,
                                maxLines = if (subtitleIsNumber) 1 else 2,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                    }
                } else if (centerText.isNotBlank()) {
                    Text(
                        text = centerText,
                        color = palette.metricNumber,
                        fontSize = if (compact) 15.sp else 17.sp,
                        lineHeight = if (compact) 17.sp else 19.sp,
                        fontWeight = FontWeight.ExtraBold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                } else if (customIcon != null) {
                    customIcon()
                } else if (icon != null) {
                    Icon(
                        imageVector = icon,
                        contentDescription = title,
                        tint = accent,
                        modifier = Modifier.size(if (compact) 28.dp else 32.dp)
                    )
                } else {
                    Text(
                        text = title.take(1),
                        color = accent,
                        fontSize = if (compact) 26.sp else 30.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
            if (badgeStart > 0) {
                OrbitNotificationBadge(
                    count = badgeStart,
                    palette = palette,
                    accent = palette.haloPrimary,
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .offset(x = (-7).dp, y = (-9).dp)
                )
            }
            if (badgeEnd > 0) {
                OrbitNotificationBadge(
                    count = badgeEnd,
                    palette = palette,
                    accent = palette.lineWarm,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .offset(x = 7.dp, y = (-9).dp)
                )
            }
            onHelpClick?.let { helpClick ->
                HomeHelpButton(
                    palette = palette,
                    onClick = helpClick,
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .offset(x = 4.dp, y = 4.dp)
                )
            }
        }
        Text(
            text = title,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Bold,
            color = palette.textPrimary,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
        if (value.isNotBlank()) {
            Text(
                text = value,
                style = MaterialTheme.typography.labelSmall,
                color = palette.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        if (badgeLegend.isNotBlank() && (badgeStart > 0 || badgeEnd > 0)) {
            Text(
                text = badgeLegend,
                style = MaterialTheme.typography.labelSmall,
                color = palette.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
private fun OrbitNotificationBadge(
    count: Int,
    palette: PremiumHomePalette,
    accent: Color,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier
            .size(23.dp)
            .clip(CircleShape)
            .background(accent)
            .border(1.2.dp, palette.circleEnd, CircleShape),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = count.coerceAtMost(99).toString(),
            color = Color(0xFF11100A),
            fontSize = 11.sp,
            fontWeight = FontWeight.ExtraBold,
            maxLines = 1
        )
    }
}

@Composable
private fun OrbitMetricCircle(
    title: String,
    count: Int,
    loading: Boolean,
    accent: Color,
    palette: PremiumHomePalette,
    icon: ImageVector,
    onClick: () -> Unit
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(7.dp)
    ) {
        Box(
            modifier = Modifier
                .size(76.dp)
                .clip(CircleShape)
                .background(
                    Brush.radialGradient(
                        colors = listOf(
                            accent.copy(alpha = 0.20f),
                            palette.circleMiddle,
                            palette.circleEnd
                        )
                    )
                )
                .border(1.45.dp, accent.copy(alpha = 0.76f), CircleShape)
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center
        ) {
            if (loading) {
                CircularProgressIndicator(
                    modifier = Modifier.size(25.dp),
                    color = accent,
                    strokeWidth = 2.dp
                )
            } else {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(
                        imageVector = icon,
                        contentDescription = title,
                        tint = accent,
                        modifier = Modifier.size(17.dp)
                    )
                    Text(
                        text = count.toString(),
                        color = palette.metricNumber,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.ExtraBold,
                        lineHeight = 22.sp
                    )
                }
            }
        }
        Text(
            text = title,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color = palette.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun HomeQuickActions(
    onOpenOrders: () -> Unit,
    onCompanyProfile: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceEvenly,
        verticalAlignment = Alignment.CenterVertically
    ) {
        QuickCircleAction(
            text = stringResource(R.string.home_my_orders),
            icon = Icons.AutoMirrored.Filled.List,
            onClick = onOpenOrders
        )
        QuickCircleAction(
            text = stringResource(R.string.home_header_profile),
            icon = Icons.Filled.Person,
            onClick = onCompanyProfile
        )
    }
}

@Composable
private fun QuickCircleAction(
    text: String,
    icon: ImageVector,
    onClick: () -> Unit
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Box(
            modifier = Modifier
                .size(72.dp)
                .clip(CircleShape)
                .background(Color(0xFF111827))
                .border(1.dp, Color.White.copy(alpha = 0.10f), CircleShape)
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center
        ) {
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(Color(0xFF172235))
            )
            Icon(
                imageVector = icon,
                contentDescription = text,
                tint = Color(0xFFD9FFE8),
                modifier = Modifier.size(27.dp)
            )
        }
        Text(
            text = text,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun PrimaryCreateArtAction(
    palette: PremiumHomePalette,
    onClick: () -> Unit,
    onCameraClick: () -> Unit,
    onCarouselClick: () -> Unit,
    onMonthlyPlanningClick: () -> Unit,
    onCompanyProfile: () -> Unit,
    carouselRemainingText: String?,
    onLogout: () -> Unit,
    onHelpSelected: (HomeHelpItem) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            modifier = Modifier
                .size(194.dp),
            contentAlignment = Alignment.Center
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .clip(CircleShape)
                    .background(
                        Brush.radialGradient(
                            colors = listOf(
                                palette.primaryHalo.copy(alpha = 0.46f),
                                palette.primaryMiddle,
                                palette.primaryEnd
                            )
                        )
                    )
                    .border(2.4.dp, palette.primaryBorder.copy(alpha = 0.92f), CircleShape)
                    .clickable(onClick = onClick)
            )
            HomeHelpButton(
                palette = palette,
                onClick = { onHelpSelected(HomeHelpItem.CreateArt) },
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .offset(x = 28.dp, y = 28.dp),
                size = 28.dp
            )
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                GoldenPlusGlyph(
                    color = palette.primaryPlus,
                    glow = palette.primaryHalo,
                    modifier = Modifier.size(92.dp)
                )
                Text(
                    text = "Criar arte",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.ExtraBold,
                    color = palette.metricNumber,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        Spacer(modifier = Modifier.height(12.dp))
        Row(
            horizontalArrangement = Arrangement.spacedBy(18.dp),
            verticalAlignment = Alignment.Top
        ) {
            HomeToolButton(
                palette = palette,
                label = stringResource(R.string.home_take_or_choose_photo),
                onHelpClick = { onHelpSelected(HomeHelpItem.Camera) },
                onClick = onCameraClick,
                icon = {
                    CameraGlyph(palette.primaryBorder, palette.cameraBackground, Modifier.size(42.dp))
                }
            )
            HomeToolButton(
                palette = palette,
                label = stringResource(R.string.home_printed_materials),
                onHelpClick = { onHelpSelected(HomeHelpItem.PrintedMaterials) },
                onClick = onCompanyProfile,
                icon = {
                    CompanyGlyph(palette.primaryBorder, Modifier.size(42.dp))
                }
            )
        }
        Spacer(modifier = Modifier.height(10.dp))
        Row(
            horizontalArrangement = Arrangement.spacedBy(18.dp),
            verticalAlignment = Alignment.Top
        ) {
            HomeToolButton(
                palette = palette,
                label = stringResource(R.string.home_carousel),
                subtitle = carouselRemainingText,
                onHelpClick = { onHelpSelected(HomeHelpItem.Carousel) },
                onClick = onCarouselClick,
                icon = {
                    CarouselGlyph(palette.primaryBorder, palette.cameraBackground, Modifier.size(42.dp))
                }
            )
            HomeToolButton(
                palette = palette,
                label = "Planejamento",
                subtitle = "Junho: 4/20 prontas",
                onHelpClick = { onHelpSelected(HomeHelpItem.MonthlyPlanning) },
                onClick = onMonthlyPlanningClick,
                icon = {
                    CalendarGlyph(palette.primaryBorder, palette.cameraBackground, Modifier.size(42.dp))
                }
            )
        }
        Spacer(modifier = Modifier.height(0.dp))
        Text(
            modifier = Modifier.height(0.dp),
            text = "Câmera",
            color = palette.textPrimary,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.ExtraBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        Spacer(modifier = Modifier.height(10.dp))
        TextButton(
            modifier = Modifier
                .width(82.dp)
                .height(34.dp),
            shape = RoundedCornerShape(999.dp),
            onClick = onLogout
        ) {
            Text(
                text = stringResource(R.string.home_logout),
                color = palette.textSecondary,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Spacer(modifier = Modifier.height(2.dp))
    }
}

private fun displayPlanName(name: String): String {
    val trimmed = name.trim()
    if (trimmed.isBlank()) return trimmed

    return when {
        trimmed.startsWith("14 ", ignoreCase = true) -> "i4 ${capitalizePlanSuffix(trimmed.drop(3))}"
        trimmed.equals("14", ignoreCase = true) -> "i4"
        trimmed.startsWith("i4 ", ignoreCase = true) -> "i4 ${capitalizePlanSuffix(trimmed.drop(3))}"
        trimmed.equals("i4", ignoreCase = true) -> "i4"
        else -> trimmed
    }
}

private fun carouselRemainingText(count: Int?): String? {
    if (count == null) return null
    return if (count == 1) {
        "1 restante"
    } else {
        "${count.coerceAtLeast(0)} restantes"
    }
}

private fun capitalizePlanSuffix(value: String): String {
    val cleaned = value.trimStart()
    return cleaned.replaceFirstChar { first ->
        if (first.isLowerCase()) first.titlecase() else first.toString()
    }
}

@Composable
private fun GoldenPlusGlyph(
    color: Color,
    glow: Color,
    modifier: Modifier = Modifier
) {
    Canvas(modifier = modifier) {
        val barThickness = size.minDimension * 0.18f
        val corner = barThickness * 0.42f
        val horizontalWidth = size.width * 0.78f
        val verticalHeight = size.height * 0.82f
        val centerX = size.width / 2f
        val centerY = size.height / 2f

        drawRoundRect(
            color = glow.copy(alpha = 0.22f),
            topLeft = Offset(centerX - horizontalWidth / 2f - 3f, centerY - barThickness / 2f - 3f),
            size = Size(horizontalWidth + 6f, barThickness + 6f),
            cornerRadius = CornerRadius(corner, corner)
        )
        drawRoundRect(
            color = glow.copy(alpha = 0.22f),
            topLeft = Offset(centerX - barThickness / 2f - 3f, centerY - verticalHeight / 2f - 3f),
            size = Size(barThickness + 6f, verticalHeight + 6f),
            cornerRadius = CornerRadius(corner, corner)
        )
        drawRoundRect(
            brush = Brush.verticalGradient(
                colors = listOf(
                    Color(0xFFFFF1B8),
                    color,
                    Color(0xFFD69B22)
                )
            ),
            topLeft = Offset(centerX - horizontalWidth / 2f, centerY - barThickness / 2f),
            size = Size(horizontalWidth, barThickness),
            cornerRadius = CornerRadius(corner, corner)
        )
        drawRoundRect(
            brush = Brush.horizontalGradient(
                colors = listOf(
                    Color(0xFFD69B22),
                    Color(0xFFFFF1B8),
                    color
                )
            ),
            topLeft = Offset(centerX - barThickness / 2f, centerY - verticalHeight / 2f),
            size = Size(barThickness, verticalHeight),
            cornerRadius = CornerRadius(corner, corner)
        )
    }
}

@Composable
private fun OutlinedNeonCameraButton(
    palette: PremiumHomePalette,
    onClick: () -> Unit
) {
    Box(
        modifier = Modifier
            .width(104.dp)
            .height(50.dp)
            .clip(RoundedCornerShape(18.dp))
            .border(1.4.dp, palette.primaryBorder.copy(alpha = 0.78f), RoundedCornerShape(18.dp))
            .background(palette.cameraBackground.copy(alpha = 0.96f))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        CameraGlyph(palette.primaryBorder, palette.cameraBackground, Modifier.size(42.dp))
    }
}

@Composable
private fun HomeToolButton(
    palette: PremiumHomePalette,
    label: String,
    subtitle: String? = null,
    onHelpClick: (() -> Unit)? = null,
    onClick: () -> Unit,
    icon: @Composable () -> Unit
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Box(
            modifier = Modifier
                .width(122.dp)
                .height(68.dp),
            contentAlignment = Alignment.Center
        ) {
            Box(
                modifier = Modifier
                    .width(104.dp)
                    .height(50.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .border(1.4.dp, palette.primaryBorder.copy(alpha = 0.78f), RoundedCornerShape(18.dp))
                    .background(palette.cameraBackground.copy(alpha = 0.96f))
                    .clickable(onClick = onClick)
            )
            icon()
            onHelpClick?.let { helpClick ->
                HomeHelpButton(
                    palette = palette,
                    onClick = helpClick,
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .offset(x = (-10).dp, y = (-10).dp),
                    size = 28.dp,
                    touchSize = 48.dp
                )
            }
        }
        Text(
            text = label,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.ExtraBold,
            color = palette.textPrimary,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
        if (!subtitle.isNullOrBlank()) {
            Text(
                text = subtitle,
                color = palette.textSecondary,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
private fun CameraGlyph(color: Color, background: Color, modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.04f, size.height * 0.18f),
            size = Size(size.width * 0.92f, size.height * 0.74f),
            cornerRadius = CornerRadius(size.width * 0.16f, size.width * 0.16f)
        )
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.24f, size.height * 0.06f),
            size = Size(size.width * 0.34f, size.height * 0.18f),
            cornerRadius = CornerRadius(size.width * 0.07f, size.width * 0.07f)
        )
        drawCircle(
            color = background,
            radius = size.minDimension * 0.25f,
            center = Offset(size.width * 0.50f, size.height * 0.57f),
        )
        drawCircle(
            color = color.copy(alpha = 0.95f),
            radius = size.minDimension * 0.13f,
            center = Offset(size.width * 0.50f, size.height * 0.57f),
        )
        drawCircle(
            color = background,
            radius = size.minDimension * 0.06f,
            center = Offset(size.width * 0.79f, size.height * 0.40f)
        )
    }
}

@Composable
private fun CarouselGlyph(color: Color, background: Color, modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val cardWidth = size.width * 0.48f
        val cardHeight = size.height * 0.62f
        val stroke = Stroke(width = size.minDimension * 0.065f, cap = StrokeCap.Round)

        listOf(0.08f, 0.25f, 0.42f).forEachIndexed { index, leftFactor ->
            val alpha = 0.45f + index * 0.18f
            drawRoundRect(
                color = color.copy(alpha = alpha),
                topLeft = Offset(size.width * leftFactor, size.height * (0.18f + index * 0.03f)),
                size = Size(cardWidth, cardHeight),
                cornerRadius = CornerRadius(size.width * 0.08f, size.width * 0.08f),
                style = stroke
            )
        }
        drawCircle(
            color = background,
            radius = size.minDimension * 0.08f,
            center = Offset(size.width * 0.70f, size.height * 0.40f)
        )
        drawLine(
            color = color,
            start = Offset(size.width * 0.55f, size.height * 0.58f),
            end = Offset(size.width * 0.82f, size.height * 0.58f),
            strokeWidth = size.minDimension * 0.055f,
            cap = StrokeCap.Round
        )
        drawLine(
            color = color,
            start = Offset(size.width * 0.55f, size.height * 0.70f),
            end = Offset(size.width * 0.76f, size.height * 0.70f),
            strokeWidth = size.minDimension * 0.055f,
            cap = StrokeCap.Round
        )
    }
}

@Composable
private fun CalendarGlyph(color: Color, background: Color, modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val stroke = Stroke(width = size.minDimension * 0.065f, cap = StrokeCap.Round)
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.16f, size.height * 0.18f),
            size = Size(size.width * 0.68f, size.height * 0.66f),
            cornerRadius = CornerRadius(size.width * 0.08f, size.width * 0.08f),
            style = stroke
        )
        drawRoundRect(
            color = color.copy(alpha = 0.22f),
            topLeft = Offset(size.width * 0.16f, size.height * 0.30f),
            size = Size(size.width * 0.68f, size.height * 0.14f),
            cornerRadius = CornerRadius(size.width * 0.04f, size.width * 0.04f)
        )
        drawLine(
            color = background,
            start = Offset(size.width * 0.24f, size.height * 0.43f),
            end = Offset(size.width * 0.76f, size.height * 0.43f),
            strokeWidth = size.minDimension * 0.035f,
            cap = StrokeCap.Round
        )
        listOf(0.32f, 0.50f, 0.68f).forEach { xFactor ->
            drawCircle(
                color = color,
                radius = size.minDimension * 0.035f,
                center = Offset(size.width * xFactor, size.height * 0.56f)
            )
            drawCircle(
                color = color,
                radius = size.minDimension * 0.035f,
                center = Offset(size.width * xFactor, size.height * 0.70f)
            )
        }
        drawLine(
            color = color,
            start = Offset(size.width * 0.32f, size.height * 0.10f),
            end = Offset(size.width * 0.32f, size.height * 0.25f),
            strokeWidth = size.minDimension * 0.075f,
            cap = StrokeCap.Round
        )
        drawLine(
            color = color,
            start = Offset(size.width * 0.68f, size.height * 0.10f),
            end = Offset(size.width * 0.68f, size.height * 0.25f),
            strokeWidth = size.minDimension * 0.075f,
            cap = StrokeCap.Round
        )
    }
}

@Composable
private fun WalletGlyph(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val stroke = Stroke(width = size.minDimension * 0.08f, cap = StrokeCap.Round)
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.12f, size.height * 0.24f),
            size = Size(size.width * 0.76f, size.height * 0.56f),
            cornerRadius = CornerRadius(size.width * 0.12f, size.width * 0.12f),
            style = stroke
        )
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.58f, size.height * 0.43f),
            size = Size(size.width * 0.30f, size.height * 0.20f),
            cornerRadius = CornerRadius(size.width * 0.06f, size.width * 0.06f),
            style = stroke
        )
        drawCircle(
            color = color,
            radius = size.minDimension * 0.035f,
            center = Offset(size.width * 0.69f, size.height * 0.53f)
        )
    }
}

@Composable
private fun CompanyGlyph(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val stroke = Stroke(width = size.minDimension * 0.075f, cap = StrokeCap.Round)
        drawRoundRect(
            color = color.copy(alpha = 0.20f),
            topLeft = Offset(size.width * 0.12f, size.height * 0.46f),
            size = Size(size.width * 0.76f, size.height * 0.38f),
            cornerRadius = CornerRadius(size.width * 0.05f, size.width * 0.05f),
        )
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.12f, size.height * 0.46f),
            size = Size(size.width * 0.76f, size.height * 0.38f),
            cornerRadius = CornerRadius(size.width * 0.05f, size.width * 0.05f),
            style = stroke
        )
        val roof = listOf(
            Offset(size.width * 0.14f, size.height * 0.46f),
            Offset(size.width * 0.28f, size.height * 0.32f),
            Offset(size.width * 0.28f, size.height * 0.46f),
            Offset(size.width * 0.44f, size.height * 0.32f),
            Offset(size.width * 0.44f, size.height * 0.46f),
            Offset(size.width * 0.60f, size.height * 0.32f),
            Offset(size.width * 0.60f, size.height * 0.46f),
            Offset(size.width * 0.86f, size.height * 0.46f)
        )
        roof.zipWithNext().forEach { (start, end) ->
            drawLine(
                color = color,
                start = start,
                end = end,
                strokeWidth = size.minDimension * 0.075f,
                cap = StrokeCap.Round
            )
        }
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.70f, size.height * 0.18f),
            size = Size(size.width * 0.12f, size.height * 0.28f),
            cornerRadius = CornerRadius(size.width * 0.025f, size.width * 0.025f)
        )
        repeat(3) { index ->
            val left = size.width * (0.22f + index * 0.18f)
            drawRoundRect(
                color = color.copy(alpha = 0.90f),
                topLeft = Offset(left, size.height * 0.58f),
                size = Size(size.width * 0.08f, size.height * 0.10f),
                cornerRadius = CornerRadius(size.width * 0.02f, size.width * 0.02f)
            )
        }
        drawRoundRect(
            color = color.copy(alpha = 0.95f),
            topLeft = Offset(size.width * 0.66f, size.height * 0.62f),
            size = Size(size.width * 0.10f, size.height * 0.24f),
            cornerRadius = CornerRadius(size.width * 0.02f, size.width * 0.02f)
        )
    }
}

@Composable
private fun HeadsetGlyph(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val stroke = Stroke(width = size.minDimension * 0.08f, cap = StrokeCap.Round)
        drawArc(
            color = color,
            startAngle = 205f,
            sweepAngle = 130f,
            useCenter = false,
            topLeft = Offset(size.width * 0.18f, size.height * 0.15f),
            size = Size(size.width * 0.64f, size.height * 0.68f),
            style = stroke
        )
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.13f, size.height * 0.48f),
            size = Size(size.width * 0.16f, size.height * 0.24f),
            cornerRadius = CornerRadius(size.width * 0.05f, size.width * 0.05f),
            style = stroke
        )
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.71f, size.height * 0.48f),
            size = Size(size.width * 0.16f, size.height * 0.24f),
            cornerRadius = CornerRadius(size.width * 0.05f, size.width * 0.05f),
            style = stroke
        )
        drawLine(
            color = color,
            start = Offset(size.width * 0.58f, size.height * 0.77f),
            end = Offset(size.width * 0.72f, size.height * 0.77f),
            strokeWidth = size.minDimension * 0.08f,
            cap = StrokeCap.Round
        )
        drawCircle(
            color = color,
            radius = size.minDimension * 0.04f,
            center = Offset(size.width * 0.55f, size.height * 0.77f)
        )
    }
}

@Composable
private fun HomeHeader(
    state: HomeUiState,
    onLogout: () -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.background
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 2.dp, bottom = 4.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.app_name),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.ExtraBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    if (state.loading) {
                        Spacer(modifier = Modifier.height(6.dp))
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else {
                        Spacer(modifier = Modifier.height(3.dp))
                        Text(
                            text = stringResource(R.string.home_balance_short, state.saldo),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                state.error?.let { error ->
                    Text(
                        modifier = Modifier.weight(1f),
                        text = error.asString(),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }

            Spacer(modifier = Modifier.height(6.dp))

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                HeaderAction(text = stringResource(R.string.home_logout), onClick = onLogout)
            }
        }
    }
}

@Composable
private fun HeaderAction(
    text: String,
    onClick: () -> Unit
) {
    TextButton(
        onClick = onClick,
        shape = RoundedCornerShape(999.dp)
    ) {
        Text(
            text = text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.labelLarge
        )
    }
}

@Composable
private fun StatusShortcuts(
    state: HomeUiState,
    onOpenOrders: (OrderListFilter) -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        CompactStatusCard(
            modifier = Modifier.weight(1f),
            title = stringResource(R.string.home_status_production_short),
            count = state.emProducao,
            loading = state.summaryLoading,
            tint = Color(0xFF2563EB),
            onClick = { onOpenOrders(OrderListFilter.Production) }
        )
        CompactStatusCard(
            modifier = Modifier.weight(1f),
            title = stringResource(R.string.home_status_ready_short),
            count = state.artesProntas,
            loading = state.summaryLoading,
            tint = Color(0xFF059669),
            onClick = { onOpenOrders(OrderListFilter.Ready) }
        )
        CompactStatusCard(
            modifier = Modifier.weight(1f),
            title = stringResource(R.string.home_status_payment_short),
            count = state.pagamentosPendentes,
            loading = state.summaryLoading,
            tint = Color(0xFFD97706),
            onClick = { onOpenOrders(OrderListFilter.PaymentPending) }
        )
    }
}

@Composable
private fun CompactStatusCard(
    modifier: Modifier,
    title: String,
    count: Int,
    loading: Boolean,
    tint: Color,
    onClick: () -> Unit
) {
    Card(
        modifier = modifier
            .height(96.dp)
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(12.dp),
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            Box(
                modifier = Modifier
                    .size(10.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(tint)
            )
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                Text(
                    text = count.toString(),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold
                )
            }
            Text(
                text = title,
                style = MaterialTheme.typography.labelMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun RecentOrders(
    orders: List<OrderSummary>,
    loading: Boolean,
    onOpenOrders: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = stringResource(R.string.home_recent_orders),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold
        )
        TextButton(onClick = onOpenOrders) {
            Text(stringResource(R.string.home_see_all))
        }
    }

    if (loading) {
        CircularProgressIndicator(modifier = Modifier.size(24.dp))
        return
    }

    if (orders.isEmpty()) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(18.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            Text(
                modifier = Modifier.padding(16.dp),
                text = stringResource(R.string.home_no_recent_orders),
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        return
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        orders.forEach { order ->
            RecentOrderRow(order = order, onClick = onOpenOrders)
        }
    }
}

@Composable
private fun RecentOrderRow(
    order: OrderSummary,
    onClick: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = order.tipo.ifBlank { stringResource(R.string.orders_default_type) },
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    text = stringResource(R.string.orders_id, order.id),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Spacer(modifier = Modifier.width(10.dp))
            Text(
                text = orderStatusLabel(order),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
                maxLines = 1
            )
        }
    }
}

@Composable
private fun orderStatusLabel(order: OrderSummary): String {
    return when {
        order.status.equals("erro", ignoreCase = true) -> stringResource(R.string.orders_badge_error)
        order.pagamentoPendente -> stringResource(R.string.home_status_payment_short)
        order.imagemPronta -> stringResource(R.string.orders_badge_ready)
        else -> stringResource(R.string.home_status_production_short)
    }
}
