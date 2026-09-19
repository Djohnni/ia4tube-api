package br.com.ia4tube.app.feature.calendar.imports

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
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
    }
    @Test fun completePhotoWorkflowRendersActualComposeWithoutImplicitConsent() = render(ready = true, fontScale = 1f, filename = "import-workflow-photo-preview.png")
    @Test fun fullWorkflowKeepsLargerTextReadable() = render(ready = true, fontScale = 1.4f, filename = "import-workflow-large-text-preview.png")
    @Test fun processingCannotRenderOrConfirmAnUnpreparedOriginal() = render(ready = false, fontScale = 1f, filename = "import-workflow-processing-preview.png")
    @Test fun videoAudioChoicesRemainReadableWithLargerText() = render(ready = true, fontScale = 1.4f,
        filename = "import-workflow-video-large-text-preview.png", video = true)

    private fun render(ready: Boolean, fontScale: Float, filename: String, video: Boolean = false) {
        val f = ImportPreparationTestData
        val record = ImportPreparationProtocol.parseRecord(if (video) f.videoStatus() else f.status(if (ready) "ready" else "queued"))
        val preview = if (ready) ImportPreparationProtocol.parsePreview(f.preview("https://ia4tube-api.onrender.com", record), record,
            "https://ia4tube-api.onrender.com".toHttpUrl()) else null
        val source = GalleryImportState(f.owner, "synthetic-draft", if (video) f.selection.copy(kind = ImportMediaKind.VIDEO,
            mimeType = "video/mp4", durationMs = 20_000) else f.selection, record.configuration!!,
            phase = if (ready) ImportPhase.READY else ImportPhase.PREPARING,
            upload = ImportUploadProgress(ImportUploadTicket(f.uploadId, f.assetId, f.sourceSha, f.selection.byteCount), serverVerified = true))
        val view = ImportWorkflowView(f.owner, ImportCapabilities(true, f.owner, preparationEnabled = true, schedulingEnabled = true),
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
        assertEquals(if (ready) 1 else 0, renderCount)
    }
}
