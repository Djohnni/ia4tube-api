package br.com.ia4tube.app.feature.calendar.imports

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
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.TextLayoutResult
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import java.io.File
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w411dp-h3000dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class GalleryImportWorkflowRenderTest {
    private class Actions : GalleryImportWorkflowActions {
        var mutations = 0
        override fun restore() { mutations++ }; override fun transfer() { mutations++ }
        override fun reconcileUpload() { mutations++ }; override fun cancelUpload() { mutations++ }
        override fun discardCancelled() { mutations++ }; override fun configure(value: ImportConfiguration) { mutations++ }
        override fun prepare() { mutations++ }; override fun refreshPreparation() { mutations++ }
        override fun adoptGenerated(id: String, revision: Long) { mutations++ }; override fun confirm(value: ImportPreviewConfirmation) { mutations++ }
        override fun schedule(caption: String, at: Long, automatic: Boolean) { mutations++ }; override fun reconcileSchedule() { mutations++ }
        override fun pauseTransfer() { mutations++ }; override fun finishScheduledDraft() { mutations++ }
        override fun addToCalendar(caption: String) { mutations++ }
    }
    @Test fun completePhotoWorkflowRendersActualComposeWithoutImplicitConsent() = render(ready = true, fontScale = 1f, filename = "import-workflow-photo-preview.png")
    @Test fun fullWorkflowKeepsLargerTextReadable() = render(ready = true, fontScale = 1.4f, filename = "import-workflow-large-text-preview.png")
    @Test fun processingCannotRenderOrConfirmAnUnpreparedOriginal() = render(ready = false, fontScale = 1f, filename = "import-workflow-processing-preview.png")
    @Test fun videoAudioChoicesRemainReadableWithLargerText() = render(ready = true, fontScale = 1.4f,
        filename = "import-workflow-video-large-text-preview.png", video = true)

    @Test @Config(qualifiers = "w411dp-h891dp-xhdpi")
    fun loadingEntryIsCompactAndReadableOverTheGallery() = renderStatus(true, null, "loading")

    @Test @Config(qualifiers = "w411dp-h891dp-xhdpi")
    fun closedGateEntryIsCompactAndReadableOverTheGallery() = renderStatus(false,
        "Adicionar foto ou vídeo ainda não está disponível para esta conta. Nenhum arquivo foi enviado.", "blocked")

    @Test @Config(qualifiers = "w411dp-h891dp-xhdpi")
    fun closedGatePhotoEntryUsesTheSameReadableCompactPanel() = renderStatus(false,
        "Adicionar foto ou vídeo ainda não está disponível para esta conta. Nenhum arquivo foi enviado.", "blocked-photo", musicOnly = false)

    @Test @Config(qualifiers = "w411dp-h891dp-xhdpi")
    fun failedEntryKeepsLargerTextReadableOverTheGallery() = renderStatus(false,
        "Não foi possível conferir a conta. Volte e abra novamente com a sessão atual.", "error", 1.5f)

    @Test @Config(qualifiers = "w411dp-h891dp-xhdpi")
    fun expiredSessionEntryUsesTheSameReadableCompactPanel() = renderStatus(false, null, "session", 1.5f)

    @Test @Config(qualifiers = "w411dp-h891dp-xhdpi")
    fun longEntryErrorIsBoundedAndScrollableWithoutHidingTheGallery() = renderStatus(false,
        "Não foi possível conferir a conta. ".repeat(60), "long-error", 1.5f, longError = true)

    private fun renderStatus(loading: Boolean, error: String?, name: String, fontScale: Float = 1f, longError: Boolean = false, musicOnly: Boolean = true) {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        val activity = controller.get(); activity.setTheme(android.R.style.Theme_Material_NoActionBar); controller.setup()
        val config = android.content.res.Configuration(activity.resources.configuration).apply { this.fontScale = fontScale }
        @Suppress("DEPRECATION") activity.resources.updateConfiguration(config, activity.resources.displayMetrics)
        // Keep the indeterminate indicator visible without an unbounded Robolectric animation clock.
        val animationScale = android.provider.Settings.Global.getFloat(activity.contentResolver,
            android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        android.provider.Settings.Global.putFloat(activity.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        var returns = 0
        activity.setContent { MaterialTheme(colorScheme = lightColorScheme()) {
            // A dark sheet must remain readable even when its parent page supplies dark text.
            CompositionLocalProvider(LocalContentColor provides Color.Black) {
                Box(Modifier.fillMaxSize().background(Color(0xFF1C4568)), contentAlignment = Alignment.BottomCenter) {
                    GalleryImportWorkflowStatus(loading, error, musicOnly) { returns++ }
                }
            }
        } }
        try {
            Snapshot.sendApplyNotifications(); shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
            val root = activity.window.decorView
            root.measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY))
            root.layout(0, 0, 822, 1782); shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
            Snapshot.sendApplyNotifications(); shadowOf(Looper.getMainLooper()).idle()
            fun owners(view: View): List<SemanticsOwner> {
                val own = if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                    listOf(view.javaClass.getMethod("getSemanticsOwner").invoke(view) as SemanticsOwner) else emptyList()
                return own + if (view is ViewGroup) (0 until view.childCount).flatMap { owners(view.getChildAt(it)) } else emptyList()
            }
            fun descendants(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::descendants)
            val nodes = owners(root).flatMap { descendants(it.rootSemanticsNode) }
            fun label(node: SemanticsNode) = node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }.orEmpty()
            val panel = nodes.single { it.config.getOrNull(SemanticsProperties.VerticalScrollAxisRange) != null }
            val density = activity.resources.displayMetrics.density
            assertTrue("Entry wraps content and leaves the gallery above it", panel.boundsInRoot.top > 1782 * 0.2f)
            assertTrue("Every status respects the existing compact workflow ceiling", panel.boundsInRoot.height <= 620 * density + 1)
            if (!longError) assertTrue("A short status must not expand to the maximum sheet height", panel.boundsInRoot.height < 1782 * 0.6f)
            else assertTrue("Long errors stay reachable by scrolling", panel.config[SemanticsProperties.VerticalScrollAxisRange].maxValue() > 0)
            val expected = listOfNotNull(if (musicOnly) "Escolher música" else "Adicionar foto ou vídeo",
                if (loading) null else error ?: "A sessão mudou. Abra novamente para continuar.")
            for (text in expected) {
                val node = nodes.single { label(it) == text }
                val layouts = mutableListOf<TextLayoutResult>()
                assertTrue(node.config[SemanticsActions.GetTextLayoutResult].action!!.invoke(layouts))
                assertEquals("Dark panel text must not inherit dark parent-page text", Color.White, layouts.single().layoutInput.style.color)
            }
            assertEquals("Rendering never dismisses or mutates the workflow", 0, returns)
            val bitmap = Bitmap.createBitmap(822, 1782, Bitmap.Config.ARGB_8888); root.draw(Canvas(bitmap))
            val output = File("build/reports/import-workflow-status-$name.png"); output.parentFile?.mkdirs()
            output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        } finally {
            controller.pause().stop().destroy(); shadowOf(Looper.getMainLooper()).idle()
            android.provider.Settings.Global.putFloat(activity.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, animationScale)
        }
    }

    private fun render(ready: Boolean, fontScale: Float, filename: String, video: Boolean = false) {
        val f = ImportPreparationTestData
        val record = ImportPreparationProtocol.parseRecord(if (video) f.videoStatus() else f.status(if (ready) "ready" else "queued"))
        val preview = if (ready) ImportPreparationProtocol.parsePreview(f.preview("https://ia4tube-api.onrender.com", record), record,
            "https://ia4tube-api.onrender.com".toHttpUrl()) else null
        val source = GalleryImportState(f.owner, "synthetic-draft", if (video) f.selection.copy(kind = ImportMediaKind.VIDEO,
            mimeType = "video/mp4", durationMs = 20_000) else f.selection, record.configuration!!,
            phase = if (ready) ImportPhase.READY else ImportPhase.PREPARING,
            upload = ImportUploadProgress(ImportUploadTicket(f.uploadId, f.assetId, f.sourceSha, f.selection.byteCount), serverVerified = true))
        val view = ImportWorkflowView(f.owner, ImportCapabilities(true, f.owner, preparationEnabled = true, schedulingEnabled = true, calendarSubmissionEnabled = true),
            upload = ImportUploadRunView(source, ImportUploadRunStatus.UPLOADED), preparation = ImportPreparationRunView(
                if (ready) ImportPreparationRunStatus.PREVIEW_AVAILABLE else ImportPreparationRunStatus.PREPARING,
                source, record, preview, availability = ImportScheduleAvailability(true, true, true, "@empresa_sintetica")),
            foreground = true, initialized = true)
        val actions = Actions(); var renderCount = 0
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        val activity = controller.get(); activity.setTheme(android.R.style.Theme_Material_NoActionBar); controller.setup()
        val config = android.content.res.Configuration(activity.resources.configuration).apply { this.fontScale = fontScale }
        @Suppress("DEPRECATION") activity.resources.updateConfiguration(config, activity.resources.displayMetrics)
        val sample = Bitmap.createBitmap(1080, if (video) 1920 else 1350, Bitmap.Config.ARGB_8888)
        val art = Canvas(sample); art.drawColor(android.graphics.Color.rgb(18, 75, 93))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.WHITE; textSize = 100f }
        art.drawText("iA4tube", 100f, 410f, paint); paint.textSize = 42f
        art.drawText("Arquivo sintético para teste local", 100f, 560f, paint)
        activity.setContent { IA4TubeTheme {
            CompositionLocalProvider(LocalImportWorkflowPreviewRenderer provides { part, modifier, verified, _ ->
                SideEffect { if (renderCount == 0) { renderCount++; verified() } }
                Image(sample.asImageBitmap(), "Prévia sintética do teste local", modifier, contentScale = ContentScale.Fit)
            }) {
                GalleryImportWorkflowContent(view, actions, { "synthetic-token" }, null, null, {}, {}, { _, _ -> error("No picker on render") })
            }
        } }
        Snapshot.sendApplyNotifications(); shadowOf(Looper.getMainLooper()).idle()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        val root = activity.window.decorView
        root.measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(6000, View.MeasureSpec.EXACTLY))
        root.layout(0, 0, 822, 6000); shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        Snapshot.sendApplyNotifications(); shadowOf(Looper.getMainLooper()).idle()
        val bitmap = Bitmap.createBitmap(822, 6000, Bitmap.Config.ARGB_8888); root.draw(Canvas(bitmap))
        val colors = mutableSetOf<Int>(); for (y in 0 until 6000 step 16) for (x in 0 until 822 step 16) colors.add(bitmap.getPixel(x, y))
        val output = File("build/reports/$filename"); output.parentFile?.mkdirs()
        output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        controller.pause().stop().destroy()
        shadowOf(Looper.getMainLooper()).idle()
        bitmap.recycle(); sample.recycle()
        assertTrue("Actual Compose must render nonblank workflow", colors.size > 20)
        assertEquals("Opening/rendering does not upload, prepare, approve or schedule", 0, actions.mutations)
        assertEquals("Adding to calendar never requires loading a preview", 0, renderCount)
    }
}
