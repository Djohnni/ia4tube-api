package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.Executors

@OptIn(ExperimentalCoroutinesApi::class)
class GalleryImportUploadPresenterTest {
    private val owner = ImportOwner("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    private val image = ImportSelection("file-1", ImportMediaKind.IMAGE, "image/png", 12, 10, 10, null, "a".repeat(64))
    private val photoConfig = ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE)
    private fun draft(phase: ImportPhase = ImportPhase.EDITING, verified: Boolean = false) = GalleryImportState(owner, "draft-1", image,
        photoConfig, phase = phase, upload = if (phase == ImportPhase.EDITING) null else ImportUploadProgress(
            ImportUploadTicket("upload-1", "asset-1", image.sha256, image.byteCount), serverVerified = verified))
    private fun view(phase: ImportPhase = ImportPhase.EDITING, status: ImportUploadRunStatus = ImportUploadRunStatus.PAUSED,
                     verified: Boolean = false) = ImportUploadRunView(draft(phase, verified), status, totalBytes = 12)

    private inner class Fixture(scope: CoroutineScope) {
        var activeOwner: ImportOwner? = owner
        var token = "synthetic-token-not-for-display"
        lateinit var observer: (ImportUploadRunView) -> Unit
        var current = ImportUploadRunView()
        var restoring: (suspend () -> ImportUploadRunView)? = null
        var transferring: (suspend () -> ImportUploadRunView)? = null
        var restoreCalls = 0
        var selectCalls = 0
        var transferCalls = 0
        var reconcileCalls = 0
        var cancelCalls = 0
        var discardCalls = 0
        var reselectCalls = 0
        var pauses = 0
        var invalidations = 0
        var selectionConfig: ImportConfiguration? = null
        val control = object : GalleryImportUploadControl {
            override suspend fun restore(): ImportUploadRunView { restoreCalls++; return restoring?.invoke() ?: current }
            override suspend fun select(uri: String, configuration: ImportConfiguration): ImportUploadRunView {
                selectCalls++; selectionConfig = configuration
                current = view().let { it.copy(state = it.state!!.copy(configuration = configuration)) }; return current
            }
            override suspend fun reselectSource(uri: String): ImportUploadRunView { reselectCalls++; return current }
            override suspend fun transfer(): ImportUploadRunView { transferCalls++; return transferring?.invoke() ?: current }
            override suspend fun reconcileOnce(): ImportUploadRunView { reconcileCalls++; return current }
            override suspend fun requestCancel(): ImportUploadRunView { cancelCalls++; current = view(ImportPhase.CANCELLED, ImportUploadRunStatus.CANCELLED); return current }
            override suspend fun discardCancelledDraft(): ImportUploadRunView { discardCalls++; current = ImportUploadRunView(); return current }
            override fun pause() { pauses++ }
            override fun invalidateSession() { invalidations++ }
        }
        val presenter = GalleryImportUploadPresenter(owner, token, { activeOwner }, { token }, scope) { callback ->
            observer = callback; control
        }
        fun choosePhoto() = presenter.select("content://synthetic/private-image", ImportMediaKind.IMAGE)
    }

    @Test fun openingOnlyReadsAndSelectingPhotoDoesNotSendOrPublish() = runTest {
        val f = Fixture(this); f.presenter.onStart(); advanceUntilIdle()
        assertEquals(1, f.restoreCalls); assertEquals(0, f.transferCalls)
        assertEquals(setOf(GalleryImportUploadAction.SELECT_PHOTO, GalleryImportUploadAction.SELECT_VIDEO), f.presenter.state.value.actions)
        f.choosePhoto(); advanceUntilIdle()
        assertEquals(1, f.selectCalls); assertEquals(0, f.transferCalls)
        assertEquals(photoConfig, f.selectionConfig)
        assertTrue(GalleryImportUploadAction.SEND_FILE in f.presenter.state.value.actions)
        assertTrue(f.presenter.state.value.detail.contains("não publica nem programa"))
        f.presenter.runAction(GalleryImportUploadAction.SEND_FILE); advanceUntilIdle()
        assertEquals(1, f.transferCalls)
    }

    @Test fun selectingVideoUsesOriginalAudioAndReelWithoutPretendingLicensedMusic() = runTest {
        val f = Fixture(this); f.presenter.onStart(); advanceUntilIdle()
        f.presenter.select("content://synthetic/private-video", ImportMediaKind.VIDEO); advanceUntilIdle()
        assertEquals(setOf(ImportTarget.REEL), f.selectionConfig!!.targets)
        assertEquals(ImportAudioMode.ORIGINAL, f.selectionConfig!!.audioMode)
        assertNull(f.selectionConfig!!.musicTrackId); assertTrue(f.selectionConfig!!.shareToFeed)
        assertEquals(0, f.transferCalls)
    }

    @Test fun duplicateSendAndOtherActionsAreBlockedWhileOperationIsBusy() = runTest {
        val f = Fixture(this); f.presenter.onStart(); advanceUntilIdle(); f.choosePhoto(); advanceUntilIdle()
        val release = CompletableDeferred<Unit>(); f.transferring = { release.await(); f.current }
        f.presenter.runAction(GalleryImportUploadAction.SEND_FILE)
        f.presenter.runAction(GalleryImportUploadAction.SEND_FILE)
        f.presenter.runAction(GalleryImportUploadAction.CANCEL); runCurrent()
        assertEquals(1, f.transferCalls); assertEquals(0, f.cancelCalls)
        assertEquals(setOf(GalleryImportUploadAction.PAUSE), f.presenter.state.value.actions)
        f.presenter.runAction(GalleryImportUploadAction.PAUSE); assertEquals(1, f.pauses)
        release.complete(Unit); advanceUntilIdle(); assertFalse(f.presenter.state.value.busy)
    }

    @Test fun stopPausesAndResumeNeverAutomaticallyTransfersOrPollsAgain() = runTest {
        val f = Fixture(this); f.presenter.onStart(); advanceUntilIdle(); f.choosePhoto(); advanceUntilIdle()
        f.presenter.onStop(); assertEquals(1, f.pauses); assertTrue(f.presenter.state.value.actions.isEmpty())
        f.presenter.runAction(GalleryImportUploadAction.SEND_FILE); advanceUntilIdle(); assertEquals(0, f.transferCalls)
        f.presenter.onStart(); advanceUntilIdle()
        assertEquals(1, f.restoreCalls); assertEquals(0, f.reconcileCalls); assertEquals(0, f.transferCalls)
        assertTrue(GalleryImportUploadAction.SEND_FILE in f.presenter.state.value.actions)
    }

    @Test fun stopBeforeQueuedSelectionDoesNotInspectOrTransfer() = runTest {
        val f = Fixture(this); f.presenter.onStart(); advanceUntilIdle()
        f.choosePhoto(); f.presenter.onStop(); advanceUntilIdle()
        assertEquals(0, f.selectCalls); assertEquals(0, f.transferCalls)
    }

    @Test fun completedUploadIsExplicitlyNotPreparedOrScheduledAndCannotBeCancelledOrDiscarded() = runTest {
        val f = Fixture(this); f.current = view(ImportPhase.UPLOADED, ImportUploadRunStatus.UPLOADED, true)
        f.presenter.onStart(); advanceUntilIdle()
        val state = f.presenter.state.value
        assertEquals("Arquivo enviado — aguardando preparo", state.title)
        assertTrue(state.detail.contains("não está programado nem publicado"))
        assertEquals(setOf(GalleryImportUploadAction.RECONCILE), state.actions)
        assertEquals(1f, state.confirmedProgress)
        f.presenter.runAction(GalleryImportUploadAction.SEND_FILE); f.presenter.runAction(GalleryImportUploadAction.CANCEL)
        f.presenter.runAction(GalleryImportUploadAction.DISCARD_CANCELLED); advanceUntilIdle()
        assertEquals(0, f.transferCalls); assertEquals(0, f.cancelCalls); assertEquals(0, f.discardCalls)
    }

    @Test fun uncertainStartOrVerificationOnlyReconcilesSameDraft() = runTest {
        val f = Fixture(this); f.current = view(ImportPhase.VERIFYING, ImportUploadRunStatus.RECONCILIATION_REQUIRED)
        f.presenter.onStart(); advanceUntilIdle()
        assertEquals(setOf(GalleryImportUploadAction.RECONCILE), f.presenter.state.value.actions)
        assertFalse(f.presenter.state.value.title.contains("Arquivo enviado"))
        f.presenter.runAction(GalleryImportUploadAction.RECONCILE); advanceUntilIdle()
        assertEquals(1, f.reconcileCalls); assertEquals(0, f.transferCalls); assertEquals(0, f.selectCalls)
    }

    @Test fun cancelPendingCannotResumeAndOnlyConfirmedCancellationEnablesLocalDiscard() = runTest {
        val f = Fixture(this); f.current = view(ImportPhase.CANCEL_PENDING, ImportUploadRunStatus.CANCEL_REQUESTED)
        f.presenter.onStart(); advanceUntilIdle()
        assertEquals(setOf(GalleryImportUploadAction.RECONCILE), f.presenter.state.value.actions)
        f.presenter.runAction(GalleryImportUploadAction.DISCARD_CANCELLED); advanceUntilIdle(); assertEquals(0, f.discardCalls)
        f.current = view(ImportPhase.CANCELLED, ImportUploadRunStatus.CANCELLED); f.observer(f.current)
        assertEquals(setOf(GalleryImportUploadAction.DISCARD_CANCELLED), f.presenter.state.value.actions)
        f.presenter.runAction(GalleryImportUploadAction.DISCARD_CANCELLED); advanceUntilIdle()
        assertEquals(1, f.discardCalls); assertTrue(GalleryImportUploadAction.SELECT_PHOTO in f.presenter.state.value.actions)
    }

    @Test fun sourcePermissionFailureOnlyReselectsSameOriginalInsteadOfCreatingReplacement() = runTest {
        val f = Fixture(this); f.current = view(ImportPhase.UPLOADING, ImportUploadRunStatus.ATTENTION).copy(errorCode = "import_source_unavailable")
        f.presenter.onStart(); advanceUntilIdle()
        assertTrue(GalleryImportUploadAction.RESELECT_SOURCE in f.presenter.state.value.actions)
        assertFalse(GalleryImportUploadAction.SELECT_PHOTO in f.presenter.state.value.actions)
        f.presenter.reselect("content://synthetic/reselected"); advanceUntilIdle()
        assertEquals(1, f.reselectCalls); assertEquals(0, f.selectCalls); assertEquals(0, f.transferCalls)
    }

    @Test fun oldOwnerOrTokenCallbacksNeverReachPresentationAfterSessionChange() = runTest {
        val f = Fixture(this); f.presenter.onStart(); advanceUntilIdle(); f.choosePhoto(); advanceUntilIdle()
        f.activeOwner = owner.copy(companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc")
        f.observer(view(ImportPhase.UPLOADED, ImportUploadRunStatus.UPLOADED, true))
        assertEquals("Sessão alterada", f.presenter.state.value.title); assertNull(f.presenter.state.value.selectedSummary)
        assertTrue(f.presenter.state.value.actions.isEmpty())
        f.presenter.runAction(GalleryImportUploadAction.SEND_FILE); advanceUntilIdle(); assertEquals(0, f.transferCalls)
        f.activeOwner = owner; f.observer(view())
        assertEquals("Sessão alterada", f.presenter.state.value.title)
        val sameOwner = Fixture(this); sameOwner.presenter.onStart(); advanceUntilIdle(); sameOwner.choosePhoto(); advanceUntilIdle()
        sameOwner.token = "new-synthetic-token"; sameOwner.presenter.invalidateSession()
        sameOwner.observer(view(ImportPhase.UPLOADED, ImportUploadRunStatus.UPLOADED, true))
        assertEquals("Sessão alterada", sameOwner.presenter.state.value.title); assertEquals(1, sameOwner.invalidations)
        assertFalse(sameOwner.presenter.state.value.toString().contains("token"))
    }

    @Test fun disposedPresenterPausesInvalidatesAndRejectsLatePickerResultAndCallbacks() = runTest {
        val f = Fixture(this); f.presenter.onStart(); advanceUntilIdle(); f.presenter.dispose()
        f.choosePhoto(); f.observer(view()); advanceUntilIdle()
        assertEquals(1, f.pauses); assertEquals(1, f.invalidations); assertEquals(0, f.selectCalls)
        assertEquals("Sessão alterada", f.presenter.state.value.title)
        assertNull(f.presenter.state.value.selectedSummary)
    }

    @Test fun explicitInvalidationCannotBeReversedByCallbackWithUnchangedProviders() = runTest {
        val f = Fixture(this); f.presenter.onStart(); advanceUntilIdle(); f.choosePhoto(); advanceUntilIdle()
        f.presenter.invalidateSession()
        f.observer(view(ImportPhase.UPLOADED, ImportUploadRunStatus.UPLOADED, true))
        f.presenter.onStop(); f.presenter.onStart(); f.presenter.runAction(GalleryImportUploadAction.RECONCILE)
        advanceUntilIdle()
        assertEquals("Sessão alterada", f.presenter.state.value.title); assertNull(f.presenter.state.value.selectedSummary)
        assertEquals(1, f.restoreCalls); assertEquals(0, f.reconcileCalls); assertTrue(f.presenter.state.value.actions.isEmpty())
    }

    @Test fun invalidSelectionWithoutDraftRequiresAuthoritativeEmptyRestoreBeforeSelectingAgain() = runTest {
        val f = Fixture(this); f.presenter.onStart(); advanceUntilIdle()
        f.current = ImportUploadRunView(status = ImportUploadRunStatus.ATTENTION, errorCode = "import_source_unavailable")
        f.observer(f.current)
        assertEquals(setOf(GalleryImportUploadAction.RECONCILE), f.presenter.state.value.actions)
        f.choosePhoto(); advanceUntilIdle(); assertEquals(0, f.selectCalls)
        f.current = ImportUploadRunView()
        f.presenter.runAction(GalleryImportUploadAction.RECONCILE); advanceUntilIdle()
        assertEquals(2, f.restoreCalls); assertNull(f.presenter.state.value.error)
        f.choosePhoto(); advanceUntilIdle(); assertEquals(1, f.selectCalls); assertEquals(0, f.transferCalls)
    }

    @Test fun transferProgressFromWorkerThreadDoesNotCountUnacknowledgedBytesAsReceived() = runTest {
        val f = Fixture(this); f.presenter.onStart(); advanceUntilIdle(); f.choosePhoto(); advanceUntilIdle()
        val release = CompletableDeferred<Unit>(); f.transferring = { release.await(); f.current }
        f.presenter.runAction(GalleryImportUploadAction.SEND_FILE); runCurrent()
        val executor = Executors.newSingleThreadExecutor()
        try { executor.submit { f.observer(view(ImportPhase.UPLOADING, ImportUploadRunStatus.TRANSFERRING).copy(transferredPartBytes = 12)) }.get() }
        finally { executor.shutdownNow() }
        assertEquals(0f, f.presenter.state.value.confirmedProgress); assertEquals(1f, f.presenter.state.value.currentPartProgress)
        assertEquals("Enviando arquivo…", f.presenter.state.value.title)
        release.complete(Unit); advanceUntilIdle()
    }

    @Test fun unavailableBackendDoesNotOfferSelectionOrPerformSilentRetry() = runTest {
        val f = Fixture(this); f.current = ImportUploadRunView(status = ImportUploadRunStatus.ATTENTION, errorCode = "import_owner_unavailable")
        f.presenter.onStart(); advanceUntilIdle(); f.presenter.onStop(); f.presenter.onStart(); advanceUntilIdle()
        assertEquals(setOf(GalleryImportUploadAction.RECONCILE), f.presenter.state.value.actions)
        assertEquals(1, f.restoreCalls); assertEquals(0, f.selectCalls)
        assertTrue(f.presenter.state.value.error!!.contains("ainda não está disponível"))
        f.presenter.runAction(GalleryImportUploadAction.RECONCILE); advanceUntilIdle(); assertEquals(2, f.restoreCalls)
    }

    @Test fun advancedPreparedStateDoesNotExposeReadyOrScheduleButtonsInUploadScreen() {
        val result = galleryImportUploadPresentation(view(ImportPhase.READY), false, true, true, true)
        assertEquals("A etapa de envio deste arquivo terminou", result.title)
        assertTrue(result.actions.isEmpty()); assertTrue(result.detail.contains("não altera a programação"))
    }
}
