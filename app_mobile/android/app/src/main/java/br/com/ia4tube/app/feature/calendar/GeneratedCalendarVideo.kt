package br.com.ia4tube.app.feature.calendar

import android.net.Uri
import androidx.annotation.OptIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import br.com.ia4tube.app.core.art_cache.AndroidPrivateArts
import br.com.ia4tube.app.core.session.SessionStore

/** Plays an owned calendar result only on explicit user action while its page and session are active. */
@Composable
fun ScheduledGeneratedVideo(video: GeneratedCalendarVideo, tokenProvider: () -> String,
    active: Boolean, posterLabel: String? = null, modifier: Modifier = Modifier) {
    val context = LocalContext.current.applicationContext
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val epoch by AndroidPrivateArts.sessionChanges.collectAsState()
    val token = tokenProvider()
    val session = remember(context) { SessionStore(context) }
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) foreground = true
            if (event == Lifecycle.Event.ON_STOP) foreground = false
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val authorized = token.isNotBlank() && runCatching { session.getToken() == token }.getOrDefault(false)
    key(video.sha256, token, epoch) {
        var requested by remember { mutableStateOf(false) }
        LaunchedEffect(active, foreground, authorized) {
            if (!active || !foreground || !authorized) requested = false
        }
        Box(modifier, contentAlignment = Alignment.Center) {
            when {
                !authorized -> Text("Entre novamente para ver este vídeo.")
                !active || !foreground -> Text("Abra este item para reproduzir o vídeo.")
                else -> GeneratedVideoPlayer(video, token, requested, { requested = true }, posterLabel, Modifier.fillMaxSize())
            }
        }
    }
}

@Composable
fun GeneratedCalendarVideoDialog(video: GeneratedCalendarVideo, token: String, onDismiss: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Vídeo programado") },
        text = { ScheduledGeneratedVideo(video, { token }, active = true,
            modifier = Modifier.fillMaxWidth().height(430.dp)) },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Fechar") } })
}

@OptIn(UnstableApi::class)
@Composable
private fun GeneratedVideoPlayer(video: GeneratedCalendarVideo, token: String, requested: Boolean,
    onRequest: () -> Unit, posterLabel: String?, modifier: Modifier) {
    val context = LocalContext.current
    var playing by remember(video.sha256, token) { mutableStateOf(false) }
    var muted by remember(video.sha256, token) { mutableStateOf(false) }
    var buffering by remember(video.sha256, token) { mutableStateOf(true) }
    var error by remember(video.sha256, token) { mutableStateOf(false) }
    val player = remember(video.sha256, token) {
        ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(CalendarVideoDataSource.Factory(video, token))).build().apply {
            repeatMode = Player.REPEAT_MODE_OFF
            // Only the visible item loads its first frame. Audio and playback wait for the tap.
            playWhenReady = false
            setMediaItem(MediaItem.fromUri(Uri.parse(CALENDAR_ORIGIN + video.url)))
        }
    }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(exception: PlaybackException) { error = true }
            override fun onIsPlayingChanged(isPlaying: Boolean) { playing = isPlaying }
            override fun onPlaybackStateChanged(state: Int) { buffering = state == Player.STATE_BUFFERING }
        }
        player.addListener(listener)
        player.prepare()
        onDispose {
            player.playWhenReady = false
            player.stop()
            player.removeListener(listener)
            player.clearMediaItems()
            player.release()
        }
    }
    LaunchedEffect(player, requested) {
        if (requested) player.play() else player.pause()
    }
    Column(modifier) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            AndroidView(factory = { viewContext -> PlayerView(viewContext).apply {
                useController = false
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                this.player = player
            } }, update = { it.player = player }, onRelease = { it.player = null }, modifier = Modifier.fillMaxSize())
            if (buffering && requested && !error) CircularProgressIndicator()
            if (!requested) {
                posterLabel?.takeIf { it.isNotBlank() }?.let { label ->
                    Surface(modifier = Modifier.align(Alignment.BottomStart).padding(8.dp),
                        color = Color.Black.copy(alpha = 0.72f), shape = RoundedCornerShape(6.dp)) {
                        Text(label, color = Color.White, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(7.dp))
                    }
                }
                Button(onClick = {
                    if (error) { error = false; buffering = true; player.prepare() }
                    onRequest()
                }) { Text("Reproduzir vídeo") }
            }
        }
        if (error) Text("Vídeo indisponível. Confira a conexão e tente novamente.")
        if (requested) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (error) OutlinedButton(onClick = {
                error = false
                buffering = true
                player.playWhenReady = true
                player.prepare()
            }) { Text("Tentar novamente") }
            OutlinedButton(onClick = {
                if (player.isPlaying) player.pause() else {
                    if (player.playbackState == Player.STATE_ENDED) player.seekTo(0)
                    player.play()
                }
            }, enabled = !error) { Text(if (playing) "Pausar" else if (buffering && player.playWhenReady) "Carregando..." else "Reproduzir") }
            if (video.hasAudio) OutlinedButton(onClick = {
                muted = !muted
                player.volume = if (muted) 0f else 1f
            }, enabled = !error) { Text(if (muted) "Ouvir" else "Silenciar") }
        }
    }
}
