package br.com.ia4tube.app.feature.calendar.imports

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color as AndroidColor
import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.time.Duration
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Real shared Compose surface + HTTP + checked cache + Coil. This tests reload ownership, not MP4 decoding. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class ScheduledPrivateMediaRefreshTest {
    private lateinit var server: MockWebServer
    private lateinit var directory: File
    private lateinit var cache: PrivateImportPreviewCache
    private lateinit var bytes: ByteArray
    private var host: Host? = null
    private val owner = ImportPreparationTestData.owner
    private val token = "synthetic-preview-session"
    private val failures = AtomicInteger()
    private val verified = AtomicInteger()

    @Before fun setup() {
        bytes = Bitmap.createBitmap(120, 180, Bitmap.Config.ARGB_8888).let { bitmap ->
            try {
                bitmap.eraseColor(AndroidColor.rgb(15, 220, 25))
                ByteArrayOutputStream().use { output ->
                    check(bitmap.compress(Bitmap.CompressFormat.JPEG, 100, output))
                    output.toByteArray()
                }
            } finally { bitmap.recycle() }
        }
        server = MockWebServer().apply { start() }
        directory = Files.createTempDirectory("scheduled-private-preview-").toFile().canonicalFile
        cache = PrivateImportPreviewCache(directory, server.url("/"), allowLoopbackForTests = true)
    }

    @After fun close() {
        host?.close()
        cache.clear()
        server.shutdown()
        directory.listFiles()?.forEach { file -> file.setWritable(true, true); check(file.delete()) }
        check(directory.delete())
    }

    private fun preview(): ImportPrivatePreview {
        val asset = ImportPreparationTestData.assetId
        val schedule = "d".repeat(40)
        val path = "/v1/social/calendar/imports/schedules/$schedule/preview/feed"
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val part = ImportPrivatePreviewPart("feed", ImportMediaKind.IMAGE, "image/jpeg", sha, "a".repeat(64),
            120, 180, bytes.size.toLong(), null, ImportAudioMode.NONE, false, server.url(path))
        return ImportPrivatePreview(asset, 1, 1, "c".repeat(64), false, listOf(part), null, schedule)
    }

    private fun respond(firstFails: Boolean) {
        server.dispatcher = object : Dispatcher() {
            private val calls = AtomicInteger()
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (calls.incrementAndGet() == 1 && firstFails) MockResponse().setResponseCode(503)
                    .setHeader("Content-Type", "application/json").setBody("{\"error\":\"temporarily_unavailable\"}")
                else MockResponse().setHeader("Content-Type", "image/jpeg").setBody(Buffer().write(bytes))
        }
    }

    private inner class Host(initialActive: Boolean = true) {
        val refresh = mutableStateOf(0)
        val unrelated = mutableStateOf(0)
        val active = mutableStateOf(initialActive)
        val preview = preview()
        private val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        private val lifecycleOwner = object : LifecycleOwner {
            val registry = LifecycleRegistry(this)
            override val lifecycle: Lifecycle get() = registry
        }
        private var committed = false

        init {
            lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
            lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
            lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
            controller.get().setTheme(android.R.style.Theme_Material_NoActionBar)
            controller.setup()
            controller.get().setContent {
                IA4TubeTheme {
                    SideEffect { committed = true }
                    CompositionLocalProvider(LocalLifecycleOwner provides lifecycleOwner) {
                        Box(Modifier.fillMaxSize()) {
                            PrivateImportPreviewSurface(owner, { token }, preview, "feed", active.value,
                                modifier = Modifier.fillMaxSize(), refreshKey = refresh.value,
                                cacheForTests = cache, storedTokenForTests = { token },
                                onVerified = { verified.incrementAndGet() }, onFailure = { failures.incrementAndGet() })
                            Text("Estado independente: ${unrelated.value}", Modifier.align(Alignment.BottomCenter))
                        }
                    }
                }
            }
            pump()
            assertTrue("The production Compose surface must actually be mounted", committed)
        }

        private fun layout() {
            controller.get().window.decorView.apply {
                requestLayout()
                measure(View.MeasureSpec.makeMeasureSpec(WIDTH, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(HEIGHT, View.MeasureSpec.EXACTLY))
                layout(0, 0, WIDTH, HEIGHT)
            }
        }

        fun pump(milliseconds: Long = 32) {
            Snapshot.sendApplyNotifications()
            val main = shadowOf(Looper.getMainLooper())
            main.idle(); main.idleFor(Duration.ofMillis(milliseconds))
            Snapshot.sendApplyNotifications(); layout(); main.idle()
        }

        fun greenPixels(): Int {
            val bitmap = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888)
            return try {
                controller.get().window.decorView.draw(Canvas(bitmap))
                var green = 0
                for (y in 0 until HEIGHT step 12) for (x in 0 until WIDTH step 12) {
                    val color = bitmap.getPixel(x, y)
                    if (AndroidColor.green(color) > 180 && AndroidColor.red(color) < 60 && AndroidColor.blue(color) < 60) green++
                }
                green
            } finally { bitmap.recycle() }
        }

        fun await(message: String, condition: () -> Boolean) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
            while (System.nanoTime() < deadline) {
                pump(); greenPixels()
                if (condition()) return
                Thread.sleep(10)
            }
            assertTrue("$message (GETs=${server.requestCount}, failed=${failures.get()}, verified=${verified.get()})", condition())
        }

        fun background() {
            lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
            lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
            pump()
        }

        fun foreground() {
            lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
            lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
            pump()
        }

        fun close() {
            lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)
            controller.pause().stop().destroy()
            Snapshot.sendApplyNotifications(); shadowOf(Looper.getMainLooper()).idle()
        }
    }

    @Test fun sameScheduledMediaRecoversFrom503OnlyAfterExplicitRefreshWithoutARequestLoop() {
        respond(firstFails = true)
        val mounted = Host().also { host = it }
        mounted.await("The first server failure must become visible") { failures.get() == 1 }
        assertEquals(1, server.requestCount)
        assertEquals(0, verified.get())
        assertEquals(0, mounted.greenPixels())
        mounted.unrelated.value++
        mounted.pump(121_000)
        assertEquals("Neither cache epochs nor unrelated recomposition may retry a failed preview", 1, server.requestCount)

        val sameDescriptor = mounted.preview
        mounted.refresh.value++
        mounted.await("Explicit refresh must decode and render the same scheduled file") {
            verified.get() >= 1 && mounted.greenPixels() > 1000
        }
        assertSame(sameDescriptor, mounted.preview)
        assertEquals(2, server.requestCount)
        val first = server.takeRequest(1, TimeUnit.SECONDS)!!
        val second = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals(first.path, second.path)
        assertEquals("Bearer $token", first.getHeader("Authorization"))
        assertEquals("Bearer $token", second.getHeader("Authorization"))
        assertEquals(1, directory.listFiles()!!.size)
        assertTrue(cache.isCurrent(cache.epochs.value, owner, token))

        mounted.unrelated.value++
        mounted.pump(121_000)
        assertEquals("A stable refresh key keeps the successful lease without another download", 2, server.requestCount)
        assertTrue(mounted.greenPixels() > 1000)
        assertEquals(1, failures.get())
    }

    @Test fun refreshingInBackgroundCannotDownloadUntilTheSameSurfaceReturnsToForeground() {
        respond(firstFails = false)
        val mounted = Host().also { host = it }
        mounted.await("Initial checked file must render") { verified.get() >= 1 && mounted.greenPixels() > 1000 }
        assertEquals(1, server.requestCount)
        mounted.background()
        mounted.refresh.value++
        mounted.unrelated.value++
        mounted.pump(121_000)
        assertEquals("Background refresh must not download or expose the old private file", 1, server.requestCount)
        assertEquals(0, mounted.greenPixels())
        assertTrue(directory.listFiles()!!.isEmpty())
        mounted.foreground()
        mounted.await("Foreground resumes a single authenticated read for the same descriptor") {
            server.requestCount == 2 && mounted.greenPixels() > 1000
        }
        mounted.pump(121_000)
        assertEquals(2, server.requestCount)
    }

    @Test fun inactiveMediaCannotDownloadEvenWhenItsRefreshKeyChanges() {
        respond(firstFails = false)
        val mounted = Host(initialActive = false).also { host = it }
        mounted.refresh.value++
        mounted.pump(121_000)
        assertEquals(0, server.requestCount)
        assertTrue(directory.listFiles()!!.isEmpty())
        mounted.active.value = true
        mounted.await("The selected visible item is allowed exactly one checked download") {
            server.requestCount == 1 && mounted.greenPixels() > 1000
        }
        mounted.pump(121_000)
        assertEquals(1, server.requestCount)
    }

    private companion object { const val WIDTH = 822; const val HEIGHT = 1782 }
}
