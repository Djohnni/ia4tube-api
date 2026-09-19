package br.com.ia4tube.app.feature.calendar.imports

import android.content.Context
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import br.com.ia4tube.app.core.art_cache.AndroidPrivateArts
import br.com.ia4tube.app.core.session.SessionStore
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.request.CachePolicy
import coil.request.ImageRequest
import kotlinx.coroutines.CancellationException
import java.io.File

internal object AndroidImportPreviews {
    private var cache: PrivateImportPreviewCache? = null
    @Synchronized fun cache(context: Context): PrivateImportPreviewCache = cache ?: PrivateImportPreviewCache(
        File(context.applicationContext.cacheDir.canonicalFile, "private_import_preview_v1")).also { cache = it }
}

/** No ad hooks, tracking listeners, external URLs or automatic gallery prefetch. Active means the visible, settled item. */
@Composable
fun ScheduledPrivateMedia(owner: ImportOwner, tokenProvider: () -> String, preview: ImportPrivatePreview,
                          target: String, active: Boolean, modifier: Modifier = Modifier) {
    PrivateImportPreviewSurface(owner, tokenProvider, preview, target, active, modifier)
}

@Composable
internal fun PrivateImportPreviewSurface(owner: ImportOwner, tokenProvider: () -> String, preview: ImportPrivatePreview,
    target: String, active: Boolean, modifier: Modifier = Modifier,
    onVerified: (String) -> Unit = {}, onFailure: (String) -> Unit = {}) {
    val context = LocalContext.current.applicationContext
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val cache = remember(context) { AndroidImportPreviews.cache(context) }
    val session = remember(context) { SessionStore(context) }
    val token = tokenProvider()
    val currentToken by rememberUpdatedState(tokenProvider)
    val sessionEpoch by AndroidPrivateArts.sessionChanges.collectAsState()
    val cacheEpoch by cache.epochs.collectAsState()
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    var onScreen by remember(owner, preview.assetId, preview.mediaRevision, target) { mutableStateOf(false) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) foreground = true
            if (event == Lifecycle.Event.ON_STOP) { foreground = false; cache.clear() }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val sessionAllowed = token.isNotBlank() && runCatching { session.getToken() == token && currentToken() == token }.getOrDefault(false)
    key(owner, token, sessionEpoch, preview.assetId, preview.mediaRevision, preview.previewDigest, target) {
        var saved by remember { mutableStateOf<VerifiedImportPreview?>(null) }
        var error by remember { mutableStateOf<String?>(null) }
        val verifiedCallback by rememberUpdatedState(onVerified)
        val failureCallback by rememberUpdatedState(onFailure)
        LaunchedEffect(active, foreground, sessionAllowed, onScreen) {
            saved = null; error = null
            if (!active || !foreground || !sessionAllowed || !onScreen) return@LaunchedEffect
            var lease: VerifiedImportPreview? = null
            try {
                lease = cache.load(owner, token, { if (session.getToken() == token) currentToken() else "" }, { owner }, preview, target)
                saved = lease
                // The DisposableEffect below owns the successful lease. Cancellation still releases a pending download.
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                error = (failure as? ImportPreviewFailure)?.code ?: "import_preview_unavailable"
                failureCallback(target)
            }
        }
        DisposableEffect(saved) {
            val lease = saved
            onDispose { lease?.let { cache.release(it.epoch) } }
        }
        val lease = saved
        LaunchedEffect(cacheEpoch, lease) {
            if (active && foreground && onScreen && lease != null && !cache.isCurrent(lease.epoch, owner, token)) failureCallback(target)
        }
        val usable = active && foreground && sessionAllowed && onScreen && lease != null && cacheEpoch == lease.epoch && cache.isCurrent(lease.epoch, owner, token)
        Box(modifier.onGloballyPositioned { coordinates ->
            val clipped = coordinates.boundsInWindow()
            val total = coordinates.size.width.toLong() * coordinates.size.height
            onScreen = total > 0 && clipped.width * clipped.height >= total * 0.5f
        }, contentAlignment = Alignment.Center) {
            if (usable) {
                if (lease!!.part.kind == ImportMediaKind.VIDEO) VerifiedImportVideo(lease, Modifier.fillMaxSize(),
                    { verifiedCallback(target) }, { error = "import_preview_decode_failed"; failureCallback(target); cache.release(lease.epoch) })
                else VerifiedImportImage(lease, Modifier.fillMaxSize(), { verifiedCallback(target) },
                    { error = "import_preview_decode_failed"; failureCallback(target); cache.release(lease.epoch) })
            } else if (!active) Text("Selecione este item para conferir a prévia.")
            else if (!onScreen) Text("Role até a prévia para carregá-la e reproduzir.")
            else if (!foreground) Text("Prévia interrompida enquanto a tela está fora de uso.")
            else if (!sessionAllowed) Text("A sessão mudou. Abra novamente na empresa correta.")
            else if (error != null || lease != null) Text(if (error == "import_preview_access_expired")
                "O acesso à prévia expirou ou não está disponível. Confira novamente a preparação."
                else "Não foi possível conferir a prévia. Atualize antes de continuar.")
            else Column(horizontalAlignment = Alignment.CenterHorizontally) { CircularProgressIndicator(); Text("Conferindo o arquivo preparado…") }
        }
    }
}

@Composable
private fun VerifiedImportImage(lease: VerifiedImportPreview, modifier: Modifier, onVerified: () -> Unit, onError: () -> Unit) {
    val context = LocalContext.current.applicationContext
    val loader = remember(context) { ImageLoader.Builder(context).memoryCachePolicy(CachePolicy.DISABLED)
        .diskCachePolicy(CachePolicy.DISABLED).build() }
    DisposableEffect(loader) { onDispose { loader.shutdown() } }
    val request = remember(lease) { ImageRequest.Builder(context).data(lease.file).memoryCachePolicy(CachePolicy.DISABLED)
        .diskCachePolicy(CachePolicy.DISABLED).build() }
    AsyncImage(model = request, imageLoader = loader, contentDescription = "Arquivo preparado para ${importTargetLabel(lease.part.target)}",
        contentScale = ContentScale.Fit, modifier = modifier, onSuccess = { onVerified() }, onError = { onError() })
}

/** Player lifetime equals visible, authenticated file lifetime. Local volume never edits ImportConfiguration. */
@Composable
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
private fun VerifiedImportVideo(lease: VerifiedImportPreview, modifier: Modifier, onVerified: () -> Unit, onError: () -> Unit) {
    val context = LocalContext.current
    val currentVerified by rememberUpdatedState(onVerified)
    val currentError by rememberUpdatedState(onError)
    var playing by remember(lease) { mutableStateOf(false) }
    var muted by remember(lease) { mutableStateOf(false) }
    var buffering by remember(lease) { mutableStateOf(true) }
    val player = remember(lease) { ExoPlayer.Builder(context).build().apply {
        repeatMode = Player.REPEAT_MODE_OFF
        playWhenReady = false
        setMediaItem(MediaItem.fromUri(Uri.fromFile(lease.file)))
    } }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onRenderedFirstFrame() { currentVerified() }
            override fun onPlayerError(error: PlaybackException) { currentError() }
            override fun onIsPlayingChanged(isPlaying: Boolean) { playing = isPlaying }
            override fun onPlaybackStateChanged(playbackState: Int) { buffering = playbackState == Player.STATE_BUFFERING }
        }
        val playbackLease = ActiveImportPreviewPlayback.gate.activate {
            player.playWhenReady = false; player.stop(); player.removeListener(listener); player.clearMediaItems(); player.release()
        }
        player.addListener(listener); player.prepare()
        onDispose { ActiveImportPreviewPlayback.gate.release(playbackLease) }
    }
    Column(modifier) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            AndroidView(factory = { viewContext -> PlayerView(viewContext).apply {
                useController = false; resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT; this.player = player
            } }, update = { it.player = player }, onRelease = { it.player = null }, modifier = Modifier.fillMaxSize())
            if (buffering) CircularProgressIndicator()
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { if (player.isPlaying) player.pause() else {
                if (player.playbackState == Player.STATE_ENDED) player.seekTo(0); player.play()
            } }) { Text(if (playing) "Pausar prévia" else "Reproduzir prévia") }
            if (lease.part.hasAudio) OutlinedButton(onClick = { muted = !muted; player.volume = if (muted) 0f else 1f }) {
                Text(if (muted) "Ouvir prévia" else "Silenciar prévia")
            }
        }
        Text(if (lease.part.hasAudio) "Som somente desta prévia. O áudio do arquivo final é escolhido em Música/Áudio."
            else "O arquivo preparado não contém áudio.", style = MaterialTheme.typography.bodySmall)
    }
}

internal fun importTargetLabel(target: String) = when (target) { "feed" -> "Feed"; "story" -> "Story"; "reel" -> "Reel"; else -> "Miniatura" }
