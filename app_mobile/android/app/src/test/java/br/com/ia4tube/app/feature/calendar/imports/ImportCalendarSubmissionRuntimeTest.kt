package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ImportCalendarSubmissionRuntimeTest {
    private val f = ImportPreparationTestData
    private inner class Fixture(scope: CoroutineScope, uploaded: Boolean = false, val beforeUpload: Boolean = false) {
        var token = "synthetic-session"
        var transfers = 0; var submissions = 0; var oldActions = 0
        val schedules = mutableListOf<ImportCalendarSchedule?>()
        val transferRelease = CompletableDeferred<Unit>()
        var transferSucceeds = true
        var changedAfterUpload: (() -> Unit)? = null
        var acceptanceSuccessful = true
        var transportReceived = false
        var intent: ImportCalendarSubmissionIntent? = null
        val actions = mutableListOf<String>()
        var state = GalleryImportState(f.owner, "runtime-draft",
            if (beforeUpload) f.selection.copy(kind = ImportMediaKind.VIDEO, mimeType = "video/mp4", durationMs = 16000) else f.selection,
            if (beforeUpload) ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL) else f.config,
            phase = if (uploaded) ImportPhase.UPLOADED else ImportPhase.EDITING,
            upload = if (uploaded) ImportUploadProgress(ImportUploadTicket(f.uploadId, f.assetId, f.sourceSha, f.selection.byteCount), serverVerified = true) else null)
        lateinit var uploadChanged: (ImportUploadRunView) -> Unit
        lateinit var preparedChanged: (ImportPreparationRunView) -> Unit
        private val upload = object : GalleryImportUploadControl {
            override suspend fun restore() = ImportUploadRunView(state, ImportUploadRunStatus.PAUSED).also(uploadChanged)
            override suspend fun select(uri: String, configuration: ImportConfiguration) = restore()
            override suspend fun reselectSource(uri: String) = restore()
            override suspend fun reserve(): ImportUploadRunView {
                actions.add("start")
                state = state.copy(phase = ImportPhase.UPLOADING, upload = state.upload ?: ImportUploadProgress(
                    ImportUploadTicket(f.uploadId, f.assetId, f.sourceSha, state.selection.byteCount,
                        chunkBytes = state.selection.byteCount.toInt(), singleRequestVideo = true)))
                return restore()
            }
            override suspend fun transfer(): ImportUploadRunView {
                transfers++; transferRelease.await()
                if (beforeUpload) {
                    assertTrue(acceptanceSuccessful); assertNotNull(intent)
                    actions.add("put")
                    transportReceived = transferSucceeds
                    changedAfterUpload?.invoke()
                    return ImportUploadRunView(state, ImportUploadRunStatus.RECONCILIATION_REQUIRED,
                        transportReceived = transportReceived).also(uploadChanged)
                }
                if (transferSucceeds) state = state.copy(phase = ImportPhase.UPLOADED,
                    upload = ImportUploadProgress(ImportUploadTicket(f.uploadId, f.assetId, f.sourceSha, f.selection.byteCount), serverVerified = true))
                changedAfterUpload?.invoke()
                return ImportUploadRunView(state, if (transferSucceeds) ImportUploadRunStatus.UPLOADED else ImportUploadRunStatus.PAUSED).also(uploadChanged)
            }
            override suspend fun reconcileOnce() = restore()
            override suspend fun requestCancel() = restore()
            override suspend fun discardCancelledDraft() = restore()
            override fun pause() = Unit
            override fun invalidateSession() = Unit
        }
        private val preparation = object : GalleryImportPreparationControl {
            override suspend fun restore(): ImportPreparationRunView {
                if (beforeUpload && intent != null) {
                    if (!transportReceived) return ImportPreparationRunView(ImportPreparationRunStatus.CALENDAR_AWAITING_UPLOAD,
                        state, calendarSubmissionIntent = intent).also(preparedChanged)
                    actions.add("lookup")
                    return ImportPreparationRunView(ImportPreparationRunStatus.CALENDAR_ACCEPTED,
                        calendarSubmissionReceipt = ImportCalendarSubmissionReceipt("d".repeat(40), f.assetId, f.uploadId,
                            intent!!.idempotencyKey, "accepted", null, 0, "2026-11-03", "14:00", intent!!.caption, null, true)).also(preparedChanged)
                }
                return ImportPreparationRunView(if (state.upload?.serverVerified == true)
                ImportPreparationRunStatus.AWAITING_REQUEST else ImportPreparationRunStatus.UPLOAD_REQUIRED, state).also(preparedChanged)
            }
            override suspend fun configure(value: ImportConfiguration) = restore()
            override suspend fun request(): ImportPreparationRunView { oldActions++; return restore() }
            override suspend fun reconcileOnce() = restore()
            override suspend fun adoptGenerated(id: String, revision: Long) = restore()
            override suspend fun confirmPreview(value: ImportPreviewConfirmation): ImportPreparationRunView { oldActions++; return restore() }
            override suspend fun schedule(caption: String, at: Long, automatic: Boolean): ImportPreparationRunView { oldActions++; return restore() }
            override suspend fun reconcileScheduleOnce() = restore()
            override suspend fun finishScheduledDraft() = restore()
            override suspend fun submitToCalendar(caption: String) = submitToCalendar(caption, null)
            override suspend fun submitBeforeUpload(caption: String, schedule: ImportCalendarSchedule?): ImportPreparationRunView {
                assertNotNull(state.upload); assertFalse(state.upload!!.serverVerified)
                if (intent == null) {
                    submissions++; actions.add("accept")
                    intent = ImportCalendarSubmissionIntent("runtime-submission", state.revision, 0, caption, schedule, true)
                    schedules.add(schedule)
                }
                return ImportPreparationRunView(if (acceptanceSuccessful) ImportPreparationRunStatus.CALENDAR_AWAITING_UPLOAD else
                    ImportPreparationRunStatus.CALENDAR_RECONCILIATION, state, calendarSubmissionIntent = intent).also(preparedChanged)
            }
            override suspend fun submitToCalendar(caption: String, schedule: ImportCalendarSchedule?): ImportPreparationRunView {
                submissions++
                schedules.add(schedule)
                assertTrue(state.upload!!.serverVerified)
                return ImportPreparationRunView(ImportPreparationRunStatus.CALENDAR_ACCEPTED,
                    calendarSubmissionReceipt = ImportCalendarSubmissionReceipt("d".repeat(40), f.assetId, f.uploadId,
                        "runtime-submission", "accepted", null, 0, schedule?.date ?: "2026-09-24", schedule?.time ?: "09:00", caption, null)).also(preparedChanged)
            }
            override fun pause() = Unit
            override fun invalidateSession() = Unit
        }
        val runtime = GalleryImportWorkflowRuntime(f.owner, token, { token },
            ImportCapabilities(true, f.owner, preparationEnabled = true, calendarSubmissionEnabled = true,
                beforeUploadSubmissionEnabled = beforeUpload), scope,
            { _, changed -> uploadChanged = changed; upload }, { _, changed -> preparedChanged = changed; preparation })
    }

    @Test fun newVideoRecordsSameCalendarIntentBeforePutAndHandoffDoesNotWaitForInspection() = runTest {
        val fixture = Fixture(this, beforeUpload = true)
        fixture.runtime.start(); advanceUntilIdle()
        val chosen = ImportCalendarSchedule("2026-11-03", "14:00")
        fixture.runtime.addToCalendar("Frozen", chosen); runCurrent()
        assertEquals(listOf("start", "accept"), fixture.actions)
        assertNotNull(fixture.runtime.state.value.draft)
        assertNull(fixture.runtime.state.value.preparation!!.calendarSubmissionReceipt)
        fixture.runtime.addToCalendar("Duplicate tap", null)
        fixture.transferRelease.complete(Unit); advanceUntilIdle()
        assertEquals(listOf("start", "accept", "put", "lookup"), fixture.actions)
        assertEquals(1, fixture.submissions); assertEquals(1, fixture.transfers)
        assertEquals(listOf(chosen), fixture.schedules); assertEquals("Frozen", fixture.intent!!.caption)
        assertFalse(fixture.state.upload!!.serverVerified)
        assertEquals("accepted", fixture.runtime.state.value.preparation!!.calendarSubmissionReceipt!!.state)
        assertNull(fixture.runtime.state.value.draft)
    }

    @Test fun missingAcceptanceStopsBeforeAnyVideoTransfer() = runTest {
        val fixture = Fixture(this, beforeUpload = true).apply { acceptanceSuccessful = false }
        fixture.runtime.start(); advanceUntilIdle()
        fixture.runtime.addToCalendar("Saved", null); advanceUntilIdle()
        assertEquals(listOf("start", "accept"), fixture.actions)
        assertEquals(0, fixture.transfers); assertNotNull(fixture.runtime.state.value.draft)
    }

    @Test fun failedTransferRetainsAcceptedIntentAndContinuationCannotReplaceCaptionOrDate() = runTest {
        val fixture = Fixture(this, beforeUpload = true).apply { transferSucceeds = false; transferRelease.complete(Unit) }
        fixture.runtime.start(); advanceUntilIdle()
        val chosen = ImportCalendarSchedule("2026-11-03", "14:00")
        fixture.runtime.addToCalendar("Saved", chosen); advanceUntilIdle()
        assertNotNull(fixture.runtime.state.value.draft)
        fixture.transferSucceeds = true
        fixture.runtime.addToCalendar("Wrong replacement", null); advanceUntilIdle()
        assertEquals(1, fixture.submissions); assertEquals("Saved", fixture.intent!!.caption); assertEquals(chosen, fixture.intent!!.schedule)
        assertNull(fixture.runtime.state.value.draft)
    }

    @Test fun oneActionChainsVerifiedUploadAndAcceptanceWithoutLegacyActionsOrDuplicateTap() = runTest {
        val fixture = Fixture(this); fixture.runtime.start(); advanceUntilIdle()
        fixture.runtime.addToCalendar(""); runCurrent()
        fixture.runtime.addToCalendar(""); runCurrent()
        assertEquals(1, fixture.transfers); assertEquals(0, fixture.submissions)
        fixture.transferRelease.complete(Unit); advanceUntilIdle()
        assertEquals(1, fixture.submissions); assertEquals(0, fixture.oldActions)
        assertEquals("accepted", fixture.runtime.state.value.preparation!!.calendarSubmissionReceipt!!.state)
        assertNull(fixture.runtime.state.value.draft)
    }

    @Test fun verifiedOldUploadIsUsedWithoutSendingBytesAgain() = runTest {
        val fixture = Fixture(this, uploaded = true); fixture.runtime.start(); advanceUntilIdle()
        fixture.runtime.addToCalendar(""); advanceUntilIdle()
        assertEquals(0, fixture.transfers); assertEquals(1, fixture.submissions); assertEquals(0, fixture.oldActions)
        assertEquals(listOf<ImportCalendarSchedule?>(null), fixture.schedules)
    }

    @Test fun chosenScheduleSurvivesUploadAndDuplicateTapCannotReplaceIt() = runTest {
        val fixture = Fixture(this); fixture.runtime.start(); advanceUntilIdle()
        val chosen = ImportCalendarSchedule("2026-09-28", "14:35")
        fixture.runtime.addToCalendar("Saved caption", chosen); runCurrent()
        fixture.runtime.addToCalendar("Different caption", ImportCalendarSchedule("2026-10-05", "18:30")); runCurrent()
        assertEquals(1, fixture.transfers); assertEquals(0, fixture.submissions)
        fixture.transferRelease.complete(Unit); advanceUntilIdle()
        assertEquals(listOf(chosen), fixture.schedules)
        assertEquals(1, fixture.submissions); assertEquals(0, fixture.oldActions)
        val receipt = fixture.runtime.state.value.preparation!!.calendarSubmissionReceipt!!
        assertEquals(chosen.date, receipt.date); assertEquals(chosen.time, receipt.time)
        assertEquals("Saved caption", receipt.caption)
    }

    @Test fun incompleteUploadCannotSubmitAnUnverifiedSource() = runTest {
        val fixture = Fixture(this); fixture.transferSucceeds = false
        fixture.runtime.start(); advanceUntilIdle(); fixture.transferRelease.complete(Unit)
        fixture.runtime.addToCalendar(""); advanceUntilIdle()
        assertEquals(1, fixture.transfers); assertEquals(0, fixture.submissions)
        assertNotNull(fixture.runtime.state.value.draft)
    }

    @Test fun changedSessionBetweenUploadAndAcceptancePreventsCrossSessionSubmission() = runTest {
        val fixture = Fixture(this); fixture.changedAfterUpload = { fixture.token = "different-session" }
        fixture.runtime.start(); advanceUntilIdle(); fixture.transferRelease.complete(Unit)
        fixture.runtime.addToCalendar(""); advanceUntilIdle()
        assertEquals(1, fixture.transfers); assertEquals(0, fixture.submissions)
        assertFalse(fixture.runtime.state.value.sessionValid)
    }
}
