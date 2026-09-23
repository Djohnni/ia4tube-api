package br.com.ia4tube.app.feature.calendar

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.semantics.*
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextLayoutResult
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
import org.robolectric.shadows.ShadowDialog
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
    @Test fun musicOpensOverTheGalleryWithoutRemovingIt() = render(1f, "calendar-gallery-music-sheet.png", openMusic = true)
    private fun render(fontScale: Float, filename: String, openMusic: Boolean = false) {
        val today = LocalDate.now(ZoneId.of("America/Sao_Paulo")).toString()
        val item = ScheduledArt("a".repeat(40), "synthetic:1", today, "18:30", "Uma arte pronta para o próximo dia. Você pode editar esta legenda antes da publicação.",
            2, "scheduled", "Programada", true, true, "/synthetic-not-fetched", "empresa_exemplo", System.currentTimeMillis(),
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
        val animationScale = android.provider.Settings.Global.getFloat(activity.contentResolver,
            android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        android.provider.Settings.Global.putFloat(activity.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
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
        var dialogBitmap: Bitmap? = null
        if (openMusic) {
            fun owners(root: View): List<SemanticsOwner> {
                val own = if (root.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                    listOf(root.javaClass.getMethod("getSemanticsOwner").invoke(root) as SemanticsOwner) else emptyList()
                return own + if (root is ViewGroup) (0 until root.childCount).flatMap { owners(root.getChildAt(it)) } else emptyList()
            }
            fun nodes(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::nodes)
            fun texts(root: View) = owners(root).flatMap { nodes(it.rootSemanticsNode) }
            fun label(node: SemanticsNode) = node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }.orEmpty()
            val action = requireNotNull(texts(view).firstOrNull {
                it.config.getOrNull(SemanticsProperties.ContentDescription)?.contains("Usar com música") == true &&
                    it.config.getOrNull(SemanticsActions.OnClick) != null
            }) { "Music action must remain available in the calendar rail" }
            assertTrue(action.config[SemanticsActions.OnClick].action!!.invoke())
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
            assertTrue("Underlying gallery stays composed", texts(view).any { label(it) == "Ver minhas artes programadas" })
            val dialog = requireNotNull(ShadowDialog.getShownDialogs().lastOrNull { it.isShowing }) { "Music must open in a dialog over the gallery" }
            val sheet = dialog.window!!.decorView
            sheet.measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY))
            sheet.layout(0, 0, 822, 1782)
            // The first manual measure creates sheet anchors. Publish that snapshot and
            // remeasure the recomposed dialog before observing its final expanded position.
            repeat(3) {
                Snapshot.sendApplyNotifications()
                shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
                sheet.requestLayout()
                sheet.measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY))
                sheet.layout(0, 0, 822, 1782)
            }
            val sheetNodes = texts(sheet)
            val panel = requireNotNull(sheetNodes.firstOrNull { it.config.getOrNull(SemanticsProperties.PaneTitle) != null }) {
                "Modal sheet must expose its panel bounds independently of the full-window scrim"
            }
            val bounds = panel.boundsInRoot
            assertTrue("Music panel must leave the underlying gallery visible above it", bounds.top > 0f)
            assertTrue("Music panel must use at most 80% of the viewport", bounds.height <= sheet.height * 0.8f + 2f)
            assertEquals("Compact sheet stays anchored to the bottom, not floating above it", sheet.height.toFloat(), bounds.bottom, 2f)
            val title = requireNotNull(sheetNodes.firstOrNull {
                label(it) == "Escolher música" && it.config.getOrNull(SemanticsActions.GetTextLayoutResult) != null
            }) { "Music panel must contain the actual title text layout" }
            val titleLayouts = mutableListOf<TextLayoutResult>()
            assertTrue(title.config[SemanticsActions.GetTextLayoutResult].action!!.invoke(titleLayouts))
            assertTrue("Title must use white text on the dark panel", titleLayouts.isNotEmpty() &&
                titleLayouts.all { it.layoutInput.style.color == Color.White })
            // Capture the dialog while it is shown; a gallery screenshot after
            // dismiss would hide precisely the panel/contrast regression.
            dialogBitmap = Bitmap.createBitmap(822, 1782, Bitmap.Config.ARGB_8888).also { sheet.draw(Canvas(it)) }
            dialog.dismiss()
        }
        val bitmap = dialogBitmap ?: Bitmap.createBitmap(822,1782,Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
        val colors = mutableSetOf<Int>(); for (y in 0 until 1782 step 16) for (x in 0 until 822 step 16) colors.add(bitmap.getPixel(x,y))
        assertTrue("Compose render must contain real content, not a blank screenshot", colors.size > 20)
        val output = File("build/reports/$filename"); output.parentFile?.mkdirs()
        output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) }
        model.dispose(); controller.pause().stop().destroy()
        shadowOf(Looper.getMainLooper()).idle()
        android.provider.Settings.Global.putFloat(activity.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, animationScale)
        bitmap.recycle(); sample.recycle()
    }
}
