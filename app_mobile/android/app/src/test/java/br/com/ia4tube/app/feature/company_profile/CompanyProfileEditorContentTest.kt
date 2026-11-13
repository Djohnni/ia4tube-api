package br.com.ia4tube.app.feature.company_profile

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
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
import br.com.ia4tube.app.core.company.CompanyProfile
import br.com.ia4tube.app.data.api.CompanyAccountIdentity
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowChoreographer
import org.robolectric.shadows.ShadowSystemClock
import java.time.Duration
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w320dp-h832dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class CompanyProfileEditorContentTest {
    @Test fun accountLoginIsReadOnlyAndCopyUsesOnlyTheRegistrationIdentifier() {
        for (identity in listOf(CompanyAccountIdentity("google", "owner@example.invalid"), CompanyAccountIdentity("whatsapp", "47900112233"))) {
            Harness(CompanyProfileEditorState(profile = CompanyProfile(email = "business@example.invalid", whatsapp = "other-contact"), account = identity)).use { ui ->
                assertTrue(ui.text().contains("Minha conta"))
                assertTrue(ui.text().contains(if (identity.provider == "google") "Google" else "WhatsApp"))
                assertTrue(ui.text().contains(identity.login)); assertTrue(ui.events.isEmpty())
                assertNull(ui.tag("company_account_login").config.getOrNull(SemanticsActions.SetText))
                ui.click("company_account_copy")
                assertEquals(listOf(identity.login), ui.copies); assertEquals(listOf("copy-login"), ui.events)
                ui.capture("company-account111-${identity.provider}.png")
            }
        }
    }

    @Test fun blankFormExposesAllOptionalFieldsAndSaveIsAnExplicitAction() {
        Harness().use { ui ->
            assertTrue(ui.events.isEmpty())
            for (name in listOf("name", "business", "information", "contact", "website", "instagram",
                "facebook", "other_links", "address", "city", "state", "zip", "email")) {
                assertNotNull(ui.tag("company_profile_" + name))
            }
            assertFalse(ui.text().any { it.contains("opcional", ignoreCase = true) })
            for (section in listOf("brand", "information", "links", "address")) {
                assertNotNull(ui.tag("company_profile_section_" + section))
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
    @Test fun loadingAndAuthenticationMessageKeepTheirVisibleStateAndAction() {
        Harness(CompanyProfileEditorState(loading = true, authRequired = true, message = "Entre novamente para salvar.")).use { ui ->
            assertTrue(ui.text().contains("Carregando perfil…"))
            assertTrue(ui.text().contains("Entre novamente para salvar."))
            assertNotNull(ui.tag("company_profile_save").config.getOrNull(SemanticsProperties.Disabled))
            ui.click("company_profile_auth")
            assertEquals(listOf("auth"), ui.events)
        }
    }
    @Test fun nativeBlackAndGoldPreviewUsesRealContentWithoutOptionalLabels() {
        val preview = CompanyProfile(nomeEmpresa = "Empresa de exemplo", ramo = "Comércio e serviços",
            historia = "Conte um pouco sobre a sua empresa.\nInformações para usar nas suas artes.",
            site = "https://example.invalid", instagram = "@empresa.exemplo",
            cidade = "Sua cidade", estado = "UF")
        Harness(CompanyProfileEditorState(profile = preview)).use { ui ->
            assertFalse(ui.text().any { it.contains("opcional", ignoreCase = true) })
            ui.capture("company-profile-black-gold-top.png")
            val scroll = ui.tag("company_profile_editor")
            assertTrue(scroll.config[SemanticsActions.ScrollBy].action!!.invoke(0f, 1400f))
            ui.settle(); ui.capture("company-profile-black-gold-middle.png")
            val remaining = ui.tag("company_profile_editor").config[SemanticsProperties.VerticalScrollAxisRange].maxValue()
            assertTrue(ui.tag("company_profile_editor").config[SemanticsActions.ScrollBy].action!!.invoke(0f, remaining))
            ui.settle(); ui.capture("company-profile-black-gold-bottom.png")
            assertTrue(ui.events.isEmpty())
        }
    }

    private class Harness(initial: CompanyProfileEditorState = CompanyProfileEditorState(), fontScale: Float = 1f) : AutoCloseable {
        val state = mutableStateOf(initial)
        val events = mutableListOf<String>()
        val copies = mutableListOf<String>()
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
                            onBack = { events += "back" }, onAuthRequired = { events += "auth" },
                            onCopyLogin = { copies += it; events += "copy-login" })
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
        private fun nodes(): List<SemanticsNode> = owners(activity.window.decorView).flatMap { owner ->
            val getter = owner.javaClass.methods.firstOrNull { it.name.startsWith("getUnmergedRootSemanticsNode") && it.parameterCount == 0 }
            descendants(getter?.invoke(owner) as? SemanticsNode ?: owner.rootSemanticsNode)
        }
        fun tag(name: String): SemanticsNode = nodes().single { it.config.getOrNull(SemanticsProperties.TestTag) == name }
        fun text(): List<String> = nodes().flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }.map { it.text }
        fun click(name: String) { assertTrue(tag(name).config[SemanticsActions.OnClick].action!!.invoke()); settle() }
        fun capture(filename: String) {
            val bitmap = Bitmap.createBitmap(640, 1664, Bitmap.Config.ARGB_8888)
            try {
                activity.window.decorView.draw(Canvas(bitmap))
                var darkPixels = 0; var goldPixels = 0
                for (y in 0 until bitmap.height step 8) for (x in 0 until bitmap.width step 8) {
                    val pixel = bitmap.getPixel(x, y)
                    val red = Color.red(pixel); val green = Color.green(pixel); val blue = Color.blue(pixel)
                    if (red < 65 && green < 65 && blue < 65) darkPixels++
                    if (red > 140 && green > 95 && blue < green * 0.8f) goldPixels++
                }
                assertTrue("The real screen has a dark background", darkPixels > 8000)
                assertTrue("The real screen renders its gold controls and labels", goldPixels > 15)
                val directory = File(System.getenv("IA4TUBE_COMPANY_PROFILE_PREVIEW_DIR") ?: "build/reports")
                check(directory.mkdirs() || directory.isDirectory)
                File(directory, filename).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            } finally { bitmap.recycle() }
        }
        override fun close() {
            try { controller.pause().stop().destroy(); Snapshot.sendApplyNotifications(); main.idleFor(Duration.ofMillis(32)) }
            finally { ShadowChoreographer.setFrameDelay(previousDelay); ShadowChoreographer.setPaused(previousPaused) }
        }
    }
}
