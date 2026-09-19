package br.com.ia4tube.app.feature.calendar

import android.app.Application
import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.snapshots.Snapshot
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class CalendarSessionEpochRenderTest {
    private class Fake(val owner: String) : CalendarGateway {
        var reads = 0
        var pending: CompletableDeferred<CalendarSnapshot>? = null
        fun snapshot() = CalendarSnapshot(enabled = true, items = listOf(ScheduledArt(
            "a".repeat(40), "synthetic:$owner", "2026-12-01", "18:30", "Legenda privada $owner",
            1, "manual", "Mantida", true, false, null, null, 0)))
        override suspend fun list(): CalendarSnapshot {
            reads++
            // Deliberately complete even after cancellation: the owner/sequence guard
            // must reject old IO independently of whether its transport cooperates.
            return pending?.let { withContext(NonCancellable) { it.await() } } ?: snapshot()
        }
        override suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot = error("No writes")
        override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot = error("No writes")
    }

    private class Host {
        // Not Compose state: only the real session-epoch mechanism may trigger the change.
        var token = "owner-A"
        val epochs = MutableStateFlow(0L)
        val gateways = mutableListOf<Fake>()
        var nextPending: CompletableDeferred<CalendarSnapshot>? = null
        lateinit var model: CalendarViewModel
        var renderedCaption = ""
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        init {
            controller.get().setContent {
                IA4TubeTheme {
                    val current = rememberSessionCalendarModel({ token }, epochs) { owner ->
                        Fake(owner).also { it.pending = nextPending; nextPending = null; gateways += it }
                    }
                    val state by current.uiState.collectAsState()
                    val caption = state.data.items.joinToString { it.caption }
                    Text(caption)
                    SideEffect { model = current; renderedCaption = caption }
                }
            }
            idle()
        }
        fun idle() {
            repeat(3) {
                Snapshot.sendApplyNotifications()
                val main = shadowOf(Looper.getMainLooper())
                main.idle()
                main.idleFor(Duration.ofMillis(32))
                val decor = controller.get().window.decorView
                decor.measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY))
                decor.layout(0, 0, 822, 1782)
                main.idle()
            }
        }
        fun changeSession(owner: String) { token = owner; epochs.value++; idle() }
        fun close() {
            gateways.forEach { it.pending?.complete(it.snapshot()) }
            controller.pause().stop().destroy()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    @Test fun epochAloneReplacesModelAndClearsPreviousCaptionBeforeNewResponse() {
        val host = Host()
        try {
            assertEquals("Legenda privada owner-A", host.renderedCaption)
            val previous = host.model
            val pendingB = CompletableDeferred<CalendarSnapshot>()
            host.nextPending = pendingB
            host.changeSession("owner-B")
            assertNotSame(previous, host.model)
            assertEquals("", host.renderedCaption)
            assertTrue(previous.uiState.value.data.items.isEmpty())
            assertEquals(1, host.gateways.last().reads)
            pendingB.complete(host.gateways.last().snapshot()); host.idle()
            assertEquals("Legenda privada owner-B", host.renderedCaption)
        } finally { host.close() }
    }

    @Test fun logoutEpochClearsCaptionAndDoesNotReadUnauthenticatedCalendar() {
        val host = Host()
        try {
            assertEquals("Legenda privada owner-A", host.renderedCaption)
            host.changeSession("")
            assertEquals("", host.renderedCaption)
            assertTrue(host.model.uiState.value.data.items.isEmpty())
            assertEquals(0, host.gateways.last().reads)
        } finally { host.close() }
    }

    @Test fun lateOldOwnerResponseCannotRepopulateDisposedModelOrNewScreen() {
        val host = Host()
        try {
            val previous = host.model
            val oldGateway = host.gateways.single()
            val pendingA = CompletableDeferred<CalendarSnapshot>()
            oldGateway.pending = pendingA
            previous.refresh(); host.idle()
            host.changeSession("owner-B")
            assertEquals("Legenda privada owner-B", host.renderedCaption)
            pendingA.complete(oldGateway.snapshot()); host.idle()
            assertEquals("Legenda privada owner-B", host.renderedCaption)
            assertTrue(previous.uiState.value.data.items.isEmpty())
            assertEquals(1, host.gateways.last().reads)
        } finally { host.close() }
    }
}
