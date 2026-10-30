package br.com.ia4tube.app.feature.company_profile

import android.app.Application
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsOwner
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.text.AnnotatedString
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
import org.robolectric.shadows.ShadowChoreographer
import org.robolectric.shadows.ShadowSystemClock
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w320dp-h832dp-xhdpi")
@LooperMode(LooperMode.Mode.PAUSED)
class CompanyProfileEditorContentTest {
    @Test fun blankFormExposesAllOptionalFieldsAndSaveIsAnExplicitAction() {
        Harness().use { ui ->
            assertTrue(ui.events.isEmpty())
            for (name in listOf("name", "business", "information", "contact", "website", "instagram",
                "facebook", "other_links", "address", "city", "state", "zip", "email")) {
                assertNotNull(ui.tag("company_profile_" + name))
            }
            assertNull(ui.tag("company_profile_save").config.getOrNull(SemanticsProperties.Disabled))
            ui.click("company_profile_save")
            assertEquals(listOf("save"), ui.events)
        }
    }
    @Test fun linksAndMultilineInformationOnlyEditTextWithoutNavigationOrGeneration() {
        Harness().use { ui ->
            val value = "https://example.invalid/one\nhttps://example.invalid/two"
            assertTrue(ui.tag("company_profile_other_links").config[SemanticsActions.SetText].action!!.invoke(AnnotatedString(value)))
            ui.settle()
            assertEquals(value, ui.state.value.profile.outrosLinks)
            assertEquals(listOf("edit"), ui.events)
        }
    }
    @Test fun savingDisablesFieldsAndActionsWithoutDroppingDraft() {
        Harness(CompanyProfileEditorState(saving = true, dirty = true)).use { ui ->
            assertNotNull(ui.tag("company_profile_save").config.getOrNull(SemanticsProperties.Disabled))
            assertNotNull(ui.tag("company_profile_name").config.getOrNull(SemanticsProperties.Disabled))
            assertNotNull(ui.tag("company_profile_choose_logo").config.getOrNull(SemanticsProperties.Disabled))
            assertTrue(ui.events.isEmpty())
        }
    }
    @Test fun largeTextKeepsScrollableFieldsAndUsefulSaveTarget() {
        for (scale in listOf(1.5f, 2f)) Harness(fontScale = scale).use { ui ->
            val scroll = ui.tag("company_profile_editor")
            assertTrue(scroll.config[SemanticsProperties.VerticalScrollAxisRange].maxValue() > 0f)
            assertTrue(ui.tag("company_profile_save").size.height >= 96)
            assertTrue(scroll.size.width <= 640)
        }
    }

    private class Harness(initial: CompanyProfileEditorState = CompanyProfileEditorState(), fontScale: Float = 1f) : AutoCloseable {
        val state = mutableStateOf(initial)
        val events = mutableListOf<String>()
        private val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        private val activity = controller.get()
        private val main = shadowOf(Looper.getMainLooper())
        private val previousPaused = ShadowChoreographer.isPaused()
        private val previousDelay = ShadowChoreographer.getFrameDelay()
        init {
            ShadowChoreographer.setPaused(true); ShadowChoreographer.setFrameDelay(Duration.ofMillis(16))
            activity.setTheme(android.R.style.Theme_Material_NoActionBar); controller.setup()
            activity.setContent {
                IA4TubeTheme {
                    CompositionLocalProvider(LocalDensity provides Density(2f, fontScale)) {
                        CompanyProfileEditorContent(state.value,
                            onEdit = { transform -> events += "edit"; state.value = state.value.copy(profile = transform(state.value.profile)) },
                            onSave = { events += "save" }, onChooseLogo = { events += "choose-logo" },
                            onRemoveLogo = { events += "remove-logo" }, onRefresh = { events += "refresh" },
                            onBack = { events += "back" }, onAuthRequired = { events += "auth" })
                    }
                }
            }
            settle()
        }
        fun settle() {
            Snapshot.sendApplyNotifications()
            repeat(8) {
                ShadowSystemClock.advanceBy(Duration.ofMillis(64)); main.idleFor(Duration.ofMillis(16))
                val root = activity.window.decorView
                root.measure(View.MeasureSpec.makeMeasureSpec(640, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(1664, View.MeasureSpec.EXACTLY))
                root.layout(0, 0, 640, 1664); Snapshot.sendApplyNotifications()
            }
        }
        private fun descendants(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::descendants)
        private fun owners(view: View): List<SemanticsOwner> {
            val own = if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                listOf(view.javaClass.getMethod("getSemanticsOwner").invoke(view) as SemanticsOwner) else emptyList()
            return own + if (view is ViewGroup) (0 until view.childCount).flatMap { owners(view.getChildAt(it)) } else emptyList()
        }
        fun tag(name: String): SemanticsNode = owners(activity.window.decorView).flatMap { owner ->
            val getter = owner.javaClass.methods.firstOrNull { it.name.startsWith("getUnmergedRootSemanticsNode") && it.parameterCount == 0 }
            descendants(getter?.invoke(owner) as? SemanticsNode ?: owner.rootSemanticsNode)
        }.single { it.config.getOrNull(SemanticsProperties.TestTag) == name }
        fun click(name: String) { assertTrue(tag(name).config[SemanticsActions.OnClick].action!!.invoke()); settle() }
        override fun close() {
            try { controller.pause().stop().destroy(); Snapshot.sendApplyNotifications(); main.idleFor(Duration.ofMillis(32)) }
            finally { ShadowChoreographer.setFrameDelay(previousDelay); ShadowChoreographer.setPaused(previousPaused) }
        }
    }
}
