package br.com.ia4tube.app.feature.calendar

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import br.com.ia4tube.app.ui.components.ScreenScaffold
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import java.io.File
import java.time.Duration
import java.time.LocalDate
import java.time.ZoneId

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class CalendarGalleryRenderTest {
    @Test fun galleryRendersActualComposeWithSyntheticArtAndNoNetwork() = render(1f, "calendar-gallery-preview.png")
    @Test fun galleryRemainsReadableWithLargerText() = render(1.5f, "calendar-gallery-large-text-preview.png")
    private fun render(fontScale: Float, filename: String) {
        val today = LocalDate.now(ZoneId.of("America/Sao_Paulo")).toString()
        val item = ScheduledArt("a".repeat(40), "synthetic:1", today, "18:30", "Uma arte pronta para o próximo dia. Você pode editar esta legenda antes da publicação.",
            2, "scheduled", "Programada", true, true, null, "empresa_exemplo", System.currentTimeMillis(),
            destination = "both", formatsReady = true)
        val snapshot = CalendarSnapshot(true, true, 2, true, "empresa_exemplo", true, listOf(item), item)
        val gateway = object : CalendarGateway {
            override suspend fun list() = snapshot
            override suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot = error("No mutation in visual check")
            override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot = error("No mutation in visual check")
        }
        val model = CalendarViewModel({ "synthetic-only" }, "synthetic-only", gateway)
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        val activity = controller.get()
        activity.setTheme(android.R.style.Theme_Material_NoActionBar)
        controller.setup()
        val config = android.content.res.Configuration(activity.resources.configuration).apply { this.fontScale = fontScale }
        @Suppress("DEPRECATION")
        activity.resources.updateConfiguration(config, activity.resources.displayMetrics)
        val sample = Bitmap.createBitmap(1080, 1350, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(sample); canvas.drawColor(android.graphics.Color.rgb(28, 69, 104))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.rgb(244, 216, 154); textSize = 120f; isFakeBoldText = true }
        canvas.drawText("SUA MARCA", 95f, 420f, paint); paint.textSize = 58f; paint.isFakeBoldText = false
        canvas.drawText("Uma nova ideia por dia.", 110f, 555f, paint)
        model.refresh(); shadowOf(Looper.getMainLooper()).idle()
        activity.setContent { IA4TubeTheme {
            CompositionLocalProvider(LocalScheduledArtRenderer provides { _, modifier -> Image(sample.asImageBitmap(), "Arte sintética", modifier, contentScale = ContentScale.Fit) }) {
                ScreenScaffold { CalendarGallery(model, "synthetic-only") {} }
            }
        } }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        val view = activity.window.decorView
        view.measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY)); view.layout(0,0,822,1782)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        val bitmap = Bitmap.createBitmap(822,1782,Bitmap.Config.ARGB_8888); view.draw(Canvas(bitmap))
        val colors = mutableSetOf<Int>(); for (y in 0 until 1782 step 16) for (x in 0 until 822 step 16) colors.add(bitmap.getPixel(x,y))
        assertTrue("Compose render must contain real content, not a blank screenshot", colors.size > 20)
        val output = File("build/reports/$filename"); output.parentFile?.mkdirs()
        output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) }
        model.dispose(); activity.finish(); bitmap.recycle(); sample.recycle()
    }
}
