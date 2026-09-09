package br.com.ia4tube.app.core.art_cache

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color as AndroidColor
import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import java.io.ByteArrayOutputStream
import java.time.Duration
import java.util.concurrent.TimeUnit

/** Real Compose + Coil decoding of synthetic local PNGs; no network, credentials, or Keystore. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class PrivateArtImageRenderTest {
    private class FakeSource : PrivateArtSource {
        override val sessionChanges = MutableStateFlow(1L)
        override val dispatcher: CoroutineDispatcher = Dispatchers.Unconfined
        var token = OWNER
        var reads = 0
        var savedCallbacks = 0
        val discarded = mutableListOf<Triple<String, String, Long>>()
        var next = png(GREEN)
        var rejectAfterSaved = false

        override fun currentToken() = token

        override fun load(url: String, token: String, onSaved: (SavedPrivateArt) -> Unit): PrivateArtResult {
            assertEquals(URL, url)
            assertEquals(OWNER, token)
            reads++
            if (rejectAfterSaved) {
                savedCallbacks++
                onSaved(next)
                throw PrivateArtUnavailable()
            }
            return PrivateArtResult(next, verified = true)
        }

        override fun discard(url: String, token: String, epoch: Long) {
            discarded += Triple(url, token, epoch)
        }
    }

    private class Host(val fake: FakeSource = FakeSource()) {
        val unrelated = mutableStateOf(0)
        val refresh = mutableStateOf(0)
        val callerToken = mutableStateOf(OWNER)
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        private var committed = false

        init {
            controller.get().setTheme(android.R.style.Theme_Material_NoActionBar)
            controller.setup()
            controller.get().setContent {
                IA4TubeTheme {
                    SideEffect { committed = true }
                    CompositionLocalProvider(LocalPrivateArtSource provides fake) {
                        Box(Modifier.fillMaxSize().background(Color.Black)) {
                            PrivateArtImage(URL, callerToken.value, "Arte sintética privada",
                                modifier = Modifier.fillMaxSize(), revalidationKey = refresh.value,
                                errorText = "Imagem indisponível")
                            Text("Outro estado: ${unrelated.value}",
                                modifier = Modifier.align(Alignment.BottomCenter), color = Color.White)
                        }
                    }
                }
            }
            layout()
            pump()
            assertTrue("The actual PrivateArtImage composition must be mounted", committed)
        }

        private fun layout() {
            val view = controller.get().window.decorView
            view.requestLayout()
            view.measure(View.MeasureSpec.makeMeasureSpec(WIDTH, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(HEIGHT, View.MeasureSpec.EXACTLY))
            view.layout(0, 0, WIDTH, HEIGHT)
        }

        fun pump(milliseconds: Long = 32) {
            Snapshot.sendApplyNotifications()
            val main = shadowOf(Looper.getMainLooper())
            main.idle()
            main.idleFor(Duration.ofMillis(milliseconds))
            Snapshot.sendApplyNotifications()
            layout()
            main.idle()
        }

        fun sampledPixels(color: Int): Int {
            val bitmap = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888)
            return try {
                controller.get().window.decorView.draw(Canvas(bitmap))
                var matching = 0
                for (y in 0 until HEIGHT step 8) for (x in 0 until WIDTH step 8) {
                    if (bitmap.getPixel(x, y) == color) matching++
                }
                matching
            } finally { bitmap.recycle() }
        }

        fun await(message: String, diagnostic: () -> String = { "" }, condition: () -> Boolean) {
            // Coil's real decoder runs on its own worker. Virtual looper time alone cannot
            // wait for that worker; bounded frame pumping yields to it without fake painters.
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
            while (System.nanoTime() < deadline) {
                pump()
                if (condition()) return
                Thread.sleep(10)
            }
            assertTrue(message + diagnostic(), condition())
        }

        fun assertRendered(color: Int) = await("Coil must render the actual synthetic image bytes") {
            sampledPixels(color) > 1000
        }

        fun close() {
            controller.pause().stop().destroy()
            Snapshot.sendApplyNotifications()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    @Test fun firstReceivedPngIsDecodedAndRenderedAsRealPixels() {
        val host = Host()
        try {
            host.assertRendered(GREEN)
            assertEquals(1, host.fake.reads)
            assertTrue(host.fake.discarded.isEmpty())
        } finally { host.close() }
    }

    @Test fun unrelatedRecompositionAndElapsedTimeDoNotFetchAgain() {
        val host = Host()
        try {
            host.assertRendered(GREEN)
            host.unrelated.value++
            host.pump(181_000)
            assertEquals("A bitmap already displayed does not start a periodic download", 1, host.fake.reads)
            assertTrue(host.sampledPixels(GREEN) > 1000)
            assertTrue(host.fake.discarded.isEmpty())
        } finally { host.close() }
    }

    @Test fun explicitRevalidationKeyReloadsAndRendersReplacementBytes() {
        val host = Host()
        try {
            host.assertRendered(GREEN)
            host.fake.next = png(BLUE)
            host.refresh.value++
            host.assertRendered(BLUE)
            assertEquals(2, host.fake.reads)
            assertEquals("The old bitmap cannot survive successful replacement", 0, host.sampledPixels(GREEN))
            host.unrelated.value++
            host.pump(61_000)
            assertEquals(2, host.fake.reads)
        } finally { host.close() }
    }

    @Test fun logoutEpochHidesAlreadyRenderedPixelsEvenWhenCallerStillHoldsOldDescriptor() {
        val host = Host()
        try {
            host.assertRendered(GREEN)
            host.fake.token = ""
            host.fake.sessionChanges.value++
            // The caller intentionally retains the old token/URL. The source guard and epoch
            // must hide its old bitmap without asking that caller to clear its state first.
            host.pump()
            assertEquals(0, host.sampledPixels(GREEN))
            assertEquals(1, host.fake.reads)
            host.pump(121_000)
            assertEquals(1, host.fake.reads)
            assertEquals(0, host.sampledPixels(GREEN))
        } finally { host.close() }
    }

    @Test fun denialAfterSavedCallbackRemovesPreviouslyVisiblePixels() {
        val host = Host()
        try {
            host.assertRendered(GREEN)
            host.fake.rejectAfterSaved = true
            host.refresh.value++
            host.pump()
            assertEquals(1, host.fake.savedCallbacks)
            assertEquals(2, host.fake.reads)
            assertEquals("An error after a saved-byte callback must clear that image", 0, host.sampledPixels(GREEN))
            host.pump(61_000)
            assertEquals(2, host.fake.reads)
            assertEquals(0, host.sampledPixels(GREEN))
        } finally { host.close() }
    }

    @Test fun actualDecodeFailureDiscardsOnceWithoutRetrying() {
        val fake = FakeSource().apply {
            next = SavedPrivateArt("not decodable image data".toByteArray(), "image/png", "\"bad\"", null)
        }
        val host = Host(fake)
        try {
            host.await("A real Coil decode failure must discard the exact scoped descriptor",
                diagnostic = { " (discards=${fake.discarded.size}, reads=${fake.reads}, discarded=${fake.discarded})" }) {
                // Like the successful pixel tests, perform a real draw so Coil's painter
                // receives its first rendering/size signal before checking the callback.
                host.sampledPixels(GREEN)
                fake.discarded.size == 1
            }
            assertEquals(listOf(Triple(URL, OWNER, 1L)), fake.discarded)
            assertEquals(1, fake.reads)
            assertEquals(0, host.sampledPixels(GREEN))
            host.unrelated.value++
            host.pump(181_000)
            assertEquals("Decode failure cannot trigger a download loop", 1, fake.reads)
            assertEquals("One failing image is evicted only once", 1, fake.discarded.size)
        } finally { host.close() }
    }

    private companion object {
        const val WIDTH = 822
        const val HEIGHT = 1782
        const val OWNER = "synthetic-render-owner"
        const val URL = "https://ia4tube-api.onrender.com/pedidos/synthetic-render-art/preview"
        val GREEN = AndroidColor.rgb(13, 197, 91)
        val BLUE = AndroidColor.rgb(37, 83, 223)

        fun png(color: Int): SavedPrivateArt {
            val bitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
            return try {
                bitmap.eraseColor(color)
                val output = ByteArrayOutputStream()
                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
                SavedPrivateArt(output.toByteArray(), "image/png", "\"synthetic-$color\"", null)
            } finally { bitmap.recycle() }
        }
    }
}
