package br.com.ia4tube.app.feature.orders

import android.app.Application
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsOwner
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import java.time.Duration

/** The actual Orders action renders without an order, media request or network service. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class OrdersArtHistoryAccessTest {
    @Test fun historyActionIsReadableAndInvokesItsCallback() = renderAndClick(1f)
    @Test fun historyActionRemainsAvailableWithLargerText() = renderAndClick(1.5f)

    private fun renderAndClick(fontScale: Float) {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        val activity = controller.get()
        activity.setTheme(android.R.style.Theme_Material_NoActionBar)
        controller.setup()
        val configuration = android.content.res.Configuration(activity.resources.configuration).apply { this.fontScale = fontScale }
        @Suppress("DEPRECATION")
        activity.resources.updateConfiguration(configuration, activity.resources.displayMetrics)
        var opens = 0
        try {
            activity.setContent { MaterialTheme { OrdersArtHistoryAccess { opens++ } } }
            val view = activity.window.decorView
            repeat(2) {
                Snapshot.sendApplyNotifications()
                shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
                view.measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY))
                view.layout(0, 0, 822, 1782)
            }
            fun nodes(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::nodes)
            fun owners(root: View): List<SemanticsOwner> {
                val own = if (root.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                    listOf(root.javaClass.getMethod("getSemanticsOwner").invoke(root) as SemanticsOwner) else emptyList()
                return own + if (root is ViewGroup) (0 until root.childCount).flatMap { owners(root.getChildAt(it)) } else emptyList()
            }
            val action = requireNotNull(owners(view).flatMap { nodes(it.rootSemanticsNode) }.firstOrNull { node ->
                node.config.getOrNull(SemanticsActions.OnClick) != null && nodes(node).any { child ->
                    child.config.getOrNull(SemanticsProperties.Text).orEmpty().any { it.text == "Histórico de artes" }
                }
            }) { "Orders must expose a clickable Histórico de artes action" }
            assertFalse(action.config.contains(SemanticsProperties.Disabled))
            assertTrue(action.boundsInRoot.width > 0f)
            assertTrue(action.boundsInRoot.height > 0f)
            assertEquals(0, opens)
            assertTrue(action.config[SemanticsActions.OnClick].action!!.invoke())
            assertEquals(1, opens)
        } finally {
            controller.pause().stop().destroy()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }
}
