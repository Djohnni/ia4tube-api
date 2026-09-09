package br.com.ia4tube.app.feature.home

import android.app.Application
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsOwner
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.unit.Density
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
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
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class HomeGalleryShortcutTest {
    @Test fun plannedArtsIsImmediatelyBelowInstagramAndOpensOnlyItsOwnCallback() = checkShortcuts(1f)
    @Test fun shortcutsKeepTheirOrderAndReadableBoundsWithLargerText() = checkShortcuts(1.5f)

    private fun checkShortcuts(fontScale: Float) {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val activity = controller.get()
        var instagramOpens = 0
        var galleryOpens = 0
        try {
            activity.setContent {
                IA4TubeTheme {
                    CompositionLocalProvider(LocalDensity provides Density(2f, fontScale)) {
                        // This is the production shortcut group mounted first by HomeScreen.
                        HomeArtShortcuts(premiumHomePalette(PremiumHomeTheme.Black),
                            onOpenInstagram = { instagramOpens++ }, onOpenPlannedArts = { galleryOpens++ })
                    }
                }
            }
            Snapshot.sendApplyNotifications()
            val main = shadowOf(Looper.getMainLooper())
            main.idle()
            val decor = activity.window.decorView
            decor.measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY))
            decor.layout(0, 0, 822, 1782)
            main.idleFor(Duration.ofSeconds(1))
            val buttons = owners(decor).flatMap { descendants(it.rootSemanticsNode) }
                .filter { it.config.getOrNull(SemanticsActions.OnClick) != null }
                .sortedBy { it.boundsInRoot.top }
            assertEquals("Only the existing Instagram shortcut and the requested gallery shortcut", 2, buttons.size)
            assertEquals("Instagram", buttons[0].config[SemanticsProperties.Text].first().text)
            assertEquals("Minhas artes planejadas", buttons[1].config[SemanticsProperties.Text].first().text)
            assertTrue(buttons[1].boundsInRoot.top >= buttons[0].boundsInRoot.bottom)
            for (button in buttons) {
                assertTrue(button.boundsInRoot.width > 0)
                assertTrue(button.boundsInRoot.height > 0)
                assertTrue(button.boundsInRoot.left >= 0 && button.boundsInRoot.right <= 822)
                assertTrue(button.boundsInRoot.bottom <= 1782)
            }
            assertTrue(buttons[1].config[SemanticsActions.OnClick].action!!.invoke())
            assertEquals(1, galleryOpens)
            assertEquals(0, instagramOpens)
            assertTrue(buttons[0].config[SemanticsActions.OnClick].action!!.invoke())
            assertEquals(1, instagramOpens)
            assertEquals(1, galleryOpens)
        } finally {
            controller.pause().stop().destroy()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    private fun owners(view: View): List<SemanticsOwner> {
        val own = if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
            listOf(view.javaClass.getMethod("getSemanticsOwner").invoke(view) as SemanticsOwner)
        else emptyList()
        return own + if (view is ViewGroup) (0 until view.childCount).flatMap { owners(view.getChildAt(it)) } else emptyList()
    }

    private fun descendants(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::descendants)
}
