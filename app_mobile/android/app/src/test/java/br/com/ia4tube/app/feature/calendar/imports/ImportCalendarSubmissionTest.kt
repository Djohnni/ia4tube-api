package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ImportCalendarSubmissionTest {
    @get:Rule val temporary = TemporaryFolder()
    private val data = ImportPreparationTestData
    // Synthetic test-only envelope; production uses the existing authenticated Android cipher.
    private class FixtureCipher : ImportCheckpointCipher {
        override fun encrypt(scope: String, plain: ByteArray) = ByteArray(28) + plain
        override fun decrypt(scope: String, sealed: ByteArray) = sealed.copyOfRange(28, sealed.size)
    }
    private inner class Fixture(uploaded: Boolean = true) {
        val store = PrivateImportCheckpointStore(temporary.newFolder(), FixtureCipher())
        var owner: ImportOwner? = data.owner
        var token = "synthetic-calendar-session"
        var posts = 0; var gets = 0; var previews = 0; var oldPreparationPosts = 0
        var loseAck = false; var accept = true
        var postFailure: ImportApiFailure? = null
        var lookupFailure: ImportApiFailure? = null
        var recoverReceipt = false
        var receipt: ImportCalendarSubmissionReceipt? = null
        var afterAccept: (() -> Unit)? = null
        val keys = mutableListOf<String>()
        val submittedIntents = mutableListOf<ImportCalendarSubmissionIntent>()
        var record = ImportPreparationProtocol.parseRecord(data.awaiting())
        init {
            val state = GalleryImportState(data.owner, "submission-draft", data.selection, data.config,
                phase = if (uploaded) ImportPhase.UPLOADED else ImportPhase.EDITING,
                upload = if (uploaded) ImportUploadProgress(ImportUploadTicket(data.uploadId, data.assetId, data.sourceSha,
                    data.selection.byteCount), serverVerified = true) else null)
            store.write(data.owner, 0, ImportDurableCheckpoint(1, state, "content://synthetic/original", "synthetic-upload-key",
                uploadStartIssued = uploaded))
        }
        val transport = object : GalleryImportPreparationTransport {
            override suspend fun capabilities() = ImportCapabilities(true, owner, preparationEnabled = true, schedulingEnabled = true, calendarSubmissionEnabled = true)
            override suspend fun status(owner: ImportOwner, assetId: String) = record
            override suspend fun request(owner: ImportOwner, assetId: String, uploadId: String, intent: ImportPreparationIntent,
                kind: ImportMediaKind, configuration: ImportConfiguration): ImportPreparationRecord {
                oldPreparationPosts++; error("New submissions must not use the old preparation POST")
            }
            override suspend fun preview(owner: ImportOwner, record: ImportPreparationRecord): ImportPrivatePreview {
                previews++; error("Adding must not load a preview")
            }
            override suspend fun submitToCalendar(owner: ImportOwner, assetId: String, uploadId: String,
                intent: ImportCalendarSubmissionIntent, kind: ImportMediaKind, configuration: ImportConfiguration): ImportCalendarSubmissionReceipt {
                assertEquals(intent, store.read(owner)!!.calendarSubmission)
                assertEquals(data.owner, owner); assertEquals(data.assetId, assetId); assertEquals(data.uploadId, uploadId)
                posts++; keys.add(intent.idempotencyKey); submittedIntents.add(intent)
                postFailure?.let { throw it }
                val result = ImportCalendarSubmissionReceipt("d".repeat(40), assetId, uploadId, intent.idempotencyKey,
                    "accepted", null, 0, intent.schedule?.date ?: "2026-09-24", intent.schedule?.time ?: "09:00", intent.caption, null)
                if (accept) receipt = result
                afterAccept?.invoke()
                if (loseAck) throw ImportApiFailure("import_network_unavailable", resultUncertain = true)
                return result
            }
            override suspend fun calendarSubmissionStatus(owner: ImportOwner, assetId: String, uploadId: String,
                intent: ImportCalendarSubmissionIntent): ImportCalendarSubmissionReceipt? {
                gets++; assertEquals(store.read(owner)!!.calendarSubmission, intent)
                lookupFailure?.let { throw it }
                if (recoverReceipt) return ImportCalendarSubmissionReceipt("d".repeat(40), assetId, uploadId, intent.idempotencyKey,
                    "accepted", null, 0, intent.schedule!!.date, intent.schedule.time, intent.caption, null)
                return receipt
            }
        }
        fun coordinator() = GalleryImportPreparationCoordinator({ owner }, { token }, store, { transport })
    }

    @Test fun acceptedServerJobRetiresOnlyLocalDraftWithoutPreviewAndAllowsAnotherFile() = runBlocking {
        val f = Fixture()
        val result = f.coordinator().submitToCalendar()
        assertEquals(ImportPreparationRunStatus.CALENDAR_ACCEPTED, result.status)
        assertEquals("accepted", result.calendarSubmissionReceipt!!.state)
        assertNull(result.preview); assertNull(result.confirmation); assertNull(f.store.read(data.owner))
        assertEquals(1, f.posts); assertEquals(0, f.previews); assertEquals(0, f.oldPreparationPosts)
        val next = GalleryImportState(data.owner, "another-draft", data.selection, data.config)
        f.store.write(data.owner, 0, ImportDurableCheckpoint(1, next, "content://synthetic/another", "another-upload-key"))
        assertEquals("another-draft", f.store.read(data.owner)!!.state.draftId)
    }

    @Test fun lostAcceptanceAndClosedAppRecoverSameServerJobWithoutAnotherPost() = runBlocking {
        val f = Fixture(); f.loseAck = true
        val old = f.coordinator()
        val chosen = ImportCalendarSchedule("2026-09-28", "14:35")
        val uncertain = old.submitToCalendar("Optional caption", chosen)
        assertEquals(ImportPreparationRunStatus.CALENDAR_RECONCILIATION, uncertain.status)
        val saved = f.store.read(data.owner)!!
        assertEquals(chosen, saved.calendarSubmission!!.schedule)
        assertEquals(saved, ImportCheckpointCodec.decode(ImportCheckpointCodec.encode(saved), data.owner))
        old.pause()
        // The server completes independently while there is no runtime attached to the screen.
        f.receipt = f.receipt!!.copy(state = "scheduled", calendarItemId = "d".repeat(40), mediaRevision = 1)
        val restored = f.coordinator().restore()
        assertEquals(ImportPreparationRunStatus.CALENDAR_ACCEPTED, restored.status)
        assertEquals("scheduled", restored.calendarSubmissionReceipt!!.state)
        assertEquals(chosen.date, restored.calendarSubmissionReceipt!!.date)
        assertEquals(chosen.time, restored.calendarSubmissionReceipt!!.time)
        assertEquals(1, f.posts); assertEquals(1, f.gets); assertNull(f.store.read(data.owner))
    }

    @Test fun reopeningMissingSubmissionOnlyReadsAndExplicitRetryKeepsSavedKeyCaptionAndSchedule() = runBlocking {
        val f = Fixture(); f.accept = false; f.loseAck = true
        val chosen = ImportCalendarSchedule("2026-09-28", "14:35")
        f.coordinator().submitToCalendar("Saved caption", chosen)
        val saved = f.store.read(data.owner)!!
        assertEquals(ImportPreparationRunStatus.CALENDAR_RECONCILIATION, f.coordinator().restore().status)
        assertEquals(1, f.posts); assertEquals(saved, f.store.read(data.owner))
        assertThrows(ImportCheckpointFailure::class.java) { f.store.clear(data.owner, saved.generation, saved.state.draftId) }
        f.accept = true; f.loseAck = false
        // Inputs from a later screen are not a new intent, even when those inputs are malformed.
        val result = f.coordinator().submitToCalendar("Different transient caption", ImportCalendarSchedule("invalid", "99:99", "UTC"))
        assertEquals("Saved caption", result.calendarSubmissionReceipt!!.caption)
        assertEquals(chosen.date, result.calendarSubmissionReceipt!!.date)
        assertEquals(chosen.time, result.calendarSubmissionReceipt!!.time)
        assertEquals(2, f.posts); assertEquals(1, f.keys.toSet().size)
        assertEquals(listOf(saved.calendarSubmission, saved.calendarSubmission), f.submittedIntents)
    }

    @Test fun legacySavedIntentRemainsWithoutScheduleWhenRetriedWithNewScreenValues() = runBlocking {
        val f = Fixture(); f.accept = false; f.loseAck = true
        f.coordinator().submitToCalendar("Legacy caption")
        val saved = f.store.read(data.owner)!!.calendarSubmission!!
        assertNull(saved.schedule)
        f.accept = true; f.loseAck = false
        f.coordinator().submitToCalendar("New caption", ImportCalendarSchedule("2026-10-05", "18:30"))
        assertEquals(listOf(saved, saved), f.submittedIntents)
        assertEquals(0, f.previews); assertEquals(0, f.oldPreparationPosts)
    }

    @Test fun malformedChosenScheduleCannotCreateAnIntentOrSendPreparation() = runBlocking {
        val f = Fixture()
        f.coordinator().submitToCalendar("Caption", ImportCalendarSchedule("2026-02-30", "09:00"))
        assertNull(f.store.read(data.owner)!!.calendarSubmission)
        assertEquals(0, f.posts); assertEquals(0, f.previews); assertEquals(0, f.oldPreparationPosts)
    }

    @Test fun firstDefinitiveScheduleRefusalAndConfirmedAbsenceRestoreEditableDraftWithoutResending() = runBlocking {
        for ((code, status) in listOf("calendar_import_submission_time_occupied" to 409,
            "calendar_import_submission_time_outside_window" to 400, "calendar_import_submission_schedule_invalid" to 400)) {
            val f = Fixture(); val original = f.store.read(data.owner)!!
            f.postFailure = ImportApiFailure(code, status)
            val rejected = f.coordinator().submitToCalendar("Caption", ImportCalendarSchedule("2026-09-28", "14:35"))
            assertEquals(ImportPreparationRunStatus.AWAITING_REQUEST, rejected.status)
            assertTrue(rejected.errorCode!!.startsWith("import_calendar_schedule_rejected_"))
            val editable = f.store.read(data.owner)!!
            assertNull(editable.calendarSubmission)
            assertEquals(original.state, editable.state); assertEquals(original.selectedContentUri, editable.selectedContentUri)
            assertEquals(original.preparationIntent, editable.preparationIntent)
            assertEquals(1, f.posts); assertEquals(1, f.gets); assertEquals(0, f.previews); assertEquals(0, f.oldPreparationPosts)
            f.postFailure = null
            val chosen = ImportCalendarSchedule("2026-10-05", "18:30")
            val accepted = f.coordinator().submitToCalendar("Corrected caption", chosen)
            assertEquals(ImportPreparationRunStatus.CALENDAR_ACCEPTED, accepted.status)
            assertEquals(chosen, f.submittedIntents.last().schedule)
            assertEquals(2, f.posts); assertEquals(2, f.keys.toSet().size)
        }
    }

    @Test fun unknownGenericOrUncertainRefusalsCannotRetireSubmissionIntent() = runBlocking {
        for (failure in listOf(ImportApiFailure("import_network_unavailable", resultUncertain = true),
            ImportApiFailure("import_request_rejected", 409), ImportApiFailure("calendar_import_submission_time_occupied", 400),
            ImportApiFailure("calendar_import_submission_time_occupied", 409, resultUncertain = true),
            ImportApiFailure("calendar_import_submission_time_outside_window", 503, resultUncertain = true))) {
            val f = Fixture(); f.postFailure = failure
            val result = f.coordinator().submitToCalendar("Caption", ImportCalendarSchedule("2026-09-28", "14:35"))
            assertEquals(ImportPreparationRunStatus.CALENDAR_RECONCILIATION, result.status)
            assertEquals(f.submittedIntents.single(), f.store.read(data.owner)!!.calendarSubmission)
            assertEquals(1, f.posts); assertEquals(0, f.gets)
        }
    }

    @Test fun failedAbsenceLookupPreservesIntentAndRecoveredReceiptFinishesExistingSubmission() = runBlocking {
        val uncertain = Fixture()
        uncertain.postFailure = ImportApiFailure("calendar_import_submission_time_occupied", 409)
        uncertain.lookupFailure = ImportApiFailure("import_network_unavailable")
        assertEquals(ImportPreparationRunStatus.CALENDAR_RECONCILIATION,
            uncertain.coordinator().submitToCalendar("Caption", ImportCalendarSchedule("2026-09-28", "14:35")).status)
        assertNotNull(uncertain.store.read(data.owner)!!.calendarSubmission)
        assertEquals(1, uncertain.posts); assertEquals(1, uncertain.gets)

        val recovered = Fixture(); recovered.postFailure = ImportApiFailure("calendar_import_submission_time_occupied", 409)
        recovered.recoverReceipt = true
        assertEquals(ImportPreparationRunStatus.CALENDAR_ACCEPTED,
            recovered.coordinator().submitToCalendar("Caption", ImportCalendarSchedule("2026-09-28", "14:35")).status)
        assertNull(recovered.store.read(data.owner))
        assertEquals(1, recovered.posts); assertEquals(1, recovered.gets)
    }

    @Test fun definitiveRefusalDuringReplayCannotReleaseAnEarlierUncertainKey() = runBlocking {
        val f = Fixture(); f.accept = false; f.loseAck = true
        f.coordinator().submitToCalendar("Saved caption", ImportCalendarSchedule("2026-09-28", "14:35"))
        val saved = f.store.read(data.owner)!!.calendarSubmission!!
        f.loseAck = false; f.postFailure = ImportApiFailure("calendar_import_submission_time_occupied", 409)
        val retry = f.coordinator().submitToCalendar("New caption", ImportCalendarSchedule("2026-10-05", "18:30"))
        assertEquals(ImportPreparationRunStatus.CALENDAR_RECONCILIATION, retry.status)
        assertEquals(saved, f.store.read(data.owner)!!.calendarSubmission)
        assertEquals(listOf(saved, saved), f.submittedIntents)
        assertEquals(2, f.posts); assertEquals(1, f.gets); assertEquals(1, f.keys.toSet().size)
    }

    @Test fun ownerChangeAfterServerAcceptanceCannotClearOrDisplayOtherSessionData() = runBlocking {
        val f = Fixture()
        f.afterAccept = { f.token = "replacement-session" }
        assertEquals(ImportPreparationRunStatus.SESSION_CHANGED, f.coordinator().submitToCalendar().status)
        assertNotNull(f.store.read(data.owner)?.calendarSubmission)
        assertEquals(1, f.posts)
    }

    @Test fun formatCanChangeBeforeUploadWithoutSendingOrPreparing() = runBlocking {
        val f = Fixture(uploaded = false)
        val configuration = ImportConfiguration(setOf(ImportTarget.STORY), ImportAudioMode.NONE)
        assertEquals(ImportPreparationRunStatus.UPLOAD_REQUIRED, f.coordinator().configure(configuration).status)
        assertEquals(configuration, f.store.read(data.owner)!!.state.configuration)
        assertEquals(0, f.posts); assertEquals(0, f.oldPreparationPosts); assertEquals(0, f.previews)
    }

    @Test fun existingReadyDraftUsesVerifiedUploadAndCurrentRevisionWithoutPreview() = runBlocking {
        val f = Fixture()
        val current = f.store.read(data.owner)!!
        f.record = ImportPreparationProtocol.parseRecord(data.status("ready"))
        val variants = f.record.variants.map { ImportPreparedVariant(it.target, it.kind, it.mimeType, data.assetId,
            it.sha256, it.audioMode, null, it.durationMs) }
        f.store.write(data.owner, current.generation, current.copy(state = current.state.copy(phase = ImportPhase.READY, prepared = variants),
            preparationIntent = ImportPreparationIntent("legacy-preparation", current.state.revision, 0, 1, f.record.jobId)))
        val result = f.coordinator().submitToCalendar()
        assertEquals(ImportPreparationRunStatus.CALENDAR_ACCEPTED, result.status)
        assertEquals(1, f.posts); assertEquals(0, f.oldPreparationPosts); assertEquals(0, f.previews)
    }
}
