package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class GalleryImportPreparationCoordinatorTest {
    @get:Rule val temporary = TemporaryFolder()
    private val data = ImportPreparationTestData
    private class TestCipher : ImportCheckpointCipher {
        private val key = ByteArray(32).also(SecureRandom()::nextBytes)
        override fun encrypt(scope: String, plain: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
            cipher.updateAAD(scope.toByteArray()); return cipher.iv + cipher.doFinal(plain)
        }
        override fun decrypt(scope: String, sealed: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
            cipher.updateAAD(scope.toByteArray()); return cipher.doFinal(sealed, 12, sealed.size - 12)
        }
    }
    private inner class Fixture(val videoDurationMs: Long? = null) {
        val root = temporary.newFolder(); val cipher = TestCipher(); val store = PrivateImportCheckpointStore(root, cipher)
        var owner: ImportOwner? = data.owner; var token = "synthetic-preparation-session"
        var capabilityEnabled = true; var capabilityOwner = data.owner
        var record = ImportPreparationProtocol.parseRecord(data.awaiting())
        var loseAck = false; var creations = 0; var statuses = 0; var previews = 0
        val keys = mutableListOf<String>(); val views = mutableListOf<ImportPreparationRunView>()
        var capabilityHook: (() -> Unit)? = null
        var requestHook: (suspend () -> Unit)? = null
        var previewHook: ((ImportPrivatePreview) -> ImportPrivatePreview)? = null
        var statusFailure: Boolean = false
        var statusException: ImportApiFailure? = null
        init {
            val ticket = ImportUploadTicket(data.uploadId, data.assetId, data.sourceSha, 12)
            val selected = if (videoDurationMs == null) data.selection else data.selection.copy(kind = ImportMediaKind.VIDEO,
                mimeType = "video/mp4", durationMs = videoDurationMs)
            val config = if (videoDurationMs == null) data.config else ImportConfiguration(setOf(ImportTarget.STORY, ImportTarget.REEL), ImportAudioMode.ORIGINAL, shareToFeed = true)
            store.write(data.owner, 0, ImportDurableCheckpoint(1, GalleryImportState(data.owner, "draft-1", selected, config,
                phase = ImportPhase.UPLOADED, upload = ImportUploadProgress(ticket, serverVerified = true)),
                "content://synthetic-source/private-file", "synthetic-upload-key", uploadStartIssued = true))
        }
        val transport = object : GalleryImportPreparationTransport {
            override suspend fun capabilities(): ImportCapabilities {
                capabilityHook?.invoke()
                return ImportCapabilities(true, capabilityOwner, preparationEnabled = capabilityEnabled)
            }
            override suspend fun status(owner: ImportOwner, assetId: String): ImportPreparationRecord {
                statusException?.let { throw it }
                if (statusFailure) throw ImportApiFailure("import_response_invalid")
                statuses++; assertEquals(data.owner, owner); assertEquals(data.assetId, assetId); return record
            }
            override suspend fun request(owner: ImportOwner, assetId: String, uploadId: String, intent: ImportPreparationIntent,
                                         kind: ImportMediaKind, configuration: ImportConfiguration): ImportPreparationRecord {
                val saved = saved()
                assertEquals(ImportPhase.PREPARING, saved.state.phase)
                assertEquals(saved.preparationIntent!!.idempotencyKey, intent.idempotencyKey)
                assertEquals(saved.state.revision, intent.sourceRevision)
                keys.add(intent.idempotencyKey)
                if (record.phase == ImportPreparationPhase.AWAITING_SELECTION) {
                    creations++; record = ImportPreparationProtocol.parseRecord(if (videoDurationMs == null) data.status() else data.videoStatus("queued"))
                }
                requestHook?.invoke()
                if (loseAck) { loseAck = false; throw ImportApiFailure("synthetic_ack_lost", resultUncertain = true) }
                return record
            }
            override suspend fun preview(owner: ImportOwner, record: ImportPreparationRecord): ImportPrivatePreview {
                previews++
                val metadata = ImportPreparationProtocol.parsePreview(data.preview("https://ia4tube-api.onrender.com", record), record,
                    "https://ia4tube-api.onrender.com".toHttpUrl())
                return previewHook?.invoke(metadata) ?: metadata
            }
        }
        fun coordinator() = GalleryImportPreparationCoordinator({ owner }, { token }, store, { transport }, onChanged = { views.add(it) })
        fun saved() = store.read(data.owner)!!
        fun ready(testOnly: Boolean = false) {
            record = ImportPreparationProtocol.parseRecord(if (videoDurationMs == null) data.status("ready") else data.videoStatus(seconds = videoDurationMs / 1000.0))
            if (testOnly) record = record.copy(testOnly = true, previewDigest = ImportPreparationProtocol.fingerprint(
                record.kind!!, record.configuration!!, true, record.variants))
        }
    }

    @Test fun restoredHttpStatusIsBoundedAndNeverChangesCheckpointOrRepeatsPreparation() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator().request(); fixture.ready()
        val saved = fixture.saved()
        for (status in listOf(null, -1, 200, 399, 401, 403, 404, 503, 599, 600, Int.MAX_VALUE)) {
            fixture.statusException = ImportApiFailure("import_request_rejected", status)
            val view = fixture.coordinator().restore()
            assertEquals(ImportPreparationDiagnosticStage.STATUS, view.diagnosticStage)
            assertEquals(status?.takeIf { it in 400..599 }, view.diagnosticHttpStatus)
            assertEquals(ImportPreparationRunStatus.ATTENTION, view.status)
            assertEquals(saved, fixture.saved()); assertEquals(1, fixture.creations); assertEquals(1, fixture.keys.size)
            assertNull(view.preview)
        }
        fixture.statusException = null
        fixture.previewHook = { throw ImportApiFailure("import_request_rejected", 503) }
        val previewFailed = fixture.coordinator().restore()
        assertEquals(ImportPreparationDiagnosticStage.PREVIEW, previewFailed.diagnosticStage)
        assertEquals(503, previewFailed.diagnosticHttpStatus)
        assertEquals(saved, fixture.saved()); assertEquals(1, fixture.creations)
        fixture.previewHook = null
        val restored = fixture.coordinator().restore()
        assertEquals(ImportPreparationRunStatus.PREVIEW_AVAILABLE, restored.status)
        assertNull(restored.diagnosticStage); assertNull(restored.diagnosticHttpStatus)
    }

    @Test fun restoreDistinguishesStatusFailureFromPreviewFailureWithoutRepeatingPreparation() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator().request()
        fixture.ready()
        fixture.statusFailure = true
        val statusFailed = fixture.coordinator().restore()
        assertEquals(ImportPreparationDiagnosticStage.STATUS, statusFailed.diagnosticStage)
        assertEquals("import_response_invalid", statusFailed.errorCode)
        fixture.statusFailure = false
        fixture.previewHook = { throw ImportApiFailure("import_response_invalid") }
        val previewFailed = fixture.coordinator().restore()
        assertEquals(ImportPreparationDiagnosticStage.PREVIEW, previewFailed.diagnosticStage)
        assertEquals("import_response_invalid", previewFailed.errorCode)
        assertEquals(1, fixture.creations)
        assertNull(previewFailed.preview)
        fixture.previewHook = null
        val restored = fixture.coordinator().restore()
        assertEquals(ImportPreparationRunStatus.PREVIEW_AVAILABLE, restored.status)
        assertNull(restored.diagnosticStage)
    }

    @Test fun reopeningUploadedFileDoesNotPrepareAutomaticallyAndExplicitRequestPersistsFirst() = runBlocking {
        val f = Fixture(); val coordinator = f.coordinator()
        assertEquals(ImportPreparationRunStatus.AWAITING_REQUEST, coordinator.restore().status)
        assertEquals(0, f.statuses); assertEquals(0, f.keys.size)
        assertEquals(ImportPreparationRunStatus.PREPARING, coordinator.request().status)
        assertEquals(1, f.creations); assertEquals(1L, f.saved().preparationIntent!!.acceptedMediaRevision)
        assertEquals(ImportPhase.PREPARING, f.saved().state.phase)
        assertTrue(f.saved().state.prepared.isEmpty()); assertNull(f.saved().state.previewConfirmedRevision)
    }

    @Test fun lostPostAcknowledgementReopensWithoutRetryAndExplicitReconcileReusesOnlySameKey() = runBlocking {
        val f = Fixture(); f.loseAck = true
        assertEquals(ImportPreparationRunStatus.RECONCILIATION_REQUIRED, f.coordinator().request().status)
        val before = f.saved(); assertNull(before.preparationIntent!!.acceptedMediaRevision)
        assertEquals(ImportPreparationRunStatus.RECONCILIATION_REQUIRED, f.coordinator().restore().status)
        assertEquals(1, f.keys.size)
        assertEquals(ImportPreparationRunStatus.PREPARING, f.coordinator().reconcileOnce().status)
        assertEquals(listOf(before.preparationIntent.idempotencyKey, before.preparationIntent.idempotencyKey), f.keys)
        assertEquals(1, f.creations); assertEquals(0, f.previews)
    }

    @Test fun finiteReconciliationRequiresMatchingDerivedMetadataAndDoesNotApproveOrSchedule() = runBlocking {
        val f = Fixture(); f.coordinator().request(); f.ready()
        val result = f.coordinator().reconcileOnce()
        assertEquals(ImportPreparationRunStatus.PREVIEW_AVAILABLE, result.status)
        assertEquals(data.knownDigest, result.preview!!.previewDigest)
        assertEquals(ImportPhase.READY, f.saved().state.phase); assertEquals(data.derivedSha, f.saved().state.prepared.single().sha256)
        assertNull(f.saved().state.previewConfirmedRevision); assertFalse(f.saved().state.availability.allowed)
        assertFalse(f.saved().state.canDisplayScheduled); assertNull(f.saved().state.scheduleIntent)
        assertEquals(1, f.creations); assertEquals(1, f.previews)
        val reads = f.statuses
        assertEquals(ImportPreparationRunStatus.PREVIEW_AVAILABLE, f.coordinator().restore().status)
        assertEquals(reads + 1, f.statuses); assertEquals(2, f.previews); assertEquals(1, f.keys.size)
    }

    @Test fun serverRevisionOrConfigurationChangeNeverReusesStalePreview() = runBlocking {
        for (changed in listOf("revision", "job", "configuration", "asset")) {
            val f = Fixture(); f.coordinator().request(); f.ready()
            f.record = when (changed) {
                "revision" -> f.record.copy(currentRevision = 2)
                "job" -> f.record.copy(jobId = data.assetId)
                "configuration" -> f.record.copy(configuration = ImportConfiguration(setOf(ImportTarget.STORY), ImportAudioMode.NONE))
                else -> f.record.copy(assetId = data.jobId)
            }
            val result = f.coordinator().reconcileOnce()
            assertEquals(ImportPreparationRunStatus.ATTENTION, result.status); assertNull(result.preview)
            assertEquals(ImportPhase.PREPARING, f.saved().state.phase); assertEquals(0, f.previews)
        }
    }

    @Test fun differentSourceWithInternallyValidFingerprintStillCannotPrepareThisUpload() = runBlocking {
        val f = Fixture(); f.coordinator().request(); f.ready()
        val variants = f.record.variants.map { it.copy(sourceSha256 = "c".repeat(64)) }
        f.record = f.record.copy(variants = variants, previewDigest = ImportPreparationProtocol.fingerprint(
            f.record.kind!!, f.record.configuration!!, false, variants))
        val result = f.coordinator().reconcileOnce()
        assertEquals("import_preparation_source_changed", result.errorCode); assertEquals(0, f.previews)
        assertTrue(f.saved().state.prepared.isEmpty())
    }

    @Test fun videoAtSixtySecondsAcceptsEncodingToleranceButNotChangedDuration() = runBlocking {
        val f = Fixture(videoDurationMs = 60_000); f.coordinator().request()
        f.record = ImportPreparationProtocol.parseRecord(data.videoStatus(seconds = 60.25))
        assertEquals(ImportPreparationRunStatus.PREVIEW_AVAILABLE, f.coordinator().reconcileOnce().status)
        assertTrue(f.saved().state.prepared.all { it.durationMs == 60_250L })
        val changed = Fixture(videoDurationMs = 20_000); changed.coordinator().request()
        changed.record = ImportPreparationProtocol.parseRecord(data.videoStatus(seconds = 21.0))
        assertEquals("import_preparation_duration_changed", changed.coordinator().reconcileOnce().errorCode)
        assertEquals(0, changed.previews)
    }

    @Test fun unconfirmedMusicCatalogueNeverCreatesPreparationRequest() = runBlocking {
        val f = Fixture(); val saved = f.saved()
        val config = ImportConfiguration(setOf(ImportTarget.STORY), ImportAudioMode.MUSIC, "unconfirmed-track", setOf(ImportTarget.STORY))
        f.store.write(data.owner, saved.generation, saved.copy(state = saved.state.copy(configuration = config)))
        assertEquals("import_preparation_music_unavailable", f.coordinator().request().errorCode)
        assertEquals(0, f.keys.size); assertEquals(0, f.statuses)
    }

    @Test fun previewDescriptorsCannotSubstituteOriginalEvenIfEnvelopeDigestMatches() = runBlocking {
        val f = Fixture(); f.coordinator().request(); f.ready()
        f.previewHook = { preview ->
            val original = preview.variants.single()
            preview.copy(variants = listOf(ImportPrivatePreviewPart(original.target, original.kind, original.mimeType,
                data.sourceSha, original.sourceSha256, original.width, original.height, original.sizeBytes,
                original.durationMs, original.audioMode, original.hasAudio, original.url)))
        }
        val result = f.coordinator().reconcileOnce()
        assertEquals("import_preparation_preview_invalid", result.errorCode); assertNull(result.preview)
        assertEquals(ImportPhase.PREPARING, f.saved().state.phase)
    }

    @Test fun syntheticTestOnlyResultNeverBecomesDurableReadyOrCommerciallyScheduled() = runBlocking {
        val f = Fixture(); f.coordinator().request(); f.ready(testOnly = true)
        val result = f.coordinator().reconcileOnce()
        assertEquals(ImportPreparationRunStatus.TEST_ONLY_PREVIEW, result.status); assertTrue(result.preview!!.testOnly)
        assertEquals(ImportPhase.PREPARING, f.saved().state.phase); assertTrue(f.saved().state.prepared.isEmpty())
        assertNull(f.saved().state.previewConfirmedRevision); assertNull(f.saved().state.scheduleIntent)
    }

    @Test fun cachedReadyIsNotExposedAsFreshWhenServerRequiresAttention() = runBlocking {
        val f = Fixture(); f.coordinator().request(); f.ready(); f.coordinator().reconcileOnce()
        assertEquals(ImportPhase.READY, f.saved().state.phase)
        f.record = ImportPreparationProtocol.parseRecord(data.status("attention"))
        val result = f.coordinator().restore()
        assertEquals(ImportPreparationRunStatus.ATTENTION, result.status); assertNull(result.preview)
        assertEquals(ImportPhase.PREPARING, result.state!!.phase); assertTrue(result.state.prepared.isEmpty())
    }

    @Test fun existingServerRevisionWithoutMatchingLocalIntentIsPreservedNotOverwritten() = runBlocking {
        val f = Fixture(); f.record = ImportPreparationProtocol.parseRecord(data.status())
        val result = f.coordinator().request()
        assertEquals("import_preparation_existing_revision", result.errorCode)
        assertNull(f.saved().preparationIntent); assertEquals(0, f.keys.size); assertEquals(0, f.creations)
    }

    @Test fun staleGenerationStopsBeforePreparationPostAndPreservesNewerSourceRevision() = runBlocking {
        val f = Fixture()
        f.capabilityHook = {
            val saved = f.saved(); f.store.write(data.owner, saved.generation, saved.copy(state = saved.state.copy(revision = 2)))
            f.capabilityHook = null
        }
        val result = f.coordinator().request()
        assertEquals("checkpoint_conflict", result.errorCode); assertEquals(0, f.keys.size)
        assertEquals(2, f.saved().state.revision); assertNull(f.saved().preparationIntent)
    }

    @Test fun ownerAndTokenChangesInvalidateLateCallbacksButPreserveUncertainIntent() = runBlocking {
        for (changed in listOf("owner", "token")) {
            val f = Fixture(); val coordinator = f.coordinator()
            f.requestHook = {
                if (changed == "owner") f.owner = data.owner.copy(companyId = data.assetId) else f.token = "new-synthetic-session"
                coordinator.invalidateSession()
            }
            assertEquals(ImportPreparationRunStatus.SESSION_CHANGED, coordinator.request().status)
            assertNull(coordinator.snapshot().state); assertNull(f.saved().preparationIntent!!.acceptedMediaRevision)
            assertTrue(f.views.all { it.state == null }); assertEquals(1, f.creations)
        }
    }

    @Test fun pauseDuringUncertainPostDoesNotDeclareFailureOrLoseIdempotency() = runBlocking {
        val f = Fixture(); val coordinator = f.coordinator()
        val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.requestHook = { withContext(NonCancellable) { started.complete(Unit); release.await() } }
        val task = async { coordinator.request() }; started.await(); coordinator.pause(); release.complete(Unit)
        assertEquals(ImportPreparationRunStatus.PAUSED, task.await().status)
        val key = f.saved().preparationIntent!!.idempotencyKey; assertNull(f.saved().preparationIntent!!.acceptedMediaRevision)
        f.requestHook = null
        assertEquals(ImportPreparationRunStatus.PREPARING, f.coordinator().reconcileOnce().status)
        assertEquals(listOf(key, key), f.keys); assertEquals(1, f.creations)
    }

    @Test fun onlyOneOperationRunsPerCoordinatorAndNothingPollsAfterReturning() = runBlocking {
        val f = Fixture(); val coordinator = f.coordinator()
        val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.requestHook = { started.complete(Unit); release.await() }
        val task = async { coordinator.request() }; started.await()
        assertEquals("import_preparation_busy", coordinator.request().errorCode)
        assertEquals("import_preparation_busy", f.coordinator().request().errorCode)
        release.complete(Unit); assertEquals(ImportPreparationRunStatus.PREPARING, task.await().status)
        assertEquals(1, f.keys.size); assertEquals(1, f.statuses); assertEquals(0, f.previews)
    }

    @Test fun disabledCapabilityAndUnverifiedUploadDoNotQueueJobs() = runBlocking {
        val f = Fixture(); f.capabilityEnabled = false
        assertEquals("import_preparation_unavailable", f.coordinator().request().errorCode)
        f.capabilityEnabled = true
        val saved = f.saved(); f.store.write(data.owner, saved.generation, saved.copy(state = saved.state.copy(
            phase = ImportPhase.UPLOADING, upload = saved.state.upload!!.copy(serverVerified = false))))
        assertEquals("import_preparation_upload_required", f.coordinator().request().errorCode)
        assertEquals(0, f.creations); assertEquals(0, f.statuses)
    }

    @Test fun preparedIntentRemainsEncryptedAndCannotBeRelabelledToAnotherLocalRevision() = runBlocking {
        val f = Fixture(); f.coordinator().request(); val saved = f.saved()
        assertEquals(saved.preparationIntent, PrivateImportCheckpointStore(f.root, f.cipher).read(data.owner)!!.preparationIntent)
        assertThrows(ImportCheckpointFailure::class.java) {
            f.store.write(data.owner, saved.generation, saved.copy(state = saved.state.copy(revision = saved.state.revision + 1)))
        }
        assertFalse(f.root.walkTopDown().filter { it.isFile }.any { String(it.readBytes(), Charsets.ISO_8859_1).contains(f.token) })
        assertFalse(saved.toString().contains("content://"))
    }
}
