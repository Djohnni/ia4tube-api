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
    private class Host(video: Boolean = false, automaticAllowed: Boolean = true, generated: Boolean = false) {
        private val f = ImportPreparationTestData
        private val record = ImportPreparationProtocol.parseRecord(if (video) f.videoStatus() else f.status("ready"))
        private val preview = ImportPreparationProtocol.parsePreview(f.preview("https://ia4tube-api.onrender.com", record), record,
            "https://ia4tube-api.onrender.com".toHttpUrl())
        private val source = GalleryImportState(f.owner, "synthetic-draft", if (video) f.selection.copy(kind = ImportMediaKind.VIDEO,
            mimeType = "video/mp4", durationMs = 20_000) else f.selection, record.configuration!!, phase = ImportPhase.READY,
            upload = ImportUploadProgress(ImportUploadTicket(f.uploadId, f.assetId, f.sourceSha, f.selection.byteCount), serverVerified = true))
        private val generatedId = "e".repeat(40)
        var view by mutableStateOf(ImportWorkflowView(f.owner, ImportCapabilities(true, f.owner, preparationEnabled = true, schedulingEnabled = true, calendarSubmissionEnabled = true,
            musicTracks = listOf(AuthorizedImportTrack("track-a", true, displayName = "Música A"), AuthorizedImportTrack("track-b", true, displayName = "Música B"))),
            upload = ImportUploadRunView(source, ImportUploadRunStatus.UPLOADED), preparation = ImportPreparationRunView(
                ImportPreparationRunStatus.PREVIEW_AVAILABLE, source, record, preview,
                availability = ImportScheduleAvailability(true, automaticAllowed, true, "@conta_sintetica"),
                generatedSourceIntent = if (generated) ImportGeneratedSourceIntent(generatedId, 1, "generated-source-test") else null), foreground = true, initialized = true))
        var confirmations = 0; var schedules = 0; var configurations = 0; var submissions = 0; var returns = 0; var previewRenders = 0
        var previewFailed by mutableStateOf(false)
        var capturedCaption: String? = null; var capturedAutomatic: Boolean? = null
        var capturedSchedule: ImportCalendarSchedule? = null
        val actions = object : GalleryImportWorkflowActions {
            override fun addToCalendar(caption: String) { submissions++; capturedCaption = caption }
            override fun addToCalendar(caption: String, schedule: ImportCalendarSchedule?) { addToCalendar(caption); capturedSchedule = schedule }
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
                    LaunchedEffect(part.target, part.sha256, previewFailed) { previewRenders++; if (previewFailed) failed() else verified() }
                    Text("Derivado sintético conferido: ${part.target}", modifier)
                }) {
                    GalleryImportWorkflowContent(view, actions, { "synthetic-session" }, if (generated) generatedId else null,
                        if (generated) 1L else null, {}, { returns++ }, { _, _ -> error("No automatic picker") },
                        if (generated) "feed" else null)
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
    @Test fun actualScreenAddsInOneActionWithoutRenderingReviewOrFinalDialog() {
        val host = Host()
        try {
            assertEquals(0, host.submissions); assertEquals(0, host.previewRenders)
            assertFalse(host.nodes().any { host.text(it) in setOf("Prévia do arquivo final", "Conferi as prévias e o áudio", "Programar", "Confirmar Programar") })
            host.click("Enviar")
            assertEquals(1, host.submissions); assertEquals("", host.capturedCaption)
            assertEquals(0, host.confirmations); assertEquals(0, host.schedules)
            assertTrue(ShadowDialog.getShownDialogs().none { it.isShowing })
        } finally { host.close() }
    }
    @Test fun optionalCaptionIsSentWithSingleSubmission() {
        val host = Host()
        try {
            host.click("Formato e legenda (opcional)")
            host.enterCaption("Legenda opcional")
            host.click("Enviar")
            assertEquals(1, host.submissions); assertEquals("Legenda opcional", host.capturedCaption)
            assertEquals(0, host.confirmations); assertEquals(0, host.schedules)
        } finally { host.close() }
    }
    @Test fun finalAudioCanChangeWithoutRenderingEveryVideoTarget() {
        val host = Host(video = true)
        try {
            host.click("Remover áudio")
            assertEquals(1, host.configurations); assertEquals(ImportAudioMode.MUTED, host.view.draft!!.configuration.audioMode)
            host.click("Enviar")
            assertEquals(1, host.submissions); assertEquals(0, host.previewRenders); assertEquals(0, host.confirmations)
        } finally { host.close() }
    }
    @Test fun formatAndAudioCanBeSelectedBeforeUpload() {
        val host = Host(video = true)
        try {
            val local = host.view.draft!!.copy(phase = ImportPhase.EDITING, upload = null)
            host.view = host.view.copy(upload = ImportUploadRunView(local, ImportUploadRunStatus.PAUSED),
                preparation = host.view.preparation!!.copy(state = local, preview = null))
            host.idle()
            host.click("Formato e legenda (opcional)")
            host.click("Exibir também no Feed")
            assertFalse(host.view.draft!!.configuration.shareToFeed)
            host.click("Enviar")
            assertEquals(1, host.submissions); assertEquals(0, host.schedules)
        } finally { host.close() }
    }
    @Test fun previewFailureDoesNotCreateAnUnrelatedGate() {
        val host = Host()
        try {
            host.previewFailed = true; host.idle()
            host.click("Enviar")
            assertEquals(1, host.submissions); assertEquals(0, host.previewRenders)
        } finally { host.close() }
    }
    @Test fun closedAutomaticAvailabilityDoesNotFabricatePublicationConsent() {
        val host = Host(automaticAllowed = false)
        try {
            host.click("Enviar")
            assertEquals(1, host.submissions); assertEquals(0, host.schedules); assertNull(host.capturedAutomatic)
        } finally { host.close() }
    }
    @Test fun acceptedReceiptReturnsToCalendarOnceWithoutWaitingForPreparation() {
        val host = Host()
        try {
            val f = ImportPreparationTestData
            host.view = host.view.copy(preparation = ImportPreparationRunView(ImportPreparationRunStatus.CALENDAR_ACCEPTED,
                calendarSubmissionReceipt = ImportCalendarSubmissionReceipt("d".repeat(40), f.assetId, f.uploadId,
                    "synthetic-submission", "accepted", null, 0, "2026-09-24", "09:00", "", null)))
            host.idle(); host.idle()
            assertEquals(1, host.returns); assertEquals(0, host.schedules); assertEquals(0, host.previewRenders)
        } finally { host.close() }
    }
    @Test fun existingArtShowsOnlyMusicChoicesThenOneSendPreservingCalendarSchedule() {
        val host = Host(generated = true)
        try {
            assertFalse(host.nodes().any { host.text(it) == "Enviar" })
            assertFalse(host.nodes().any { host.text(it) in setOf("Formato e legenda (opcional)", "Legenda (opcional)", "Sem música") })
            assertFalse(host.nodes().any { host.text(it).startsWith("Dia:") || host.text(it).startsWith("Hora:") })
            host.click("Música B")
            assertEquals(0, host.submissions)
            assertEquals("track-b", host.view.draft!!.configuration.musicTrackId)
            assertEquals(setOf(ImportTarget.REEL), host.view.draft!!.configuration.targets)
            assertTrue(host.view.draft!!.configuration.shareToFeed)
            host.click("Enviar")
            assertEquals(1, host.submissions); assertNull(host.capturedSchedule)
            assertEquals(0, host.schedules); assertEquals(0, host.previewRenders)
        } finally { host.close() }
    }
    @Test fun importedFileSendsChosenDayAndTimeInTheSameAction() {
        val host = Host(video = true)
        try {
            val day = java.time.LocalDate.now(java.time.ZoneId.of("America/Sao_Paulo")).plusDays(2)
            val dayButton = host.nodes().map(host::text).first { it.startsWith("Dia:") }
            host.click(dayButton)
            val dateDialog = ShadowDialog.getLatestDialog() as android.app.DatePickerDialog
            dateDialog.updateDate(day.year, day.monthValue - 1, day.dayOfMonth)
            dateDialog.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick(); host.idle()
            host.click("Hora: 09:00")
            val timeDialog = ShadowDialog.getLatestDialog() as android.app.TimePickerDialog
            timeDialog.updateTime(18, 45)
            timeDialog.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick(); host.idle()
            assertEquals(0, host.submissions)
            host.click("Enviar")
            assertEquals(ImportCalendarSchedule(day.toString(), "18:45"), host.capturedSchedule)
            assertEquals(1, host.submissions); assertEquals(0, host.schedules)
        } finally { host.close() }
    }
    @Test fun openingMusicForAnotherArtCannotSendAnOldDraft() {
        val host = Host(generated = true)
        try {
            host.view = host.view.copy(preparation = host.view.preparation!!.copy(generatedSourceIntent = null))
            host.idle()
            assertFalse(host.nodes().any { host.text(it) == "Enviar" })
            assertTrue(host.nodes().any { host.text(it).startsWith("Há outro arquivo em andamento") })
            assertEquals(0, host.submissions)
        } finally { host.close() }
    }
}
