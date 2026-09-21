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
class GalleryImportWorkflowRuntimePickerRaceTest {
    private val owner = ImportOwner("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    private val capabilities = ImportCapabilities(true, owner, preparationEnabled = true, schedulingEnabled = true)
    private val image = ImportSelection("selected", ImportMediaKind.IMAGE, "image/jpeg", 10, 10, 10, null, "a".repeat(64))
    private val imageConfiguration = ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE)
    private fun existingDraft() = GalleryImportState(owner, "draft", image, imageConfiguration)

    private inner class Fixture(scope: CoroutineScope) {
        var token = "session-token"
        var restoreCalls = 0
        var preparationRestoreCalls = 0
        var selectCalls = 0
        var reselectCalls = 0
        var transferCalls = 0
        var uploadPauses = 0
        var uploadInvalidations = 0
        var preparationInvalidations = 0
        var failRestore = false
        var selectedUri: String? = null
        var reselectedUri: String? = null
        var selectedConfiguration: ImportConfiguration? = null
        var restoredUpload = ImportUploadRunView()
        var restoredPreparation = ImportPreparationRunView(ImportPreparationRunStatus.EMPTY)
        var restoreRelease = CompletableDeferred<Unit>()
        var transferRelease = CompletableDeferred<Unit>()
        lateinit var uploadChanged: (ImportUploadRunView) -> Unit
        lateinit var preparationChanged: (ImportPreparationRunView) -> Unit
        lateinit var runtimeOwnerProvider: () -> ImportOwner?

        private val upload = object : GalleryImportUploadControl {
            override suspend fun restore(): ImportUploadRunView {
                restoreCalls++
                restoreRelease.await()
                if (failRestore) error("synthetic restore failure")
                return restoredUpload.also(uploadChanged)
            }
            override suspend fun select(uri: String, configuration: ImportConfiguration): ImportUploadRunView {
                selectCalls++
                selectedUri = uri
                selectedConfiguration = configuration
                return ImportUploadRunView(status = ImportUploadRunStatus.PAUSED).also(uploadChanged)
            }
            override suspend fun reselectSource(uri: String): ImportUploadRunView {
                reselectCalls++
                reselectedUri = uri
                return ImportUploadRunView(status = ImportUploadRunStatus.PAUSED).also(uploadChanged)
            }
            override suspend fun transfer(): ImportUploadRunView {
                transferCalls++
                transferRelease.await()
                return ImportUploadRunView(status = ImportUploadRunStatus.PAUSED).also(uploadChanged)
            }
            override suspend fun reconcileOnce() = ImportUploadRunView()
            override suspend fun requestCancel() = ImportUploadRunView()
            override suspend fun discardCancelledDraft() = ImportUploadRunView()
            override fun pause() { uploadPauses++ }
            override fun invalidateSession() { uploadInvalidations++ }
        }

        private val preparation = object : GalleryImportPreparationControl {
            private fun empty() = ImportPreparationRunView(ImportPreparationRunStatus.EMPTY).also(preparationChanged)
            override suspend fun restore(): ImportPreparationRunView {
                preparationRestoreCalls++
                return restoredPreparation.also(preparationChanged)
            }
            override suspend fun configure(value: ImportConfiguration) = empty()
            override suspend fun request() = empty()
            override suspend fun reconcileOnce() = empty()
            override suspend fun adoptGenerated(id: String, revision: Long) = empty()
            override suspend fun confirmPreview(value: ImportPreviewConfirmation) = empty()
            override suspend fun schedule(caption: String, at: Long, automatic: Boolean) = empty()
            override suspend fun reconcileScheduleOnce() = empty()
            override suspend fun finishScheduledDraft() = empty()
            override fun pause() = Unit
            override fun invalidateSession() { preparationInvalidations++ }
        }

        val runtime = GalleryImportWorkflowRuntime(owner, token, { token }, capabilities, scope,
            { ownerProvider, changed -> runtimeOwnerProvider = ownerProvider; uploadChanged = changed; upload },
            { _, changed -> preparationChanged = changed; preparation })
    }

    @Test fun openDocumentResultDuringRestoreIsConsumedOnceAfterRestoreWithoutTransfer() = runTest {
        val fixture = Fixture(this)
        fixture.runtime.start()
        runCurrent()
        assertTrue(fixture.runtime.state.value.busy)
        assertEquals(1, fixture.restoreCalls)

        fixture.runtime.select(1L, "content://authorized/first-photo", ImportMediaKind.IMAGE)
        fixture.runtime.select(2L, "content://authorized/duplicate-photo", ImportMediaKind.IMAGE)
        runCurrent()
        assertEquals(0, fixture.selectCalls)

        fixture.restoreRelease.complete(Unit)
        advanceUntilIdle()

        assertEquals(1, fixture.selectCalls)
        assertEquals("content://authorized/first-photo", fixture.selectedUri)
        assertEquals(0, fixture.transferCalls)
        assertEquals(ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE), fixture.selectedConfiguration)
        assertFalse(fixture.runtime.state.value.busy)
        fixture.runtime.select(2L, "content://authorized/duplicate-photo", ImportMediaKind.IMAGE)
        advanceUntilIdle()
        assertEquals(1, fixture.selectCalls)
    }

    @Test fun resultDeliveredBeforeForegroundWaitsForAuthoritativeRestoreAndIsNotRepeatedOnResume() = runTest {
        val fixture = Fixture(this)
        fixture.runtime.select(1L, "content://authorized/video", ImportMediaKind.VIDEO)
        runCurrent()
        assertEquals(0, fixture.selectCalls)

        fixture.runtime.start()
        runCurrent()
        assertEquals(1, fixture.restoreCalls)
        assertEquals(0, fixture.selectCalls)
        fixture.restoreRelease.complete(Unit)
        advanceUntilIdle()
        assertEquals(1, fixture.selectCalls)
        assertEquals(ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL, shareToFeed = true),
            fixture.selectedConfiguration)
        assertEquals(0, fixture.transferCalls)

        fixture.runtime.pause()
        fixture.runtime.start()
        advanceUntilIdle()
        assertEquals(2, fixture.restoreCalls)
        assertEquals(1, fixture.selectCalls)
        assertEquals(0, fixture.transferCalls)
    }

    @Test fun resultReturningWhileStoppedSurvivesUntilNextSuccessfulForegroundRestore() = runTest {
        val fixture = Fixture(this)
        fixture.runtime.start()
        runCurrent()
        fixture.runtime.pause()
        fixture.runtime.select(1L, "content://authorized/stopped-photo", ImportMediaKind.IMAGE)
        fixture.restoreRelease.complete(Unit)
        advanceUntilIdle()
        assertEquals(0, fixture.selectCalls)

        fixture.restoreRelease = CompletableDeferred()
        fixture.runtime.start()
        runCurrent()
        assertEquals(2, fixture.restoreCalls)
        fixture.restoreRelease.complete(Unit)
        advanceUntilIdle()
        assertEquals(1, fixture.selectCalls)
        assertEquals("content://authorized/stopped-photo", fixture.selectedUri)
        assertEquals(0, fixture.transferCalls)
    }

    @Test fun stoppedRestoreReturningPausedWithoutDraftRetainsResultForNextStart() = runTest {
        val fixture = Fixture(this)
        fixture.restoredUpload = ImportUploadRunView(status = ImportUploadRunStatus.PAUSED)
        fixture.runtime.start()
        runCurrent()
        fixture.runtime.pause()
        fixture.runtime.select(1L, "content://authorized/paused-restore-photo", ImportMediaKind.IMAGE)
        // A fast ON_START sees the still-running restore as busy. Its PAUSED/no-draft result is not
        // authoritative evidence of a conflict and must not discard the ActivityResult.
        fixture.runtime.start()
        fixture.restoreRelease.complete(Unit)
        advanceUntilIdle()
        assertEquals(0, fixture.selectCalls)
        assertTrue(fixture.runtime.state.value.pickerResultPending)
        assertFalse(fixture.runtime.state.value.initialized)

        fixture.restoredUpload = ImportUploadRunView()
        fixture.restoreRelease = CompletableDeferred()
        fixture.runtime.start()
        runCurrent()
        fixture.restoreRelease.complete(Unit)
        advanceUntilIdle()
        assertEquals(1, fixture.selectCalls)
        assertEquals("content://authorized/paused-restore-photo", fixture.selectedUri)
        assertEquals(0, fixture.transferCalls)
    }

    @Test fun failedRestoreKeepsOneResultFailClosedUntilExplicitSuccessfulRestore() = runTest {
        val fixture = Fixture(this)
        fixture.failRestore = true
        fixture.runtime.start()
        runCurrent()
        fixture.runtime.select(1L, "content://authorized/photo-after-retry", ImportMediaKind.IMAGE)
        fixture.restoreRelease.complete(Unit)
        advanceUntilIdle()
        assertEquals(0, fixture.selectCalls)
        assertNotNull(fixture.runtime.state.value.error)
        assertTrue(fixture.runtime.state.value.pickerResultPending)
        assertFalse(fixture.runtime.state.value.initialized)
        val retryUi = fixture.runtime.state.value.let {
            galleryImportUploadPresentation(it.upload, it.busy, it.foreground, it.initialized, it.sessionValid)
        }
        assertEquals(setOf(GalleryImportUploadAction.RECONCILE), retryUi.actions)
        fixture.runtime.select(2L, "content://authorized/later-photo", ImportMediaKind.IMAGE)

        fixture.failRestore = false
        fixture.restoreRelease = CompletableDeferred<Unit>().apply { complete(Unit) }
        fixture.runtime.restore()
        advanceUntilIdle()
        assertEquals(1, fixture.selectCalls)
        assertEquals("content://authorized/photo-after-retry", fixture.selectedUri)
        assertEquals(0, fixture.transferCalls)
    }

    @Test fun sessionChangeOrDisposeDropsDeferredResultAndCannotBeRevived() = runTest {
        val changed = Fixture(this)
        changed.runtime.start()
        runCurrent()
        changed.runtime.select(1L, "content://old-owner/photo", ImportMediaKind.IMAGE)
        changed.token = "different-session"
        changed.restoreRelease.complete(Unit)
        advanceUntilIdle()
        assertEquals(0, changed.selectCalls)
        assertFalse(changed.runtime.state.value.sessionValid)
        assertTrue(changed.uploadInvalidations > 0)
        assertTrue(changed.preparationInvalidations > 0)

        val disposed = Fixture(this)
        disposed.runtime.start()
        runCurrent()
        disposed.runtime.select(1L, "content://disposed/photo", ImportMediaKind.IMAGE)
        disposed.runtime.dispose()
        disposed.restoreRelease.complete(Unit)
        advanceUntilIdle()
        assertEquals(0, disposed.selectCalls)
        assertFalse(disposed.runtime.state.value.sessionValid)
    }

    @Test fun ownerGateMakesTransientTokenMismatchIrreversibleForThisRuntime() = runTest {
        val fixture = Fixture(this)
        fixture.token = "different-session"
        assertNull(fixture.runtimeOwnerProvider())
        fixture.token = "session-token"
        assertNull(fixture.runtimeOwnerProvider())
        fixture.runtime.start()
        advanceUntilIdle()
        assertEquals(0, fixture.restoreCalls)
        assertFalse(fixture.runtime.state.value.sessionValid)
    }

    @Test fun deferredReselectionStaysReselectionAndNeverCreatesOrTransfers() = runTest {
        val fixture = Fixture(this)
        fixture.restoredUpload = ImportUploadRunView(existingDraft(), ImportUploadRunStatus.PAUSED)
        fixture.restoredPreparation = ImportPreparationRunView(ImportPreparationRunStatus.UPLOAD_REQUIRED, existingDraft())
        fixture.runtime.start()
        runCurrent()
        fixture.runtime.reselect(1L, "content://authorized/same-original")
        fixture.restoreRelease.complete(Unit)
        advanceUntilIdle()

        assertEquals(1, fixture.reselectCalls)
        assertEquals("content://authorized/same-original", fixture.reselectedUri)
        assertEquals(0, fixture.selectCalls)
        assertEquals(0, fixture.transferCalls)
    }

    @Test fun authoritativeNonReselectableDraftRejectsPendingReselectionInsteadOfRetainingForever() = runTest {
        val fixture = Fixture(this)
        val cancelled = existingDraft().copy(phase = ImportPhase.CANCELLED)
        fixture.restoredUpload = ImportUploadRunView(cancelled, ImportUploadRunStatus.CANCELLED)
        fixture.restoredPreparation = ImportPreparationRunView(ImportPreparationRunStatus.UPLOAD_REQUIRED, cancelled)
        fixture.runtime.start()
        runCurrent()
        fixture.runtime.reselect(1L, "content://authorized/obsolete-reselection")
        fixture.restoreRelease.complete(Unit)
        advanceUntilIdle()

        assertEquals(0, fixture.reselectCalls)
        assertFalse(fixture.runtime.state.value.pickerResultPending)
        assertTrue(fixture.runtime.state.value.initialized)
        assertNotNull(fixture.runtime.state.value.error)
        assertEquals(0, fixture.transferCalls)
    }

    @Test fun pickerResultDuringDifferentBusyActionFailsClosedInsteadOfQueuingReplacement() = runTest {
        val fixture = Fixture(this)
        fixture.restoreRelease.complete(Unit)
        fixture.runtime.start()
        advanceUntilIdle()
        fixture.runtime.transfer()
        runCurrent()
        assertEquals(1, fixture.transferCalls)
        assertTrue(fixture.runtime.state.value.busy)

        fixture.runtime.select(1L, "content://ambiguous/photo", ImportMediaKind.IMAGE)
        fixture.transferRelease.complete(Unit)
        advanceUntilIdle()
        assertEquals(0, fixture.selectCalls)
        assertEquals(1, fixture.transferCalls)
    }
}
