package br.com.ia4tube.app.feature.home

import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.ia4tube.app.R
import br.com.ia4tube.app.feature.orders.OrderListFilter
import br.com.ia4tube.app.ui.text.asString
import kotlinx.coroutines.launch

/** Presentation only: no session, repository, navigation controller or business work is created here. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun HomeVisualContent(
    state: HomeUiState,
    palette: PremiumHomePalette,
    premiumTheme: PremiumHomeTheme,
    firstFreeArtMode: Boolean,
    showLogout: Boolean,
    onThemeSelected: (PremiumHomeTheme) -> Unit,
    onOpenOrders: (OrderListFilter) -> Unit,
    onOpenPlans: () -> Unit,
    onCreateArtEmpresa: () -> Unit,
    onCarouselClick: () -> Unit,
    onMonthlyPlanningClick: () -> Unit,
    onEditVideoClick: () -> Unit,
    onOpenInstagram: () -> Unit,
    onOpenPlannedArts: () -> Unit,
    onCompanyProfile: () -> Unit,
    onSupport: () -> Unit,
    onLogout: () -> Unit,
    onIconHelpClick: () -> Unit,
    onLockedFeatureClick: () -> Unit,
    onEditCompanyProfile: () -> Unit = {},
    assistantContent: (@Composable () -> Unit)? = null
) {
    val scroll = rememberScrollState()
    val assistantImeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val scope = rememberCoroutineScope()
    var otherForms by rememberSaveable { mutableStateOf(false) }
    var more by rememberSaveable { mutableStateOf(false) }
    val lockable: (() -> Unit) -> () -> Unit = { action ->
        if (firstFreeArtMode) onLockedFeatureClick else action
    }
    val activePlan = state.planoStatus.trim().lowercase() in setOf("active", "ativo") && state.planoNome.isNotBlank()
    // Same credit calculation as the previous Home combo shortcut; these are not order counts.
    val imageCredits = (if (activePlan) state.artesMensaisRestantes else 0).coerceAtLeast(0)
    val videoCredits = (if (activePlan && state.quotaVersion == 1) state.videosMensaisRestantes else 0).coerceAtLeast(0)
    val credits = imageCredits + videoCredits + state.artesAvulsasRestantes.coerceAtLeast(0)
    val creditDescription = if (state.quotaVersion == 1) "$imageCredits imagens · $videoCredits vídeos" +
        (if (state.artesAvulsasRestantes > 0) " · ${state.artesAvulsasRestantes} créditos anteriores" else "")
        else "$credits imagens disponíveis"

    BoxWithConstraints(Modifier.fillMaxSize()) {
    // Some system bars consume IME insets before Compose receives them. The resized
    // viewport still identifies the compact keyboard layout without touching other screens.
    val assistantTyping = assistantContent != null && (assistantImeVisible || maxHeight < 600.dp)
    Column(
        Modifier.fillMaxSize().then(if(assistantContent != null) Modifier.imePadding() else Modifier).background(Brush.verticalGradient(
            listOf(palette.panelGradient.first(), palette.screenBackground, palette.screenBackground)
        )).drawWithCache {
            // Static ambient light: native gradients cached at the current size, without a blur layer.
            val strength = if (premiumTheme == PremiumHomeTheme.White) 0.055f else 0.12f
            val warm = palette.primaryBorder
            val ambient = Brush.radialGradient(
                0f to warm.copy(alpha = strength),
                0.42f to warm.copy(alpha = strength * 0.35f),
                1f to Color.Transparent,
                center = Offset(-size.width * 0.08f, -size.height * 0.03f),
                radius = size.width * 1.15f
            )
            val softLight = Brush.radialGradient(
                0f to warm.copy(alpha = strength * 0.65f),
                0.45f to warm.copy(alpha = strength * 0.22f),
                1f to Color.Transparent,
                center = Offset.Zero, radius = size.width * 0.38f
            )
            onDrawBehind {
                clipRect {
                    drawRect(ambient)
                    withTransform({
                        rotate(-35f, pivot = Offset.Zero)
                        scale(1f, 2.8f, pivot = Offset.Zero)
                    }) {
                        drawCircle(softLight, radius = size.width * 0.38f, center = Offset.Zero)
                    }
                }
            }
        }
    ) {
        Column(
            Modifier.weight(1f).fillMaxWidth().then(if(assistantContent == null) Modifier.verticalScroll(scroll) else Modifier).testTag("home_scroll")
                .padding(horizontal = 20.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            if (!assistantTyping) HomeMetallicHeading(palette)
            if (state.loading || state.summaryLoading) {
                LinearProgressIndicator(Modifier.fillMaxWidth().testTag("home_loading"), color = palette.primaryBorder,
                    trackColor = palette.panelBorder.copy(alpha = 0.15f))
            }
            state.error?.let { Text(it.asString(), color = MaterialTheme.colorScheme.error, fontSize = 16.sp) }
            state.summaryError?.let { Text(it.asString(), color = MaterialTheme.colorScheme.error, fontSize = 16.sp) }

            if (!assistantTyping) {
            HomeVisualShortcut("Instagram", R.drawable.home_instagram_3d, "home_instagram", palette,
                subtitle = "conecte seu instagram ao iA4tube", onClick = onOpenInstagram)
            HomeVisualShortcut("Calendário", R.drawable.home_calendar_3d, "home_calendar", palette,
                accessibilityLabel = "Minhas artes planejadas", onClick = onOpenPlannedArts)
            }
            Spacer(Modifier.height(8.dp))
            if (assistantContent != null) Box(Modifier.weight(1f).fillMaxWidth()) { assistantContent() } else BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                HomeVisualCreation("Posts prontos", R.drawable.home_ready_posts_3d, "home_ready_posts", palette,
                    modifier = Modifier.width((maxWidth - 12.dp) / 2), onClick = onEditVideoClick)
            }
            Spacer(Modifier.height(4.dp))
            if (assistantContent == null) Row(
                Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(14.dp))
                    .clickable(role = Role.Button) { otherForms = !otherForms }.testTag("home_other_forms")
                    .padding(horizontal = 10.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("Outras formas de criar", color = palette.textPrimary, fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Icon(if (otherForms) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                    contentDescription = if (otherForms) "Recolher outras formas" else "Expandir outras formas",
                    tint = palette.primaryBorder, modifier = Modifier.size(28.dp))
            }
            if (otherForms && assistantContent == null) {
                HomeVisualMenuAction("Criar imagens", "home_create_image", palette,
                    onClick = onMonthlyPlanningClick)
                HomeVisualMenuAction("Várias fotos", "home_multiple_photos", palette, firstFreeArtMode,
                    onClick = lockable(onCreateArtEmpresa))
                HomeVisualMenuAction("Mat. Impresso", "home_printed_materials", palette, firstFreeArtMode,
                    onClick = lockable(onCompanyProfile))
                HomeVisualMenuAction("Post Deslizante", "home_carousel", palette, firstFreeArtMode,
                    description = state.carrosseisRestantes?.let { "$it disponíveis" }, onClick = lockable(onCarouselClick))
            }
            if (assistantContent == null) Text("Perfil da empresa", color = palette.textPrimary, fontSize = 16.sp,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .clickable(role = Role.Button, onClick = onEditCompanyProfile)
                    .padding(horizontal = 10.dp, vertical = 12.dp).testTag("home_company_profile_editor"))
            Spacer(Modifier.height(8.dp))
        }
        if (!assistantTyping) HomeVisualFooter(palette, credits,
            onHome = { otherForms = false; scope.launch { scroll.scrollTo(0) } },
            onCombo = lockable(onOpenPlans), onMore = { more = true })
    }
    }

    if (more) {
        val dismissAndRun: (() -> Unit) -> () -> Unit = { action ->
            { more = false; action() }
        }
        ModalBottomSheet(
            onDismissRequest = { more = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = palette.cameraBackground,
            contentColor = palette.textPrimary
        ) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)
                .testTag("home_more_sheet"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Mais", color = palette.textPrimary, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                if (assistantContent != null) {
                    Text("Outras formas de criar", color = palette.textSecondary, fontSize = 16.sp)
                    HomeVisualMenuAction("Criar imagens", "home_create_image", palette, onClick = dismissAndRun(onMonthlyPlanningClick))
                    HomeVisualMenuAction("Várias fotos", "home_multiple_photos", palette, firstFreeArtMode, onClick = lockable(dismissAndRun(onCreateArtEmpresa)))
                    HomeVisualMenuAction("Mat. Impresso", "home_printed_materials", palette, firstFreeArtMode, onClick = lockable(dismissAndRun(onCompanyProfile)))
                    HomeVisualMenuAction("Post Deslizante", "home_carousel", palette, firstFreeArtMode, onClick = lockable(dismissAndRun(onCarouselClick)))
                    HomeVisualMenuAction("Perfil da empresa", "home_company_profile_editor", palette, onClick = dismissAndRun(onEditCompanyProfile))
                    HorizontalDivider(color = palette.panelBorder)
                }
                HomeVisualMenuAction("Pedidos", "home_orders", palette, firstFreeArtMode,
                    description = if (state.summaryLoading) "Consultando seus pedidos…"
                    else "${state.emProducao} em produção · ${state.artesProntas} prontas",
                    onClick = lockable(dismissAndRun { onOpenOrders(OrderListFilter.All) }))
                HomeVisualMenuAction("Meus combos", "home_plans", palette, firstFreeArtMode,
                    description = if (state.loading) "Consultando seu saldo…" else creditDescription +
                        if (state.planoNome.isNotBlank()) " · ${state.planoNome}" else "",
                    onClick = lockable(dismissAndRun(onOpenPlans)))
                HomeVisualMenuAction("Suporte", "home_support", palette, firstFreeArtMode,
                    onClick = lockable(dismissAndRun(onSupport)))
                HomeVisualMenuAction("Ajuda", "home_help", palette, firstFreeArtMode,
                    onClick = lockable(dismissAndRun(onIconHelpClick)))
                HorizontalDivider(color = palette.panelBorder)
                Text("Tema da Home", color = palette.textSecondary, fontSize = 16.sp)
                PremiumHomeTheme.entries.chunked(2).forEach { themes ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        themes.forEach { theme ->
                            FilterChip(selected = premiumTheme == theme, onClick = { onThemeSelected(theme) },
                                label = { Text(theme.label, fontSize = 16.sp) },
                                modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                                    .testTag("home_theme_${theme.name.lowercase()}"))
                        }
                    }
                }
                if (showLogout) {
                    HomeVisualMenuAction("Sair", "home_logout", palette, onClick = dismissAndRun(onLogout))
                }
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

@Composable
private fun HomeMetallicHeading(palette: PremiumHomePalette) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val brandSize = minOf(50f, maxWidth.value / (4.5f * LocalDensity.current.fontScale)).sp
        Column(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("iA4tube", modifier = Modifier.testTag("home_brand"), style = TextStyle(
            brush = Brush.verticalGradient(listOf(Color.White, Color(0xFFEAE6DB), Color(0xFF97948D), Color.White)),
            fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Black, fontSize = brandSize,
            shadow = Shadow(Color.Black.copy(alpha = 0.85f), Offset(2f, 4f), 3f)), textAlign = TextAlign.Center)
        Text("PRODUÇÕES", style = TextStyle(
            brush = Brush.verticalGradient(listOf(Color(0xFFFFEDB3), palette.primaryBorder, Color(0xFFAF711B))),
            fontWeight = FontWeight.ExtraBold, fontSize = 21.sp, letterSpacing = 2.sp,
            shadow = Shadow(Color.Black.copy(alpha = 0.7f), Offset(1f, 2f), 2f)), textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun HomeVisualShortcut(label: String, @DrawableRes illustration: Int, tag: String,
    palette: PremiumHomePalette, accessibilityLabel: String = label, subtitle: String? = null, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 80.dp).clip(RoundedCornerShape(18.dp))
        .clickable(role = Role.Button, onClick = onClick).semantics { contentDescription = accessibilityLabel }
        .testTag(tag).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Image(painterResource(illustration), contentDescription = null, contentScale = ContentScale.Fit,
            modifier = Modifier.size(80.dp))
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, color = palette.textPrimary, fontSize = 20.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.fillMaxWidth().testTag("${tag}_title"))
            subtitle?.let {
                Text(it, color = palette.textSecondary, fontSize = 13.sp, lineHeight = 17.sp,
                    modifier = Modifier.fillMaxWidth().testTag("${tag}_subtitle"))
            }
        }
        Icon(Icons.Default.KeyboardArrowRight, contentDescription = null, tint = palette.primaryBorder,
            modifier = Modifier.size(24.dp))
    }
}

@Composable
private fun HomeVisualCreation(label: String, @DrawableRes illustration: Int, tag: String,
    palette: PremiumHomePalette, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Column(modifier.clip(RoundedCornerShape(20.dp)).clickable(role = Role.Button, onClick = onClick)
        .testTag(tag).padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy((-8).dp)) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            Image(painterResource(illustration), contentDescription = null, contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxWidth().height(maxWidth))
        }
        Row(Modifier.fillMaxWidth().heightIn(min = 36.dp).padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = palette.textPrimary, fontSize = 18.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f), textAlign = TextAlign.Center)
            Icon(Icons.Default.KeyboardArrowRight, contentDescription = null, tint = palette.primaryBorder,
                modifier = Modifier.size(24.dp))
        }
    }
}

@Composable
private fun HomeVisualMenuAction(label: String, tag: String, palette: PremiumHomePalette,
    locked: Boolean = false, description: String? = null, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(14.dp))
        .border(BorderStroke(1.dp, palette.panelBorder), RoundedCornerShape(14.dp))
        .clickable(role = Role.Button, onClick = onClick).testTag(tag).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(label, color = palette.textPrimary, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            description?.let { Text(it, color = palette.textSecondary, fontSize = 16.sp) }
        }
        Icon(if (locked) Icons.Default.Lock else Icons.Default.KeyboardArrowRight, contentDescription =
            if (locked) "Entre na sua conta para acessar" else null,
            tint = palette.primaryBorder, modifier = Modifier.padding(start = 8.dp).size(24.dp))
    }
}

@Composable
private fun HomeVisualFooter(palette: PremiumHomePalette, credits: Int,
    onHome: () -> Unit, onCombo: () -> Unit, onMore: () -> Unit) {
    Row(Modifier.fillMaxWidth().background(palette.screenBackground.copy(alpha = 0.96f))
        .testTag("home_footer").padding(horizontal = 20.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        HomeFooterAction("Início", "home_footer_home", palette, true, Modifier.weight(1f), onHome) {
            Icon(Icons.Default.Home, contentDescription = null, tint = palette.primaryBorder, modifier = Modifier.size(24.dp))
        }
        HomeFooterAction("Combo", "home_footer_combo", palette, false, Modifier.weight(1f), onCombo) {
            Box(Modifier.size(30.dp), contentAlignment = Alignment.Center) {
                HomeComboGlyph(palette.textPrimary, Modifier.size(24.dp))
                if (credits > 0) {
                    Text(credits.toString(), color = Color.White, fontSize = 13.sp, lineHeight = 17.sp,
                        fontWeight = FontWeight.Bold, softWrap = false, maxLines = 1,
                        modifier = Modifier.align(Alignment.TopEnd).offset(x = 10.dp, y = (-3).dp)
                            .wrapContentSize(Alignment.TopEnd, unbounded = true).width(IntrinsicSize.Max)
                            .background(Color(0xFFE95532), RoundedCornerShape(20.dp))
                            .padding(horizontal = 6.dp, vertical = 2.dp).testTag("home_credits_badge"))
                }
            }
        }
        HomeFooterAction("Mais", "home_footer_more", palette, false, Modifier.weight(1f), onMore) {
            Icon(Icons.Default.MoreVert, contentDescription = null, tint = palette.textPrimary,
                modifier = Modifier.size(24.dp).rotate(90f))
        }
    }
}

@Composable
private fun HomeFooterAction(label: String, tag: String, palette: PremiumHomePalette, selected: Boolean,
    modifier: Modifier, onClick: () -> Unit, icon: @Composable () -> Unit) {
    Column(modifier.heightIn(min = 60.dp).clip(RoundedCornerShape(12.dp))
        .clickable(role = Role.Button, onClick = onClick).testTag(tag).padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Box(Modifier.height(30.dp), contentAlignment = Alignment.Center) { icon() }
        Text(label, color = if (selected) palette.primaryBorder else palette.textPrimary, fontSize = 14.sp, lineHeight = 18.sp,
            fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        if (selected) Box(Modifier.width(44.dp).height(3.dp).background(palette.primaryBorder, RoundedCornerShape(3.dp)))
    }
}

@Composable
private fun HomeComboGlyph(color: Color, modifier: Modifier) {
    Canvas(modifier) {
        val stroke = Stroke(width = 2.dp.toPx())
        drawRoundRect(color, topLeft = Offset(size.width * .18f, size.height * .32f),
            size = Size(size.width * .64f, size.height * .60f), cornerRadius = CornerRadius(4.dp.toPx()), style = stroke)
        val handle = Path().apply {
            moveTo(size.width * .36f, size.height * .34f)
            lineTo(size.width * .36f, size.height * .21f)
            cubicTo(size.width * .36f, 0f, size.width * .64f, 0f, size.width * .64f, size.height * .21f)
            lineTo(size.width * .64f, size.height * .34f)
        }
        drawPath(handle, color, style = stroke)
    }
}
