package br.com.ia4tube.app.feature.calendar

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.semantics.*
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextLayoutResult
import br.com.ia4tube.app.ui.components.ScreenScaffold
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
import java.io.File
import java.time.Duration
import java.time.LocalDate
import java.time.ZoneId

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class CalendarGalleryRenderTest {
    @Test fun galleryRendersActualComposeWithSyntheticArtAndNoNetwork() = render(1f, "calendar-gallery-preview.png")
    @Test fun galleryRemainsReadableWithLargerText() = render(1.5f, "calendar-gallery-large-text-preview.png")
    @Test fun musicOpensOverTheGalleryWithoutRemovingIt() = render(1f, "calendar-gallery-music-sheet.png", openMusic = true)
    @Test fun historyShowsPublishedArtWithoutAnyImportEntry() = render(1f, "calendar-history-preview.png", mode = CalendarGalleryMode.HISTORY)
    @Test fun monthOverviewUsesLoadedSchedulesWithoutAnotherReadOrMutation() =
        render(1f, "calendar-month-overview-preview.png", openMonth = true)

    @Test
    @Config(qualifiers = "w360dp-h800dp-xhdpi")
    fun monthOverviewRemainsReadableOnSmallPhoneWithLargestText() =
        render(2f, "calendar-month-360dp-large-text-preview.png", openMonth = true,
            widthPx = 720, heightPx = 1600)

    private fun render(fontScale: Float, filename: String, openMusic: Boolean = false,
        mode: CalendarGalleryMode = CalendarGalleryMode.UPCOMING, openMonth: Boolean = false,
        widthPx: Int = 822, heightPx: Int = 1782) {
        val today = LocalDate.now(ZoneId.of("America/Sao_Paulo")).toString()
        val item = ScheduledArt("a".repeat(40), "synthetic:1", today, "18:30", "Uma arte pronta para o próximo dia. Você pode editar esta legenda antes da publicação.",
            2, if (mode == CalendarGalleryMode.HISTORY) "published" else "scheduled", if (mode == CalendarGalleryMode.HISTORY) "Publicada" else "Programada",
            mode != CalendarGalleryMode.HISTORY, true, "/synthetic-not-fetched", "empresa_exemplo", System.currentTimeMillis() + 3_600_000,
            destination = "both", formatsReady = true)
        val binding = CalendarBinding("11111111-1111-4111-8111-111111111111", "123456789", 72)
        val sampleItems = if (openMonth) listOf(item,
            item.copy(id = "b".repeat(40), key = "synthetic:2", date = LocalDate.parse(today).plusDays(2).toString(),
                caption = "Publicação futura do calendário", scheduledAt = System.currentTimeMillis() + 172_800_000)) else listOf(item)
        val snapshot = CalendarSnapshot(true, true, 2, true, "empresa_exemplo", true, sampleItems, item,
            preferenceBinding = binding, connectionBinding = binding)
        var calendarReads = 0
        var mutations = 0
        val gateway = object : CalendarGateway {
            override suspend fun list(): CalendarSnapshot { calendarReads++; return snapshot }
            override suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot { mutations++; error("No mutation in visual check") }
            override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot { mutations++; error("No mutation in visual check") }
        }
        val model = CalendarViewModel({ "synthetic-only" }, "synthetic-only", gateway)
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        val activity = controller.get()
        activity.setTheme(android.R.style.Theme_Material_NoActionBar)
        controller.setup()
        val config = android.content.res.Configuration(activity.resources.configuration).apply { this.fontScale = fontScale }
        @Suppress("DEPRECATION")
        activity.resources.updateConfiguration(config, activity.resources.displayMetrics)
        val animationScale = android.provider.Settings.Global.getFloat(activity.contentResolver,
            android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        android.provider.Settings.Global.putFloat(activity.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        val sample = Bitmap.createBitmap(1080, 1350, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(sample); canvas.drawColor(android.graphics.Color.rgb(28, 69, 104))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.rgb(244, 216, 154); textSize = 120f; isFakeBoldText = true }
        canvas.drawText("SUA MARCA", 95f, 420f, paint); paint.textSize = 58f; paint.isFakeBoldText = false
        canvas.drawText("Uma nova ideia por dia.", 110f, 555f, paint)
        model.refresh(); shadowOf(Looper.getMainLooper()).idle()
        activity.setContent { IA4TubeTheme {
            CompositionLocalProvider(LocalScheduledArtRenderer provides { _, modifier -> Image(sample.asImageBitmap(), "Arte sintética", modifier, contentScale = ContentScale.Fit) }) {
                ScreenScaffold { CalendarGallery(model, "synthetic-only", mode = mode) {} }
            }
        } }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        val view = activity.window.decorView
        view.measure(View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY)); view.layout(0,0,widthPx,heightPx)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        val initialNodes = monthRenderOwners(view).flatMap { monthRenderNodes(it.rootSemanticsNode) }
        val initialTexts = initialNodes.flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }.map { it.text }
        assertFalse("Direct manual uploads stay hidden without deleting their workflow", initialTexts.contains("Adicionar foto ou vídeo"))
        assertEquals(mode == CalendarGalleryMode.UPCOMING, initialTexts.contains("Veja seu calendário"))
        if (mode == CalendarGalleryMode.HISTORY) {
            fun owners(root: View): List<SemanticsOwner> {
                val own = if (root.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                    listOf(root.javaClass.getMethod("getSemanticsOwner").invoke(root) as SemanticsOwner) else emptyList()
                return own + if (root is ViewGroup) (0 until root.childCount).flatMap { owners(root.getChildAt(it)) } else emptyList()
            }
            fun nodes(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::nodes)
            val semantics = owners(view).flatMap { nodes(it.rootSemanticsNode) }
            val texts = semantics.flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }.map { it.text }
            assertTrue(texts.contains("Histórico de artes"))
            assertFalse(texts.contains("Adicionar foto ou vídeo"))
            assertFalse(semantics.any { it.config.getOrNull(SemanticsProperties.ContentDescription)?.contains("Usar com música") == true })
        }
        var dialogBitmap: Bitmap? = null
        if (openMonth) {
            val readsBeforeOpening = calendarReads
            val shortcut = requireNotNull(initialNodes.firstOrNull {
                it.config.getOrNull(SemanticsActions.OnClick) != null &&
                    it.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { value -> value.text } == "Veja seu calendário"
            })
            assertTrue(shortcut.config[SemanticsActions.OnClick].action!!.invoke())
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
            val dialog = requireNotNull(ShadowDialog.getShownDialogs().lastOrNull { it.isShowing })
            val monthView = dialog.window!!.decorView
            fun settleMonth() {
                repeat(5) {
                    Snapshot.sendApplyNotifications()
                    monthView.requestLayout()
                    monthView.measure(View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.AT_MOST),
                        View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.AT_MOST))
                    monthView.layout(0, 0, monthView.measuredWidth, monthView.measuredHeight)
                    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
                }
            }
            fun currentMonthNodes() = monthRenderOwners(monthView).flatMap { monthRenderNodes(it.rootSemanticsNode) }
            settleMonth()
            val monthNodes = monthRenderOwners(monthView).flatMap { monthRenderNodes(it.rootSemanticsNode) }
            val monthTexts = monthNodes.flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }.map { it.text }
            assertTrue(monthTexts.contains("Seu calendário"))
            assertTrue(monthTexts.contains("Dias com publicações"))
            assertTrue(monthNodes.any { node -> node.config.getOrNull(SemanticsProperties.ContentDescription)
                ?.any { it.contains(LocalDate.parse(today).format(java.time.format.DateTimeFormatter.ofPattern("dd/MM/yyyy"))) && it.contains("publica") } == true })
            // Keep the actual popup proof even if a large-font text assertion fails.
            val monthPreview = Bitmap.createBitmap(monthView.width, monthView.height, Bitmap.Config.ARGB_8888)
                .also { monthView.draw(Canvas(it)) }
            dialogBitmap = monthPreview
            val monthProof = File("build/reports/$filename").also { it.parentFile?.mkdirs() }
            monthProof.outputStream().use { monthPreview.compress(Bitmap.CompressFormat.PNG, 100, it) }

            val dayNumbers = (1..LocalDate.parse(today).lengthOfMonth()).map { it.toString() }.toSet()
            val fullWeekdays = listOf("Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado")
            val weekdayLabels = if (fontScale > 1.4f) listOf("D", "S", "T", "Q", "Q", "S", "S")
                else listOf("Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb")
            val gridTextNodes = monthNodes.filter { node ->
                val label = node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }
                label != null && (label in dayNumbers || label in weekdayLabels)
            }
            val gridLabels = gridTextNodes.map { node ->
                node.config[SemanticsProperties.Text].joinToString(" ") { it.text }
            }.toSet()
            assertTrue("Every day must remain in the actual popup; labels=$gridLabels; fontScale=$fontScale; viewport=${widthPx}x$heightPx",
                gridLabels.containsAll(dayNumbers))
            val weekdayNodes = gridTextNodes.filter { node ->
                node.config[SemanticsProperties.Text].joinToString(" ") { it.text } in weekdayLabels
            }.sortedBy { it.boundsInRoot.left }
            val actualWeekdays = weekdayNodes.map { it.config[SemanticsProperties.Text].joinToString(" ") { value -> value.text } }
            assertEquals("Seven weekday labels must stay ordered; fontScale=$fontScale; viewport=${widthPx}x$heightPx", weekdayLabels, actualWeekdays)
            weekdayNodes.zip(fullWeekdays).forEach { (node, fullName) ->
                assertTrue("Weekday '$fullName' must keep its full accessible name; semantics=${node.config}",
                    node.config.getOrNull(SemanticsProperties.ContentDescription)?.any { it.equals(fullName, ignoreCase = true) } == true)
            }
            gridTextNodes.forEach { node ->
                val label = node.config[SemanticsProperties.Text].joinToString(" ") { it.text }
                val layouts = mutableListOf<TextLayoutResult>()
                val getLayout = requireNotNull(node.config.getOrNull(SemanticsActions.GetTextLayoutResult)) {
                    "Grid label '$label' must expose its measured text layout"
                }
                assertTrue(getLayout.action!!.invoke(layouts))
                assertTrue("Grid label '$label' must have a measured text layout", layouts.isNotEmpty())
                layouts.forEach { layout ->
                    val diagnostic = buildString {
                        append("label='$label', layoutText='${layout.layoutInput.text.text}', fontScale=$fontScale, viewport=${widthPx}x$heightPx")
                        append(", size=${layout.size}, constraints=${layout.layoutInput.constraints}, bounds=${node.boundsInRoot}")
                        append(", paragraph=${layout.multiParagraph.width}x${layout.multiParagraph.height}, lines=${layout.lineCount}")
                        append(", overflow=${layout.hasVisualOverflow}, widthOverflow=${layout.didOverflowWidth}, heightOverflow=${layout.didOverflowHeight}")
                        (0 until layout.lineCount).forEach { line ->
                            append(", line$line(left=${layout.getLineLeft(line)}, right=${layout.getLineRight(line)}, top=${layout.getLineTop(line)}, bottom=${layout.getLineBottom(line)}, end=${layout.getLineEnd(line, visibleEnd = true)}, ellipsized=${layout.isLineEllipsized(line)})")
                        }
                    }
                    if (layout.hasVisualOverflow) println("Calendar grid overflow diagnostic: $diagnostic")
                    assertEquals("Grid text must preserve its label; $diagnostic", label, layout.layoutInput.text.text)
                    assertEquals("Grid label must stay on one line; $diagnostic", 1, layout.lineCount)
                    assertFalse("Grid label must not be ellipsized; $diagnostic", layout.isLineEllipsized(0))
                    assertEquals("Grid label must show every character; $diagnostic", label.length, layout.getLineEnd(0, visibleEnd = true))
                    // hasVisualOverflow compares floating paragraph dimensions with rounded
                    // IntSize, which can flag a subpixel remainder despite fully visible text.
                    // Check the measured line itself with at most one physical pixel of rounding.
                    assertTrue("Grid text must fit horizontally; $diagnostic",
                        layout.getLineLeft(0) >= -1f && layout.getLineRight(0) <= layout.size.width + 1f)
                    assertTrue("Grid text must fit vertically; $diagnostic",
                        layout.getLineTop(0) >= -1f && layout.getLineBottom(0) <= layout.size.height + 1f)
                }
            }

            val dateFormat = java.time.format.DateTimeFormatter.ofPattern("dd/MM/yyyy")
            val selectedDate = LocalDate.parse(today).withDayOfMonth(if (LocalDate.parse(today).dayOfMonth == 1) 2 else 1)
            fun dayNode(date: LocalDate) = requireNotNull(currentMonthNodes().firstOrNull { node ->
                node.config.getOrNull(SemanticsActions.OnClick) != null &&
                    node.config.getOrNull(SemanticsProperties.ContentDescription)?.any { it.startsWith(date.format(dateFormat)) } == true
            }) { "The day $date must have a semantic click action" }
            assertTrue(dayNode(selectedDate).config[SemanticsActions.OnClick].action!!.invoke())
            settleMonth()
            assertEquals("Selecting a day only changes the local selection", true,
                dayNode(selectedDate).config.getOrNull(SemanticsProperties.Selected))
            assertEquals("Selecting a day must not read the gateway", readsBeforeOpening, calendarReads)
            assertEquals("Selecting a day must not mutate a publication", 0, mutations)

            fun clickMonthArrow(description: String) {
                val arrow = requireNotNull(currentMonthNodes().firstOrNull { node ->
                    node.config.getOrNull(SemanticsActions.OnClick) != null &&
                        node.config.getOrNull(SemanticsProperties.ContentDescription)?.contains(description) == true
                }) { "Month arrow '$description' must have a semantic click action" }
                assertTrue(arrow.config[SemanticsActions.OnClick].action!!.invoke())
                settleMonth()
                assertEquals("Month navigation must not read the gateway", readsBeforeOpening, calendarReads)
                assertEquals("Month navigation must not mutate a publication", 0, mutations)
            }
            clickMonthArrow("Próximo mês")
            dayNode(LocalDate.parse(today).plusMonths(1).withDayOfMonth(1))
            clickMonthArrow("Mês anterior")
            dayNode(LocalDate.parse(today).withDayOfMonth(1))
            assertEquals("Opening the month must reuse the loaded snapshot", readsBeforeOpening, calendarReads)
            assertEquals("The month is a read-only overview", 0, mutations)
            dialog.dismiss()
        }
        if (openMusic) {
            fun owners(root: View): List<SemanticsOwner> {
                val own = if (root.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                    listOf(root.javaClass.getMethod("getSemanticsOwner").invoke(root) as SemanticsOwner) else emptyList()
                return own + if (root is ViewGroup) (0 until root.childCount).flatMap { owners(root.getChildAt(it)) } else emptyList()
            }
            fun nodes(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::nodes)
            fun texts(root: View) = owners(root).flatMap { nodes(it.rootSemanticsNode) }
            fun label(node: SemanticsNode) = node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }.orEmpty()
            val action = requireNotNull(texts(view).firstOrNull {
                it.config.getOrNull(SemanticsProperties.ContentDescription)?.contains("Usar com música") == true &&
                    it.config.getOrNull(SemanticsActions.OnClick) != null
            }) { "Music action must remain available in the calendar rail" }
            assertTrue(action.config[SemanticsActions.OnClick].action!!.invoke())
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
            assertTrue("Underlying gallery stays composed", texts(view).any { label(it) == "Ver minhas artes programadas" })
            val dialog = requireNotNull(ShadowDialog.getShownDialogs().lastOrNull { it.isShowing }) { "Music must open in a dialog over the gallery" }
            val sheet = dialog.window!!.decorView
            sheet.measure(View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY))
            sheet.layout(0, 0, widthPx, heightPx)
            // The first manual measure creates sheet anchors. Publish that snapshot and
            // remeasure the recomposed dialog before observing its final expanded position.
            repeat(3) {
                Snapshot.sendApplyNotifications()
                shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
                sheet.requestLayout()
                sheet.measure(View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY))
                sheet.layout(0, 0, widthPx, heightPx)
            }
            val sheetNodes = texts(sheet)
            val titleProof = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888).also { sheet.draw(Canvas(it)) }
            val titleProofFile = File("build/reports/calendar-music-title-diagnostic.png")
            titleProofFile.parentFile?.mkdirs()
            titleProofFile.outputStream().use { titleProof.compress(Bitmap.CompressFormat.PNG, 100, it) }
            titleProof.recycle()
            val panel = requireNotNull(sheetNodes.firstOrNull { it.config.getOrNull(SemanticsProperties.PaneTitle) != null }) {
                "Modal sheet must expose its panel bounds independently of the full-window scrim"
            }
            val bounds = panel.boundsInRoot
            assertTrue("Music panel must leave the underlying gallery visible above it", bounds.top > 0f)
            assertTrue("Music panel must use at most 80% of the viewport", bounds.height <= sheet.height * 0.8f + 2f)
            assertEquals("Compact sheet stays anchored to the bottom, not floating above it; panel=$bounds; roots=${owners(sheet).map { it.rootSemanticsNode.boundsInRoot }}; decor=${sheet.width}x${sheet.height}; metrics=${activity.resources.displayMetrics.widthPixels}x${activity.resources.displayMetrics.heightPixels}", sheet.height.toFloat(), bounds.bottom, 2f)
            val title = requireNotNull(sheetNodes.firstOrNull {
                label(it) == "Escolher música" && it.config.getOrNull(SemanticsActions.GetTextLayoutResult) != null
            }) { "Music panel must contain the actual title text layout" }
            val titleLayouts = mutableListOf<TextLayoutResult>()
            assertTrue(title.config[SemanticsActions.GetTextLayoutResult].action!!.invoke(titleLayouts))
            assertTrue("Title must use white text on the dark panel; layoutColors=${titleLayouts.map { it.layoutInput.style.color }}", titleLayouts.isNotEmpty() &&
                titleLayouts.all { it.layoutInput.style.color == Color.White })
            // Capture the dialog while it is shown; a gallery screenshot after
            // dismiss would hide precisely the panel/contrast regression.
            dialogBitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888).also { sheet.draw(Canvas(it)) }
            dialog.dismiss()
        }
        val bitmap = dialogBitmap ?: Bitmap.createBitmap(widthPx,heightPx,Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
        val colors = mutableSetOf<Int>(); for (y in 0 until bitmap.height step 16) for (x in 0 until bitmap.width step 16) colors.add(bitmap.getPixel(x,y))
        assertTrue("Compose render must contain real content, not a blank screenshot", colors.size > 20)
        val output = File("build/reports/$filename"); output.parentFile?.mkdirs()
        output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) }
        model.dispose(); controller.pause().stop().destroy()
        shadowOf(Looper.getMainLooper()).idle()
        android.provider.Settings.Global.putFloat(activity.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, animationScale)
        bitmap.recycle(); sample.recycle()
    }

    private fun monthRenderOwners(view: View): List<SemanticsOwner> {
        val own = if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
            listOf(view.javaClass.getMethod("getSemanticsOwner").invoke(view) as SemanticsOwner) else emptyList()
        return own + if (view is ViewGroup) (0 until view.childCount).flatMap { monthRenderOwners(view.getChildAt(it)) } else emptyList()
    }
    private fun monthRenderNodes(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::monthRenderNodes)
}
