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
    private inner class Fixture(scope: CoroutineScope, uploaded: Boolean = false) {
        var token = "synthetic-session"
        var transfers = 0; var submissions = 0; var oldActions = 0
        val transferRelease = CompletableDeferred<Unit>()
        var transferSucceeds = true
        var changedAfterUpload: (() -> Unit)? = null
        var state = GalleryImportState(f.owner, "runtime-draft", f.selection, f.config,
            phase = if (uploaded) ImportPhase.UPLOADED else ImportPhase.EDITING,
            upload = if (uploaded) ImportUploadProgress(ImportUploadTicket(f.uploadId, f.assetId, f.sourceSha, f.selection.byteCount), serverVerified = true) else null)
        lateinit var uploadChanged: (ImportUploadRunView) -> Unit
        lateinit var preparedChanged: (ImportPreparationRunView) -> Unit
        private val upload = object : GalleryImportUploadControl {
            override suspend fun restore() = ImportUploadRunView(state, ImportUploadRunStatus.PAUSED).also(uploadChanged)
            override suspend fun select(uri: String, configuration: ImportConfiguration) = restore()
            override suspend fun reselectSource(uri: String) = restore()
            override suspend fun transfer(): ImportUploadRunView {
                transfers++; transferRelease.await()
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
            override suspend fun restore() = ImportPreparationRunView(if (state.upload?.serverVerified == true)
                ImportPreparationRunStatus.AWAITING_REQUEST else ImportPreparationRunStatus.UPLOAD_REQUIRED, state).also(preparedChanged)
            override suspend fun configure(value: ImportConfiguration) = restore()
            override suspend fun request(): ImportPreparationRunView { oldActions++; return restore() }
            override suspend fun reconcileOnce() = restore()
            override suspend fun adoptGenerated(id: String, revision: Long) = restore()
            override suspend fun confirmPreview(value: ImportPreviewConfirmation): ImportPreparationRunView { oldActions++; return restore() }
            override suspend fun schedule(caption: String, at: Long, automatic: Boolean): ImportPreparationRunView { oldActions++; return restore() }
            override suspend fun reconcileScheduleOnce() = restore()
            override suspend fun finishScheduledDraft() = restore()
            override suspend fun submitToCalendar(caption: String): ImportPreparationRunView {
                submissions++
                assertTrue(state.upload!!.serverVerified)
                return ImportPreparationRunView(ImportPreparationRunStatus.CALENDAR_ACCEPTED,
                    calendarSubmissionReceipt = ImportCalendarSubmissionReceipt("d".repeat(40), f.assetId, f.uploadId,
                        "runtime-submission", "accepted", null, 0, "2026-09-24", "09:00", caption, null)).also(preparedChanged)
            }
            override fun pause() = Unit
            override fun invalidateSession() = Unit
        }
        val runtime = GalleryImportWorkflowRuntime(f.owner, token, { token },
            ImportCapabilities(true, f.owner, preparationEnabled = true, calendarSubmissionEnabled = true), scope,
            { _, changed -> uploadChanged = changed; upload }, { _, changed -> preparedChanged = changed; preparation })
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
