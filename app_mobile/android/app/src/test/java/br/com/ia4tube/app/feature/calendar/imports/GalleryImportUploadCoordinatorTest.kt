package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** All files, media, identities and transports are synthetic; no remote URL is fetched. */
class GalleryImportUploadCoordinatorTest {
    @get:Rule val temporary = TemporaryFolder()
    private val config = ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE)
    private val uri = "content://synthetic-picker/private-selected-file"
    private class TestCipher : ImportCheckpointCipher {
        private val key = ByteArray(32).also(SecureRandom()::nextBytes)
        override fun encrypt(scope: String, plain: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES")); cipher.updateAAD(scope.toByteArray())
            return cipher.iv + cipher.doFinal(plain)
        }
        override fun decrypt(scope: String, sealed: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
            cipher.updateAAD(scope.toByteArray()); return cipher.doFinal(sealed, 12, sealed.size - 12)
        }
    }
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private inner class Fixture(val root: File, size: Int = 17) {
        val owner = ImportOwner(UUID.randomUUID().toString(), UUID.randomUUID().toString())
        var activeOwner: ImportOwner? = owner
        var token = "synthetic-session-secret"
        val cipher = TestCipher()
        val store = PrivateImportCheckpointStore(root, cipher)
        var content = ByteArray(size) { (it % 251).toByte() }
        var sourceAvailable = true
        var inspectCount = 0
        val readParts = mutableListOf<Int>()
        val views = mutableListOf<ImportUploadRunView>()
        val source = object : GalleryImportUploadSource {
            override fun retain(uri: String) = sourceAvailable
            override suspend fun inspect(uri: String): ImportSelection {
                inspectCount++; if (!sourceAvailable) throw ImportSourceFailure()
                return ImportSelection(UUID.randomUUID().toString(), ImportMediaKind.IMAGE, "image/png", content.size.toLong(), 10, 10, null, hash(content))
            }
            override suspend fun part(uri: String, selection: ImportSelection, index: Int): ByteArray {
                if (!sourceAvailable) throw ImportSourceFailure()
                readParts.add(index)
                val start = index * GalleryImportPolicy.CHUNK_BYTES
                return content.copyOfRange(start, minOf(content.size, start + GalleryImportPolicy.CHUNK_BYTES))
            }
        }
        var enabled = true
        var capabilityOwner = owner
        var capabilityHook: (() -> Unit)? = null
        var startHook: (suspend () -> Unit)? = null
        var putHook: (suspend () -> Unit)? = null
        var afterPutHook: (() -> Unit)? = null
        var loseStart = false
        var losePut = false
        var loseComplete = false
        var loseCancel = false
        var pendingVerification = false
        var initialPhase = ImportServerPhase.UPLOADING
        var serverRecord: ImportUploadRecord? = null
        val received = linkedMapOf<Int, ByteArray>()
        val receipts = linkedMapOf<Int, ImportPartReceipt>()
        val grants = mutableMapOf<String, Pair<Int, ImportPartChecksums>>()
        val startKeys = mutableListOf<String>()
        var creations = 0
        var puts = 0
        var resumes = 0
        var completions = 0
        var cancellations = 0
        val transport = object : GalleryImportUploadTransport {
            override suspend fun capabilities(): ImportCapabilities {
                capabilityHook?.invoke()
                return ImportCapabilities(enabled, capabilityOwner, "https://ia4tube-api.onrender.com",
                    maxImageBytes = GalleryImportPolicy.IMAGE_MAX_BYTES, maxVideoBytes = GalleryImportPolicy.VIDEO_MAX_BYTES)
            }
            override suspend fun start(owner: ImportOwner, media: ImportSelection, key: String): ImportUploadRecord {
                val saved = store.read(owner)!!
                assertTrue(saved.uploadStartIssued); assertEquals(key, saved.uploadStartIdempotencyKey)
                startKeys.add(key); startHook?.invoke()
                if (serverRecord == null) {
                    creations++
                    serverRecord = ImportUploadRecord(UUID.randomUUID().toString(), UUID.randomUUID().toString(), media.kind, media.mimeType,
                        media.byteCount, GalleryImportPolicy.CHUNK_BYTES,
                        ((media.byteCount + GalleryImportPolicy.CHUNK_BYTES - 1) / GalleryImportPolicy.CHUNK_BYTES).toInt(), initialPhase, null)
                }
                if (loseStart) { loseStart = false; throw ImportApiFailure("synthetic_ack_lost", resultUncertain = true) }
                return serverRecord!!
            }
            override suspend fun resume(owner: ImportOwner, uploadId: String): ImportUploadRecord {
                resumes++; assertEquals(uploadId, serverRecord!!.uploadId)
                return serverRecord!!.copy(completedParts = if (serverRecord!!.phase == ImportServerPhase.UPLOADING) receipts.values.toList() else emptyList())
            }
            override suspend fun authorizePart(owner: ImportOwner, upload: ImportUploadRecord, part: Int, checksums: ImportPartChecksums): ImportPartAuthorization {
                assertEquals(upload.uploadId, store.read(owner)!!.state.upload!!.ticket.uploadId)
                val id = UUID.randomUUID().toString(); grants[id] = part to checksums
                val size = minOf(upload.chunkBytes.toLong(), upload.sizeBytes - (part - 1L) * upload.chunkBytes).toInt()
                return ImportPartAuthorization(upload.uploadId, part, size, id, Long.MAX_VALUE)
            }
            override suspend fun resolvePart(owner: ImportOwner, authorization: ImportPartAuthorization, checksums: ImportPartChecksums): ImportPartGrant =
                ImportPartGrant("http://127.0.0.1/never-requested/${authorization.authorizationId}".toHttpUrl(),
                    mapOf("content-md5" to checksums.md5Base64), authorization.sizeBytes, Long.MAX_VALUE, token)
            override suspend fun putPart(grant: ImportPartGrant, bytes: ByteArray, progress: (Long, Long) -> Unit) {
                putHook?.invoke()
                val (part, checksum) = grants[grant.url.pathSegments.last()]!!
                assertEquals(checksum.sha256, hash(bytes)); puts++
                received[part] = bytes.copyOf(); receipts[part] = ImportPartReceipt.fromServer(part, bytes.size, checksum.sha256)
                afterPutHook?.invoke()
                progress(bytes.size.toLong(), bytes.size.toLong())
                if (losePut) { losePut = false; throw ImportApiFailure("synthetic_ack_lost", resultUncertain = true) }
            }
            override suspend fun complete(owner: ImportOwner, uploadId: String): ImportUploadRecord {
                completions++; assertEquals(ImportPhase.VERIFYING, store.read(owner)!!.state.phase)
                if (pendingVerification) {
                    serverRecord = serverRecord!!.copy(phase = ImportServerPhase.VERIFYING)
                    throw ImportApiFailure("import_verification_pending", 503, true)
                }
                val digest = MessageDigest.getInstance("SHA-256")
                received.toSortedMap().values.forEach { digest.update(it) }
                val actual = digest.digest().joinToString("") { "%02x".format(it) }
                assertEquals(store.read(owner)!!.state.selection.sha256, actual)
                serverRecord = serverRecord!!.copy(phase = ImportServerPhase.UPLOADED, verifiedSha256 = actual)
                if (loseComplete) { loseComplete = false; throw ImportApiFailure("synthetic_ack_lost", resultUncertain = true) }
                return serverRecord!!
            }
            override suspend fun cancel(owner: ImportOwner, uploadId: String): ImportUploadRecord {
                cancellations++; assertTrue(store.read(owner)!!.cancelRequested)
                assertEquals(ImportPhase.CANCEL_PENDING, store.read(owner)!!.state.phase)
                serverRecord = serverRecord!!.copy(phase = ImportServerPhase.CANCELLED)
                if (loseCancel) { loseCancel = false; throw ImportApiFailure("synthetic_ack_lost", resultUncertain = true) }
                return serverRecord!!
            }
        }
        fun coordinator(storeOverride: PrivateImportCheckpointStore = store) = GalleryImportUploadCoordinator(
            { activeOwner }, { token }, source, storeOverride, { transport }, onChanged = { synchronized(views) { views.add(it) } })
        fun saved() = store.read(owner)!!
    }
    private fun fixture(size: Int = 17) = Fixture(temporary.newFolder(), size)

    @Test fun selectionPersistsIntentButDoesNotStartAndFiniteTransferOnlyMarksVerifiedUpload() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator()
        assertEquals(ImportUploadRunStatus.PAUSED, coordinator.select(uri, config).status)
        assertFalse(f.saved().uploadStartIssued); assertEquals(0, f.creations)
        val result = coordinator.transfer()
        assertEquals(ImportUploadRunStatus.UPLOADED, result.status); assertEquals(ImportPhase.UPLOADED, result.state!!.phase)
        assertTrue(result.state.upload!!.serverVerified); assertTrue(result.state.prepared.isEmpty()); assertFalse(result.state.canDisplayScheduled)
        assertEquals(1, f.creations); assertEquals(1, f.puts); assertEquals(1, f.completions)
        assertTrue(f.views.any { it.transferredPartBytes == f.content.size.toLong() && it.acknowledgedBytes == 0L })
        assertFalse(f.root.walkTopDown().filter { it.isFile }.any { String(it.readBytes(), Charsets.ISO_8859_1).contains(f.token) })
        assertFalse(f.saved().toString().contains(uri))
    }

    @Test fun startAcknowledgementLostReopensWithSameKeyAndOnlyOneRemoteAsset() = runBlocking {
        val f = fixture(); val first = f.coordinator(); first.select(uri, config); f.loseStart = true
        assertEquals(ImportUploadRunStatus.RECONCILIATION_REQUIRED, first.transfer().status)
        val saved = f.saved(); assertTrue(saved.uploadStartIssued); assertNull(saved.state.upload)
        val reopened = f.coordinator(PrivateImportCheckpointStore(f.root, f.cipher))
        assertEquals(ImportUploadRunStatus.PAUSED, reopened.restore().status); assertEquals(1, f.startKeys.size)
        assertEquals(ImportUploadRunStatus.UPLOADED, reopened.transfer().status)
        assertEquals(listOf(saved.uploadStartIdempotencyKey, saved.uploadStartIdempotencyKey), f.startKeys)
        assertEquals(1, f.creations); assertEquals(1, f.puts)
    }

    @Test fun lostPutAcknowledgementUsesObservedReceiptWithoutResendingEvenIfPickerAccessWasLost() = runBlocking {
        val f = fixture(); val first = f.coordinator(); first.select(uri, config); f.losePut = true
        assertEquals(ImportUploadRunStatus.RECONCILIATION_REQUIRED, first.transfer().status)
        assertEquals(0, f.saved().state.upload!!.receipts.size); f.sourceAvailable = false
        assertEquals(ImportUploadRunStatus.UPLOADED, f.coordinator().transfer().status)
        assertEquals(1, f.puts); assertEquals(1, f.creations)
    }

    @Test fun partialTransferReopensAndReadsOnlyTheNextPart() = runBlocking {
        val f = fixture(GalleryImportPolicy.CHUNK_BYTES + 7); val first = f.coordinator(); first.select(uri, config)
        assertEquals(ImportUploadRunStatus.PAUSED, first.transfer(maxParts = 1).status)
        assertTrue(f.saved().transferPaused); assertEquals(1, f.saved().state.upload!!.receipts.size)
        assertEquals(ImportUploadRunStatus.UPLOADED, f.coordinator().transfer().status)
        assertEquals(listOf(0, 1), f.readParts); assertEquals(2, f.puts)
    }

    @Test fun pauseDuringCancellablePutPreservesResumeAndDoesNotClaimReceiptOrReady() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator(); coordinator.select(uri, config)
        val started = CompletableDeferred<Unit>(); f.putHook = { started.complete(Unit); awaitCancellation() }
        val task = async { coordinator.transfer() }; started.await(); coordinator.pause()
        assertEquals(ImportUploadRunStatus.PAUSED, task.await().status)
        assertTrue(f.saved().transferPaused); assertEquals(0, f.saved().state.upload!!.receipts.size)
        assertEquals(0, f.completions); f.putHook = null
        assertEquals(ImportUploadRunStatus.UPLOADED, coordinator.transfer().status)
    }

    @Test fun cancellingNeverStartedDraftDoesNotCreateRemoteUpload() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator(); coordinator.select(uri, config)
        assertEquals(ImportUploadRunStatus.CANCELLED, coordinator.requestCancel().status)
        assertEquals(0, f.startKeys.size); assertEquals(0, f.cancellations); assertFalse(f.saved().cancelRequested)
    }

    @Test fun explicitDiscardOfCancelledDraftAllowsNewSelectionWithoutDeletingMediaOrCallingServer() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator(); coordinator.select(uri, config)
        val before = f.saved(); coordinator.requestCancel()
        assertEquals(ImportUploadRunStatus.EMPTY, coordinator.discardCancelledDraft().status)
        assertNull(f.store.read(f.owner)); assertEquals(0, f.creations); assertEquals(0, f.cancellations)
        assertEquals(17, f.content.size)
        assertEquals(ImportUploadRunStatus.PAUSED, coordinator.select(uri, config).status)
        assertNotEquals(before.state.draftId, f.saved().state.draftId)
        assertNotEquals(before.uploadStartIdempotencyKey, f.saved().uploadStartIdempotencyKey)
    }

    @Test fun unknownRemoteIntentAndCompletedUploadCannotBeDiscardedOrReplaced() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator(); coordinator.select(uri, config); f.loseStart = true
        coordinator.transfer(); val uncertain = f.saved()
        assertEquals("import_discard_not_cancelled", coordinator.discardCancelledDraft().errorCode)
        assertEquals("import_existing_draft", coordinator.select(uri, config).errorCode)
        assertEquals(uncertain.generation, f.saved().generation)
        assertEquals(ImportUploadRunStatus.UPLOADED, coordinator.transfer().status)
        val uploaded = f.saved()
        assertEquals("import_upload_not_cancellable", coordinator.requestCancel().errorCode)
        assertEquals("import_discard_not_cancelled", coordinator.discardCancelledDraft().errorCode)
        assertEquals(uploaded.generation, f.saved().generation); assertFalse(f.saved().cancelRequested)
        assertEquals(0, f.cancellations); assertEquals(1, f.creations)
    }

    @Test fun restoredDisplayNeverUsesPreviouslyObservedAvailabilityOrPreviewApproval() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator(); coordinator.select(uri, config)
        val saved = f.saved()
        f.store.write(f.owner, saved.generation, saved.copy(state = saved.state.copy(
            availability = ImportOperationalAvailability(true, true, true, true, true), previewConfirmedRevision = 1)))
        val result = f.coordinator().restore()
        assertFalse(result.state!!.availability.allowed); assertNull(result.state.previewConfirmedRevision)
        assertFalse(result.state.canDisplayScheduled); assertEquals(0, f.startKeys.size)
    }

    @Test fun cancellingUnknownStartReconcilesSameIntentBeforeCancellingOnlyThatUpload() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator(); coordinator.select(uri, config); f.loseStart = true
        coordinator.transfer(); val key = f.saved().uploadStartIdempotencyKey
        assertEquals(ImportUploadRunStatus.CANCELLED, f.coordinator().requestCancel().status)
        assertEquals(listOf(key, key), f.startKeys); assertEquals(1, f.creations); assertEquals(1, f.cancellations); assertEquals(0, f.puts)
    }

    @Test fun lostCancelAcknowledgementNeverReopensTransferOnRestart() = runBlocking {
        val f = fixture(GalleryImportPolicy.CHUNK_BYTES + 1); val coordinator = f.coordinator(); coordinator.select(uri, config)
        coordinator.transfer(maxParts = 1); f.loseCancel = true
        assertEquals(ImportUploadRunStatus.CANCEL_REQUESTED, coordinator.requestCancel().status)
        assertTrue(f.saved().cancelRequested); assertEquals(ImportPhase.CANCEL_PENDING, f.saved().state.phase)
        assertEquals(ImportUploadRunStatus.CANCELLED, f.coordinator().transfer().status)
        assertEquals(1, f.cancellations); assertEquals(1, f.puts); assertEquals(0, f.completions)
    }

    @Test fun requestCancelWaitsForOwnTransferToStopBeforeCallingCancel() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator(); coordinator.select(uri, config)
        val started = CompletableDeferred<Unit>(); f.putHook = { started.complete(Unit); awaitCancellation() }
        val task = async { coordinator.transfer() }; started.await()
        assertEquals(ImportUploadRunStatus.CANCELLED, coordinator.requestCancel().status)
        assertEquals(ImportUploadRunStatus.PAUSED, task.await().status); assertEquals(0, f.puts); assertEquals(1, f.cancellations)
    }

    @Test fun verificationPendingRequiresExplicitReconciliationAndNeverPollsContinuously() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator(); coordinator.select(uri, config); f.pendingVerification = true
        assertEquals(ImportUploadRunStatus.RECONCILIATION_REQUIRED, coordinator.transfer().status)
        assertEquals(ImportPhase.VERIFYING, f.saved().state.phase); assertEquals(1, f.completions)
        f.coordinator().restore(); assertEquals(1, f.completions)
        f.pendingVerification = false
        assertEquals(ImportUploadRunStatus.UPLOADED, f.coordinator().reconcileOnce().status)
        assertEquals(2, f.completions); assertEquals(1, f.puts)
    }

    @Test fun uploadedButLostCompletionAckCanRecoverWithoutReadingThePhoneFileAgain() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator(); coordinator.select(uri, config); f.loseComplete = true
        coordinator.transfer(); assertEquals(ImportPhase.VERIFYING, f.saved().state.phase)
        val reads = f.inspectCount; f.sourceAvailable = false
        assertEquals(ImportUploadRunStatus.UPLOADED, f.coordinator().reconcileOnce().status)
        assertEquals(reads, f.inspectCount); assertEquals(1, f.completions)
    }

    @Test fun changedSourceAndWrongReselectionKeepOriginalIdentityAndDoNotSendRemainingBytes() = runBlocking {
        val f = fixture(GalleryImportPolicy.CHUNK_BYTES + 3); val coordinator = f.coordinator(); coordinator.select(uri, config)
        coordinator.transfer(maxParts = 1); val before = f.saved(); f.content[0] = (f.content[0] + 1).toByte()
        assertEquals("import_source_changed", f.coordinator().transfer().errorCode)
        assertEquals("import_source_changed", f.coordinator().reselectSource("content://synthetic-picker/different").errorCode)
        assertEquals(1, f.puts); assertEquals(before.state.selection, f.saved().state.selection)
        assertEquals(before.selectedContentUri, f.saved().selectedContentUri)
    }

    @Test fun correctReselectionRetainsExistingUploadKeyAndDoesNotCopyTokenOrUriIntoViews() = runBlocking {
        val f = fixture(GalleryImportPolicy.CHUNK_BYTES + 3); val coordinator = f.coordinator(); coordinator.select(uri, config)
        coordinator.transfer(maxParts = 1); val before = f.saved(); val replacement = "content://synthetic-picker/reselected-same-bytes"
        assertEquals(ImportUploadRunStatus.PAUSED, f.coordinator().reselectSource(replacement).status)
        assertEquals(before.uploadStartIdempotencyKey, f.saved().uploadStartIdempotencyKey)
        assertEquals(before.state.upload!!.ticket, f.saved().state.upload!!.ticket)
        assertEquals(replacement, f.saved().selectedContentUri)
        assertFalse(f.views.toString().contains(replacement)); assertFalse(f.views.toString().contains(f.token))
    }

    @Test fun accountChangeInvalidatesBlockedOldCallbacksAndDoesNotDisplayOrOverwriteForeignState() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator(); coordinator.select(uri, config)
        val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.putHook = { withContext(NonCancellable) { started.complete(Unit); release.await() } }
        val task = async { coordinator.transfer() }; started.await()
        val before = f.saved(); f.activeOwner = ImportOwner(UUID.randomUUID().toString(), UUID.randomUUID().toString())
        coordinator.invalidateSession(); val clearIndex = f.views.size; release.complete(Unit)
        assertEquals(ImportUploadRunStatus.SESSION_CHANGED, task.await().status)
        assertNull(coordinator.snapshot().state); assertTrue(f.views.drop(clearIndex).all { it.state == null })
        assertEquals(before.generation, f.saved().generation)
        assertNull(f.store.read(f.activeOwner!!))
    }

    @Test fun tokenRefreshEvenForSameOwnerRejectsOldCallbackAndNewCoordinatorCanResume() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator(); coordinator.select(uri, config)
        f.afterPutHook = { f.token = "new-synthetic-session"; coordinator.invalidateSession() }
        assertEquals(ImportUploadRunStatus.SESSION_CHANGED, coordinator.transfer().status)
        assertEquals(0, f.saved().state.upload!!.receipts.size)
        f.afterPutHook = null
        assertEquals(ImportUploadRunStatus.UPLOADED, f.coordinator().transfer().status)
        assertEquals(1, f.puts)
    }

    @Test fun distinctCoordinatorsCannotRunUnlimitedParallelWorkForSameOwner() = runBlocking {
        val f = fixture(); val first = f.coordinator(); first.select(uri, config)
        val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.startHook = { started.complete(Unit); release.await() }
        val task = async { first.transfer() }; started.await()
        assertEquals("import_operation_busy", f.coordinator().transfer().errorCode)
        assertEquals(1, f.startKeys.size); release.complete(Unit)
        assertEquals(ImportUploadRunStatus.UPLOADED, task.await().status)
    }

    @Test fun staleGenerationStopsBeforeStartPostAndNeverOverwritesNewerCheckpoint() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator(); coordinator.select(uri, config)
        f.capabilityHook = {
            val saved = f.saved(); f.store.write(f.owner, saved.generation, saved.copy(transferPaused = true)); f.capabilityHook = null
        }
        assertEquals("checkpoint_conflict", coordinator.transfer().errorCode)
        assertEquals(0, f.startKeys.size); assertEquals(2, f.saved().generation)
    }

    @Test fun changedPreviouslyAcknowledgedReceiptFailsWithoutResendingOrInventingReady() = runBlocking {
        val f = fixture(GalleryImportPolicy.CHUNK_BYTES + 1); val coordinator = f.coordinator(); coordinator.select(uri, config)
        coordinator.transfer(maxParts = 1); f.receipts[1] = f.receipts[1]!!.copy(sha256 = "0".repeat(64))
        assertEquals("import_transition_part_conflict", f.coordinator().transfer().errorCode)
        assertEquals(1, f.puts); assertFalse(f.saved().state.upload!!.serverVerified)
    }

    @Test fun createdRemoteStateAndDisabledOrWrongOwnerCapabilitiesDoNotLoopOrStartReplacement() = runBlocking {
        val f = fixture(); val coordinator = f.coordinator(); coordinator.select(uri, config); f.initialPhase = ImportServerPhase.CREATED
        assertEquals(ImportUploadRunStatus.RECONCILIATION_REQUIRED, coordinator.transfer().status)
        assertEquals(1, f.startKeys.size); assertEquals(0, f.puts); assertEquals(0, f.completions)
        f.enabled = false; assertEquals("import_owner_unavailable", f.coordinator().transfer().errorCode)
        f.enabled = true; f.capabilityOwner = f.owner.copy(userId = UUID.randomUUID().toString())
        assertEquals("import_owner_unavailable", f.coordinator().transfer().errorCode)
        assertEquals(1, f.startKeys.size)
    }
}
