package br.com.ia4tube.app.core.art_cache

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.request.CachePolicy
import coil.request.ImageRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private data class PrivateArtDisplay(val art: SavedPrivateArt? = null, val checking: Boolean = true,
    val verified: Boolean = false, val failed: Boolean = false)

internal interface PrivateArtSource {
    val sessionChanges: StateFlow<Long>
    val dispatcher: CoroutineDispatcher get() = Dispatchers.IO
    fun currentToken(): String
    fun load(url: String, token: String, onSaved: (SavedPrivateArt) -> Unit): PrivateArtResult
    fun discard(url: String, token: String, epoch: Long)
}

// Deterministic, network-free rendering tests only. Production uses the protected runtime.
internal val LocalPrivateArtSource = staticCompositionLocalOf<PrivateArtSource?> { null }

/** Local files are never exposed through Coil's global image/disk cache or external URI. */
@Composable
fun PrivateArtImage(url: String, token: String, contentDescription: String,
    modifier: Modifier = Modifier, contentScale: ContentScale = ContentScale.Fit,
    errorText: String = "Não foi possível carregar a imagem.", revalidationKey: Any? = null) {
    val context = LocalContext.current.applicationContext
    val source = LocalPrivateArtSource.current ?: remember(context) {
        val runtime = AndroidPrivateArts.runtime(context)
        object : PrivateArtSource {
            override val sessionChanges = AndroidPrivateArts.sessionChanges
            override fun currentToken() = runtime.currentToken()
            override fun load(url: String, token: String, onSaved: (SavedPrivateArt) -> Unit) = runtime.repository.load(url, token, onSaved)
            override fun discard(url: String, token: String, epoch: Long) = runtime.repository.discardUndecodable(url, token, epoch)
        }
    }
    val epoch by source.sessionChanges.collectAsState()
    // Recreate all bitmap/display state on owner replacement, not just the network request.
    key(url, token, epoch, revalidationKey) {
        val allowed = token.isNotBlank() && source.currentToken() == token
        val display by produceState(PrivateArtDisplay(), url, token, allowed) {
            if (!allowed || url.isBlank()) {
                value = PrivateArtDisplay(checking = false, failed = true)
                return@produceState
            }
            try {
                val result = withContext(source.dispatcher) {
                    source.load(url, token) { saved ->
                        value = if (source.currentToken() == token && source.sessionChanges.value == epoch)
                            PrivateArtDisplay(art = saved)
                        else PrivateArtDisplay(checking = false, failed = true)
                    }
                }
                value = if (source.currentToken() == token && source.sessionChanges.value == epoch)
                    PrivateArtDisplay(result.art, checking = false, verified = result.verified)
                else PrivateArtDisplay(checking = false, failed = true)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { value = PrivateArtDisplay(checking = false, failed = true) }
        }
        val loader = remember(context) { ImageLoader.Builder(context)
            .memoryCachePolicy(CachePolicy.DISABLED).diskCachePolicy(CachePolicy.DISABLED).build() }
        DisposableEffect(loader) { onDispose { loader.shutdown() } }
        val scope = rememberCoroutineScope()
        var decodeFailed by remember(display.art?.bytes) { mutableStateOf(false) }
        Box(modifier, contentAlignment = Alignment.Center) {
            val art = display.art
            if (allowed && art != null && !decodeFailed) {
                val request = remember(art.bytes) { ImageRequest.Builder(context).data(art.bytes)
                    .memoryCachePolicy(CachePolicy.DISABLED).diskCachePolicy(CachePolicy.DISABLED).build() }
                AsyncImage(model = request, imageLoader = loader, contentDescription = contentDescription,
                    contentScale = contentScale, modifier = Modifier.fillMaxSize(), onError = {
                        decodeFailed = true
                        scope.launch(source.dispatcher) { source.discard(url, token, epoch) }
                    })
                if (!display.checking && !display.verified) Text("Cópia salva • sem atualização confirmada",
                    modifier = Modifier.align(Alignment.BottomCenter).padding(4.dp),
                    style = MaterialTheme.typography.labelSmall)
            } else if (display.checking && !display.failed && allowed) CircularProgressIndicator()
            else Text(errorText, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(4.dp))
        }
    }
}
