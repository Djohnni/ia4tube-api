package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
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
@OptIn(ExperimentalCoroutinesApi::class)
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
    private inner class Fixture(val root: File, size: Int = 17, val video: Boolean = false) {
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
        val diagnosticEvents = mutableListOf<ImportMediaDiagnosticEvent>()
        var throwingDiagnostics = false
        var singleSupported = false
        val startModes = mutableListOf<Boolean>()
        var wholeStreams = 0
        val source = object : GalleryImportUploadSource {
            override fun retain(uri: String) = sourceAvailable
            override suspend fun inspect(uri: String): ImportSelection {
                inspectCount++; if (!sourceAvailable) throw ImportSourceFailure()
                return ImportSelection(UUID.randomUUID().toString(), if (video) ImportMediaKind.VIDEO else ImportMediaKind.IMAGE,
                    if (video) "video/mp4" else "image/png", content.size.toLong(), 10, 10, if (video) 16000L else null, hash(content))
            }
            override suspend fun part(uri: String, selection: ImportSelection, index: Int): ByteArray {
                if (!sourceAvailable) throw ImportSourceFailure()
                readParts.add(index)
                val start = index * GalleryImportPolicy.CHUNK_BYTES
                return content.copyOfRange(start, minOf(content.size, start + GalleryImportPolicy.CHUNK_BYTES))
            }
            override fun openWholeFile(uri: String): java.io.InputStream {
                if (!sourceAvailable) throw ImportSourceFailure()
                wholeStreams++
                return content.inputStream()
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
        var pendingRecordCode: String? = null
        var pendingCompleteReturnsRecord = false
        var statusHook: (suspend () -> ImportUploadRecord)? = null
        var completeError: ImportApiFailure? = null
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
        val statusIds = mutableListOf<String>()
        var cancellations = 0
        val transport = object : GalleryImportUploadTransport {
            override suspend fun capabilities(): ImportCapabilities {
                capabilityHook?.invoke()
                return ImportCapabilities(enabled, capabilityOwner, "https://ia4tube-api.onrender.com",
                    maxImageBytes = GalleryImportPolicy.IMAGE_MAX_BYTES, maxVideoBytes = GalleryImportPolicy.VIDEO_MAX_BYTES,
                    googleStorage = if (singleSupported) ImportGoogleStorageProfile("synthetic-bucket", "ready-video/", true) else null)
            }
            override suspend fun start(owner: ImportOwner, media: ImportSelection, key: String) = startMode(owner, media, key, false)
            override suspend fun startSingleVideo(owner: ImportOwner, media: ImportSelection, key: String) = startMode(owner, media, key, true)
            private suspend fun startMode(owner: ImportOwner, media: ImportSelection, key: String, single: Boolean): ImportUploadRecord {
                val saved = store.read(owner)!!
                assertTrue(saved.uploadStartIssued); assertEquals(key, saved.uploadStartIdempotencyKey)
                assertEquals(single, saved.singleVideoStartRequested); startModes.add(single)
                startKeys.add(key); startHook?.invoke()
                if (serverRecord == null) {
                    creations++
                    serverRecord = ImportUploadRecord(UUID.randomUUID().toString(), UUID.randomUUID().toString(), media.kind, media.mimeType,
                        media.byteCount, if (single) media.byteCount.toInt() else GalleryImportPolicy.CHUNK_BYTES,
                        if (single) 1 else ((media.byteCount + GalleryImportPolicy.CHUNK_BYTES - 1) / GalleryImportPolicy.CHUNK_BYTES).toInt(),
                        initialPhase, null, singleRequestVideo = single)
                }
                if (loseStart) { loseStart = false; throw ImportApiFailure("synthetic_ack_lost", resultUncertain = true) }
                return serverRecord!!
            }
            override suspend fun resume(owner: ImportOwner, uploadId: String): ImportUploadRecord {
                resumes++; assertEquals(uploadId, serverRecord!!.uploadId)
                return serverRecord!!.copy(completedParts = if (serverRecord!!.phase == ImportServerPhase.UPLOADING) receipts.values.toList() else emptyList())
            }
            override suspend fun status(owner: ImportOwner, uploadId: String): ImportUploadRecord {
                statusIds.add(uploadId); assertEquals(uploadId, serverRecord!!.uploadId)
                return statusHook?.invoke() ?: serverRecord!!
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
            override suspend fun putWholeFile(grant: ImportPartGrant, file: ImportWholeVideoFile, progress: (Long, Long) -> Unit) {
                assertEquals(file.sizeBytes, content.size)
                file.open().use { putPart(grant, it.readBytes(), progress) }
            }
            override suspend fun complete(owner: ImportOwner, uploadId: String): ImportUploadRecord {
                completions++; assertEquals(ImportPhase.VERIFYING, store.read(owner)!!.state.phase)
                completeError?.let { throw it }
                if (pendingVerification) {
                    serverRecord = serverRecord!!.copy(phase = ImportServerPhase.VERIFYING, errorCode = pendingRecordCode)
                    if (pendingCompleteReturnsRecord) return serverRecord!!
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
        fun coordinator(storeOverride: PrivateImportCheckpointStore = store, io: CoroutineDispatcher = Dispatchers.IO,
            changed: (ImportUploadRunView) -> Unit = {}) = GalleryImportUploadCoordinator(
            { activeOwner }, { token }, source, storeOverride, { transport }, io = io,
            onChanged = { synchronized(views) { views.add(it) }; changed(it) },
            diagnostics = ImportMediaDiagnostics({ event ->
                synchronized(diagnosticEvents) { diagnosticEvents.add(event) }
                if (throwingDiagnostics) throw AssertionError("synthetic-private-sink-error")
            }))
        fun saved() = store.read(owner)!!
    }
    private fun fixture(size: Int = 17) = Fixture(temporary.newFolder(), size)

    private fun Fixture.preUploadIntent(accepted: Boolean) {
        val old = saved()
        store.write(owner, old.generation, old.copy(calendarSubmission = ImportCalendarSubmissionIntent(
            "same-calendar-key", old.state.revision, 0, "Frozen caption", ImportCalendarSchedule("2026-11-03", "12:00"), true),
            calendarSubmissionAcceptedBeforeUpload = accepted))
    }

    @Test fun reservationSendsNoMediaAndUnacceptedCalendarIntentCannotAuthorizePut() = runBlocking {
        val f = Fixture(temporary.newFolder(), 1024, true).apply { singleSupported = true }
        val coordinator = f.coordinator()
        coordinator.select(uri, ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL))
        coordinator.reserve()
        assertEquals(1, f.creations); assertEquals(0, f.puts); assertEquals(0, f.completions)
        f.preUploadIntent(accepted = false)
        val refused = coordinator.transfer()
        assertEquals("import_calendar_acceptance_required", refused.errorCode)
        assertEquals(0, f.puts); assertNotNull(f.store.read(f.owner))
    }

    @Test fun acceptedIntentStopsAfterWholePutAndProcessRestartDoesNotCompleteOrResend() = runBlocking {
        val f = Fixture(temporary.newFolder(), 6_000_000, true).apply { singleSupported = true }
        val coordinator = f.coordinator()
        coordinator.select(uri, ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL)); coordinator.reserve()
        f.preUploadIntent(accepted = true)
        val sent = coordinator.transfer()
        assertTrue(sent.transportReceived); assertFalse(sent.state!!.upload!!.serverVerified)
        assertEquals(1, f.puts); assertEquals(0, f.completions)
        assertTrue(f.saved().wholeVideoPutSucceeded); assertEquals(uri, f.saved().selectedContentUri)
        f.sourceAvailable = false
        val reopened = f.coordinator()
        assertTrue(reopened.restore().transportReceived)
        assertTrue(reopened.reserve().transportReceived); assertTrue(reopened.transfer().transportReceived)
        assertEquals(1, f.puts); assertEquals(0, f.completions); assertEquals(1, f.creations)
    }

    @Test fun lostWholePutAcknowledgementUsesServerReceiptWithoutCompleteOrSecondPut() = runBlocking {
        val f = Fixture(temporary.newFolder(), 1024, true).apply { singleSupported = true; losePut = true }
        val coordinator = f.coordinator()
        coordinator.select(uri, ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL)); coordinator.reserve()
        f.preUploadIntent(accepted = true)
        assertFalse(coordinator.transfer().transportReceived)
        assertFalse(f.saved().wholeVideoPutSucceeded)
        f.sourceAvailable = false
        assertTrue(f.coordinator().transfer().transportReceived)
        assertEquals(1, f.puts); assertEquals(0, f.completions)
    }

    @Test fun pendingAcceptedCalendarIntentCanBeCancelledBeforePutWithoutLosingOriginal() = runBlocking {
        val f = Fixture(temporary.newFolder(), 1024, true).apply { singleSupported = true }
        val coordinator = f.coordinator()
        coordinator.select(uri, ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL)); coordinator.reserve()
        f.preUploadIntent(accepted = true)
        assertThrows(ImportCheckpointFailure::class.java) { f.store.clear(f.owner, f.saved().generation, f.saved().state.draftId) }
        assertEquals(ImportUploadRunStatus.CANCELLED, coordinator.requestCancel().status)
        assertEquals(uri, f.saved().selectedContentUri); assertEquals(0, f.puts)
        assertEquals(ImportUploadRunStatus.EMPTY, coordinator.discardCancelledDraft().status)
        assertTrue(f.sourceAvailable); assertEquals(1, f.cancellations)
    }

    @Test fun twentyTwoMegabyteVideoUsesOneWholeTransferWithOneReceiptAndNoPartArray() = runBlocking {
        val f = Fixture(temporary.newFolder(), 22_225_691, true).apply { singleSupported = true }
        val coordinator = f.coordinator()
        coordinator.select(uri, ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL))
        val result = coordinator.transfer()
        assertEquals(ImportUploadRunStatus.UPLOADED, result.status)
        assertEquals(listOf(true), f.startModes); assertEquals(1, f.puts)
        assertTrue(f.readParts.isEmpty()); assertEquals(2, f.wholeStreams)
        assertEquals(22_225_691, result.state!!.upload!!.ticket.chunkBytes)
        assertTrue(result.state.upload!!.ticket.singleRequestVideo)
        assertEquals(1, result.state.upload!!.receipts.size)
        assertEquals(f.content.size, f.received[1]!!.size)
        assertTrue(f.saved().singleVideoStartRequested)
    }

    @Test fun fullVideoLostReceiptReconcilesSameUploadWithoutAnotherPut() = runBlocking {
        val f = Fixture(temporary.newFolder(), 6_000_000, true).apply { singleSupported = true; losePut = true }
        val coordinator = f.coordinator()
        coordinator.select(uri, ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL))
        assertEquals(ImportUploadRunStatus.RECONCILIATION_REQUIRED, coordinator.transfer().status)
        assertEquals(1, f.puts)
        f.sourceAvailable = false
        assertEquals(ImportUploadRunStatus.UPLOADED, f.coordinator().transfer().status)
        assertEquals(1, f.puts); assertEquals(1, f.creations)
    }

    @Test fun fullVideoLostStartPreservesOptInAcrossProcessRestart() = runBlocking {
        val f = Fixture(temporary.newFolder(), 6_000_000, true).apply { singleSupported = true; loseStart = true }
        val coordinator = f.coordinator()
        coordinator.select(uri, ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL))
        assertEquals(ImportUploadRunStatus.RECONCILIATION_REQUIRED, coordinator.transfer().status)
        assertTrue(f.saved().singleVideoStartRequested)
        assertEquals(ImportUploadRunStatus.UPLOADED, f.coordinator().transfer().status)
        assertEquals(listOf(true, true), f.startModes)
        assertEquals(1, f.creations); assertEquals(1, f.puts)
    }

    @Test fun oldUncertainVideoStartDoesNotChangeRequestWhenNewCapabilityAppears() = runBlocking {
        val f = Fixture(temporary.newFolder(), 6_000_000, true).apply { loseStart = true }
        val coordinator = f.coordinator()
        coordinator.select(uri, ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL))
        assertEquals(ImportUploadRunStatus.RECONCILIATION_REQUIRED, coordinator.transfer().status)
        f.singleSupported = true
        assertEquals(ImportUploadRunStatus.UPLOADED, f.coordinator().transfer().status)
        assertEquals(listOf(false, false), f.startModes); assertEquals(2, f.puts)
        assertFalse(f.saved().state.upload!!.ticket.singleRequestVideo)
        assertEquals(0, f.wholeStreams)
    }

    @Test fun legacyPartialVideoResumesSameGeometryAfterSingleModeBecomesAvailable() = runBlocking {
        val f = Fixture(temporary.newFolder(), 6_000_000, true)
        val coordinator = f.coordinator()
        coordinator.select(uri, ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL))
        assertEquals(ImportUploadRunStatus.PAUSED, coordinator.transfer(maxParts = 1).status)
        f.singleSupported = true
        assertEquals(ImportUploadRunStatus.UPLOADED, f.coordinator().transfer().status)
        assertEquals(listOf(false), f.startModes); assertEquals(2, f.puts)
        assertEquals(listOf(0, 1), f.readParts)
    }

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

    @Test fun fivePartSourceResumesAfterFirstReceiptWithoutNewUploadOrChangingIndices() = runBlocking {
        val f = fixture(22_225_691); val first = f.coordinator(); first.select(uri, config)
        first.transfer(maxParts = 1); val saved = f.saved()
        assertEquals(5_242_880L, saved.state.upload!!.acknowledgedBytes)
        assertEquals(ImportUploadRunStatus.UPLOADED, f.coordinator().transfer().status)
        assertEquals(listOf(0, 1, 2, 3, 4), f.readParts)
        assertEquals(5, f.puts); assertEquals(1, f.creations); assertEquals(1, f.startKeys.size)
        assertEquals(saved.state.upload.ticket, f.saved().state.upload!!.ticket)
        assertEquals(1_254_171, f.received[5]!!.size)
        assertTrue(f.diagnosticEvents.isEmpty())
    }

    @Test fun changedFirstReceiptGetsSafeStageAndCanResumeSameSourceAfterServerObservationIsCorrected() = runBlocking {
        val f = fixture(GalleryImportPolicy.CHUNK_BYTES + 7); val first = f.coordinator(); first.select(uri, config)
        first.transfer(maxParts = 1); val saved = f.saved(); val receipt = f.receipts[1]!!
        f.receipts[1] = receipt.copy(sha256 = "f".repeat(64)); f.throwingDiagnostics = true
        val rejected = f.coordinator().transfer()
        assertEquals("import_transition_part_conflict", rejected.errorCode)
        assertEquals(1, f.puts); assertEquals(1, f.grants.size)
        val event = f.diagnosticEvents.single()
        assertEquals(ImportMediaStage.RECEIPT_VALIDATION, event.stage)
        assertEquals(ImportMediaFailureReason.RECEIPT_CONFLICT, event.reason)
        assertFalse(event.fixedMessage().contains(uri)); assertFalse(event.fixedMessage().contains(f.token))
        assertEquals(saved.state.upload!!.ticket, f.saved().state.upload!!.ticket)
        assertEquals(saved.uploadStartIdempotencyKey, f.saved().uploadStartIdempotencyKey)
        f.receipts[1] = receipt
        assertEquals(ImportUploadRunStatus.UPLOADED, f.coordinator().transfer().status)
        assertEquals(1, f.creations); assertEquals(2, f.puts)
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

    @Test fun explicitPendingInspectionCompletesAfterThirtyOneSecondsWithoutNewUploadOrCompletePost() = runTest {
        val f = fixture(); val coordinator = f.coordinator(io = StandardTestDispatcher(testScheduler))
        coordinator.select(uri, config); f.pendingVerification = true; f.pendingRecordCode = "import_verification_pending"
        f.statusHook = {
            if (testScheduler.currentTime >= 31_000) f.serverRecord = f.serverRecord!!.copy(
                phase = ImportServerPhase.UPLOADED, verifiedSha256 = hash(f.content), errorCode = null)
            f.serverRecord!!
        }
        val result = coordinator.transfer()
        assertEquals(ImportUploadRunStatus.UPLOADED, result.status)
        assertTrue(result.state!!.upload!!.serverVerified)
        assertTrue(testScheduler.currentTime in 31_000L..33_000L)
        assertEquals(1, f.creations); assertEquals(1, f.puts); assertEquals(1, f.completions)
        assertTrue(f.statusIds.size > 1)
        assertEquals(setOf(f.serverRecord!!.uploadId), f.statusIds.toSet())
        assertTrue(f.views.any { it.state?.phase == ImportPhase.VERIFYING && it.errorCode == null })
        assertTrue(result.state.prepared.isEmpty()); assertFalse(result.state.canDisplayScheduled)
    }

    @Test fun pendingRecordErrorKeepsTheSameRuntimeActionWaitingThenSubmitsExactlyOnce() = runTest {
        val f = fixture(); val io = StandardTestDispatcher(testScheduler)
        f.coordinator(io = io).select(uri, config)
        f.pendingVerification = true; f.pendingRecordCode = "import_verification_pending"
        f.statusHook = {
            if (testScheduler.currentTime >= 31_000) f.serverRecord = f.serverRecord!!.copy(
                phase = ImportServerPhase.UPLOADED, verifiedSha256 = hash(f.content), errorCode = null)
            f.serverRecord!!
        }
        var submissions = 0
        val chosen = ImportCalendarSchedule("2026-10-30", "09:30")
        val runtime = GalleryImportWorkflowRuntime(f.owner, f.token, { f.token }, ImportCapabilities(true, f.owner,
            preparationEnabled = true, calendarSubmissionEnabled = true), this,
            { _, changed -> CoordinatedGalleryImportUpload(f.coordinator(io = io, changed = changed)) },
            { _, changed -> object : GalleryImportPreparationControl {
                override suspend fun restore() = ImportPreparationRunView(ImportPreparationRunStatus.UPLOAD_REQUIRED, f.saved().state).also(changed)
                override suspend fun configure(value: ImportConfiguration) = restore()
                override suspend fun request() = restore()
                override suspend fun reconcileOnce() = restore()
                override suspend fun adoptGenerated(id: String, revision: Long) = restore()
                override suspend fun confirmPreview(value: ImportPreviewConfirmation) = restore()
                override suspend fun schedule(caption: String, at: Long, automatic: Boolean) = restore()
                override suspend fun reconcileScheduleOnce() = restore()
                override suspend fun finishScheduledDraft() = restore()
                override suspend fun submitToCalendar(caption: String, schedule: ImportCalendarSchedule?): ImportPreparationRunView {
                    assertTrue(f.saved().state.upload!!.serverVerified); assertEquals(chosen, schedule)
                    submissions++
                    return ImportPreparationRunView(ImportPreparationRunStatus.CALENDAR_ACCEPTED,
                        calendarSubmissionReceipt = ImportCalendarSubmissionReceipt("d".repeat(40), f.serverRecord!!.assetId,
                            f.serverRecord!!.uploadId, "one-calendar-intent", "accepted", null, 0, chosen.date, chosen.time, caption, null)).also(changed)
                }
                override fun pause() = Unit
                override fun invalidateSession() = Unit
            } })
        runtime.start(); advanceUntilIdle()
        runtime.addToCalendar("Caption", chosen); runCurrent()
        advanceTimeBy(10_000); runCurrent()
        assertTrue(runtime.state.value.busy); assertEquals(0, submissions)
        val waiting = galleryImportUploadPresentation(runtime.state.value.upload, busy = true,
            foreground = true, initialized = true, sessionValid = true)
        assertEquals("Conferindo o arquivo no servidor…", waiting.title)
        runtime.addToCalendar("Duplicate tap", chosen); runCurrent()
        advanceUntilIdle()
        assertFalse(runtime.state.value.busy); assertEquals(1, submissions)
        assertEquals(1, f.creations); assertEquals(1, f.puts); assertEquals(1, f.completions)
        assertEquals(setOf(f.serverRecord!!.uploadId), f.statusIds.toSet())
        assertTrue(f.statusIds.size > 1); assertTrue(testScheduler.currentTime in 31_000L..33_000L)
        assertEquals("accepted", runtime.state.value.preparation!!.calendarSubmissionReceipt!!.state)
        assertNull(runtime.state.value.draft)
        runtime.dispose()
    }

    @Test fun aRealVerifyingRecordErrorStillStopsPollingWithoutSubmittingOrReplacingTheUpload() = runTest {
        val f = fixture(); val coordinator = f.coordinator(io = StandardTestDispatcher(testScheduler))
        coordinator.select(uri, config); f.pendingVerification = true; f.pendingRecordCode = "import_media_invalid"
        val result = coordinator.transfer()
        assertEquals("import_media_invalid", result.errorCode)
        assertEquals(1, f.statusIds.size); assertEquals(2_000L, testScheduler.currentTime)
        assertEquals(1, f.creations); assertEquals(1, f.puts); assertEquals(1, f.completions)
        assertFalse(result.state!!.upload!!.serverVerified)
    }

    @Test fun aVerifyingCompleteRecordWithTheExpectedPendingCodeAlsoWaitsForUploaded() = runTest {
        val f = fixture(); val coordinator = f.coordinator(io = StandardTestDispatcher(testScheduler))
        coordinator.select(uri, config)
        f.pendingVerification = true; f.pendingRecordCode = "import_verification_pending"; f.pendingCompleteReturnsRecord = true
        f.statusHook = {
            if (testScheduler.currentTime >= 6_000) f.serverRecord = f.serverRecord!!.copy(
                phase = ImportServerPhase.UPLOADED, verifiedSha256 = hash(f.content), errorCode = null)
            f.serverRecord!!
        }
        assertEquals(ImportUploadRunStatus.UPLOADED, coordinator.transfer().status)
        assertEquals(6_000L, testScheduler.currentTime); assertEquals(3, f.statusIds.size)
        assertEquals(1, f.completions); assertEquals(1, f.puts); assertEquals(1, f.creations)
    }

    @Test fun pendingWaitStopsAtFiveMinutesAndRestoreDoesNotRestartPolling() = runTest {
        val f = fixture(); val io = StandardTestDispatcher(testScheduler)
        val coordinator = f.coordinator(io = io); coordinator.select(uri, config); f.pendingVerification = true
        f.pendingRecordCode = "import_verification_pending"
        val result = coordinator.transfer()
        assertEquals(300_000L, testScheduler.currentTime)
        assertEquals(ImportUploadRunStatus.RECONCILIATION_REQUIRED, result.status)
        assertEquals("import_verification_pending", result.errorCode)
        assertEquals(ImportPhase.VERIFYING, f.saved().state.phase)
        assertTrue(f.statusIds.size in 1..150)
        val observed = f.statusIds.size
        f.coordinator(io = io).restore()
        assertEquals(observed, f.statusIds.size)
        assertEquals(1, f.completions); assertEquals(1, f.puts); assertEquals(1, f.creations)
    }

    @Test fun pendingWaitCanBePausedWithoutCancellingOrReplacingTheServerUpload() = runTest {
        val f = fixture(); val coordinator = f.coordinator(io = StandardTestDispatcher(testScheduler))
        coordinator.select(uri, config); f.pendingVerification = true
        val observing = CompletableDeferred<Unit>()
        f.statusHook = { observing.complete(Unit); awaitCancellation() }
        val task = async { coordinator.transfer() }; observing.await(); coordinator.pause()
        assertEquals(ImportUploadRunStatus.PAUSED, task.await().status)
        assertEquals(ImportPhase.VERIFYING, f.saved().state.phase)
        assertEquals(1, f.completions); assertEquals(1, f.statusIds.size)
        assertEquals(1, f.puts); assertEquals(1, f.creations); assertEquals(0, f.cancellations)
    }

    @Test fun sessionChangeDuringPendingObservationCannotContinueOrExposeAnotherOwner() = runTest {
        val f = fixture(); val coordinator = f.coordinator(io = StandardTestDispatcher(testScheduler))
        coordinator.select(uri, config); f.pendingVerification = true
        f.statusHook = { f.token = "different-session"; f.serverRecord!! }
        assertEquals(ImportUploadRunStatus.SESSION_CHANGED, coordinator.transfer().status)
        assertEquals(1, f.statusIds.size); assertEquals(1, f.completions)
        assertEquals(1, f.puts); assertEquals(1, f.creations)
        assertEquals(ImportPhase.VERIFYING, f.saved().state.phase)
    }

    @Test fun otherUncertainCompleteFailureNeverStartsAnAutomaticStatusLoop() = runTest {
        val f = fixture(); val coordinator = f.coordinator(io = StandardTestDispatcher(testScheduler))
        coordinator.select(uri, config)
        f.completeError = ImportApiFailure("import_request_rejected", 503, true)
        val result = coordinator.transfer()
        assertEquals(ImportUploadRunStatus.RECONCILIATION_REQUIRED, result.status)
        assertEquals("import_request_rejected", result.errorCode)
        assertTrue(f.statusIds.isEmpty()); assertEquals(1, f.completions)
        assertEquals(1, f.puts); assertEquals(1, f.creations)
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
