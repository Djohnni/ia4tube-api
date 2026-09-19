package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class GalleryImportWorkflowCoordinatorTest {
    @get:Rule val temporary = TemporaryFolder()
    private val data = ImportPreparationTestData
    private val track = AuthorizedImportTrack("synthetic-test-track", false, true)
    private val at get() = ((System.currentTimeMillis() / 60000L) + 120L) * 60000L
    private class TestCipher : ImportCheckpointCipher {
        private val key = SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES")
        override fun encrypt(scope: String, plain: ByteArray): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, key); updateAAD(scope.toByteArray()); iv + doFinal(plain)
        }
        override fun decrypt(scope: String, sealed: ByteArray): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed.copyOfRange(0, 12))); updateAAD(scope.toByteArray()); doFinal(sealed, 12, sealed.size - 12)
        }
    }
    private inner class Fixture(val local: Boolean = false, val video: Boolean = false, seed: Boolean = true) {
        val directory = temporary.newFolder(); val store = PrivateImportCheckpointStore(directory, TestCipher())
        var owner: ImportOwner? = data.owner; var token = "synthetic-workflow-session"
        var record = ImportPreparationProtocol.parseRecord(data.awaiting())
        val preparationKeys = mutableListOf<String>(); val scheduleKeys = mutableListOf<String>(); val sourceKeys = mutableListOf<String>()
        var receipt: ImportScheduleReceipt? = null; var loseScheduleAck = false; var loseSourceAck = false; var losePrepareAck = false
        var automaticAllowed = true; var scheduleHook: (() -> Unit)? = null
        val config = if (video) ImportConfiguration(setOf(ImportTarget.STORY, ImportTarget.REEL), ImportAudioMode.ORIGINAL, shareToFeed = true) else data.config
        val selection = if (video) data.selection.copy(kind = ImportMediaKind.VIDEO, mimeType = "video/mp4", durationMs = 20_000) else data.selection
        init { if (seed) store.write(data.owner, 0, ImportDurableCheckpoint(1,
            GalleryImportState(data.owner, "draft-workflow", selection, config, phase = ImportPhase.UPLOADED,
                upload = ImportUploadProgress(ImportUploadTicket(data.uploadId, data.assetId, selection.sha256, selection.byteCount), serverVerified = true)),
            "content://synthetic-private/source", "upload-workflow-key", uploadStartIssued = true)) }
        val transport = object : GalleryImportPreparationTransport {
            override suspend fun capabilities() = ImportCapabilities(true, data.owner, preparationEnabled = true, schedulingEnabled = true,
                localSimulation = local, musicTracks = if (local) listOf(track) else emptyList())
            override suspend fun status(owner: ImportOwner, assetId: String) = record
            override suspend fun request(owner: ImportOwner, assetId: String, uploadId: String, intent: ImportPreparationIntent,
                                         kind: ImportMediaKind, configuration: ImportConfiguration): ImportPreparationRecord {
                assertEquals(intent, store.read(data.owner)!!.preparationIntent)
                preparationKeys.add(intent.idempotencyKey)
                if (record.mediaRevision != intent.expectedMediaRevision + 1) {
                    assertEquals(record.currentRevision, intent.expectedMediaRevision)
                    record = ImportPreparationRecord(assetId, uploadId, intent.expectedMediaRevision + 1, intent.expectedMediaRevision + 1,
                        java.util.UUID.randomUUID().toString(), ImportPreparationPhase.QUEUED, kind, configuration, local, null, emptyList())
                }
                if (losePrepareAck) { losePrepareAck = false; throw ImportApiFailure("synthetic_lost", resultUncertain = true) }
                return record
            }
            override suspend fun preview(owner: ImportOwner, record: ImportPreparationRecord) = ImportPreparationProtocol.parsePreview(
                data.preview("https://ia4tube-api.onrender.com", record), record, "https://ia4tube-api.onrender.com".toHttpUrl())
            override suspend fun availability(owner: ImportOwner, record: ImportPreparationRecord) = ImportScheduleAvailability(true,
                automaticAllowed, true, "synthetic-account", localSimulation = local, commercialReady = !local)
            override suspend fun schedule(owner: ImportOwner, binding: ImportScheduleBinding, intent: ImportScheduleIntent): ImportScheduleReceipt {
                val saved = store.read(data.owner)!!
                assertEquals(ImportPhase.SCHEDULING, saved.state.phase); assertEquals(binding, saved.scheduleBinding); assertEquals(intent, saved.state.scheduleIntent)
                scheduleKeys.add(intent.idempotencyKey)
                receipt = receipt ?: ImportScheduleReceipt("c".repeat(40), binding.assetId, binding.mediaRevision, binding.previewDigest,
                    intent.idempotencyKey, 1, "ready", binding.date, binding.time, intent.automatic, local)
                scheduleHook?.invoke()
                if (loseScheduleAck) { loseScheduleAck = false; throw ImportApiFailure("synthetic_lost", resultUncertain = true) }
                return receipt!!
            }
            override suspend fun scheduleStatus(owner: ImportOwner, binding: ImportScheduleBinding, intent: ImportScheduleIntent) = receipt
            override suspend fun generated(owner: ImportOwner, intent: ImportGeneratedSourceIntent): ImportGeneratedSource {
                assertEquals(intent, store.readGeneratedIntent(owner)); assertNull(store.read(owner)); sourceKeys.add(intent.idempotencyKey)
                if (loseSourceAck) { loseSourceAck = false; throw ImportApiFailure("synthetic_lost", resultUncertain = true) }
                return ImportGeneratedSource(ImportUploadRecord(data.uploadId, data.assetId, ImportMediaKind.IMAGE, "image/png", 12,
                    GalleryImportPolicy.CHUNK_BYTES, 1, ImportServerPhase.UPLOADED, data.sourceSha),
                    data.selection.copy(selectionId = "generated-${intent.calendarItemId}"), intent)
            }
        }
        fun coordinator() = GalleryImportPreparationCoordinator({ owner }, { token }, store, { transport }, if (local) listOf(track) else emptyList())
        fun ready() {
            val chosen = record.configuration!!
            val variants = GalleryImportPolicy.variants(record.kind!!, chosen).map { expected -> ImportPreparedMetadata(expected.target,
                (if (chosen.audioMode == ImportAudioMode.MUTED) "f" else "b").repeat(64), data.sourceSha, expected.mimeType, 1080,
                if (expected.target == ImportTarget.FEED) 1350 else 1920, 123,
                if (expected.kind == ImportMediaKind.IMAGE) null else if (record.kind == ImportMediaKind.IMAGE) 15_000 else 20_000,
                expected.audioMode, expected.audioMode in setOf(ImportAudioMode.MUSIC, ImportAudioMode.ORIGINAL),
                if (expected.audioMode == ImportAudioMode.MUSIC) "e".repeat(64) else null) }
            record = record.copy(phase = ImportPreparationPhase.READY, variants = variants,
                previewDigest = ImportPreparationProtocol.fingerprint(record.kind!!, chosen, local, variants))
        }
        suspend fun prepared(coordinator: GalleryImportPreparationCoordinator = coordinator()): GalleryImportPreparationCoordinator {
            coordinator.request(); ready(); coordinator.reconcileOnce(); return coordinator
        }
        fun confirmation() = ImportPreviewConfirmation(data.assetId, record.mediaRevision, record.previewDigest!!, record.variants.map { it.target.wire }.toSet())
    }

    @Test fun explicitConfirmationAndSchedulePersistIntentAndReturnSameCalendarReceipt() = runBlocking {
        val f = Fixture(); val coordinator = f.prepared()
        assertEquals("import_preview_confirmation_required", coordinator.schedule("Caption", at, true).errorCode)
        assertEquals(0, f.scheduleKeys.size)
        coordinator.confirmPreview(f.confirmation())
        val result = coordinator.schedule(" Caption ", at, true)
        assertEquals(ImportPreparationRunStatus.SCHEDULED, result.status); assertEquals("c".repeat(40), result.state!!.calendarItemId)
        assertFalse(result.scheduleReceipt!!.localSimulation); assertEquals(1, f.scheduleKeys.size)
        val saved = f.store.read(data.owner)!!
        assertEquals(f.record.previewDigest, saved.scheduleBinding!!.previewDigest)
        assertEquals("Caption", saved.state.scheduleIntent!!.caption); assertNull(saved.state.previewConfirmedRevision)
        assertFalse(f.directory.walkTopDown().filter { it.isFile }.any { String(it.readBytes(), Charsets.ISO_8859_1).contains(f.token) })
    }
    @Test fun lostScheduleAckReadOnlyRestoreAndRepeatedConfirmationDoNotDuplicateSchedule() = runBlocking {
        val f = Fixture(); val coordinator = f.prepared(); coordinator.confirmPreview(f.confirmation()); f.loseScheduleAck = true
        val whenAt = at
        assertEquals(ImportPreparationRunStatus.SCHEDULE_RECONCILIATION, coordinator.schedule("Caption", whenAt, true).status)
        assertEquals(ImportPhase.SCHEDULING, f.store.read(data.owner)!!.state.phase)
        val reopened = f.coordinator()
        assertEquals(ImportPreparationRunStatus.SCHEDULED, reopened.restore().status)
        assertEquals(ImportPreparationRunStatus.SCHEDULED, reopened.schedule("Caption", whenAt, true).status)
        assertEquals(1, f.scheduleKeys.size)
        assertEquals("import_schedule_conflicting_intent", reopened.schedule("Different", whenAt, true).errorCode)
    }
    @Test fun missingScheduleReceiptRequiresExplicitSameKeyReplayNeverBackgroundPost() = runBlocking {
        val f = Fixture(); val coordinator = f.prepared(); coordinator.confirmPreview(f.confirmation()); f.loseScheduleAck = true
        coordinator.schedule("Caption", at, true); f.receipt = null
        val before = f.store.read(data.owner)!!.state.scheduleIntent!!.idempotencyKey
        val reopened = f.coordinator()
        assertEquals(ImportPreparationRunStatus.SCHEDULE_RECONCILIATION, reopened.restore().status); assertEquals(1, f.scheduleKeys.size)
        assertEquals(ImportPreparationRunStatus.SCHEDULED, reopened.reconcileScheduleOnce().status)
        assertEquals(listOf(before, before), f.scheduleKeys)
    }
    @Test fun staleOrPartialPreviewCannotConfirmAndReopeningRequiresDisplayAgain() = runBlocking {
        val f = Fixture(video = true); val coordinator = f.prepared()
        assertEquals("import_preview_confirmation_changed", coordinator.confirmPreview(f.confirmation().copy(verifiedTargets = setOf("story"))).errorCode)
        coordinator.confirmPreview(f.confirmation())
        assertNotNull(coordinator.snapshot().confirmation)
        assertNull(f.coordinator().restore().confirmation)
        assertEquals("import_preview_confirmation_required", f.coordinator().schedule("Caption", at, true).errorCode)
        assertEquals(0, f.scheduleKeys.size)
    }
    @Test fun audioFormatEditInvalidatesPreviewAndUsesNewRevisionWithoutAnotherUpload() = runBlocking {
        val f = Fixture(video = true); val coordinator = f.prepared(); coordinator.confirmPreview(f.confirmation())
        val old = f.confirmation(); val original = f.store.read(data.owner)!!.state.upload
        val changed = ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.MUTED, shareToFeed = true)
        assertEquals(ImportPreparationRunStatus.AWAITING_REQUEST, coordinator.configure(changed).status)
        assertNull(coordinator.snapshot().confirmation); assertEquals(original, f.store.read(data.owner)!!.state.upload)
        assertEquals(1L, f.store.read(data.owner)!!.preparationBaseRevision)
        coordinator.request(); f.ready(); val preview = coordinator.reconcileOnce()
        assertEquals(2L, preview.preparation!!.mediaRevision); assertFalse(preview.preview!!.variants.single().hasAudio)
        assertEquals("import_preview_confirmation_changed", coordinator.confirmPreview(old).errorCode)
        assertEquals(2, f.preparationKeys.distinct().size)
    }
    @Test fun unknownPreparationCannotBeDiscardedByEditingAndLostAckKeepsKey() = runBlocking {
        val f = Fixture(); f.losePrepareAck = true; val coordinator = f.coordinator(); coordinator.request()
        val key = f.store.read(data.owner)!!.preparationIntent!!.idempotencyKey
        assertEquals("import_preparation_reconcile_required", coordinator.configure(ImportConfiguration(setOf(ImportTarget.STORY), ImportAudioMode.NONE)).errorCode)
        coordinator.reconcileOnce(); assertEquals(listOf(key, key), f.preparationKeys)
        assertEquals(1L, f.record.mediaRevision)
    }
    @Test fun syntheticMusicCanScheduleOnlyExplicitLocalSimulationWithDistinctReceipt() = runBlocking {
        val f = Fixture(local = true); val coordinator = f.coordinator()
        val music = ImportConfiguration(setOf(ImportTarget.FEED, ImportTarget.STORY), ImportAudioMode.MUSIC, track.id, setOf(ImportTarget.STORY))
        assertEquals(ImportPreparationRunStatus.AWAITING_REQUEST, coordinator.configure(music).status)
        coordinator.request(); f.ready(); val preview = coordinator.reconcileOnce()
        assertEquals(ImportPreparationRunStatus.TEST_ONLY_PREVIEW, preview.status)
        assertEquals(ImportPhase.PREPARING, f.store.read(data.owner)!!.state.phase)
        assertEquals(setOf("image/jpeg", "video/mp4"), preview.preview!!.variants.map { it.mimeType }.toSet())
        coordinator.confirmPreview(f.confirmation())
        val result = coordinator.schedule("Synthetic only", at, true)
        assertEquals(ImportPreparationRunStatus.SCHEDULED, result.status); assertTrue(result.scheduleReceipt!!.localSimulation)
        assertTrue(f.store.read(data.owner)!!.scheduleBinding!!.localSimulation)
    }
    @Test fun syntheticResultOrUnlicensedMusicNeverOpensCommercialSchedule() = runBlocking {
        val f = Fixture(); val coordinator = f.prepared()
        assertEquals("import_preparation_music_unavailable", coordinator.configure(ImportConfiguration(setOf(ImportTarget.STORY), ImportAudioMode.MUSIC,
            track.id, setOf(ImportTarget.STORY))).errorCode)
        f.record = f.record.copy(testOnly = true, previewDigest = ImportPreparationProtocol.fingerprint(f.record.kind!!, f.record.configuration!!, true, f.record.variants))
        assertEquals("import_schedule_availability_invalid", coordinator.reconcileOnce().errorCode)
        assertEquals(0, f.scheduleKeys.size)
    }
    @Test fun blockedAutomaticDoesNotPreventExplicitPausedItemAndDoesNotAuthorizeItLater() = runBlocking {
        val f = Fixture(); val coordinator = f.prepared(); f.automaticAllowed = false
        coordinator.confirmPreview(f.confirmation())
        assertEquals("import_scheduling_unavailable", coordinator.schedule("Caption", at, true).errorCode)
        coordinator.confirmPreview(f.confirmation())
        val result = coordinator.schedule("Caption", at, false)
        assertEquals(ImportPreparationRunStatus.SCHEDULED, result.status); assertFalse(result.scheduleReceipt!!.automaticEnabled)
        assertFalse(f.store.read(data.owner)!!.state.scheduleIntent!!.automatic)
    }
    @Test fun changedSessionDuringSchedulePreservesIntentWithoutLeakingReceipt() = runBlocking {
        val f = Fixture(); val coordinator = f.prepared(); coordinator.confirmPreview(f.confirmation())
        f.scheduleHook = { f.token = "different-session"; coordinator.invalidateSession() }
        assertEquals(ImportPreparationRunStatus.SESSION_CHANGED, coordinator.schedule("Caption", at, true).status)
        assertNull(coordinator.snapshot().scheduleReceipt); assertEquals(ImportPhase.SCHEDULING, f.store.read(data.owner)!!.state.phase)
        f.token = "synthetic-workflow-session"
        assertEquals(ImportPreparationRunStatus.SESSION_CHANGED, coordinator.restore().status)
    }
    @Test fun scheduleRetryReturnsLatestPausedOrCancelledRecordWithoutCreatingAnother() = runBlocking {
        val f = Fixture(); val coordinator = f.prepared(); coordinator.confirmPreview(f.confirmation()); coordinator.schedule("Caption", at, true)
        f.receipt = f.receipt!!.copy(phase = "cancelled", revision = 2, automaticEnabled = false)
        val result = f.coordinator().restore()
        assertEquals("cancelled", result.scheduleReceipt!!.phase); assertEquals(1, f.scheduleKeys.size)
        assertEquals("c".repeat(40), result.state!!.calendarItemId)
    }
    @Test fun generatedArtSourceIntentSurvivesLostAckWithoutUriOrNewOrder() = runBlocking {
        val f = Fixture(seed = false); f.loseSourceAck = true; val coordinator = f.coordinator(); val art = "a".repeat(40)
        assertEquals(ImportPreparationRunStatus.SOURCE_RECONCILIATION, coordinator.adoptGenerated(art, 1).status)
        assertNull(f.store.read(data.owner)); val pending = f.store.readGeneratedIntent(data.owner)!!
        assertEquals(ImportPreparationRunStatus.SOURCE_RECONCILIATION, f.coordinator().restore().status); assertEquals(1, f.sourceKeys.size)
        assertEquals(ImportPreparationRunStatus.AWAITING_REQUEST, f.coordinator().adoptGenerated(art, 1).status)
        val saved = f.store.read(data.owner)!!
        assertEquals(listOf(pending.idempotencyKey, pending.idempotencyKey), f.sourceKeys)
        assertEquals(ImportPhase.UPLOADED, saved.state.phase); assertNull(saved.selectedContentUri); assertEquals(pending, saved.generatedSource)
        assertNull(f.store.readGeneratedIntent(data.owner)); assertEquals(0, f.preparationKeys.size); assertEquals(0, f.scheduleKeys.size)
    }
    @Test fun pendingGeneratedArtBlocksDifferentArtAndAnotherCompanyCannotReadIt() = runBlocking {
        val f = Fixture(seed = false); f.loseSourceAck = true; f.coordinator().adoptGenerated("a".repeat(40), 1)
        assertEquals("checkpoint_generated_conflict", f.coordinator().adoptGenerated("b".repeat(40), 1).errorCode)
        assertNull(f.store.readGeneratedIntent(data.owner.copy(companyId = data.assetId)))
        assertEquals(1, f.sourceKeys.size)
    }
    @Test fun finishingConfirmedDraftOnlyClearsPrivateCheckpointNotCalendarOrOriginal() = runBlocking {
        val f = Fixture(); val coordinator = f.prepared(); coordinator.confirmPreview(f.confirmation()); coordinator.schedule("Caption", at, true)
        assertEquals(ImportPreparationRunStatus.EMPTY, coordinator.finishScheduledDraft().status)
        assertNull(f.store.read(data.owner)); assertNotNull(f.receipt); assertEquals(1, f.scheduleKeys.size)
    }
}
