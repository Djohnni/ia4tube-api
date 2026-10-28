package br.com.ia4tube.app.feature.calendar

import android.app.Application
import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.time.Duration
import java.util.concurrent.TimeUnit

/** Actual Compose lifecycle ownership: a modal/scroll disables observation and background cancels it. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class CalendarImportReturnObservationTest {
    @Test fun observationRespectsVisibilityModalAndForegroundWithoutChangingPublication() {
        val item = ScheduledArt("a".repeat(40), "synthetic:1", "2026-11-10", "12:30", "Legenda escolhida",
            1, "waiting_media", "Preparando arquivo", true, false, null, null, 1,
            destination = "reel", sourceKind = "upload", preparationPending = true, mediaReadAvailable = false, submissionState = "accepted")
        var reads = 0
        val gateway = object : CalendarGateway {
            override suspend fun list(): CalendarSnapshot { reads++; return CalendarSnapshot(enabled = true, items = listOf(item)) }
            override suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot = error("Read only")
            override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot = error("Read only")
        }
        val model = CalendarViewModel({ "session" }, "session", gateway)
        val enabled = mutableStateOf(false)
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        fun pump(seconds: Long) {
            Snapshot.sendApplyNotifications()
            shadowOf(Looper.getMainLooper()).idle()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(seconds))
            Snapshot.sendApplyNotifications()
            controller.get().window.decorView.apply {
                requestLayout()
                measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY))
                layout(0, 0, 822, 1782)
            }
            shadowOf(Looper.getMainLooper()).idle()
        }
        fun awaitReads(expected: Int) {
            // Compose's AndroidUiDispatcher uses a real coroutine delay; advancing
            // Robolectric's main looper alone does not advance that scheduler.
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            while (reads < expected && System.nanoTime() < deadline) { pump(0); Thread.sleep(20) }
            pump(0)
            assertEquals(expected, reads)
        }
        fun assertNoReadDuringOneInterval(expected: Int) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(11)
            while (System.nanoTime() < deadline) { pump(0); assertEquals(expected, reads); Thread.sleep(20) }
        }
        try {
            model.refresh(); pump(0)
            controller.get().setContent {
                PendingImportReturnObservation(model, item.id, enabled.value)
                Text("Mídia pendente")
            }
            pump(30); assertEquals(1, reads)
            enabled.value = true; pump(1); awaitReads(2)
            enabled.value = false; pump(1); pump(30)
            assertNoReadDuringOneInterval(2)
            enabled.value = true; pump(1)
            controller.pause(); pump(1); pump(30)
            assertNoReadDuringOneInterval(2)
            controller.resume(); pump(1); awaitReads(3)
            assertFalse(model.uiState.value.data.items.single().automatic)
            assertEquals(item.caption, model.uiState.value.data.items.single().caption)
        } finally {
            controller.pause().stop().destroy(); model.dispose()
            Snapshot.sendApplyNotifications(); shadowOf(Looper.getMainLooper()).idle()
        }
    }
}
