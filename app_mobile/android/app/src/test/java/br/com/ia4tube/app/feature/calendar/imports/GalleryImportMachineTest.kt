package br.com.ia4tube.app.feature.calendar.imports

import org.junit.Assert.*
import org.junit.Test

class GalleryImportMachineTest {
    private val owner = ImportOwner("synthetic-company", "synthetic-user")
    private val foreignCompany = owner.copy(companyId = "other-company")
    private val foreignUser = owner.copy(userId = "other-user")
    private val hash = "a".repeat(64)
    private val photo = ImportSelection("local-selection", ImportMediaKind.IMAGE, "image/jpeg", GalleryImportPolicy.CHUNK_BYTES + 123L,
        1080, 1350, null, hash)
    private val config = ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE)
    private val ticket = ImportUploadTicket("upload-1", "original-asset-1", hash, photo.byteCount)
    private val available = ImportOperationalAvailability(true, true, true, true, true)
    private val intent = ImportScheduleIntent("schedule-1", 1, 10_000, "Synthetic caption")

    private fun accepted(machine: GalleryImportMachine, event: ImportEvent): GalleryImportState {
        val result = machine.dispatch(owner, event)
        assertTrue("Expected applied but was $result", result is ImportTransition.Applied)
        return machine.snapshot()!!
    }
    private fun rejected(machine: GalleryImportMachine, event: ImportEvent, reason: ImportRejection) {
        val before = machine.snapshot()
        assertEquals(ImportTransition.Rejected(reason), machine.dispatch(owner, event))
        assertEquals(before, machine.snapshot())
    }
    private fun started(configuration: ImportConfiguration = config, media: ImportSelection = photo,
                        tracks: List<AuthorizedImportTrack> = emptyList()): GalleryImportMachine = GalleryImportMachine(owner, tracks).also {
        accepted(it, ImportEvent.Begin("draft-1", media, configuration))
        accepted(it, ImportEvent.UploadStarted(1, ticket))
    }
    private fun uploaded(configuration: ImportConfiguration = config, media: ImportSelection = photo,
                         tracks: List<AuthorizedImportTrack> = emptyList()): GalleryImportMachine = started(configuration, media, tracks).also {
        accepted(it, ImportEvent.PartAcknowledged(ticket.uploadId, ImportPartReceipt(0, GalleryImportPolicy.CHUNK_BYTES, hash)))
        accepted(it, ImportEvent.PartAcknowledged(ticket.uploadId, ImportPartReceipt(1, 123, hash)))
        accepted(it, ImportEvent.UploadCompleted(ticket.uploadId, hash))
    }
    private fun ready(configuration: ImportConfiguration = config): GalleryImportMachine = uploaded(configuration).also {
        accepted(it, ImportEvent.PreparationStarted(1, ticket.assetId))
        accepted(it, ImportEvent.PreparationReady(1, ticket.assetId,
            configuration.targets.map { target -> ImportPreparedVariant(target, ImportMediaKind.IMAGE, "image/jpeg", "prepared-${target.wire}", hash) }))
    }
    private fun scheduling(): GalleryImportMachine = ready().also {
        accepted(it, ImportEvent.PreviewConfirmed(1))
        accepted(it, ImportEvent.AvailabilityObserved(available))
        accepted(it, ImportEvent.ScheduleRequested(intent, 100))
    }

    @Test fun selectingFileDoesNotScheduleOrAuthorizeExternalOperations() {
        val machine = GalleryImportMachine(owner)
        val state = accepted(machine, ImportEvent.Begin("draft-1", photo, config))
        assertEquals(ImportPhase.EDITING, state.phase)
        assertFalse(state.availability.allowed)
        assertFalse(state.canDisplayScheduled)
        assertNull(state.scheduleIntent)
    }

    @Test fun fullProgressRequiresExactOrderedPartsAndWholeChecksum() {
        val machine = started()
        rejected(machine, ImportEvent.PartAcknowledged(ticket.uploadId, ImportPartReceipt(1, 123, hash)), ImportRejection.INVALID_PART)
        rejected(machine, ImportEvent.PartAcknowledged(ticket.uploadId, ImportPartReceipt(0, 100, hash)), ImportRejection.INVALID_PART)
        rejected(machine, ImportEvent.UploadCompleted(ticket.uploadId, hash), ImportRejection.UPLOAD_INCOMPLETE)
        accepted(machine, ImportEvent.PartAcknowledged(ticket.uploadId, ImportPartReceipt(0, GalleryImportPolicy.CHUNK_BYTES, hash)))
        val progress = machine.snapshot()!!.upload!!
        assertEquals(1, progress.nextPart)
        assertEquals(GalleryImportPolicy.CHUNK_BYTES.toLong(), progress.acknowledgedBytes)
        accepted(machine, ImportEvent.PartAcknowledged(ticket.uploadId, ImportPartReceipt(1, 123, hash)))
        rejected(machine, ImportEvent.UploadCompleted(ticket.uploadId, "b".repeat(64)), ImportRejection.INVALID_CHECKSUM)
        assertEquals(ImportPhase.UPLOADED, accepted(machine, ImportEvent.UploadCompleted(ticket.uploadId, hash)).phase)
    }

    @Test fun repeatedPartAcknowledgementIsIdempotentButChangedBytesConflict() {
        val machine = started()
        val receipt = ImportPartReceipt(0, GalleryImportPolicy.CHUNK_BYTES, hash)
        accepted(machine, ImportEvent.PartAcknowledged(ticket.uploadId, receipt))
        accepted(machine, ImportEvent.PartAcknowledged(ticket.uploadId, receipt.copy(sha256 = hash.uppercase())))
        assertEquals(1, machine.snapshot()!!.upload!!.nextPart)
        rejected(machine, ImportEvent.PartAcknowledged(ticket.uploadId, receipt.copy(sha256 = "b".repeat(64))), ImportRejection.PART_CONFLICT)
        rejected(machine, ImportEvent.PartAcknowledged(ticket.uploadId, receipt.copy(bytes = 12)), ImportRejection.PART_CONFLICT)
    }

    @Test fun malformedPartAndForeignUploadAreRejected() {
        val machine = started()
        rejected(machine, ImportEvent.PartAcknowledged("foreign-upload", ImportPartReceipt(0, GalleryImportPolicy.CHUNK_BYTES, hash)), ImportRejection.INVALID_TICKET)
        rejected(machine, ImportEvent.PartAcknowledged(ticket.uploadId, ImportPartReceipt(-1, GalleryImportPolicy.CHUNK_BYTES, hash)), ImportRejection.INVALID_PART)
        rejected(machine, ImportEvent.PartAcknowledged(ticket.uploadId, ImportPartReceipt(0, GalleryImportPolicy.CHUNK_BYTES, "bad")), ImportRejection.INVALID_CHECKSUM)
    }

    @Test fun interruptedUploadRestoresOwnerBoundCheckpointWithoutFinalizingIt() {
        val original = started()
        accepted(original, ImportEvent.PartAcknowledged(ticket.uploadId, ImportPartReceipt(0, GalleryImportPolicy.CHUNK_BYTES, hash)))
        val checkpoint = original.uploadCheckpoint()!!
        val machine = GalleryImportMachine(owner)
        assertTrue(machine.restoreUpload(owner, checkpoint) is ImportTransition.Applied)
        assertEquals(1, machine.snapshot()!!.upload!!.nextPart)
        accepted(machine, ImportEvent.PartAcknowledged(ticket.uploadId, ImportPartReceipt(1, 123, hash)))
        assertEquals(ImportPhase.UPLOADING, machine.snapshot()!!.phase)
        accepted(machine, ImportEvent.UploadCompleted(ticket.uploadId, hash))
        assertEquals(ImportPhase.UPLOADED, machine.snapshot()!!.phase)
    }

    @Test fun completeCheckpointStillNeedsServerUploadConfirmation() {
        val checkpoint = uploaded().uploadCheckpoint()!!
        val machine = GalleryImportMachine(owner)
        assertTrue(machine.restoreUpload(owner, checkpoint) is ImportTransition.Applied)
        assertEquals(ImportPhase.UPLOADING, machine.snapshot()!!.phase)
        assertFalse(machine.snapshot()!!.canDisplayScheduled)
    }

    @Test fun otherCompanyOtherUserAndCorruptCheckpointsCannotRestore() {
        val checkpoint = started().uploadCheckpoint()!!
        for (foreign in listOf(foreignCompany, foreignUser)) {
            val machine = GalleryImportMachine(foreign)
            assertEquals(ImportTransition.Rejected(ImportRejection.WRONG_OWNER), machine.restoreUpload(foreign, checkpoint))
            assertNull(machine.snapshot())
        }
        val machine = GalleryImportMachine(owner)
        val malformed = checkpoint.copy(progress = checkpoint.progress.copy(receipts = listOf(ImportPartReceipt(2, 123, hash))))
        assertEquals(ImportTransition.Rejected(ImportRejection.INVALID_PART), machine.restoreUpload(owner, malformed))
        assertNull(machine.snapshot())
    }

    @Test fun changingSessionClearsMediaAndRejectsLateCallbacksFromPreviousTenant() {
        for (foreign in listOf(foreignCompany, foreignUser)) {
            val machine = ready()
            machine.changeSession(foreign)
            assertNull(machine.snapshot())
            assertEquals(ImportTransition.Rejected(ImportRejection.WRONG_OWNER), machine.dispatch(owner, ImportEvent.PreviewConfirmed(1)))
        }
        val machine = ready()
        machine.changeSession(null)
        assertNull(machine.snapshot())
        assertEquals(ImportTransition.Rejected(ImportRejection.WRONG_OWNER), machine.dispatch(owner, ImportEvent.Cancel))
    }

    @Test fun mediaChangeInvalidatesPreparedPreviewUploadAndRevision() {
        val machine = ready()
        accepted(machine, ImportEvent.PreviewConfirmed(1))
        val state = accepted(machine, ImportEvent.EditMedia(photo.copy(selectionId = "replacement", sha256 = "b".repeat(64))))
        assertEquals(2L, state.revision)
        assertEquals(ImportPhase.EDITING, state.phase)
        assertNull(state.upload)
        assertNull(state.previewConfirmedRevision)
        assertTrue(state.prepared.isEmpty())
        rejected(machine, ImportEvent.PreparationReady(1, ticket.assetId, emptyList()), ImportRejection.STALE_REVISION)
    }

    @Test fun formatOrAudioChangeInvalidatesPreviewButRetainsConfirmedOriginalUpload() {
        val machine = ready()
        accepted(machine, ImportEvent.PreviewConfirmed(1))
        val state = accepted(machine, ImportEvent.EditConfiguration(config.copy(targets = setOf(ImportTarget.STORY))))
        assertEquals(ImportPhase.UPLOADED, state.phase)
        assertEquals(ticket.assetId, state.upload!!.ticket.assetId)
        assertNull(state.previewConfirmedRevision)
        assertTrue(state.prepared.isEmpty())
        assertEquals(2L, state.revision)
    }

    @Test fun previewRequiresEveryCorrectTypedVariantNotAThumbnailOrOldRevision() {
        val machine = uploaded()
        accepted(machine, ImportEvent.PreparationStarted(1, ticket.assetId))
        rejected(machine, ImportEvent.PreviewConfirmed(1), ImportRejection.INVALID_PHASE)
        rejected(machine, ImportEvent.PreparationReady(0, ticket.assetId, emptyList()), ImportRejection.STALE_REVISION)
        rejected(machine, ImportEvent.PreparationReady(1, ticket.assetId, emptyList()), ImportRejection.INVALID_PREPARED_VARIANTS)
        rejected(machine, ImportEvent.PreparationReady(1, ticket.assetId,
            listOf(ImportPreparedVariant(ImportTarget.FEED, ImportMediaKind.VIDEO, "video/mp4", "asset", hash))), ImportRejection.INVALID_PREPARED_VARIANTS)
    }

    @Test fun noScheduleUntilPreviewExplicitlyConfirmedAndAllObservedConditionsAllow() {
        val machine = ready()
        rejected(machine, ImportEvent.ScheduleRequested(intent, 100), ImportRejection.PREVIEW_NOT_CONFIRMED)
        accepted(machine, ImportEvent.PreviewConfirmed(1))
        listOf(available.copy(connected = false), available.copy(ownerAllowed = false),
            available.copy(connectionGateOpen = false), available.copy(publicationGateOpen = false), available.copy(destinationsEligible = false)).forEach { blocked ->
            accepted(machine, ImportEvent.AvailabilityObserved(blocked))
            rejected(machine, ImportEvent.ScheduleRequested(intent, 100), ImportRejection.OPERATIONS_BLOCKED)
        }
        accepted(machine, ImportEvent.AvailabilityObserved(available))
        val pending = accepted(machine, ImportEvent.ScheduleRequested(intent, 100))
        assertEquals(ImportPhase.SCHEDULING, pending.phase)
        assertFalse(pending.canDisplayScheduled)
    }

    @Test fun onlyMatchingServerConfirmationAllowsScheduledLabel() {
        val machine = scheduling()
        rejected(machine, ImportEvent.ScheduleConfirmed("different-intent", 1, "calendar-1"), ImportRejection.INVALID_CONFIRMATION)
        rejected(machine, ImportEvent.ScheduleConfirmed(intent.idempotencyKey, 2, "calendar-1"), ImportRejection.INVALID_CONFIRMATION)
        val result = accepted(machine, ImportEvent.ScheduleConfirmed(intent.idempotencyKey, 1, "calendar-1"))
        assertTrue(result.canDisplayScheduled)
        assertEquals("calendar-1", result.calendarItemId)
        accepted(machine, ImportEvent.AvailabilityObserved(available.copy(publicationGateOpen = false)))
        assertFalse(machine.snapshot()!!.canDisplayScheduled)
    }

    @Test fun uncertainSchedulingKeepsSameIntentAndCannotBeEditedCancelledOrRepeatedWithNewKey() {
        val machine = scheduling()
        accepted(machine, ImportEvent.ScheduleResponseUncertain(intent.idempotencyKey))
        assertTrue(machine.snapshot()!!.scheduleResultUncertain)
        accepted(machine, ImportEvent.ScheduleRequested(intent, 100))
        assertTrue(machine.snapshot()!!.scheduleResultUncertain)
        rejected(machine, ImportEvent.ScheduleRequested(intent.copy(idempotencyKey = "second-post"), 100), ImportRejection.CONFLICTING_INTENT)
        rejected(machine, ImportEvent.EditMedia(photo), ImportRejection.INVALID_PHASE)
        rejected(machine, ImportEvent.Cancel, ImportRejection.INVALID_PHASE)
        rejected(machine, ImportEvent.Failed(1, ImportRejection.INVALID_CONFIRMATION), ImportRejection.INVALID_PHASE)
        assertNull(machine.uploadCheckpoint())
        accepted(machine, ImportEvent.ScheduleConfirmed(intent.idempotencyKey, 1, "calendar-1"))
        assertFalse(machine.snapshot()!!.scheduleResultUncertain)
    }

    @Test fun storyOnlyAllowsEmptyCaptionButFeedNeedsCaptionAndFutureTime() {
        val story = ready(config.copy(targets = setOf(ImportTarget.STORY)))
        accepted(story, ImportEvent.PreviewConfirmed(1))
        accepted(story, ImportEvent.AvailabilityObserved(available))
        accepted(story, ImportEvent.ScheduleRequested(intent.copy(caption = ""), 100))
        val feed = ready()
        accepted(feed, ImportEvent.PreviewConfirmed(1))
        accepted(feed, ImportEvent.AvailabilityObserved(available))
        rejected(feed, ImportEvent.ScheduleRequested(intent.copy(caption = ""), 100), ImportRejection.INVALID_SCHEDULE)
        rejected(feed, ImportEvent.ScheduleRequested(intent, 10_000), ImportRejection.INVALID_SCHEDULE)
        rejected(feed, ImportEvent.ScheduleRequested(intent.copy(caption = "x".repeat(2201)), 100), ImportRejection.INVALID_SCHEDULE)
    }

    @Test fun cancelBeforeSchedulingIsLocalAndCannotRestartWorkThroughLateCallback() {
        val machine = ready()
        val cancelled = accepted(machine, ImportEvent.Cancel)
        assertEquals(ImportPhase.CANCELLED, cancelled.phase)
        assertNull(cancelled.calendarItemId)
        assertNull(cancelled.previewConfirmedRevision)
        assertTrue(cancelled.prepared.isEmpty())
        rejected(machine, ImportEvent.PreviewConfirmed(1), ImportRejection.INVALID_PHASE)
        rejected(machine, ImportEvent.PreparationStarted(1, ticket.assetId), ImportRejection.INVALID_PHASE)
    }

    @Test fun mutableCallerCollectionsCannotChangeTargetsAfterValidation() {
        val targets = mutableSetOf(ImportTarget.FEED)
        val machine = started(config.copy(targets = targets))
        targets.clear()
        targets.add(ImportTarget.REEL)
        assertEquals(setOf(ImportTarget.FEED), machine.snapshot()!!.configuration.targets)
    }

    @Test fun uploadTicketMustMatchSelectionBytesHashChunkLimitAndRevision() {
        val machine = GalleryImportMachine(owner)
        accepted(machine, ImportEvent.Begin("draft-1", photo, config))
        rejected(machine, ImportEvent.UploadStarted(2, ticket), ImportRejection.STALE_REVISION)
        listOf(ticket.copy(totalBytes = 1), ticket.copy(chunkBytes = 1024), ticket.copy(selectionSha256 = "b".repeat(64)),
            ticket.copy(uploadId = "https://external.invalid/upload")).forEach { bad ->
            rejected(machine, ImportEvent.UploadStarted(1, bad), ImportRejection.INVALID_TICKET)
        }
    }

    @Test fun multipartServerUsesOneBasedNumbersWhileLocalProgressUsesZeroBasedIndex() {
        val first = ImportPartReceipt.fromServer(1, GalleryImportPolicy.CHUNK_BYTES, hash)
        assertEquals(0, first.part)
        assertEquals(1, first.serverPartNumber)
        val second = ImportPartReceipt.fromServer(2, 123, hash)
        assertEquals(1, second.part)
        assertEquals(2, second.serverPartNumber)
        assertThrows(IllegalArgumentException::class.java) { ImportPartReceipt.fromServer(0, 123, hash) }
        assertThrows(IllegalArgumentException::class.java) { ImportPartReceipt(-1, 123, hash).serverPartNumber }
    }

    @Test fun musicalPreviewMustMatchApprovedTrackAudioDurationAndIndependentFeedVariant() {
        val track = AuthorizedImportTrack("synthetic-licensed-track", true)
        val musical = ImportConfiguration(setOf(ImportTarget.FEED, ImportTarget.STORY), ImportAudioMode.MUSIC,
            track.id, setOf(ImportTarget.STORY))
        val machine = uploaded(musical, tracks = listOf(track))
        accepted(machine, ImportEvent.PreparationStarted(1, ticket.assetId))
        val feed = ImportPreparedVariant(ImportTarget.FEED, ImportMediaKind.IMAGE, "image/jpeg", "prepared-feed", hash)
        val story = ImportPreparedVariant(ImportTarget.STORY, ImportMediaKind.VIDEO, "video/mp4", "prepared-story", hash,
            ImportAudioMode.MUSIC, track.id, 15_000)
        for (bad in listOf(story.copy(audioMode = ImportAudioMode.MUTED), story.copy(musicTrackId = "wrong-track"), story.copy(durationMs = 60_000)))
            rejected(machine, ImportEvent.PreparationReady(1, ticket.assetId, listOf(feed, bad)), ImportRejection.INVALID_PREPARED_VARIANTS)
        accepted(machine, ImportEvent.PreparationReady(1, ticket.assetId, listOf(feed, story)))
        accepted(machine, ImportEvent.PreviewConfirmed(1))
        val silent = accepted(machine, ImportEvent.EditConfiguration(config))
        assertEquals(ImportPhase.UPLOADED, silent.phase)
        assertTrue(silent.prepared.isEmpty())
        assertNull(silent.previewConfirmedRevision)
    }

    @Test fun ownVideoPreviewMustRespectSelectedOriginalAudioOrSilence() {
        val video = photo.copy(kind = ImportMediaKind.VIDEO, mimeType = "video/mp4", durationMs = 30_000)
        for (mode in listOf(ImportAudioMode.ORIGINAL, ImportAudioMode.MUTED)) {
            val videoConfig = ImportConfiguration(setOf(ImportTarget.REEL), mode, shareToFeed = true)
            val machine = uploaded(videoConfig, video)
            accepted(machine, ImportEvent.PreparationStarted(1, ticket.assetId))
            val reel = ImportPreparedVariant(ImportTarget.REEL, ImportMediaKind.VIDEO, "video/mp4", "prepared-reel", hash,
                mode, durationMs = 30_000)
            rejected(machine, ImportEvent.PreparationReady(1, ticket.assetId, listOf(reel.copy(audioMode = ImportAudioMode.NONE))), ImportRejection.INVALID_PREPARED_VARIANTS)
            rejected(machine, ImportEvent.PreparationReady(1, ticket.assetId, listOf(reel.copy(durationMs = 60_001))), ImportRejection.INVALID_PREPARED_VARIANTS)
            accepted(machine, ImportEvent.PreparationReady(1, ticket.assetId, listOf(reel)))
            assertEquals(ImportPhase.READY, machine.snapshot()!!.phase)
        }
    }

    @Test fun musicalDurationMatchesServerToleranceInsteadOfDemandingExactEncoderLength() {
        val track = AuthorizedImportTrack("synthetic-licensed-track", true)
        val musical = ImportConfiguration(setOf(ImportTarget.STORY), ImportAudioMode.MUSIC, track.id, setOf(ImportTarget.STORY))
        for (duration in listOf(14_750L, 14_999L, 15_000L, 15_040L, 15_250L, 14_749L, 15_251L)) {
            val machine = uploaded(musical, tracks = listOf(track))
            accepted(machine, ImportEvent.PreparationStarted(1, ticket.assetId))
            val variant = ImportPreparedVariant(ImportTarget.STORY, ImportMediaKind.VIDEO, "video/mp4", "prepared-story", hash,
                ImportAudioMode.MUSIC, track.id, duration)
            val event = ImportEvent.PreparationReady(1, ticket.assetId, listOf(variant))
            if (duration in 14_750L..15_250L) accepted(machine, event)
            else rejected(machine, event, ImportRejection.INVALID_PREPARED_VARIANTS)
        }
    }

    @Test fun serverPhaseMapperRecognizesEveryUploadPhaseAndNeverAuthorizesReplacement() {
        val expected = mapOf("created" to ImportPhase.INITIALIZING, "uploading" to ImportPhase.UPLOADING,
            "verifying" to ImportPhase.VERIFYING, "uploaded" to ImportPhase.VERIFYING,
            "rejected" to ImportPhase.FAILED, "failed" to ImportPhase.FAILED,
            "cancel_pending" to ImportPhase.CANCEL_PENDING, "cancelled" to ImportPhase.CANCELLED)
        expected.forEach { (wire, phase) ->
            val mapped = mapImportUploadPhase(ImportServerPhase.fromWire(wire)!!)!!
            assertEquals(phase, mapped.phase)
            assertFalse(mapped.mayStartReplacementUpload)
            assertEquals(wire == "uploading", mapped.mayTransferParts)
        }
        assertTrue(mapImportUploadPhase(ImportServerPhase.VERIFYING)!!.requiresReconciliation)
        assertTrue(mapImportUploadPhase(ImportServerPhase.CANCEL_PENDING)!!.requiresReconciliation)
        assertNull(ImportServerPhase.fromWire("unknown"))
        assertNull(mapImportUploadPhase(ImportServerPhase.READY))
        assertNull(mapImportUploadPhase(ImportServerPhase.PREPARING))
    }

    @Test fun uncertainUploadVerificationKeepsAssetAndPartsAndCannotBecomeReplacementUpload() {
        val machine = started()
        accepted(machine, ImportEvent.PartAcknowledged(ticket.uploadId, ImportPartReceipt(0, GalleryImportPolicy.CHUNK_BYTES, hash)))
        accepted(machine, ImportEvent.PartAcknowledged(ticket.uploadId, ImportPartReceipt(1, 123, hash)))
        for (phase in listOf(ImportServerPhase.VERIFYING, ImportServerPhase.UPLOADED)) {
            val pending = accepted(machine, ImportEvent.UploadPhaseObserved(ticket.uploadId, phase))
            assertEquals(ImportPhase.VERIFYING, pending.phase)
            assertEquals(ticket, pending.upload!!.ticket)
            assertEquals(2, pending.upload.nextPart)
            assertFalse(pending.canDisplayScheduled)
            rejected(machine, ImportEvent.UploadStarted(1, ticket.copy(uploadId = "replacement")), ImportRejection.INVALID_PHASE)
            rejected(machine, ImportEvent.EditMedia(photo), ImportRejection.INVALID_PHASE)
            rejected(machine, ImportEvent.Cancel, ImportRejection.INVALID_PHASE)
            rejected(machine, ImportEvent.Failed(1, ImportRejection.INVALID_CONFIRMATION), ImportRejection.INVALID_PHASE)
        }
        accepted(machine, ImportEvent.UploadCompleted(ticket.uploadId, hash))
        assertEquals(ImportPhase.UPLOADED, machine.snapshot()!!.phase)
    }

    @Test fun initializationAndPendingCancellationWaitForSameBackendUpload() {
        val machine = GalleryImportMachine(owner)
        accepted(machine, ImportEvent.Begin("draft-1", photo, config))
        val pending = accepted(machine, ImportEvent.UploadStarted(1, ticket, ImportServerPhase.CREATED))
        assertEquals(ImportPhase.INITIALIZING, pending.phase)
        rejected(machine, ImportEvent.PartAcknowledged(ticket.uploadId, ImportPartReceipt(0, GalleryImportPolicy.CHUNK_BYTES, hash)), ImportRejection.INVALID_PHASE)
        accepted(machine, ImportEvent.UploadPhaseObserved(ticket.uploadId, ImportServerPhase.UPLOADING))
        accepted(machine, ImportEvent.UploadPhaseObserved(ticket.uploadId, ImportServerPhase.CANCEL_PENDING))
        assertEquals(ImportPhase.CANCEL_PENDING, machine.snapshot()!!.phase)
        assertEquals(ticket, machine.snapshot()!!.upload!!.ticket)
        rejected(machine, ImportEvent.UploadPhaseObserved(ticket.uploadId, ImportServerPhase.UPLOADING), ImportRejection.INVALID_PHASE)
        rejected(machine, ImportEvent.UploadStarted(1, ticket), ImportRejection.INVALID_PHASE)
        rejected(machine, ImportEvent.EditMedia(photo), ImportRejection.INVALID_PHASE)
        accepted(machine, ImportEvent.UploadPhaseObserved(ticket.uploadId, ImportServerPhase.CANCELLED))
        assertEquals(ImportPhase.CANCELLED, machine.snapshot()!!.phase)
    }

    @Test fun explicitBackendRejectionIsFailureNotImplicitReuploadOrPreparedMedia() {
        val machine = started()
        val rejected = accepted(machine, ImportEvent.UploadPhaseObserved(ticket.uploadId, ImportServerPhase.REJECTED))
        assertEquals(ImportPhase.FAILED, rejected.phase)
        assertEquals(ticket, rejected.upload!!.ticket)
        assertFalse(rejected.canDisplayScheduled)
        rejected(machine, ImportEvent.UploadStarted(1, ticket), ImportRejection.INVALID_PHASE)
    }

    @Test fun serverVerifiedUploadRecoversLostLocalReceiptsWithoutFabricatingParts() {
        val machine = started()
        accepted(machine, ImportEvent.UploadPhaseObserved(ticket.uploadId, ImportServerPhase.UPLOADED))
        rejected(machine, ImportEvent.UploadCompleted(ticket.uploadId, hash), ImportRejection.UPLOAD_INCOMPLETE)
        rejected(machine, ImportEvent.UploadCompleted(ticket.uploadId, hash, photo.byteCount + 1, photo.mimeType), ImportRejection.INVALID_CONFIRMATION)
        val recovered = accepted(machine, ImportEvent.UploadCompleted(ticket.uploadId, hash, photo.byteCount, photo.mimeType))
        assertEquals(ImportPhase.UPLOADED, recovered.phase)
        assertTrue(recovered.upload!!.serverVerified)
        assertTrue(recovered.upload.complete)
        assertTrue(recovered.upload.receipts.isEmpty())
        assertEquals(0L, recovered.upload.acknowledgedBytes)
    }
}
