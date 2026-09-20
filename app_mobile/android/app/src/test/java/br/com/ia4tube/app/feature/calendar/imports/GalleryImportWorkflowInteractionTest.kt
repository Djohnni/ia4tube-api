package br.com.ia4tube.app.feature.calendar.imports

import android.app.Application
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.AnnotatedString
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowDialog
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class GalleryImportWorkflowInteractionTest {
    private class Host(video: Boolean = false, automaticAllowed: Boolean = true) {
        private val f = ImportPreparationTestData
        private val record = ImportPreparationProtocol.parseRecord(if (video) f.videoStatus() else f.status("ready"))
        private val preview = ImportPreparationProtocol.parsePreview(f.preview("https://ia4tube-api.onrender.com", record), record,
            "https://ia4tube-api.onrender.com".toHttpUrl())
        private val source = GalleryImportState(f.owner, "synthetic-draft", if (video) f.selection.copy(kind = ImportMediaKind.VIDEO,
            mimeType = "video/mp4", durationMs = 20_000) else f.selection, record.configuration!!, phase = ImportPhase.READY,
            upload = ImportUploadProgress(ImportUploadTicket(f.uploadId, f.assetId, f.sourceSha, f.selection.byteCount), serverVerified = true))
        var view by mutableStateOf(ImportWorkflowView(f.owner, ImportCapabilities(true, f.owner, preparationEnabled = true, schedulingEnabled = true),
            upload = ImportUploadRunView(source, ImportUploadRunStatus.UPLOADED), preparation = ImportPreparationRunView(
                ImportPreparationRunStatus.PREVIEW_AVAILABLE, source, record, preview,
                availability = ImportScheduleAvailability(true, automaticAllowed, true, "@conta_sintetica")), foreground = true, initialized = true))
        var confirmations = 0; var schedules = 0; var configurations = 0
        var previewFailed by mutableStateOf(false)
        var capturedCaption: String? = null; var capturedAutomatic: Boolean? = null
        val actions = object : GalleryImportWorkflowActions {
            override fun restore() = error("No implicit restore from content")
            override fun transfer() = error("No implicit upload")
            override fun reconcileUpload() = error("No implicit upload retry")
            override fun cancelUpload() = error("No implicit cancellation")
            override fun discardCancelled() = error("No implicit draft deletion")
            override fun configure(value: ImportConfiguration) {
                configurations++
                view = view.copy(preparation = view.preparation!!.copy(state = view.draft!!.copy(configuration = value, revision = 2,
                    phase = ImportPhase.UPLOADED, prepared = emptyList(), previewConfirmedRevision = null),
                    preparation = null, preview = null, confirmation = null, status = ImportPreparationRunStatus.AWAITING_REQUEST))
            }
            override fun prepare() = error("No implicit preparation")
            override fun refreshPreparation() = error("No implicit refresh")
            override fun adoptGenerated(id: String, revision: Long) = error("No implicit source adoption")
            override fun confirm(value: ImportPreviewConfirmation) {
                confirmations++
                assertEquals(preview.variants.map { it.target }.toSet(), value.verifiedTargets)
                assertEquals(preview.previewDigest, value.previewDigest)
                view = view.copy(preparation = view.preparation!!.copy(confirmation = value))
            }
            override fun schedule(caption: String, at: Long, automatic: Boolean) {
                schedules++; capturedCaption = caption; capturedAutomatic = automatic
                view = view.copy(preparation = view.preparation!!.copy(state = view.draft!!.copy(phase = ImportPhase.SCHEDULED,
                    calendarItemId = "d".repeat(40)), status = ImportPreparationRunStatus.SCHEDULED))
            }
            override fun reconcileSchedule() = error("No implicit scheduling retry")
            override fun pauseTransfer() = error("No implicit pause")
            override fun finishScheduledDraft() = error("No implicit draft finish")
        }
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        init {
            controller.get().setContent { IA4TubeTheme {
                CompositionLocalProvider(LocalImportWorkflowPreviewRenderer provides { part, modifier, verified, failed ->
                    LaunchedEffect(part.target, part.sha256, previewFailed) { if (previewFailed) failed() else verified() }
                    Text("Derivado sintético conferido: ${part.target}", modifier)
                }) {
                    GalleryImportWorkflowContent(view, actions, { "synthetic-session" }, null, null, {}, {}, { _, _ -> error("No automatic picker") })
                }
            } }
            idle()
        }
        private fun roots() = listOf(controller.get().window.decorView) + ShadowDialog.getShownDialogs().filter { it.isShowing }.mapNotNull { it.window?.decorView }
        private fun owners(view: View): List<SemanticsOwner> {
            val own = if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                listOf(view.javaClass.getMethod("getSemanticsOwner").invoke(view) as SemanticsOwner) else emptyList()
            return own + if (view is ViewGroup) (0 until view.childCount).flatMap { owners(view.getChildAt(it)) } else emptyList()
        }
        private fun descendants(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::descendants)
        fun nodes() = roots().flatMap(::owners).flatMap { descendants(it.rootSemanticsNode) }
        fun text(node: SemanticsNode) = node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }.orEmpty()
        fun button(label: String) = nodes().first { it.config.getOrNull(SemanticsActions.OnClick) != null && text(it) == label }
        fun click(label: String) {
            val node = button(label); assertFalse("Button must be enabled: $label", node.config.contains(SemanticsProperties.Disabled))
            assertTrue(node.config[SemanticsActions.OnClick].action!!.invoke()); idle()
        }
        fun enterCaption(value: String = "Legenda sintética revisada") {
            val editor = nodes().first { it.config.getOrNull(SemanticsActions.SetText) != null }
            assertTrue(editor.config[SemanticsActions.SetText].action!!.invoke(AnnotatedString(value))); idle()
        }
        fun idle() {
            Snapshot.sendApplyNotifications(); val main = shadowOf(Looper.getMainLooper()); main.idle()
            roots().forEach { view -> view.requestLayout(); view.measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(6000, View.MeasureSpec.EXACTLY)); view.layout(0, 0, 822, 6000) }
            main.idleFor(Duration.ofSeconds(1)); Snapshot.sendApplyNotifications(); main.idle()
        }
        fun close() {
            ShadowDialog.getShownDialogs().filter { it.isShowing }.forEach { it.dismiss() }
            controller.pause().stop().destroy(); shadowOf(Looper.getMainLooper()).idle()
        }
    }
    @Test fun actualScreenRequiresPreviewReviewThenSeparateExplicitScheduleConfirmation() {
        val host = Host()
        try {
            assertEquals(0, host.confirmations); assertEquals(0, host.schedules)
            assertTrue(host.button("Programar").config.contains(SemanticsProperties.Disabled))
            host.click("Conferi as prévias e o áudio"); assertEquals(1, host.confirmations)
            val editor = host.nodes().first { it.config.getOrNull(SemanticsActions.SetText) != null }
            assertTrue(editor.config[SemanticsActions.SetText].action!!.invoke(AnnotatedString("Legenda revisada localmente"))); host.idle()
            host.click("Programar"); assertEquals(0, host.schedules)
            assertTrue(host.nodes().any { host.text(it) == "Confirmar Programar?" })
            host.click("Confirmar Programar")
            assertEquals(1, host.schedules); assertEquals("Legenda revisada localmente", host.capturedCaption); assertEquals(true, host.capturedAutomatic)
            assertFalse(host.nodes().any { host.text(it) == "Programar" || host.text(it) == "Confirmar Programar" })
        } finally { host.close() }
    }
    @Test fun everyVideoTargetMustBeSeenAndChangingFinalAudioInvalidatesOldPreview() {
        val host = Host(video = true)
        try {
            assertTrue(host.button("Conferi as prévias e o áudio").config.contains(SemanticsProperties.Disabled))
            host.click("Reel")
            host.click("Conferi as prévias e o áudio"); assertEquals(1, host.confirmations)
            host.click("Remover áudio final")
            assertEquals(1, host.configurations); assertEquals(ImportAudioMode.MUTED, host.view.draft!!.configuration.audioMode)
            assertNull(host.view.preparation!!.preview); assertNull(host.view.preparation!!.confirmation)
            assertFalse(host.nodes().any { host.text(it) == "Prévia do arquivo final" || host.text(it) == "Programar" })
            assertEquals(0, host.schedules)
        } finally { host.close() }
    }
    @Test fun explicitReelFeedControlSendsFalseAndInvalidatesTheOldPreview() {
        val host = Host(video = true)
        try {
            assertTrue(host.view.draft!!.configuration.shareToFeed)
            assertTrue(host.nodes().any { host.text(it) == "O Reel também será exibido no Feed. Continua sendo uma única publicação." })
            host.click("Exibir também no Feed")
            assertEquals(1, host.configurations)
            assertFalse(host.view.draft!!.configuration.shareToFeed)
            assertNull(host.view.preparation!!.preview)
            assertNull(host.view.preparation!!.confirmation)
            assertFalse(host.nodes().any { host.text(it) == "Prévia do arquivo final" || host.text(it) == "Programar" })
            assertEquals(0, host.schedules)
        } finally { host.close() }
    }
    @Test fun previewFailureAfterConfirmationDisablesScheduleUntilVerifiedAgain() {
        val host = Host()
        try {
            host.click("Conferi as prévias e o áudio")
            host.enterCaption()
            assertFalse(host.button("Programar").config.contains(SemanticsProperties.Disabled))
            host.previewFailed = true; host.idle()
            assertTrue(host.button("Programar").config.contains(SemanticsProperties.Disabled))
            assertEquals(0, host.schedules)
        } finally { host.close() }
    }
    @Test fun closedAutomaticAvailabilityAllowsExplicitCalendarSaveWithoutReusingOldPreference() {
        val host = Host(automaticAllowed = false)
        try {
            host.click("Conferi as prévias e o áudio")
            host.enterCaption()
            host.click("Programar")
            assertEquals(0, host.schedules)
            assertTrue(host.nodes().any { host.text(it) == "Salvar no calendário sem publicar automaticamente." })
            host.click("Confirmar Programar")
            assertEquals(1, host.schedules)
            assertEquals(false, host.capturedAutomatic)
        } finally { host.close() }
    }
    @Test fun availabilityClosureDropsAutomaticChoiceAndReopeningDoesNotRestoreIt() {
        val host = Host()
        try {
            host.click("Conferi as prévias e o áudio")
            host.enterCaption()
            val prepared = host.view.preparation!!
            host.view = host.view.copy(preparation = prepared.copy(availability = prepared.availability!!.copy(automaticAllowed = false)))
            host.idle()
            host.view = host.view.copy(preparation = prepared)
            host.idle()
            host.click("Programar")
            assertTrue(host.nodes().any { host.text(it) == "Salvar no calendário sem publicar automaticamente." })
            host.click("Confirmar Programar")
            assertEquals(1, host.schedules)
            assertEquals(false, host.capturedAutomatic)
        } finally { host.close() }
    }
    @Test fun requiredFeedCaptionIsValidatedBeforeOpeningConfirmationOrSending() {
        val host = Host()
        try {
            host.click("Conferi as prévias e o áudio")
            assertTrue(host.button("Programar").config.contains(SemanticsProperties.Disabled))
            host.enterCaption("   ")
            assertTrue(host.button("Programar").config.contains(SemanticsProperties.Disabled))
            host.enterCaption()
            assertFalse(host.button("Programar").config.contains(SemanticsProperties.Disabled))
            assertEquals(0, host.schedules)
        } finally { host.close() }
    }
}
