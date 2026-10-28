package br.com.ia4tube.app.feature.calendar

import android.app.Application
import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.pager.PagerState
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.Text
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w411dp-h891dp-xhdpi")
@LooperMode(LooperMode.Mode.PAUSED)
class CalendarImportReturnFocusTest {
    @Test fun acceptedIdWaitsForRefreshThenFocusesExactlyOnceWithoutReorderingOrOverridingUserNavigation() {
        val oldId = "a".repeat(40)
        val acceptedId = "b".repeat(40)
        val ids = mutableStateOf(listOf(oldId))
        val requested = mutableStateOf<String?>(null)
        val importOpen = mutableStateOf(true)
        val unrelated = mutableStateOf(0)
        var consumed = 0
        lateinit var pager: PagerState
        var scrollTo: (Int) -> Unit = {}
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        fun pump() {
            Snapshot.sendApplyNotifications(); shadowOf(Looper.getMainLooper()).idle()
            controller.get().window.decorView.apply {
                requestLayout()
                measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY))
                layout(0, 0, 822, 1782)
            }
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
            Snapshot.sendApplyNotifications(); shadowOf(Looper.getMainLooper()).idle()
        }
        try {
            controller.get().setContent {
                val state = rememberPagerState(pageCount = { ids.value.size })
                val scope = rememberCoroutineScope()
                SideEffect { pager = state; scrollTo = { index -> scope.launch { state.scrollToPage(index) } } }
                FocusAcceptedImportReturn(state, ids.value, requested.value, importOpen.value) { id ->
                    assertEquals(acceptedId, id)
                    consumed++
                    if (requested.value == id) requested.value = null
                }
                VerticalPager(state, modifier = Modifier.fillMaxSize(), key = { ids.value[it] }) { index ->
                    Text("${ids.value[index]} · ${unrelated.value}")
                }
            }
            pump(); assertEquals(0, pager.settledPage)
            requested.value = acceptedId
            pump(); assertEquals(0, consumed); assertEquals(0, pager.settledPage)
            importOpen.value = false
            pump()
            assertEquals("An accepted response alone cannot scroll to an unrelated existing item", 0, consumed)
            assertEquals(acceptedId, requested.value)

            ids.value = listOf(oldId, acceptedId)
            pump()
            assertEquals(1, pager.settledPage)
            assertEquals(listOf(oldId, acceptedId), ids.value)
            assertEquals(1, consumed); assertNull(requested.value)

            scrollTo(0); pump(); assertEquals(0, pager.settledPage)
            unrelated.value++
            ids.value = ids.value.toList()
            pump()
            assertEquals("Later status refreshes must not force the user back to the accepted item", 0, pager.settledPage)
            assertEquals(1, consumed)
        } finally {
            controller.pause().stop().destroy()
            Snapshot.sendApplyNotifications(); shadowOf(Looper.getMainLooper()).idle()
        }
    }
}
