package br.com.ia4tube.app.feature.calendar

import android.app.Application
import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.time.Duration
import java.time.LocalDate
import java.time.ZoneId

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class CalendarRefreshLifecycleTest {
    private class Fake : CalendarGateway {
        var reads = 0
        var caption = "Legenda inicial"

        override suspend fun list(): CalendarSnapshot {
            reads++
            val date = LocalDate.now(ZoneId.of("America/Sao_Paulo")).plusDays(1).toString()
            val art = ScheduledArt("a".repeat(40), "synthetic:1", date, "18:30", caption,
                1, "manual", "Mantida no calendário", true, false, null, null, 0)
            return CalendarSnapshot(enabled = true, items = listOf(art))
        }

        override suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot =
            error("Lifecycle verification must not change preferences")

        override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot =
            error("Lifecycle verification must not edit or publish")
    }

    private class Host {
        val fake = Fake()
        val model = CalendarViewModel({ "synthetic-only" }, "synthetic-only", fake)
        val galleryVisible = mutableStateOf(false)
        val unrelatedState = mutableStateOf(0)
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        private var compositionCommitted = false

        init {
            controller.get().setContent {
                IA4TubeTheme {
                    SideEffect { compositionCommitted = true }
                    CalendarRefreshLifecycle(model)
                    Text("Outro estado: ${unrelatedState.value}")
                    CompositionLocalProvider(LocalScheduledArtRenderer provides { _, modifier ->
                        Text("Arte sintética, sem rede", modifier)
                    }) {
                        if (galleryVisible.value) {
                            CalendarGallery(model, "synthetic-only") { galleryVisible.value = false }
                        }
                    }
                }
            }
            layoutContent()
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue("The lifecycle helper must be mounted before checking its requests", compositionCommitted)
        }

        private fun layoutContent() {
            val decor = controller.get().window.decorView
            decor.requestLayout()
            decor.measure(
                View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY)
            )
            decor.layout(0, 0, 822, 1782)
        }

        fun idle(seconds: Long = 1) {
            // Test-side state writes need explicit snapshot delivery before advancing
            // the paused frame clock; elapsed virtual time alone is not synchronization.
            Snapshot.sendApplyNotifications()
            val main = shadowOf(Looper.getMainLooper())
            main.idle()
            main.idleFor(Duration.ofSeconds(seconds))
            Snapshot.sendApplyNotifications()
            layoutContent()
            main.idle()
        }

        fun close() {
            controller.pause().stop().destroy()
            model.dispose()
            // Finish lifecycle/composition cancellation before Robolectric resets the
            // clock and looper for the next test; do not leave a queued frame behind.
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    @Test fun screenLoadsOnceAndDoesNotPollOrReloadForUnrelatedRecomposition() {
        val host = Host()
        try {
            assertEquals(1, host.fake.reads)
            assertTrue(host.model.uiState.value.fresh)
            host.idle(181)
            assertEquals("No timer-driven reload after several former polling intervals", 1, host.fake.reads)
            host.unrelatedState.value++
            host.idle()
            assertEquals("Recomposition is not a new screen opening", 1, host.fake.reads)
        } finally { host.close() }
    }

    @Test fun galleryKeepsItsSnapshotUntilReopenedOrManuallyRefreshed() {
        val host = Host()
        try {
            assertEquals(1, host.fake.reads)
            host.galleryVisible.value = true
            host.idle()
            assertEquals(2, host.fake.reads)
            assertEquals("Legenda inicial", host.model.uiState.value.data.items.single().caption)

            host.fake.caption = "Mudança externa simulada"
            host.idle(121)
            host.unrelatedState.value++
            host.idle()
            assertEquals("The open gallery must not continuously reload", 2, host.fake.reads)
            assertEquals("Legenda inicial", host.model.uiState.value.data.items.single().caption)

            host.galleryVisible.value = false
            host.idle()
            assertEquals("Closing the gallery must not start its own refresh", 2, host.fake.reads)
            host.galleryVisible.value = true
            host.idle()
            assertEquals(3, host.fake.reads)
            assertEquals("Mudança externa simulada", host.model.uiState.value.data.items.single().caption)

            host.fake.caption = "Atualização manual simulada"
            host.model.refresh()
            host.idle()
            assertEquals(4, host.fake.reads)
            assertEquals("Atualização manual simulada", host.model.uiState.value.data.items.single().caption)
            host.idle(61)
            assertEquals(4, host.fake.reads)
        } finally { host.close() }
    }

    @Test fun backgroundInvalidatesFreshnessAndResumeRefreshesOnlyOnce() {
        val host = Host()
        try {
            host.galleryVisible.value = true
            host.idle()
            assertEquals(2, host.fake.reads)
            assertTrue(host.model.uiState.value.fresh)
            host.controller.pause()
            host.idle()
            assertFalse("A paused snapshot must not remain editable as fresh", host.model.uiState.value.fresh)
            host.idle(121)
            assertEquals("No reload while in background", 2, host.fake.reads)

            host.fake.caption = "Retorno ao aplicativo"
            host.controller.resume()
            host.idle()
            assertEquals("Resume has one lifecycle refresh, not a restarted polling loop", 3, host.fake.reads)
            assertTrue(host.model.uiState.value.fresh)
            assertEquals("Retorno ao aplicativo", host.model.uiState.value.data.items.single().caption)
            host.idle(61)
            assertEquals(3, host.fake.reads)
        } finally { host.close() }
    }

    @Test fun rapidPauseAndResumeStillRefreshWithoutAnIntermediateRecomposition() {
        val host = Host()
        try {
            host.galleryVisible.value = true
            host.idle()
            assertEquals(2, host.fake.reads)
            assertTrue(host.model.uiState.value.fresh)

            host.fake.caption = "Retomada rápida confirmada"
            host.controller.pause()
            assertFalse(host.model.uiState.value.fresh)
            // Intentionally no idle between lifecycle events: Compose must not be required
            // to observe an intermediate paused Boolean to schedule the resumed read.
            host.controller.resume()
            host.idle()

            assertEquals(3, host.fake.reads)
            assertTrue(host.model.uiState.value.fresh)
            assertEquals("Retomada rápida confirmada", host.model.uiState.value.data.items.single().caption)
            host.idle(61)
            assertEquals(3, host.fake.reads)
        } finally { host.close() }
    }
}
