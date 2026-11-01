package br.com.ia4tube.app.feature.edit

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsOwner
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import br.com.ia4tube.app.feature.calendar.calendarAppearanceTestSchemes
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowChoreographer
import org.robolectric.shadows.ShadowDialog
import org.robolectric.shadows.ShadowSystemClock
import java.io.File
import java.time.Duration
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Render the actual dialog only, with synthetic values and callbacks; no order, WebView or network. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w360dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class EditCalendarScheduleDialogVisualTest {
    @Test fun firstDaysRenderTheirRangesWithoutClippingAndOnlyConfirmEmitsASelection() {
        val futureYear = LocalDate.now(ZoneId.of("America/Sao_Paulo")).year + 1
        for (day in 1..2) {
            val date = LocalDate.of(futureYear, 1, day)
            Harness(date, if (day == 1) 1f else 1.3f).use { ui ->
                val range = if (day == 1) "17:55 às 18:05" else "17:48 às 17:58"
                ui.assertContent(date, range)
                assertTrue(ui.confirmed.isEmpty())
                assertEquals(0, ui.dismissed)
                ui.click(range)
                assertTrue("Selecting a suggestion must not send or confirm anything", ui.confirmed.isEmpty())
                assertTrue(ui.text().contains(if (day == 1) "18:00" else "17:53"))
                assertTrue(ui.text().contains(date.format(DateTimeFormatter.ofPattern("dd/MM/yyyy"))))
                ui.assertTextFits()
                ui.assertConfirmationVisible()
                ui.capture(if (day == 1) "posting97-day01-360.png" else "posting97-day02-large-text.png")
                ui.click("Confirmar")
                assertEquals(listOf(EditCalendarSchedule(date.toString(), if (day == 1) "18:00" else "17:53")), ui.confirmed)
            }
        }
    }

    @Test fun expiredRangesStayReadableAndCannotConfirmAPastSchedule() {
        val date = LocalDate.of(LocalDate.now(ZoneId.of("America/Sao_Paulo")).year - 1, 1, 1)
        Harness(date).use { ui ->
            ui.assertContent(date, "17:55 às 18:05")
            assertNotNull(ui.button("17:55 às 18:05").config.getOrNull(SemanticsProperties.Disabled))
            assertNotNull(ui.button("Confirmar").config.getOrNull(SemanticsProperties.Disabled))
            assertTrue(ui.text().contains("Escolha uma data e um horário futuros."))
            ui.assertTextFits()
            ui.assertConfirmationVisible()
            ui.capture("posting97-past-ranges-360.png")
            assertTrue(ui.confirmed.isEmpty())
            assertEquals(0, ui.dismissed)
        }
    }

    private class Harness(date: LocalDate, fontScale: Float = 1f) : AutoCloseable {
        val confirmed = mutableListOf<EditCalendarSchedule>()
        var dismissed = 0
        private val width = 720
        private val height = 1600
        private val scheme = calendarAppearanceTestSchemes().getValue("gold-dark")
        private val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        private val activity = controller.get()
        private val main = shadowOf(Looper.getMainLooper())
        private val oldDelay = ShadowChoreographer.getFrameDelay()
        private val oldPaused = ShadowChoreographer.isPaused()

        init {
            ShadowChoreographer.setPaused(true)
            ShadowChoreographer.setFrameDelay(Duration.ofMillis(16))
            activity.setTheme(android.R.style.Theme_Material_NoActionBar)
            controller.setup()
            activity.setContent {
                IA4TubeTheme {
                    MaterialTheme(colorScheme = scheme) {
                        CompositionLocalProvider(LocalDensity provides Density(2f, fontScale)) {
                            EditCalendarScheduleDialog(
                                initial = EditCalendarSchedule(date.toString(), "18:00"),
                                suggestionCategory = editPostingTimeCategory("Pizzaria"),
                                onDismiss = { dismissed++ }, onConfirm = { confirmed += it })
                        }
                    }
                }
            }
            settle()
        }

        private fun roots(): List<View> = listOf(activity.window.decorView) +
            listOfNotNull(ShadowDialog.getLatestDialog()?.takeIf { it.isShowing }?.window?.decorView)

        private fun dialogRoot(): View = requireNotNull(
            ShadowDialog.getLatestDialog()?.takeIf { it.isShowing }?.window?.decorView
        ) { "The actual Compose AlertDialog must be showing" }

        private fun settle() {
            Snapshot.sendApplyNotifications()
            repeat(12) {
                ShadowSystemClock.advanceBy(Duration.ofMillis(64))
                main.idleFor(Duration.ofMillis(16))
                for (root in roots()) {
                    // The Activity fills the viewport; the actual dialog keeps its wrap-content size.
                    val mode = if (root === activity.window.decorView) View.MeasureSpec.EXACTLY else View.MeasureSpec.AT_MOST
                    root.requestLayout()
                    root.measure(View.MeasureSpec.makeMeasureSpec(width, mode),
                        View.MeasureSpec.makeMeasureSpec(height, mode))
                    root.layout(0, 0, root.measuredWidth, root.measuredHeight)
                }
                Snapshot.sendApplyNotifications()
            }
            main.idleFor(Duration.ofMillis(32))
        }

        private fun descendants(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::descendants)
        private fun owners(view: View): List<SemanticsOwner> {
            val own = if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                listOf(view.javaClass.getMethod("getSemanticsOwner").invoke(view) as SemanticsOwner) else emptyList()
            return own + if (view is ViewGroup) (0 until view.childCount).flatMap { owners(view.getChildAt(it)) } else emptyList()
        }
        private fun nodes(): List<SemanticsNode> = owners(dialogRoot()).flatMap { owner ->
            val unmerged = owner.javaClass.methods.firstOrNull {
                it.name.startsWith("getUnmergedRootSemanticsNode") && it.parameterCount == 0
            }
            descendants(unmerged?.invoke(owner) as? SemanticsNode ?: owner.rootSemanticsNode)
        }
        private fun label(node: SemanticsNode): String = descendants(node)
            .flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }.joinToString(" ") { it.text }
        fun text(): List<String> = nodes().flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }.map { it.text }
        fun button(value: String): SemanticsNode = nodes().first {
            it.config.getOrNull(SemanticsActions.OnClick) != null && label(it) == value
        }
        fun click(value: String) {
            val node = button(value)
            assertNull("$value must be enabled before a test click", node.config.getOrNull(SemanticsProperties.Disabled))
            assertTrue(requireNotNull(node.config[SemanticsActions.OnClick].action).invoke())
            settle()
        }
        fun assertContent(date: LocalDate, range: String) {
            assertTrue(text().contains("Que dia e hora você quer que seja publicado?"))
            assertTrue(text().contains("Dia"))
            assertTrue(text().contains("Hora"))
            assertTrue(text().contains("Sugestão de horário para você baseado no seu negócio"))
            val dateValue = date.format(DateTimeFormatter.ofPattern("dd/MM/yyyy"))
            assertTrue(text().contains(dateValue))
            assertNotNull("The day field must remain directly editable", button(dateValue))
            val timeValue = text().first { it.matches(Regex("[0-9]{2}:[0-9]{2}")) }
            assertNotNull("The time field must remain directly editable", button(timeValue))
            assertTrue(text().contains(range))
            assertTrue(text().contains("Horário de Brasília"))
            assertFalse(text().any { it.contains("Sugestões gerais") || it.contains("Sugestões pelo ramo") })
        }
        fun assertTextFits() {
            for (node in nodes()) {
                val action = node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action ?: continue
                val layouts = mutableListOf<TextLayoutResult>()
                assertTrue("Text layout must exist after the dialog settles: '${label(node)}'; " +
                    "bounds=${node.boundsInRoot}; size=${node.size}; dialog=${dialogRoot().measuredWidth}x${dialogRoot().measuredHeight}",
                    action.invoke(layouts))
                assertFalse("Text layout results must not be empty: '${label(node)}'", layouts.isEmpty())
                for (layout in layouts) {
                    val details = "Text must fit: ${layout.layoutInput.text}; size=${layout.size}; constraints=${layout.layoutInput.constraints}"
                    assertFalse(details, layout.didOverflowHeight)
                    for (line in 0 until layout.lineCount) {
                        assertTrue(details, layout.getLineRight(line) <= layout.size.width + 0.51f)
                        assertFalse(details, layout.isLineEllipsized(line))
                    }
                }
            }
        }
        fun assertConfirmationVisible() {
            val bounds = button("Confirmar").boundsInRoot
            val root = dialogRoot()
            assertTrue("Confirmar stays inside the dialog viewport: $bounds",
                bounds.left >= 0f && bounds.right <= root.measuredWidth + 1f && bounds.top >= 0f && bounds.bottom <= root.measuredHeight + 1f)
            assertTrue("Confirmar retains a usable touch target", bounds.height >= 96f)
        }
        fun capture(name: String) {
            val root = dialogRoot()
            assertTrue("The measured dialog must fit the viewport", root.measuredWidth in 1..width && root.measuredHeight in 1..height)
            val bitmap = Bitmap.createBitmap(root.measuredWidth, root.measuredHeight, Bitmap.Config.ARGB_8888)
            try {
                val canvas = Canvas(bitmap)
                canvas.drawColor(android.graphics.Color.rgb(18, 18, 20))
                root.draw(canvas)
                val colors = mutableSetOf<Int>()
                for (y in 0 until bitmap.height step 2) for (x in 0 until bitmap.width step 2) colors += bitmap.getPixel(x, y)
                assertTrue("The preview must contain the actual rendered dialog", colors.size > 20)
                assertTrue("The dialog uses the explicit readable surface", colors.contains(scheme.surface.toArgb()))
                assertTrue("The dialog renders its readable foreground", colors.contains(scheme.onSurface.toArgb()))
                val directory = File(System.getenv("IA4TUBE_POSTING_PREVIEW_DIR") ?: "build/reports/posting-time-previews")
                check(directory.mkdirs() || directory.isDirectory)
                File(directory, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            } finally { bitmap.recycle() }
        }
        override fun close() {
            try {
                ShadowDialog.getLatestDialog()?.takeIf { it.isShowing }?.dismiss()
                controller.pause().stop().destroy()
                Snapshot.sendApplyNotifications()
                main.idleFor(Duration.ofMillis(32))
            } finally {
                ShadowChoreographer.setFrameDelay(oldDelay)
                ShadowChoreographer.setPaused(oldPaused)
            }
        }
    }
}
