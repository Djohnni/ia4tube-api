package br.com.ia4tube.app.feature.monthly_planning

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.TextLayoutResult
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import java.io.File
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class MonthlyPlanningWaitingCardTest {
    @Test fun waitingForConfirmationNeverClaimsProductionOrInventsAPercentage() = checkCard(1f)
    @Test fun enlargedTextStillShowsWaitingAndDoesNotInventProgress() = checkCard(1.5f)

    private fun checkCard(fontScale: Float) {
        val awaitingConfirmation = mutableStateOf(true)
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        val activity = controller.get()
        activity.setTheme(android.R.style.Theme_Material_NoActionBar)
        controller.setup()
        val animationScale = android.provider.Settings.Global.getFloat(activity.contentResolver,
            android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        android.provider.Settings.Global.putFloat(activity.contentResolver,
            android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        val config = android.content.res.Configuration(activity.resources.configuration).apply { this.fontScale = fontScale }
        @Suppress("DEPRECATION")
        activity.resources.updateConfiguration(config, activity.resources.displayMetrics)
        activity.setContent {
            MaterialTheme(colorScheme = darkColorScheme().copy(surface = Color(0xFFFFFBF3), onSurface = Color(0xFF111827))) {
                MonthlyPlanningWaitingCard(awaitingConfirmation.value)
            }
        }
        val view = activity.window.decorView
        fun settle() {
            Snapshot.sendApplyNotifications()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
            view.measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY))
            view.layout(0, 0, 822, 1782)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        }
        fun allNodes(): List<SemanticsNode> {
            fun owners(root: View): List<SemanticsOwner> {
                val own = if (root.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                    listOf(root.javaClass.getMethod("getSemanticsOwner").invoke(root) as SemanticsOwner) else emptyList()
                return own + if (root is ViewGroup) (0 until root.childCount).flatMap { owners(root.getChildAt(it)) } else emptyList()
            }
            fun nodes(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::nodes)
            return owners(view).flatMap { nodes(it.rootSemanticsNode) }
        }
        fun texts() = allNodes().flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }.map { it.text }
        fun noMadeUpProgress() {
            assertFalse(texts().any { Regex("\\d+%").containsMatchIn(it) })
            val progress = allNodes().mapNotNull { it.config.getOrNull(SemanticsProperties.ProgressBarRangeInfo) }
            assertTrue(progress.isNotEmpty())
            assertTrue(progress.all { it == ProgressBarRangeInfo.Indeterminate })
            assertFalse(texts().any { it == "Seu pedido foi enviado para produção." })
        }
        try {
            settle(); settle()
            assertTrue(texts().contains("Aguardando confirmação do pedido"))
            val actualLayouts = mutableListOf<TextLayoutResult>()
            allNodes().forEach { it.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(actualLayouts) }
            assertTrue("The actual text layout must be inspected", actualLayouts.isNotEmpty())
            actualLayouts.forEach { assertEquals(fontScale, it.layoutInput.density.fontScale, 0.01f) }
            noMadeUpProgress()
            // Jump the clock rather than rendering thousands of indeterminate animation frames.
            ShadowSystemClock.advanceBy(Duration.ofSeconds(110))
            settle()
            assertTrue(texts().contains("Aguardando confirmação do pedido"))
            noMadeUpProgress()
            awaitingConfirmation.value = false
            settle(); settle()
            assertTrue(texts().contains("Acompanhando seu pedido"))
            assertFalse(texts().contains("Aguardando confirmação do pedido"))
            noMadeUpProgress()
            val bitmap = Bitmap.createBitmap(822, 1782, Bitmap.Config.ARGB_8888)
            try {
                view.draw(Canvas(bitmap))
                val output = File("build/reports/monthly-waiting-${fontScale}.png")
                output.parentFile?.mkdirs()
                output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            } finally { bitmap.recycle() }
        } finally {
            controller.pause().stop().destroy()
            shadowOf(Looper.getMainLooper()).idle()
            android.provider.Settings.Global.putFloat(activity.contentResolver,
                android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, animationScale)
        }
    }
}
