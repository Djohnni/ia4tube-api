package br.com.ia4tube.app.feature.calendar

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.request.CachePolicy
import coil.request.ImageRequest
import kotlinx.coroutines.delay
import okhttp3.OkHttpClient
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// Preview/test injection only; production always renders the owned, immutable server JPEG.
internal val LocalScheduledArtRenderer = staticCompositionLocalOf<(@Composable (ScheduledArt, Modifier) -> Unit)?> { null }

@Composable
fun rememberCalendarModel(tokenProvider: () -> String): CalendarViewModel {
    val token = tokenProvider()
    val model = remember(token) { CalendarViewModel(tokenProvider, token) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by remember { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) { resumed = true; model.refresh() }
            if (event == Lifecycle.Event.ON_PAUSE) { resumed = false; model.onPause() }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dispose() }
    }
    LaunchedEffect(model, resumed) { if (resumed) while (true) { model.refresh(); delay(15000) } }
    return model
}

@Composable
fun ScheduledArtImage(item: ScheduledArt, token: String, modifier: Modifier = Modifier) {
    LocalScheduledArtRenderer.current?.let { render -> render(item, modifier); return }
    val context = LocalContext.current
    val loader = remember(token) { ImageLoader.Builder(context).okHttpClient(
        OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build())
        .memoryCachePolicy(CachePolicy.DISABLED).diskCachePolicy(CachePolicy.DISABLED).build() }
    DisposableEffect(loader) { onDispose { loader.shutdown() } }
    val url = item.imageUrl
    if (url != null && token.isNotBlank()) {
        var imageFailed by remember(item.id, item.revision) { mutableStateOf(false) }
        Box(modifier, contentAlignment = Alignment.Center) {
        AsyncImage(model = ImageRequest.Builder(context).data(CALENDAR_ORIGIN + url)
            .addHeader("Authorization", "Bearer $token").addHeader("Cache-Control", "no-store")
            .memoryCachePolicy(CachePolicy.DISABLED).diskCachePolicy(CachePolicy.DISABLED).build(),
            imageLoader = loader, contentDescription = "Arte preparada para o Instagram, sem corte",
            contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize(),
            onError = { imageFailed = true }, onSuccess = { imageFailed = false })
        if (imageFailed) Text("Não foi possível carregar a prévia. Atualize para conferir a imagem.", color = Color(0xFFFFB4AB), modifier = Modifier.background(Color(0xFF171B25)).padding(12.dp))
        }
    } else Box(modifier, contentAlignment = Alignment.Center) { Text("Preparando a imagem…", color = Color(0xFFACB5C8)) }
}

@Composable
fun CalendarAutomationSettings(model: CalendarViewModel) {
    val state by model.uiState.collectAsState()
    var confirm by remember { mutableStateOf(false) }
    if (!state.data.enabled) return
    Card { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Publicação pelo calendário", fontWeight = FontWeight.Bold)
        Text(if (state.data.automatic) "Novos pedidos serão programados para o Instagram. Você pode mudar a legenda, a data ou excluir o agendamento no calendário."
            else "Ative uma vez para programar automaticamente as artes dos próximos pedidos.")
        Text("Conta: ${state.data.username?.let { "@$it" } ?: "conecte seu Instagram profissional"}")
        OutlinedButton(onClick = { if (state.data.automatic) model.preferences(false) else confirm = true },
            enabled = state.fresh && !state.busy && (state.data.connected || state.data.automatic)) {
            Text(if (state.data.automatic) "Pausar programação automática" else "Ativar para novos pedidos")
        }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    } }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text("Ativar publicação automática?") },
        text = { Text("As artes dos próximos pedidos serão publicadas em @${state.data.username} nas datas e horários do calendário, mesmo com o celular desligado. A legenda final será usada como está, salvo se você a editar. Artes antigas não serão publicadas automaticamente. Você pode pausar a programação antes do início de um envio.") },
        confirmButton = { TextButton(onClick = { confirm = false; model.preferences(true) }) { Text("Ativar") } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Voltar") } })
}

@Composable
fun ScheduledNextContent(model: CalendarViewModel, token: String, onGallery: () -> Unit) {
    val state by model.uiState.collectAsState()
    val next = state.data.next ?: return
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Próxima arte do calendário", fontWeight = FontWeight.Bold)
        ScheduledArtImage(next, token, Modifier.fillMaxWidth().aspectRatio(1f).heightIn(max = 380.dp))
        Text(next.caption)
        Text("${next.date} às ${next.time} · Brasília")
        Text(if (state.fresh) next.statusLabel else "Estado não confirmado — atualize")
        OutlinedButton(onClick = onGallery) { Text("Editar na galeria") }
        Text("Esta arte já está na programação. Não é necessário enviá-la manualmente.", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun CalendarGallery(model: CalendarViewModel, token: String, onBack: () -> Unit) {
    val state by model.uiState.collectAsState()
    val today = LocalDate.now(ZoneId.of("America/Sao_Paulo"))
    val items = galleryItems(state.data.items, today)
    val actionWidth = (68f * LocalDensity.current.fontScale).coerceIn(68f, 112f).dp
    var editing by remember { mutableStateOf<Pair<ScheduledArt, String>?>(null) }
    var showStatus by remember { mutableStateOf<ScheduledArt?>(null) }
    BackHandler(onBack = onBack)
    Column(Modifier.fillMaxSize().background(Color(0xFF101218)).padding(horizontal = 12.dp, vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Voltar ao calendário", tint = Color.White) }
            Text("Ver minhas artes programadas", color = Color.White, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            IconButton(onClick = model::refresh, enabled = !state.busy) { Icon(Icons.Default.Refresh, "Atualizar", tint = Color.White) }
        }
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { Text(it, color = Color(0xFFFFB4AB), modifier = Modifier.padding(8.dp)) }
        if (!state.data.enabled) Text("A galeria programada ainda não está disponível neste servidor.", color = Color.White)
        else if (items.isEmpty()) Text("Nenhuma arte programada. As artes criadas aparecerão aqui.", color = Color.White, modifier = Modifier.padding(16.dp))
        else {
            val pager = rememberPagerState(initialPage = items.indexOfFirst { it.date >= today.toString() }.coerceAtLeast(0), pageCount = { items.size })
            VerticalPager(state = pager, key = { items[it].id }, modifier = Modifier.weight(1f)) { index ->
                val art = items[index]
                Column(Modifier.fillMaxSize().padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("${art.username?.let { "@$it · " } ?: ""}${LocalDate.parse(art.date).format(DateTimeFormatter.ofPattern("dd/MM/yyyy"))} · ${art.time}", color = Color.White)
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                        ScheduledArtImage(art, token, Modifier.weight(1f).fillMaxHeight())
                        Column(Modifier.width(actionWidth), verticalArrangement = Arrangement.spacedBy(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            GalleryAction(Icons.Default.Edit, "Legenda", art.editable && state.fresh && !state.busy) { editing = art to "caption" }
                            GalleryAction(Icons.Default.DateRange, "Data/hora", art.editable && state.fresh && !state.busy) { editing = art to "schedule" }
                            GalleryAction(Icons.Default.Check, "Situação", true,
                                if (state.fresh && art.status == "scheduled") Color(0xFF64E6A5) else Color(0xFFFFD28A)) { showStatus = art }
                            GalleryAction(Icons.Default.Delete, "Excluir", art.editable && state.fresh && !state.busy) { editing = art to "cancel" }
                        }
                    }
                    Text(art.caption, color = Color.White, maxLines = 5, overflow = TextOverflow.Ellipsis)
                    Text(if (state.fresh) art.statusLabel else "Estado não confirmado — atualize", color = Color(0xFFD3D6DF))
                    Text("${index + 1} de ${items.size} · Arraste para ver a próxima · Horário de Brasília", color = Color(0xFFB8BDC9), style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
    editing?.let { (art, action) -> CalendarEditDialog(art, action, onDismiss = { editing = null },
        onSave = { caption, date, time -> model.edit(art, action, caption, date, time); editing = null }) }
    showStatus?.let { art -> AlertDialog(onDismissRequest = { showStatus = null }, title = { Text(if (state.fresh) art.statusLabel else "Atualização necessária") },
        text = { Text(if (art.status == "scheduled" && state.fresh) "O envio está programado para ${art.date}, às ${art.time} (Brasília). A conexão será conferida novamente na hora. Não é preciso manter o app aberto."
            else if (art.status == "published") "O Instagram confirmou esta publicação. Excluir um agendamento não apaga uma publicação já feita."
            else if (art.status in setOf("confirming", "dispatching")) "O envio já começou. Aguarde a confirmação. A IA4Tube não repetirá a publicação automaticamente se o resultado estiver incerto."
            else "${art.statusLabel}. Confira a conexão e a programação. Horários vencidos precisam ser reagendados; não são publicados em lote ao voltar.") },
        confirmButton = { TextButton(onClick = { showStatus = null }) { Text("Entendi") } }) }
}

@Composable
private fun GalleryAction(icon: ImageVector, label: String, enabled: Boolean, color: Color = Color.White, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(48.dp)) {
            Icon(icon, label, tint = if (enabled) color else Color(0xFF727885)) }
        Text(label, color = if (enabled) color else Color(0xFF9197A3), style = MaterialTheme.typography.labelSmall,
            textAlign = TextAlign.Center, maxLines = 2)
    }
}

@Composable
private fun CalendarEditDialog(art: ScheduledArt, action: String, onDismiss: () -> Unit, onSave: (String, String, String) -> Unit) {
    val context = LocalContext.current
    var caption by remember(art.id, art.revision) { mutableStateOf(art.caption) }
    var date by remember { mutableStateOf(LocalDate.parse(art.date)) }
    var time by remember { mutableStateOf(LocalTime.parse(art.time)) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(when (action) { "caption" -> "Editar legenda"; "schedule" -> "Mudar data e horário"; else -> "Excluir agendamento?" }) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when (action) {
                "caption" -> { OutlinedTextField(value = caption, onValueChange = { if (it.length <= 2200) caption = it },
                    label = { Text("Legenda do Instagram") }, minLines = 4, maxLines = 9)
                    Text("${caption.length}/2200 · Não altera o texto desenhado na imagem.") }
                "schedule" -> {
                    OutlinedButton(onClick = { DatePickerDialog(context, { _, y, m, d -> date = LocalDate.of(y, m + 1, d) }, date.year, date.monthValue - 1, date.dayOfMonth).show() }) { Text(date.format(DateTimeFormatter.ofPattern("dd/MM/yyyy"))) }
                    OutlinedButton(onClick = { TimePickerDialog(context, { _, h, m -> time = LocalTime.of(h, m) }, time.hour, time.minute, true).show() }) { Text(time.toString()) }
                    Text("Horário de Brasília. A arte será movida, sem criar outra publicação.")
                }
                else -> Text("A arte será retirada do calendário e não será enviada. A imagem original e o pedido continuam disponíveis. Outras artes e publicações já feitas não serão apagadas.")
            }
        } },
        confirmButton = { TextButton(onClick = { onSave(caption, date.toString(), time.toString()) }, enabled = action != "caption" || caption.isNotBlank()) { Text(if (action == "cancel") "Excluir agendamento" else "Salvar") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Voltar") } })
}
