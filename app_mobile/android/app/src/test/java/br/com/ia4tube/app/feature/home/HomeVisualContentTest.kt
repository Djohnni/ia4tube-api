package br.com.ia4tube.app.feature.home

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsOwner
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.ui.text.UiText
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import br.com.ia4tube.app.feature.assistant.AssistantContent
import br.com.ia4tube.app.feature.assistant.AssistantUiState
import br.com.ia4tube.app.feature.assistant.AssistantSnapshot
import br.com.ia4tube.app.feature.assistant.AssistantMessage
import br.com.ia4tube.app.feature.assistant.AssistantAttachment
import br.com.ia4tube.app.feature.assistant.AssistantCampaign
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
import org.robolectric.shadows.ShadowDialog
import org.robolectric.shadows.ShadowSystemClock
import java.io.File
import java.time.Duration

/** Real presentation with synthetic state and callbacks; no HomeViewModel, repository or navigation. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w384dp-h832dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class HomeVisualContentTest {
    @Test fun assistantIconHeaderAndDistinctMessagesGiveConversationMostOfTheScreen() {
        val snapshot=AssistantSnapshot(listOf(
            AssistantMessage("u1","user","Quero preparar minhas publicações.",emptyList()),
            AssistantMessage("m1","assistant","Envie suas fotos e eu ajudo a organizar.",emptyList())),
            null,emptyList(),12,1,true,false,2,120,false)
        HomeHarness(assistant=true,heightDp=832,chatState=AssistantUiState(snapshot=snapshot,loading=false)).use { home ->
            val instagram=home.tag("home_instagram").boundsInRoot
            val brand=home.tag("home_brand_icon").boundsInRoot
            val calendar=home.tag("home_calendar").boundsInRoot
            assertTrue(instagram.right<=brand.left+1&&brand.right<=calendar.left+1)
            assertEquals(instagram.top,brand.top,1f)
            assertEquals(brand.top,calendar.top,1f)
            assertEquals("",home.label(home.tag("home_assistant_icons")))
            assertNull(home.findTag("home_brand"))
            assertTrue("The enlarged conversation must retain at least 300dp",home.tag("assistant_messages").boundsInRoot.height>=600f)
            val composer=home.tag("assistant_composer").boundsInRoot
            assertTrue("The composer uses the screen width without a surrounding card",composer.left<=10f&&composer.right>=home.widthPx-10f)
            assertNull(home.findTag("assistant_plan_month"))
            assertTrue(home.nodes().none { home.label(it).contains("Assistente de IA · confira") })
            val user=home.tag("assistant_bubble_user")
            val assistant=home.tag("assistant_bubble_assistant")
            assertTrue(home.label(user).startsWith("Você "))
            assertTrue(home.label(assistant).startsWith("iA4tube "))
            assertTrue("Customer messages align to the right of assistant messages",user.positionInRoot.x>assistant.positionInRoot.x)
            home.assertAction("home_instagram","instagram")
            home.assertAction("home_brand_icon","edit")
            home.assertAction("home_calendar","calendar")
            home.assertAction("assistant_report","report")
            home.capture("assistant104-header-and-messages.png")
        }
    }
    @Test fun actualAssistantMessagesAndComposerRemainVisibleOnSamsungSizedHome() {
        val snapshot = AssistantSnapshot(listOf(AssistantMessage("m1","assistant","Envie suas fotos para preparar o mês da sua empresa.",emptyList())),
            null,emptyList(),12,1,true,false,1,60,false)
        HomeHarness(assistant=true, heightDp=784, chatState=AssistantUiState(snapshot=snapshot,loading=false,input="Planejar meu mês")).use { home ->
            val messages=home.tag("assistant_messages").boundsInRoot
            val composer=home.tag("assistant_composer").boundsInRoot
            val chat=home.tag("home_assistant").boundsInRoot
            assertTrue("Messages must have a visible scrolling area", messages.height >= 96f)
            assertTrue("The latest reply must be visible, rather than scrolled out by auxiliary buttons",
                home.nodes().first { home.label(it) == snapshot.messages.last().text }.boundsInRoot.height >= 48f)
            assertTrue("The composer must retain its touchable height", composer.height >= 96f)
            assertTrue("The composer must remain inside the chat",composer.bottom<=chat.bottom+1)
            assertTrue("Messages must end before the composer",messages.bottom<=composer.top+1)
            home.assertAction("assistant_gallery","gallery")
            home.assertAction("assistant_camera","camera")
            home.capture("assistant102-messages-and-composer.png")
        }
    }
    @Test fun actualAssistantKeepsComposerVisibleWhenKeyboardResizesWindowWithoutImeInsets() {
        val snapshot=AssistantSnapshot(listOf(AssistantMessage("m1","assistant","Envie suas fotos pelo clipe ou pela câmera.",emptyList())),
            null,emptyList(),12,1,true,false,1,60,false)
        HomeHarness(assistant=true,heightDp=420,chatState=AssistantUiState(snapshot=snapshot,loading=false,input="Preparar meu mês")).use { home ->
            assertNotNull("Compact icons remain available while typing",home.findTag("home_instagram"))
            assertNull("The footer returns after the keyboard closes",home.findTag("home_footer"))
            val messages=home.tag("assistant_messages").boundsInRoot
            val composer=home.tag("assistant_composer").boundsInRoot
            assertTrue("The conversation retains useful space above the keyboard",messages.height>=160f)
            assertTrue("The entire composer is in the resized viewport",composer.bottom<=home.tag("home_assistant").boundsInRoot.bottom)
            home.assertAction("assistant_gallery","gallery")
            home.assertAction("assistant_camera","camera")
            home.capture("assistant104-keyboard-viewport.png")
        }
    }
    @Test fun actualAssistantPhotoAndStatusCannotConsumeAllMessageSpace() {
        val photo=File.createTempFile("assistant-ui-",".png").apply {writeBytes(java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII="))}
        try {
            val snapshot=AssistantSnapshot(listOf(AssistantMessage("m1","assistant","Confira o planejamento antes de confirmar.",emptyList())),
                null,listOf(AssistantCampaign("campaign","queued",0,4)),12,1,true,false,1,60,false)
            val state=AssistantUiState(snapshot=snapshot,loading=false,input="Preparar estas fotos",attachments=listOf(AssistantAttachment("photo",photo)),error="Exemplo de aviso de conexão preservada.")
            HomeHarness(assistant=true,heightDp=784,chatState=state).use { home ->
                val messages=home.tag("assistant_messages").boundsInRoot
                val composer=home.tag("assistant_composer").boundsInRoot
                assertTrue("Attachments and notices belong in the scroll area",messages.height>=96f)
                assertTrue("Send must remain fully visible",home.tag("assistant_send").boundsInRoot.bottom<=home.tag("home_assistant").boundsInRoot.bottom)
                assertTrue(messages.bottom<=composer.top+1)
                home.assertAction("assistant_send","send")
                home.capture("assistant102-photo-and-status.png")
            }
        }finally{photo.delete()}
    }
    @Test fun assistantHomePreservesInstagramCalendarAndMovesOnlySecondaryActionsToMore() {
        HomeHarness(assistant = true).use { home ->
            assertNotNull(home.findTag("home_assistant_fixture"))
            assertNull(home.findTag("home_ready_posts"))
            assertNull(home.findTag("home_company_profile_editor"))
            home.assertAction("home_instagram", "instagram")
            home.assertAction("home_calendar", "calendar")
            home.assertAction("home_footer_more", null)
            home.assertAction("home_company_profile_editor", "company-profile-editor")
            home.assertAction("home_footer_more", null)
            home.assertAction("home_create_image", "monthly-planning")
        }
    }
    @Test fun optionalCompanyProfileIsBelowOtherFormsAndHasItsOwnUnlockedCallback() {
        HomeHarness(firstFree = true).use { home ->
            val editor = home.tag("home_company_profile_editor")
            val accordion = home.tag("home_other_forms")
            assertTrue(editor.positionInRoot.y >= accordion.positionInRoot.y + accordion.size.height - 1)
            assertNull(home.findTag("home_printed_materials"))
            home.assertAction("home_company_profile_editor", "company-profile-editor")
            home.assertAction("home_other_forms", null)
            home.assertAction("home_printed_materials", "locked")
            home.assertAction("home_company_profile_editor", "company-profile-editor")
        }
    }
    @Test fun primaryActionsUseOnlyTheirAssignedCallbacks() {
        HomeHarness().use { home ->
            assertTrue("Composition must not open any product flow", home.events.isEmpty())
            home.assertAction("home_instagram", "instagram")
            home.assertAction("home_calendar", "calendar")
            assertNull("Image creation belongs only to the closed Other forms menu", home.findTag("home_create_image"))
            home.assertAction("home_ready_posts", "edit")
            assertTrue(home.nodes().none { node ->
                home.label(node).contains("Câmera", ignoreCase = true)
            })
        }
    }

    @Test fun comboReplacesOrdersInFooterAndMoreOpensTheExistingAllOrdersCallback() {
        HomeHarness().use { home ->
            assertNull(home.findTag("home_orders"))
            assertTrue(home.label(home.tag("home_footer_combo")).contains("Combo"))
            home.assertAction("home_footer_home", null)
            home.assertAction("home_footer_combo", "plans")
            home.assertAction("home_footer_more", null)
            assertNotNull(home.findTag("home_more_sheet"))
            home.assertAction("home_orders", "orders:All")
        }
    }

    @Test fun moreMenuActionsKeepSeparateCallbacks() {
        HomeHarness().use { home ->
            for ((tag, expected) in listOf(
                "home_plans" to "plans", "home_support" to "support",
                "home_help" to "help", "home_logout" to "logout"
            )) {
                home.assertAction("home_footer_more", null)
                home.assertAction(tag, expected)
            }
        }
    }

    @Test fun firstFreeArtKeepsPrimaryEntriesAndBlocksSecondaryMenuFlows() {
        HomeHarness(firstFree = true).use { home ->
            assertTrue("Visitor Home must not promise an unconditional free image", home.nodes().none { node ->
                home.label(node) in setOf("Crie sua primeira imagem grátis.", "Depois disso, você desbloqueia o acesso ao app completo.")
            })
            home.assertAction("home_instagram", "instagram")
            home.assertAction("home_calendar", "calendar")
            assertNull("The free-image entry also starts inside Other forms", home.findTag("home_create_image"))
            home.assertAction("home_ready_posts", "edit")
            home.assertAction("home_footer_combo", "locked")
            home.assertAction("home_footer_more", null)
            for (tag in listOf("home_orders", "home_plans", "home_support", "home_help")) {
                home.assertAction(tag, "locked")
                assertNotNull("A blocked item must not navigate or dismiss More", home.findTag("home_more_sheet"))
            }
            home.assertAction("home_theme_blue", "theme:Blue")
            home.assertAction("home_logout", "logout")
        }
    }

    @Test fun otherFormsStartClosedAndOnlyTheirOwnCallbacksRunAfterExpansion() {
        HomeHarness().use { home ->
            assertNull(home.findTag("home_create_image"))
            assertNull(home.findTag("home_multiple_photos"))
            assertNull(home.findTag("home_printed_materials"))
            assertNull(home.findTag("home_carousel"))
            home.assertAction("home_other_forms", null)
            assertEquals("Criar imagens", home.label(home.tag("home_create_image")))
            home.assertAction("home_create_image", "monthly-planning")
            home.assertAction("home_multiple_photos", "create-art")
            home.assertAction("home_printed_materials", "company-profile")
            home.assertAction("home_carousel", "carousel")
            home.assertAction("home_other_forms", null)
            assertNull(home.findTag("home_create_image"))
            assertNull(home.findTag("home_carousel"))
            home.assertAction("home_other_forms", null)
            home.assertAction("home_footer_home", null)
            assertNull("Início hides image creation again", home.findTag("home_create_image"))
            assertNull("Início returns to the compact local Home", home.findTag("home_carousel"))
        }
    }

    @Test fun firstFreeArtCanExpandOtherFormsWithoutUnlockingThem() {
        HomeHarness(firstFree = true).use { home ->
            assertNull(home.findTag("home_create_image"))
            home.assertAction("home_other_forms", null)
            assertEquals("Criar imagens", home.label(home.tag("home_create_image")))
            home.assertAction("home_create_image", "monthly-planning")
            for (tag in listOf("home_multiple_photos", "home_printed_materials", "home_carousel")) {
                home.assertAction(tag, "locked")
            }
            home.assertAction("home_other_forms", null)
            assertNull(home.findTag("home_create_image"))
            assertNull(home.findTag("home_multiple_photos"))
        }
    }

    @Test fun comboBadgeUsesAvailableCreditsRatherThanMoneyOrOrderCounts() {
        val credited = readyState().copy(
            saldo = 999.0, saldoExtra = 800.0, artesMensaisRestantes = 4,
            artesAvulsasRestantes = 3, emProducao = 28, artesProntas = 90
        )
        HomeHarness(credited).use { home ->
            assertEquals("7", home.label(home.tag("home_credits_badge")))
            home.update(credited.copy(planoStatus = "expired", artesMensaisRestantes = 99))
            assertEquals("3", home.label(home.tag("home_credits_badge")))
            home.update(credited.copy(planoStatus = "none", artesAvulsasRestantes = -2))
            assertNull("No positive available credits means no numeric badge", home.findTag("home_credits_badge"))
            home.update(credited.copy(planoNome = ""))
            assertEquals("Legacy monthly credits require the plan name too", "3", home.label(home.tag("home_credits_badge")))
            assertTrue(home.events.isEmpty())
        }
    }

    @Test fun loadingAndDataErrorsRenderWithoutStartingWorkAndCanBeCleared() {
        val accountError = "Falha sintética ao consultar a conta. ".repeat(8)
        val summaryError = "Falha sintética ao consultar os pedidos."
        HomeHarness(readyState().copy(loading = true, summaryLoading = true,
            error = UiText.Dynamic(accountError), summaryError = UiText.Dynamic(summaryError)), fontScale = 1.5f).use { home ->
            home.capture("home-loading-large-text-debug.png")
            assertNotNull(home.findTag("home_loading"))
            assertTrue(home.nodes().any { home.label(it) == accountError })
            assertTrue(home.nodes().any { home.label(it) == summaryError })
            home.assertFooterFits()
            assertTrue("Rendering loading/error state must not request data or navigate", home.events.isEmpty())
            home.update(readyState())
            assertNull(home.findTag("home_loading"))
            assertTrue(home.nodes().none { home.label(it) == accountError || home.label(it) == summaryError })
            home.assertAction("home_calendar", "calendar")
        }
    }

    @Test fun visitorHasNoLogoutAndThemesUseOnlyTheThemeCallback() {
        HomeHarness(firstFree = true, showLogout = false).use { home ->
            home.assertAction("home_footer_more", null)
            assertNull(home.findTag("home_logout"))
            for (theme in PremiumHomeTheme.entries) {
                home.assertAction("home_theme_${theme.name.lowercase()}", "theme:${theme.name}")
            }
        }
    }

    @Test fun referenceWidthKeepsShortcutRowsCenteredPostsAndFixedComboFooter() =
        checkViewport(384, 832, 1f, "home-384-preview.png")

    @Test @Config(qualifiers = "w320dp-h740dp-xhdpi")
    fun narrowViewportKeepsLabelsAndFixedFooterUsable() =
        checkViewport(320, 740, 1f, "home-320-preview.png")

    @Test @Config(qualifiers = "w320dp-h740dp-xhdpi")
    fun largerTextOnNarrowViewportRemainsReadableAndScrollable() =
        checkViewport(320, 740, 1.5f, "home-320-large-text-preview.png")

    private fun checkViewport(widthDp: Int, heightDp: Int, fontScale: Float, filename: String) {
        HomeHarness(widthDp = widthDp, heightDp = heightDp, fontScale = fontScale).use { home ->
            home.capture(filename)
            assertEquals("iA4tube", home.label(home.tag("home_brand")))
            home.assertInstagramSubtitleFitsBelowItsTitle()
            val instagram = home.tag("home_instagram").boundsInRoot
            val calendar = home.tag("home_calendar").boundsInRoot
            assertNull("No large image-creation action remains outside Other forms", home.findTag("home_create_image"))
            val posts = home.tag("home_ready_posts").boundsInRoot
            assertTrue("Instagram and Calendário stay in vertical rows", calendar.top >= instagram.bottom - 1f)
            assertEquals(instagram.left, calendar.left, 1f)
            assertTrue("Posts follow both shortcuts", posts.top >= calendar.bottom - 1f)
            assertEquals("The single Posts action stays centered", home.widthPx / 2f, posts.center.x, 1f)
            // The harness uses density=2: preserve one old column's width and its 12dp gap.
            assertEquals("Posts keep their previous individual width", (instagram.width - 12f * 2f) / 2f, posts.width, 1f)
            for (tag in listOf("home_instagram", "home_calendar", "home_ready_posts")) {
                val rect = home.tag(tag).boundsInRoot
                assertTrue("$tag stays inside the viewport width", rect.left >= 0f && rect.right <= home.widthPx + 1f)
                assertTrue("$tag has a readable width", rect.width > 0f)
                home.assertTextFits(home.tag(tag))
            }
            home.assertFooterFits()
            val footerBefore = home.tag("home_footer").boundsInRoot
            home.assertAction("home_other_forms", null)
            home.capture(filename.removeSuffix(".png") + "-expanded.png")
            assertEquals("Criar imagens", home.label(home.tag("home_create_image")))
            home.assertTextFits(home.tag("home_create_image"))
            home.assertExpandedContentReachable()
            val footerAfter = home.tag("home_footer").boundsInRoot
            assertEquals("Scrolling content does not move the footer", footerBefore.top, footerAfter.top, 1f)
            assertEquals(footerBefore.bottom, footerAfter.bottom, 1f)
            home.assertFooterFits()
            assertTrue(home.events.isEmpty())
        }
    }

    private class HomeHarness(
        initial: HomeUiState = readyState(),
        firstFree: Boolean = false,
        showLogout: Boolean = true,
        widthDp: Int = 384,
        heightDp: Int = 832,
        fontScale: Float = 1f,
        assistant: Boolean = false,
        chatState: AssistantUiState? = null
    ) : AutoCloseable {
        val events = mutableListOf<String>()
        val widthPx = widthDp * 2
        private val heightPx = heightDp * 2
        private val state = mutableStateOf(initial)
        private val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        private val activity = controller.get()
        private val main = shadowOf(Looper.getMainLooper())
        private val originalFrameDelay = ShadowChoreographer.getFrameDelay()
        private val originalChoreographerPaused = ShadowChoreographer.isPaused()

        init {
            ShadowChoreographer.setPaused(true)
            ShadowChoreographer.setFrameDelay(Duration.ofMillis(16))
            activity.setTheme(android.R.style.Theme_Material_NoActionBar)
            controller.setup()
            activity.setContent {
                IA4TubeTheme {
                    CompositionLocalProvider(LocalDensity provides Density(2f, fontScale)) {
                        Box(Modifier.fillMaxSize()) {
                        // WindowManager in this test runner keeps its original display height.
                        // Apply the keyboard-sized viewport to Compose itself as well as the bitmap.
                        Box(if(assistant&&heightDp<600)Modifier.height(heightDp.dp)else Modifier.fillMaxSize()) {
                        HomeVisualContent(state = state.value, palette = premiumHomePalette(PremiumHomeTheme.Black),
                            premiumTheme = PremiumHomeTheme.Black, firstFreeArtMode = firstFree, showLogout = showLogout,
                            onThemeSelected = { events += "theme:${it.name}" },
                            onOpenOrders = { events += "orders:${it.name}" }, onOpenPlans = { events += "plans" },
                            onCreateArtEmpresa = { events += "create-art" }, onCarouselClick = { events += "carousel" },
                            onMonthlyPlanningClick = { events += "monthly-planning" }, onEditVideoClick = { events += "edit" },
                            onOpenInstagram = { events += "instagram" }, onOpenPlannedArts = { events += "calendar" },
                            onCompanyProfile = { events += "company-profile" }, onSupport = { events += "support" },
                            onLogout = { events += "logout" }, onIconHelpClick = { events += "help" },
                            onLockedFeatureClick = { events += "locked" },
                            onEditCompanyProfile = { events += "company-profile-editor" },
                            assistantContent = if(assistant) ({
                                if(chatState==null) androidx.compose.material3.Text("Seu assistente", modifier = androidx.compose.ui.Modifier.testTag("home_assistant_fixture"))
                                else AssistantContent(chatState,premiumHomePalette(PremiumHomeTheme.Black),
                                    onPosts={events+="edit"},onProfile={events+="company-profile-editor"},onPlans={events+="plans"},onCalendar={events+="calendar"},
                                    onInput={events+="input"},onSend={events+="send"},onPlan={events+="plan"},onGallery={events+="gallery"},onCamera={events+="camera"},
                                    onRemove={events+="remove"},onReview={events+="review"},onReport={events+="report"},onContinue={events+="continue"})
                            }) else null)
                        }
                        }
                    }
                }
            }
            settle()
        }

        fun update(value: HomeUiState) { state.value = value; settle() }

        fun assertAction(tagName: String, expected: String?) {
            events.clear()
            val action = tag(tagName).config.getOrNull(SemanticsActions.OnClick)?.action
            assertNotNull("$tagName exposes its existing action", action)
            assertTrue("$tagName accepts the action", action!!.invoke())
            settle()
            assertEquals("$tagName must not invoke another flow", listOfNotNull(expected), events)
        }

        fun tag(value: String): SemanticsNode = findTag(value)
            ?: throw AssertionError("Missing $value; visible tags: ${nodes().mapNotNull { it.config.getOrNull(SemanticsProperties.TestTag) }}")

        fun findTag(value: String): SemanticsNode? = nodes().singleOrNull {
            it.config.getOrNull(SemanticsProperties.TestTag) == value
        }

        fun label(node: SemanticsNode): String = descendants(node)
            .flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }.joinToString(" ") { it.text }

        fun nodes(): List<SemanticsNode> = roots().flatMap(::owners).flatMap { owner ->
            // The unmerged tree also exposes the credit badge inside the clickable Combo.
            val unmergedGetter = owner.javaClass.methods.firstOrNull {
                it.name.startsWith("getUnmergedRootSemanticsNode") && it.parameterCount == 0
            }
            descendants(unmergedGetter?.invoke(owner) as? SemanticsNode ?: owner.rootSemanticsNode)
        }

        fun assertTextFits(parent: SemanticsNode) {
            for (node in descendants(parent)) {
                val action = node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action ?: continue
                val layouts = mutableListOf<TextLayoutResult>()
                assertTrue("Text layout must be measured after settling; text=${label(node)}; " +
                    "parentTag=${parent.config.getOrNull(SemanticsProperties.TestTag)}; " +
                    "position=${node.positionInRoot}; size=${node.size}; bounds=${node.boundsInRoot}", action.invoke(layouts))
                assertTrue("Measured text must expose its layout; text=${label(node)}", layouts.isNotEmpty())
                for (layout in layouts) {
                    val details = "Text must not overflow: ${layout.layoutInput.text}; " +
                        "size=${layout.size}; constraints=${layout.layoutInput.constraints}; " +
                        "didOverflowWidth=${layout.didOverflowWidth}; didOverflowHeight=${layout.didOverflowHeight}; " +
                        "paragraph=${layout.multiParagraph.width}x${layout.multiParagraph.height}; " +
                        "lineCount=${layout.lineCount}; maxLines=${layout.layoutInput.maxLines}; " +
                        "fontSize=${layout.layoutInput.style.fontSize}; density=${layout.layoutInput.density.density}; " +
                        "fontScale=${layout.layoutInput.density.fontScale}; " +
                        "parentTag=${parent.config.getOrNull(SemanticsProperties.TestTag)}; bounds=${node.boundsInRoot}; " +
                        (0 until layout.lineCount).joinToString { line ->
                            "line$line(left=${layout.getLineLeft(line)}, right=${layout.getLineRight(line)}, " +
                                "top=${layout.getLineTop(line)}, bottom=${layout.getLineBottom(line)}, " +
                                "end=${layout.getLineEnd(line)}, ellipsized=${layout.isLineEllipsized(line)})"
                        }
                    if (layout.hasVisualOverflow) println("Home text measurement diagnostic: $details")
                    assertTrue("Text must contain a measured line; $details", layout.lineCount > 0)
                    assertEquals("Every character must remain laid out; $details", layout.layoutInput.text.length,
                        layout.getLineEnd(layout.lineCount - 1))
                    // Simple text can expose a paragraph at the maximum constraint width
                    // while its IntSize wraps the narrower visible text. Check the actual
                    // lines, allowing only one physical pixel for coordinate rounding.
                    (0 until layout.lineCount).forEach { line ->
                        assertFalse("Text must not be ellipsized; $details", layout.isLineEllipsized(line))
                        assertTrue("Text must fit horizontally; $details", layout.getLineLeft(line) >= -1f &&
                            layout.getLineRight(line) <= layout.size.width + 1f)
                        assertTrue("Text must fit vertically; $details", layout.getLineTop(line) >= -1f &&
                            layout.getLineBottom(line) <= layout.size.height + 1f)
                    }
                }
            }
        }

        fun assertInstagramSubtitleFitsBelowItsTitle() {
            val expected = "conecte seu instagram ao iA4tube"
            val instagram = tag("home_instagram")
            val title = tag("home_instagram_title")
            val subtitle = tag("home_instagram_subtitle")
            assertEquals("Instagram", label(title))
            assertEquals(expected, label(subtitle))
            val occurrences = nodes().filter { node ->
                node.config.getOrNull(SemanticsProperties.Text)?.singleOrNull()?.text == expected
            }
            assertEquals("The Instagram subtitle is rendered exactly once", 1, occurrences.size)
            assertEquals(subtitle.id, occurrences.single().id)
            assertTrue("The subtitle belongs only to the Instagram shortcut",
                descendants(instagram).any { it.id == subtitle.id })
            assertEquals("Calendário has no Instagram subtitle or additional label", "Calendário", label(tag("home_calendar")))
            val bounds = subtitle.boundsInRoot
            val row = instagram.boundsInRoot
            val scroll = tag("home_scroll").boundsInRoot
            val left = subtitle.positionInRoot.x
            val top = subtitle.positionInRoot.y
            val right = left + subtitle.size.width
            val bottom = top + subtitle.size.height
            assertTrue("The Instagram subtitle has non-empty visible bounds: $bounds", bounds.width > 0f && bounds.height > 0f)
            assertTrue("The subtitle sits below its title without overlap",
                top >= title.positionInRoot.y + title.size.height - 1f)
            assertEquals("The subtitle aligns with its title", title.positionInRoot.x, left, 1f)
            assertTrue("The complete subtitle fits inside Instagram: $bounds; shortcut=$row",
                left >= row.left - 1f && right <= row.right + 1f && top >= row.top - 1f && bottom <= row.bottom + 1f)
            assertTrue("The complete subtitle remains visible in the scroll viewport: $bounds; viewport=$scroll",
                left >= scroll.left - 1f && right <= scroll.right + 1f && top >= scroll.top - 1f && bottom <= scroll.bottom + 1f)
            assertTextFits(title)
            assertTextFits(subtitle)
        }

        fun assertFooterFits() {
            val footer = tag("home_footer").boundsInRoot
            assertTrue("Footer stays in the visible viewport", footer.top >= 0f && footer.bottom <= heightPx + 1f)
            val tabs = listOf("home_footer_home", "home_footer_combo", "home_footer_more").map(::tag)
            for (node in tabs) {
                val rect = node.boundsInRoot
                assertTrue("Footer tab stays horizontally bounded", rect.left >= 0f && rect.right <= widthPx + 1f)
                assertTrue("Footer tabs retain a useful touch target", rect.width >= 96f && rect.height >= 96f)
                assertTextFits(node)
            }
            assertTrue(tabs.zipWithNext().all { (left, right) -> left.boundsInRoot.right <= right.boundsInRoot.left + 1f })
        }

        fun assertExpandedContentReachable() {
            val scroll = tag("home_scroll")
            val range = scroll.config[SemanticsProperties.VerticalScrollAxisRange]
            val maximum = range.maxValue()
            val expandedTags = listOf("home_create_image", "home_multiple_photos", "home_printed_materials", "home_carousel")
            // Both branches require actual expanded items; a lost recomposition must fail.
            expandedTags.forEach { tag(it) }
            assertTrue("The scroll range must be finite and non-negative: $maximum", maximum.isFinite() && maximum >= 0f)
            if (maximum > 0f) {
                val before = range.value()
                assertTrue("Expanded content accepts scrolling",
                    scroll.config[SemanticsActions.ScrollBy].action!!.invoke(0f, heightPx.toFloat()))
                settle()
                val after = tag("home_scroll").config[SemanticsProperties.VerticalScrollAxisRange].value()
                assertTrue("Expanded content actually moves toward the remaining items: $before -> $after", after > before)
            } else {
                val scrollBounds = scroll.boundsInRoot
                val footerBounds = tag("home_footer").boundsInRoot
                for (tagName in expandedTags) {
                    val item = tag(tagName)
                    val bounds = item.boundsInRoot
                    val top = item.positionInRoot.y
                    val bottom = top + item.size.height
                    assertTrue("$tagName is expanded with non-empty visible bounds: $bounds",
                        bounds.width > 0f && bounds.height > 0f)
                    assertTrue("$tagName fits inside the scroll viewport horizontally: $bounds",
                        bounds.left >= scrollBounds.left - 1f && bounds.right <= scrollBounds.right + 1f)
                    assertTrue("$tagName is fully visible below the scroll viewport top: $top >= ${scrollBounds.top}",
                        top >= scrollBounds.top - 1f)
                    assertTrue("$tagName fits above the footer without overlap: $bottom <= ${footerBounds.top}",
                        bottom <= footerBounds.top + 1f)
                    assertTextFits(item)
                }
            }
        }

        fun capture(filename: String) {
            val bitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888)
            try {
                activity.window.decorView.draw(Canvas(bitmap))
                val colors = mutableSetOf<Int>()
                for (y in 0 until heightPx step 16) for (x in 0 until widthPx step 16) colors += bitmap.getPixel(x, y)
                val output = File("build/reports/$filename")
                output.parentFile?.mkdirs()
                output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                assertTrue("Preview must contain actual Compose content", colors.size > 20)
            } finally { bitmap.recycle() }
        }

        private fun roots(): List<View> = listOf(activity.window.decorView) +
            listOfNotNull(ShadowDialog.getLatestDialog()?.takeIf { it.isShowing }?.window?.decorView)

        private fun settle() {
            Snapshot.sendApplyNotifications()
            // Keep the real indeterminate indicator composed. Paused vsync and a
            // fixed frame budget avoid draining an animation until it becomes idle.
            // A same-size Android measure alone can leave Compose's new descendants
            // queued. Flush the owner's test layout pass, then draw each bounded frame.
            val frame = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888)
            try {
                val frameCanvas = Canvas(frame)
                repeat(8) {
                    ShadowSystemClock.advanceBy(Duration.ofMillis(64))
                    main.idleFor(Duration.ofMillis(16))
                    for (root in roots()) {
                        root.requestLayout()
                        root.measure(View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                            View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY))
                        root.layout(0, 0, widthPx, heightPx)
                        measureComposeOwners(root)
                        root.draw(frameCanvas)
                    }
                    Snapshot.sendApplyNotifications()
                }
            } finally { frame.recycle() }
            main.idleFor(Duration.ofMillis(32))
        }

        private fun measureComposeOwners(view: View) {
            if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView") {
                view.javaClass.getMethod("measureAndLayoutForTest").invoke(view)
            }
            if (view is ViewGroup) (0 until view.childCount).forEach { measureComposeOwners(view.getChildAt(it)) }
        }

        override fun close() {
            try {
                ShadowDialog.getLatestDialog()?.takeIf { it.isShowing }?.dismiss()
                controller.pause().stop().destroy()
                Snapshot.sendApplyNotifications()
                main.idleFor(Duration.ofMillis(32))
            } finally {
                ShadowChoreographer.setFrameDelay(originalFrameDelay)
                ShadowChoreographer.setPaused(originalChoreographerPaused)
            }
        }

        private fun owners(view: View): List<SemanticsOwner> {
            val own = if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                listOf(view.javaClass.getMethod("getSemanticsOwner").invoke(view) as SemanticsOwner) else emptyList()
            return own + if (view is ViewGroup) (0 until view.childCount).flatMap { owners(view.getChildAt(it)) } else emptyList()
        }

        private fun descendants(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::descendants)
    }

    companion object {
        private fun readyState() = HomeUiState(loading = false, summaryLoading = false,
            planoStatus = "active", planoNome = "Profissional", artesMensaisRestantes = 4,
            artesAvulsasRestantes = 3, carrosseisRestantes = 2, emProducao = 1, artesProntas = 2)
    }
}
