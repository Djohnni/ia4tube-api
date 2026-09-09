package br.com.ia4tube.app.feature.calendar

import android.app.Application
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsOwner
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowDialog
import java.time.Duration
import java.time.LocalDate
import java.time.ZoneId

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class CalendarCaptionSaveTest {
    private class Fake : CalendarGateway {
        private val date = LocalDate.now(ZoneId.of("America/Sao_Paulo")).plusDays(1).toString()
        var snapshot = CalendarSnapshot(enabled = true, items = listOf(ScheduledArt(
            "a".repeat(40), "synthetic:1", date, "18:30", "Legenda inicial", 1,
            "manual", "Mantida no calendário", true, false, null, null, 0)))
        var reads = 0
        var writes = 0
        var formatWrites = 0
        val response = CompletableDeferred<Unit>()

        override suspend fun list(): CalendarSnapshot { reads++; return snapshot }
        override suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot =
            error("Caption verification must not change preferences")
        override suspend fun destination(item: ScheduledArt, value: String): CalendarSnapshot {
            formatWrites++
            snapshot = snapshot.copy(items = listOf(item.copy(destination = value, revision = item.revision + 1)))
            return snapshot
        }
        override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot {
            writes++
            check(action == "caption")
            // Simulate persistence before the HTTP response is available to the phone.
            snapshot = snapshot.copy(items = listOf(item.copy(caption = caption, revision = item.revision + 1)))
            response.await()
            return snapshot
        }
    }

    private class Host(formatted: Boolean = false) {
        val fake = Fake()
        val model = CalendarViewModel({ "synthetic-only" }, "synthetic-only", fake)
        var confirmations = 0
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        private val decor get() = controller.get().window.decorView

        init {
            if (formatted) fake.snapshot = fake.snapshot.copy(connected = true, automatic = true, storyEligible = true,
                items = fake.snapshot.items.map { it.copy(formatsReady = true, automatic = true) })
            controller.get().setContent {
                IA4TubeTheme {
                    CompositionLocalProvider(LocalScheduledArtRenderer provides { _, modifier ->
                        Text("Arte sintética, sem rede", modifier)
                    }) {
                        CalendarGallery(model, "synthetic-only") {}
                    }
                }
            }
            idle()
        }

        private fun layout(view: View) {
            view.requestLayout()
            view.measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY))
            view.layout(0, 0, 822, 1782)
        }

        fun idle(seconds: Long = 1) {
            Snapshot.sendApplyNotifications()
            val main = shadowOf(Looper.getMainLooper())
            main.idle()
            roots().forEach(::layout)
            main.idleFor(Duration.ofSeconds(seconds))
            Snapshot.sendApplyNotifications()
            main.idle()
        }

        private fun owners(view: View): List<SemanticsOwner> {
            // Read actual Compose semantics without adding a UI-test dependency or test-only
            // production entry point. AndroidComposeView exposes its owner on the JVM.
            val own = if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                listOf(view.javaClass.getMethod("getSemanticsOwner").invoke(view) as SemanticsOwner)
            else emptyList()
            return own + if (view is ViewGroup) (0 until view.childCount).flatMap { owners(view.getChildAt(it)) } else emptyList()
        }

        private fun descendants(node: SemanticsNode): List<SemanticsNode> =
            listOf(node) + node.children.flatMap(::descendants)

        private fun roots(): List<View> = listOf(decor) + ShadowDialog.getShownDialogs()
            .filter { it.isShowing }.mapNotNull { it.window?.decorView }

        fun nodes(): List<SemanticsNode> = roots().flatMap(::owners).flatMap { descendants(it.rootSemanticsNode) }

        fun text(node: SemanticsNode): String = node.config.getOrNull(SemanticsProperties.Text)
            ?.joinToString(" ") { it.text }.orEmpty()

        fun click(label: String) {
            val node = nodes().first { node ->
                node.config.getOrNull(SemanticsActions.OnClick) != null &&
                    (text(node) == label || node.config.getOrNull(SemanticsProperties.ContentDescription)?.contains(label) == true)
            }
            assertTrue(node.config[SemanticsActions.OnClick].action!!.invoke())
            idle()
        }

        fun startSave() {
            model.edit(model.uiState.value.data.items.single(), "caption", "Legenda confirmada",
                onSuccess = { confirmations++ })
            idle()
        }

        fun close() {
            ShadowDialog.getShownDialogs().filter { it.isShowing }.forEach { it.dismiss() }
            model.dispose()
            controller.pause().stop().destroy()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    @Test fun loadingCopyRemovalRetainsTheExistingProgressComponent() {
        // Static copy contract; do not wait for an infinite indeterminate animation in Robolectric.
        val source = java.io.File("src/main/java/br/com/ia4tube/app/feature/calendar/CalendarGallery.kt").readText()
        assertFalse(source.contains("Isso pode levar até 1 minuto"))
        assertFalse(source.contains("Carregando suas artes"))
        assertTrue(source.contains("if (state.busy) LinearProgressIndicator"))
    }

    @Test fun formatButtonOpensChoicesWithoutSendingAndSavePreservesSchedule() {
        val host = Host(formatted = true)
        try {
            val before = host.fake.snapshot.items.single()
            assertFalse(host.nodes().any { it.config.getOrNull(SemanticsProperties.ContentDescription)?.contains("Destino") == true })
            host.click("Formato")
            assertTrue(host.nodes().any { host.text(it) == "Formato da publicação" })
            assertTrue(host.nodes().any { host.text(it).contains("não publica agora") })
            assertEquals(0, host.fake.formatWrites)
            assertEquals(0, host.fake.writes)
            host.click("Salvar formato")
            assertEquals(1, host.fake.formatWrites)
            val after = host.fake.snapshot.items.single()
            assertEquals(before.id, after.id); assertEquals(before.date, after.date)
            assertEquals(before.time, after.time); assertEquals(before.automatic, after.automatic)
        } finally { host.close() }
    }

    @Test fun confirmedCaptionUpdatesVisibleGalleryWithoutAnotherRead() {
        val host = Host()
        try {
            host.fake.response.complete(Unit)
            host.startSave()
            assertEquals(1, host.fake.writes)
            assertEquals(1, host.fake.reads)
            assertEquals(1, host.confirmations)
            assertTrue("The new caption must be visible on the same gallery instance",
                host.nodes().any { host.text(it) == "Legenda confirmada" })
            host.idle(121)
            assertEquals(1, host.fake.reads)
            assertEquals(1, host.fake.writes)
        } finally { host.close() }
    }

    @Test fun persistedButUnconfirmedWriteShowsErrorAndBlocksAutomaticOrManualResubmission() {
        val host = Host()
        try {
            host.fake.response.completeExceptionally(CalendarFailure(503))
            host.startSave()
            assertEquals("An uncertain result must not notify the editor to close", 0, host.confirmations)
            assertTrue(host.nodes().any { host.text(it).contains("Não foi possível confirmar") })
            assertFalse(host.model.uiState.value.fresh)
            host.model.edit(host.model.uiState.value.data.items.single(), "caption", "Legenda confirmada")
            host.idle(121)
            assertEquals(1, host.fake.writes)
            assertEquals(1, host.fake.reads)
            host.click("Atualizar")
            assertEquals(2, host.fake.reads)
            assertEquals(1, host.fake.writes)
            assertTrue(host.nodes().any { host.text(it) == "Legenda confirmada" })
        } finally { host.close() }
    }

    @Test fun accessDenialClearsTheGalleryCaptionWithoutConfirmingTheSave() {
        for (status in listOf(401, 403)) {
            val host = Host()
            try {
                host.fake.response.completeExceptionally(CalendarFailure(status))
                host.startSave()
                assertEquals(0, host.confirmations)
                assertTrue(host.model.uiState.value.data.items.isEmpty())
                assertFalse(host.nodes().any { host.text(it).contains("Legenda confirmada") || host.text(it) == "Legenda inicial" })
                assertEquals(1, host.fake.writes)
            } finally { host.close() }
        }
    }

}
