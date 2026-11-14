package br.com.ia4tube.app.feature.plans

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
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
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import br.com.ia4tube.app.feature.home.PremiumHomeTheme
import br.com.ia4tube.app.feature.home.premiumHomePalette
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
import org.robolectric.shadows.ShadowDialog
import org.robolectric.shadows.ShadowChoreographer
import org.robolectric.shadows.ShadowSystemClock
import java.io.File
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(manifest=Config.NONE,application=Application::class,sdk=[28],qualifiers="w384dp-h960dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class ComboVisualTest {
    @Test fun approvedCardsOnlyInvokeTheirOwnExistingPixCallback() {
        Harness().use { h ->
            assertTrue(h.events.isEmpty())
            for(offer in mediaCombos) {
                assertEquals(offer.allowance,h.label(h.tag("combo_allowance_${offer.id}")))
                assertEquals("+ Postagem automática no Instagram",h.label(h.tag("combo_auto_${offer.id}")))
                h.click("combo_choose_${offer.id}")
                assertEquals(listOf(offer.id),h.events)
            }
            h.click("combo_back");assertEquals(listOf("back"),h.events)
            h.capture("combo89-black.png")
            h.assertTextFits()
        }
    }
    @Test fun storyPackageRequiresExplicitConfirmationAndNeverStartsOnPageOpen() {
        Harness().use { h ->
            assertTrue(h.events.isEmpty())
            assertTrue(h.label(h.tag("story_package")).contains("R$ 19,90"))
            assertTrue(h.label(h.tag("story_package")).contains("sem mensalidade"))
            h.capture("combo112-story-package.png")
            h.click("story_package_buy"); assertTrue(h.events.isEmpty())
            h.click("story_package_confirm"); assertEquals(listOf("stories"),h.events)
        }
    }
    @Test fun actualStoryBalanceIsSeparateFromTheFiveImageOfferAndNeverStartsAPayment() {
        for (remaining in listOf(4,0,1)) Harness(state=PlansUiState(storiesRemaining=remaining,storyBalanceLoading=false)).use { h ->
            assertEquals("Seu saldo: $remaining ${if(remaining==1)"Story"else"Stories"}",h.label(h.tag("story_package_balance")))
            assertTrue(h.label(h.tag("story_package")).contains("5 Stories"))
            assertTrue(h.events.isEmpty())
            h.assertTextFits()
        }
    }
    @Test fun anUnavailableBalanceIsNeverShownAsZeroCredits() {
        Harness(state=PlansUiState(storiesRemaining=null,storyBalanceLoading=false)).use { h ->
            assertEquals("Saldo de Stories indisponível",h.label(h.tag("story_package_balance")))
            assertTrue(h.events.isEmpty())
        }
    }
    @Test fun busyStateDisablesEveryPurchaseButtonWithoutStartingAnyWork() {
        Harness(state=PlansUiState(loadingAction=mediaCombos[1].id)).use { h ->
            assertNotNull(h.tag("story_package_buy").config.getOrNull(SemanticsProperties.Disabled))
            for(offer in mediaCombos) assertNotNull(h.tag("combo_choose_${offer.id}").config.getOrNull(SemanticsProperties.Disabled))
            assertTrue(h.events.isEmpty())
        }
    }
    @Test fun compactAndLargeTextFitHomeThemesWithoutClipping() {
        for(theme in PremiumHomeTheme.entries) for(scale in listOf(1.5f,2f)) Harness(widthDp=320,heightDp=900,fontScale=scale,theme=theme).use {
            if(theme==PremiumHomeTheme.Black && scale==1.5f)it.capture("combo89-compact-large-text.png")
            it.assertTextFits()
        }
    }
    private class Harness(widthDp:Int=384,heightDp:Int=960,fontScale:Float=1f,
        theme:PremiumHomeTheme=PremiumHomeTheme.Black,state:PlansUiState=PlansUiState()):AutoCloseable {
        val events=mutableListOf<String>()
        private val width=widthDp*2;private val height=heightDp*2
        private val controller=Robolectric.buildActivity(ComponentActivity::class.java)
        private val activity=controller.get()
        private val main=shadowOf(Looper.getMainLooper())
        private val oldDelay=ShadowChoreographer.getFrameDelay()
        private val oldPaused=ShadowChoreographer.isPaused()
        init {
            ShadowChoreographer.setPaused(true);ShadowChoreographer.setFrameDelay(Duration.ofMillis(16))
            activity.setTheme(android.R.style.Theme_Material_NoActionBar);controller.setup()
            activity.setContent { IA4TubeTheme { CompositionLocalProvider(LocalDensity provides Density(2f,fontScale)) {
                ComboPlansContent(state,premiumHomePalette(theme),{events+="back"},{events+=it},{events+="stories"})
            } } }
            settle()
        }
        private fun owners(view:View):List<SemanticsOwner> {
            val own=if(view.javaClass.name=="androidx.compose.ui.platform.AndroidComposeView")
                listOf(view.javaClass.getMethod("getSemanticsOwner").invoke(view) as SemanticsOwner) else emptyList()
            return own+if(view is ViewGroup)(0 until view.childCount).flatMap {owners(view.getChildAt(it))} else emptyList()
        }
        private fun descendants(node:SemanticsNode):List<SemanticsNode> = listOf(node)+node.children.flatMap(::descendants)
        private fun roots():List<View> = listOf(activity.window.decorView) + listOfNotNull(ShadowDialog.getLatestDialog()?.takeIf { it.isShowing }?.window?.decorView)
        private fun nodes():List<SemanticsNode> = roots().flatMap(::owners).flatMap {owner ->
            val getter=owner.javaClass.methods.firstOrNull {it.name.startsWith("getUnmergedRootSemanticsNode")&&it.parameterCount==0}
            descendants(getter?.invoke(owner) as? SemanticsNode ?: owner.rootSemanticsNode)
        }
        fun tag(value:String):SemanticsNode = nodes().singleOrNull {it.config.getOrNull(SemanticsProperties.TestTag)==value}
            ?:throw AssertionError("Missing $value")
        fun label(node:SemanticsNode):String = descendants(node).flatMap {it.config.getOrNull(SemanticsProperties.Text).orEmpty()}.joinToString(" "){it.text}
        fun click(value:String) {events.clear();assertTrue(tag(value).config.getOrNull(SemanticsActions.OnClick)!!.action!!.invoke());settle()}
        fun assertTextFits() {for(node in nodes()) {
            val action=node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?:continue
            val layouts=mutableListOf<TextLayoutResult>();assertTrue(action(layouts))
            for(layout in layouts) {
                val description="${layout.layoutInput.text}; size=${layout.size}; paragraph=${layout.multiParagraph.width}; constraints=${layout.layoutInput.constraints}"
                assertFalse("Clipped height: $description",layout.didOverflowHeight)
                // Check glyph bounds: paragraph width can retain the parent's maximum constraint.
                for(line in 0 until layout.lineCount) {
                    assertTrue("Clipped glyphs: $description; right=${layout.getLineRight(line)}",layout.getLineRight(line) <= layout.size.width + 0.51f)
                    assertFalse("Ellipsized: $description",layout.isLineEllipsized(line))
                }
                if(layout.layoutInput.text.text.startsWith("R$ ") || layout.layoutInput.text.text.trim()=="/mês")
                    assertEquals("Price should stay whole: $description",1,layout.lineCount)
            }
        }}
        fun capture(name:String) {
            val bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888)
            try {
                activity.window.decorView.draw(Canvas(bitmap))
                val colors=mutableSetOf<Int>();for(y in 0 until height step 16)for(x in 0 until width step 16)colors+=bitmap.getPixel(x,y)
                assertTrue("Expected rendered native content",colors.size>20)
                val target=File("build/reports/$name");target.parentFile?.mkdirs()
                target.outputStream().use {bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}
            } finally {bitmap.recycle()}
        }
        private fun settle() {Snapshot.sendApplyNotifications();repeat(8) {
            ShadowSystemClock.advanceBy(Duration.ofMillis(64));main.idleFor(Duration.ofMillis(16))
            for(root in roots()) {
                val mode=if(root===activity.window.decorView)View.MeasureSpec.EXACTLY else View.MeasureSpec.AT_MOST
                root.requestLayout()
                root.measure(View.MeasureSpec.makeMeasureSpec(width,mode),View.MeasureSpec.makeMeasureSpec(height,mode))
                root.layout(0,0,root.measuredWidth,root.measuredHeight)
            }
            Snapshot.sendApplyNotifications()
        };main.idleFor(Duration.ofMillis(32))}
        override fun close() {try {ShadowDialog.getLatestDialog()?.takeIf { it.isShowing }?.dismiss();controller.pause().stop().destroy();Snapshot.sendApplyNotifications();main.idleFor(Duration.ofMillis(32))}
            finally {ShadowChoreographer.setFrameDelay(oldDelay);ShadowChoreographer.setPaused(oldPaused)}}
    }
}
