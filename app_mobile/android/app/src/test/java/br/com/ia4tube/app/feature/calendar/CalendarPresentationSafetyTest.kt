package br.com.ia4tube.app.feature.calendar

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsOwner
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.text.TextLayoutResult
import kotlinx.coroutines.CompletableDeferred
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
class CalendarPresentationSafetyTest {
    private class Fake : CalendarGateway {
        private val date = LocalDate.now(ZoneId.of("America/Sao_Paulo")).plusDays(1).toString()
        private val binding = CalendarBinding("11111111-1111-4111-8111-111111111111", "123456789", 72)
        var snapshot = CalendarSnapshot(enabled = true, connected = true, automatic = true,
            username = "synthetic", preferenceRevision = 2, items = listOf(ScheduledArt(
                "a".repeat(40), "synthetic:1", date, "18:30", "Legenda de teste", 2,
                "scheduled", "Programada", true, true, null, "synthetic", 0,
                formatsReady = true)), preferenceBinding = binding, connectionBinding = binding)
        var pending: CompletableDeferred<Unit>? = null
        var failure: Exception? = null
        var reads = 0
        var writes = 0
        override suspend fun list(): CalendarSnapshot {
            reads++
            pending?.await()
            failure?.let { throw it }
            return snapshot
        }
        override suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot {
            writes++
            error("Presentation checks must never change preferences")
        }
        override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot {
            writes++
            error("Presentation checks must never save, publish or cancel")
        }
    }

    private class Host(
        val fake: Fake = Fake(),
        val scheme: ColorScheme = calendarAppearanceTestSchemes().getValue("gold-dark"),
        val fontScale: Float = 1f,
        settingsOnly: Boolean = false
    ) {
        val model = CalendarViewModel({ "synthetic-only" }, "synthetic-only", fake)
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        private val activity = controller.get()
        private val animationScale: Float
        private val originalConfiguration: android.content.res.Configuration

        init {
            activity.setTheme(android.R.style.Theme_Material_NoActionBar)
            controller.setup()
            originalConfiguration = android.content.res.Configuration(activity.resources.configuration)
            val configuration = android.content.res.Configuration(originalConfiguration).apply {
                this.fontScale = this@Host.fontScale
            }
            // Dialog windows create their own composition/density from Android resources.
            // A LocalDensity override around the parent gallery alone does not exercise them.
            @Suppress("DEPRECATION")
            activity.resources.updateConfiguration(configuration, activity.resources.displayMetrics)
            animationScale = android.provider.Settings.Global.getFloat(activity.contentResolver,
                android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
            android.provider.Settings.Global.putFloat(activity.contentResolver,
                android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
            activity.setContent {
                MaterialTheme(colorScheme = scheme) {
                    CompositionLocalProvider(LocalScheduledArtRenderer provides { _, modifier -> Text("Arte sintética sem rede", modifier) }) {
                        if (settingsOnly) Column { CalendarAutomationSettings(model) }
                        else CalendarGallery(model, "synthetic-only") {}
                    }
                }
            }
            if (settingsOnly) model.refresh()
            idle()
        }

        private fun roots(): List<View> = listOf(activity.window.decorView) + ShadowDialog.getShownDialogs()
            .filter { it.isShowing }.mapNotNull { it.window?.decorView }

        private fun layout(view: View) {
            view.requestLayout()
            view.measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY))
            view.layout(0, 0, 822, 1782)
        }

        fun idle() {
            val main = shadowOf(Looper.getMainLooper())
            repeat(2) {
                Snapshot.sendApplyNotifications()
                main.idle()
                roots().forEach(::layout)
                main.idleFor(Duration.ofMillis(200))
            }
            Snapshot.sendApplyNotifications()
            main.idle()
        }

        private fun owners(view: View): List<SemanticsOwner> {
            val own = if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                listOf(view.javaClass.getMethod("getSemanticsOwner").invoke(view) as SemanticsOwner) else emptyList()
            return own + if (view is ViewGroup) (0 until view.childCount).flatMap { owners(view.getChildAt(it)) } else emptyList()
        }

        private fun descendants(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::descendants)
        fun nodes(): List<SemanticsNode> = roots().flatMap(::owners).flatMap { descendants(it.rootSemanticsNode) }
        fun dialogNodes(): List<SemanticsNode> = ShadowDialog.getShownDialogs().filter { it.isShowing }
            .mapNotNull { it.window?.decorView }.flatMap(::owners).flatMap { descendants(it.rootSemanticsNode) }
        fun text(node: SemanticsNode): String = node.config.getOrNull(SemanticsProperties.Text)
            ?.joinToString(" ") { it.text } ?: node.config.getOrNull(SemanticsProperties.EditableText)?.text.orEmpty()
        fun hasText(value: String) = nodes().any { text(it).contains(value) }

        fun click(label: String) {
            val action = nodes().first { node -> node.config.getOrNull(SemanticsActions.OnClick) != null &&
                (text(node) == label || node.config.getOrNull(SemanticsProperties.ContentDescription)?.contains(label) == true) }
            assertTrue(action.config[SemanticsActions.OnClick].action!!.invoke())
            idle()
        }

        fun assertDialogTextReadable(label: String) {
            val layouts = mutableListOf<TextLayoutResult>()
            val matchingNodes = dialogNodes().filter { text(it) == label ||
                it.config.getOrNull(SemanticsProperties.EditableText)?.text == label }
            matchingNodes.forEach { node ->
                node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(layouts)
            }
            assertTrue("Actual Compose text layout required for '$label'", layouts.isNotEmpty())
            val surface = calendarAppearance(scheme).surface
            val window = ShadowDialog.getShownDialogs().last { it.isShowing }.window!!.decorView
            matchingNodes.forEach { node ->
                val bounds = node.boundsInRoot
                assertTrue("'$label' must occupy a visible rectangle", bounds.width > 0f && bounds.height > 0f)
                assertTrue("'$label' must remain inside its actual dialog window: $bounds in ${window.width}x${window.height}",
                    bounds.left >= -1f && bounds.top >= -1f && bounds.right <= window.width + 1f && bounds.bottom <= window.height + 1f)
            }
            layouts.forEach { result ->
                assertEquals("'$label' must use the requested font scale inside its dialog window",
                    fontScale, result.layoutInput.density.fontScale, 0.001f)
                assertTrue("'$label' must be readable at font scale $fontScale; layoutColor=${result.layoutInput.style.color}; surface=$surface; ratio=${calendarContrastRatio(result.layoutInput.style.color, surface)}",
                    calendarContrastRatio(result.layoutInput.style.color, surface) >= 4.5f)
                // Compose may retain the wider measure constraint in multiParagraph.width
                // after tightening TextLayoutResult.size to its visible text (e.g. 726 vs 305).
                // Check the actual line extents, not hasVisualOverflow's allocated-box comparison.
                assertTrue("'$label' must contain laid-out text", result.lineCount > 0)
                for (line in 0 until result.lineCount) {
                    assertFalse("'$label' line $line must not be ellipsized", result.isLineEllipsized(line))
                    assertTrue("'$label' line $line must fit the rendered width ${result.size.width}",
                        result.getLineLeft(line) >= -1f && result.getLineRight(line) <= result.size.width + 1f)
                    assertTrue("'$label' line $line must fit the rendered height ${result.size.height}",
                        result.getLineTop(line) >= -1f && result.getLineBottom(line) <= result.size.height + 1f)
                }
                assertEquals("'$label' must retain all characters", result.layoutInput.text.length,
                    result.getLineEnd(result.lineCount - 1, visibleEnd = false))
            }
        }

        fun screenshot(name: String) {
            val view = ShadowDialog.getShownDialogs().last { it.isShowing }.window!!.decorView
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            val path = File("build/reports/calendar-presentation-$name.png")
            requireNotNull(path.parentFile).mkdirs()
            path.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }

        fun close() {
            ShadowDialog.getShownDialogs().filter { it.isShowing }.forEach { it.dismiss() }
            model.dispose()
            controller.pause().stop().destroy()
            shadowOf(Looper.getMainLooper()).idle()
            android.provider.Settings.Global.putFloat(activity.contentResolver,
                android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, animationScale)
            @Suppress("DEPRECATION")
            activity.resources.updateConfiguration(originalConfiguration, activity.resources.displayMetrics)
        }
    }

    @Test fun pendingAndFailedInitialReadRemainVisibleWithoutExposingControls() {
        val fake = Fake().apply { pending = CompletableDeferred() }
        val host = Host(fake = fake, settingsOnly = true)
        try {
            assertTrue(host.hasText("Consultando a programação"))
            assertFalse(host.hasText("Ativar para novos pedidos"))
            assertFalse(host.hasText("Pausar programação automática"))
            assertFalse(host.model.uiState.value.data.enabled)
            assertEquals(1, fake.reads)
            fake.failure = CalendarFailure(503)
            fake.pending!!.complete(Unit)
            host.idle()
            assertFalse(host.hasText("Consultando a programação"))
            assertTrue(host.hasText(requireNotNull(host.model.uiState.value.error)))
            assertFalse(host.hasText("Ativar para novos pedidos"))
            assertFalse(host.hasText("Pausar programação automática"))
            assertFalse(host.model.uiState.value.fresh)
            assertEquals(1, fake.reads)
            assertEquals(0, fake.writes)
        } finally { host.close() }
    }

    @Test fun confirmedDisabledGateStaysHiddenAndCannotActivateAnything() {
        val fake = Fake().apply { snapshot = CalendarSnapshot() }
        val host = Host(fake = fake, settingsOnly = true)
        try {
            assertTrue(host.model.uiState.value.fresh)
            assertFalse(host.hasText("Publicação pelo calendário"))
            assertFalse(host.hasText("Ativar"))
            assertFalse(host.nodes().any { it.config.getOrNull(SemanticsActions.OnClick) != null })
            assertEquals(1, fake.reads)
            assertEquals(0, fake.writes)
        } finally { host.close() }
    }

    @Test fun openStatusFollowsTheLatestItemWithTheSameIdAndClosesIfItDisappears() {
        val host = Host()
        try {
            host.click("Situação")
            assertTrue(host.dialogNodes().any { host.text(it) == "Programada" })
            val original = host.fake.snapshot.items.single()
            host.fake.snapshot = host.fake.snapshot.copy(items = listOf(original.copy(
                revision = original.revision + 1, status = "published", statusLabel = "Publicada", editable = false)))
            host.model.refresh()
            host.idle()
            assertTrue(host.dialogNodes().any { host.text(it) == "Publicada" })
            assertTrue(host.hasText("O Instagram confirmou esta publicação"))
            assertFalse(host.dialogNodes().any { host.text(it) == "Programada" })
            assertEquals(0, host.fake.writes)
            host.fake.failure = CalendarFailure(503)
            host.model.refresh()
            host.idle()
            assertTrue(host.dialogNodes().any { host.text(it) == "Atualização necessária" })
            assertTrue(host.hasText("Último estado consultado: Publicada"))
            assertFalse(host.hasText("O Instagram confirmou esta publicação"))
            assertFalse(host.model.uiState.value.fresh)
            assertEquals(0, host.fake.writes)
            host.fake.failure = null
            host.fake.snapshot = host.fake.snapshot.copy(items = emptyList())
            host.model.refresh()
            host.idle()
            assertTrue(host.dialogNodes().isEmpty())
            assertEquals(0, host.fake.writes)
        } finally { host.close() }
    }

    @Test fun dialogsUseReadableTextInLightAndDarkPalettesWithNormalAndLargeFonts() {
        for (name in listOf("gold-light", "gold-dark", "light", "dark")) {
            val scale = if (name.endsWith("dark")) 1.5f else 1f
            val host = Host(scheme = calendarAppearanceTestSchemes().getValue(name), fontScale = scale)
            try {
                host.click("Legenda")
                host.screenshot("caption-$name-$scale")
                host.assertDialogTextReadable("Editar legenda")
                host.assertDialogTextReadable("Legenda de teste")
                host.assertDialogTextReadable("Salvar")
                host.assertDialogTextReadable("Voltar")
                host.click("Voltar")
                host.click("Data/hora")
                host.assertDialogTextReadable("Mudar data e horário")
                host.assertDialogTextReadable("18:30")
                host.assertDialogTextReadable("Salvar")
                host.click("Voltar")
                host.click("Situação")
                host.assertDialogTextReadable("Programada")
                host.assertDialogTextReadable("Entendi")
                host.screenshot("status-$name-$scale")
                assertEquals(0, host.fake.writes)
                assertEquals(1, host.fake.reads)
            } finally { host.close() }
        }
    }
}
