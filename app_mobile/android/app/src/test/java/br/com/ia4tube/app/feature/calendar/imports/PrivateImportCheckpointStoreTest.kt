package br.com.ia4tube.app.feature.calendar.imports

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class PrivateImportCheckpointStoreTest {
    @get:Rule val temporary = TemporaryFolder()
    private val owner = ImportOwner("synthetic-company", "synthetic-user")
    private val other = owner.copy(companyId = "foreign-company")
    private val hash = "a".repeat(64)
    private val media = ImportSelection("synthetic-selection", ImportMediaKind.IMAGE, "image/png", 8, 10, 10, null, hash)
    private val config = ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE)
    private fun draft(phase: ImportPhase = ImportPhase.EDITING): ImportDurableCheckpoint {
        val uploaded = phase != ImportPhase.EDITING
        val ready = phase in setOf(ImportPhase.READY, ImportPhase.SCHEDULING, ImportPhase.SCHEDULED)
        return ImportDurableCheckpoint(1, GalleryImportState(owner, "draft-1", media, config, phase = phase,
            upload = if (uploaded) ImportUploadProgress(ImportUploadTicket("upload-1", "asset-1", hash, 8), listOf(ImportPartReceipt(0, 8, hash))) else null,
            prepared = if (ready) listOf(ImportPreparedVariant(ImportTarget.FEED, ImportMediaKind.IMAGE, "image/jpeg", "prepared-1", hash)) else emptyList(),
            availability = ImportOperationalAvailability(true, true, true, true, true), previewConfirmedRevision = if (ready) 1 else null,
            scheduleIntent = if (phase in setOf(ImportPhase.SCHEDULING, ImportPhase.SCHEDULED)) ImportScheduleIntent("schedule-intent-1", 1, 10_000, "Private synthetic caption") else null,
            calendarItemId = if (phase == ImportPhase.SCHEDULED) "calendar-1" else null),
            "content://synthetic-picker/private-item", "start-upload-intent-1")
    }
    private class TestCipher(private val key: ByteArray = ByteArray(32).also(SecureRandom()::nextBytes)) : ImportCheckpointCipher {
        override fun encrypt(scope: String, plain: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
            cipher.updateAAD(scope.toByteArray())
            return cipher.iv + cipher.doFinal(plain)
        }
        override fun decrypt(scope: String, sealed: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
            cipher.updateAAD(scope.toByteArray())
            return cipher.doFinal(sealed, 12, sealed.size - 12)
        }
    }

    @Test fun durableStoreReopensEncryptedDraftAndDoesNotPersistFreshAvailabilityOrAcknowledgement() {
        val root = temporary.newFolder("private")
        val cipher = TestCipher()
        val saved = PrivateImportCheckpointStore(root, cipher).write(owner, 0, draft(ImportPhase.READY))
        assertEquals(1, saved.generation)
        val bytes = root.listFiles()!!.single { it.extension == "bin" }.readBytes()
        val printed = String(bytes, Charsets.ISO_8859_1)
        assertFalse(printed.contains("content://")); assertFalse(printed.contains(owner.companyId)); assertFalse(printed.contains(hash))
        val reopened = PrivateImportCheckpointStore(root, cipher).read(owner)!!
        assertEquals(saved.state.draftId, reopened.state.draftId)
        assertEquals(saved.selectedContentUri, reopened.selectedContentUri)
        assertFalse(reopened.state.availability.allowed)
        assertNull(reopened.state.previewConfirmedRevision)
        val machine = GalleryImportMachine(owner)
        assertTrue(machine.restoreDurable(owner, reopened) is ImportTransition.Applied)
        assertFalse(machine.snapshot()!!.canDisplayScheduled)
    }

    @Test fun processDeathPreservesUncertainScheduleIntentAndCannotClearOrReissueIt() {
        val root = temporary.newFolder("private")
        val cipher = TestCipher()
        PrivateImportCheckpointStore(root, cipher).write(owner, 0, draft(ImportPhase.SCHEDULING))
        val store = PrivateImportCheckpointStore(root, cipher)
        val recovered = store.read(owner)!!
        assertTrue(recovered.state.scheduleResultUncertain)
        assertEquals("schedule-intent-1", recovered.state.scheduleIntent!!.idempotencyKey)
        val machine = GalleryImportMachine(owner)
        assertTrue(machine.restoreDurable(owner, recovered) is ImportTransition.Applied)
        assertEquals(ImportTransition.Rejected(ImportRejection.INVALID_PHASE), machine.dispatch(owner, ImportEvent.EditMedia(media)))
        assertEquals(ImportTransition.Rejected(ImportRejection.CONFLICTING_INTENT), machine.dispatch(owner,
            ImportEvent.ScheduleRequested(recovered.state.scheduleIntent.copy(idempotencyKey = "new-intent"), 1)))
        val failure = assertThrows(ImportCheckpointFailure::class.java) { store.clear(owner, recovered.generation) }
        assertEquals("checkpoint_uncertain", failure.code)
        assertNotNull(store.read(owner))
    }

    @Test fun directCalendarScheduleSurvivesEncryptedReopenAndLegacyOmission() {
        val root = temporary.newFolder("direct-calendar"); val cipher = TestCipher()
        val uploaded = draft(ImportPhase.UPLOADED).let { it.copy(state = it.state.copy(upload = it.state.upload!!.copy(serverVerified = true))) }
        val schedule = ImportCalendarSchedule("2020-01-15", "08:45")
        val intent = ImportCalendarSubmissionIntent("direct-calendar-intent", uploaded.state.revision, 0, "Saved caption", schedule)
        val stored = PrivateImportCheckpointStore(root, cipher).write(owner, 0, uploaded.copy(calendarSubmission = intent))
        val reopened = PrivateImportCheckpointStore(root, cipher).read(owner)!!
        assertEquals(intent, reopened.calendarSubmission)
        val encoded = org.json.JSONObject(String(ImportCheckpointCodec.encode(stored), Charsets.UTF_8))
        encoded.getJSONObject("calendarSubmission").remove("schedule")
        val legacy = ImportCheckpointCodec.decode(encoded.toString().toByteArray(Charsets.UTF_8), owner)
        assertEquals(intent.copy(schedule = null), legacy.calendarSubmission)
        assertFalse(org.json.JSONObject(String(ImportCheckpointCodec.encode(legacy), Charsets.UTF_8))
            .getJSONObject("calendarSubmission").has("schedule"))
        encoded.getJSONObject("calendarSubmission").put("schedule", org.json.JSONObject.NULL)
        assertEquals(intent.copy(schedule = null), ImportCheckpointCodec.decode(encoded.toString().toByteArray(Charsets.UTF_8), owner).calendarSubmission)
    }

    @Test fun malformedDirectCalendarScheduleCannotBeRestoredAsAnUnscheduledIntent() {
        val uploaded = draft(ImportPhase.UPLOADED).let { it.copy(state = it.state.copy(upload = it.state.upload!!.copy(serverVerified = true))) }
        val intent = ImportCalendarSubmissionIntent("direct-calendar-intent", uploaded.state.revision, 0, schedule = ImportCalendarSchedule("2026-09-28", "14:35"))
        val encoded = String(ImportCheckpointCodec.encode(uploaded.copy(calendarSubmission = intent)), Charsets.UTF_8)
        val malformed = listOf<Any>("not-an-object", org.json.JSONObject().put("date", "2026-09-28").put("time", "14:35"),
            org.json.JSONObject().put("date", "2026-02-30").put("time", "14:35").put("timeZone", "America/Sao_Paulo"),
            org.json.JSONObject().put("date", "2026-09-28").put("time", "24:00").put("timeZone", "America/Sao_Paulo"),
            org.json.JSONObject().put("date", "2026-09-28").put("time", "14:35").put("timeZone", "UTC"),
            org.json.JSONObject().put("date", "2026-09-28").put("time", "14:35").put("timeZone", "America/Sao_Paulo").put("automatic", true))
        for (schedule in malformed) {
            val changed = org.json.JSONObject(encoded)
            changed.getJSONObject("calendarSubmission").put("schedule", schedule)
            assertThrows(RuntimeException::class.java) { ImportCheckpointCodec.decode(changed.toString().toByteArray(Charsets.UTF_8), owner) }
        }
    }

    @Test fun companyAndUserScopesCannotReadOrRelabelAnotherEncryptedCheckpoint() {
        val root = temporary.newFolder("private")
        val store = PrivateImportCheckpointStore(root, TestCipher())
        store.write(owner, 0, draft())
        for (foreign in listOf(other, owner.copy(userId = "foreign-user"))) {
            assertNull(store.read(foreign))
            val source = File(root, PrivateImportCheckpointStore.ownerScope(owner) + ".bin")
            val copied = File(root, PrivateImportCheckpointStore.ownerScope(foreign) + ".bin")
            source.copyTo(copied)
            assertThrows(ImportCheckpointFailure::class.java) { store.read(foreign) }
            assertNotNull(store.read(owner))
        }
    }

    @Test fun corruptCiphertextAndLostKeyFailClosedWithoutDeletingEvidence() {
        val root = temporary.newFolder("private")
        val cipher = TestCipher()
        val store = PrivateImportCheckpointStore(root, cipher)
        store.write(owner, 0, draft())
        assertThrows(ImportCheckpointFailure::class.java) { PrivateImportCheckpointStore(root, TestCipher()).read(owner) }
        val file = root.listFiles()!!.single { it.extension == "bin" }
        val corrupted = file.readBytes(); corrupted[corrupted.lastIndex] = (corrupted.last().toInt() xor 1).toByte()
        file.writeBytes(corrupted)
        assertThrows(ImportCheckpointFailure::class.java) { store.read(owner) }
        assertTrue(file.exists())
        assertThrows(ImportCheckpointFailure::class.java) { store.write(owner, 0, draft()) }
    }

    @Test fun optimisticGenerationPreventsLateCallbackOverwriteAcrossStoreInstances() {
        val root = temporary.newFolder("private"); val cipher = TestCipher()
        val first = PrivateImportCheckpointStore(root, cipher); val second = PrivateImportCheckpointStore(root, cipher)
        val initial = first.write(owner, 0, draft())
        val updated = second.write(owner, initial.generation, initial.copy(state = initial.state.copy(revision = 2)))
        assertEquals(2, updated.generation)
        val error = assertThrows(ImportCheckpointFailure::class.java) { first.write(owner, initial.generation, initial) }
        assertEquals("checkpoint_conflict", error.code)
        assertEquals(2, first.read(owner)!!.state.revision)
    }

    @Test fun concurrentInitialWritesCreateOnlyOneGeneration() {
        val root = temporary.newFolder("private"); val cipher = TestCipher()
        val executor = Executors.newFixedThreadPool(4)
        try {
            val results = executor.invokeAll((1..4).map { Callable {
                runCatching { PrivateImportCheckpointStore(root, cipher).write(owner, 0, draft()) }.isSuccess
            } }).map { it.get() }
            assertEquals(1, results.count { it })
            assertEquals(1, PrivateImportCheckpointStore(root, cipher).read(owner)!!.generation)
        } finally { executor.shutdownNow() }
    }

    @Test fun recreatedGenerationCannotBeOverwrittenOrClearedByAnOldDraftCallback() {
        val store = PrivateImportCheckpointStore(temporary.newFolder("private"), TestCipher())
        val old = store.write(owner, 0, draft())
        store.clear(owner, old.generation, old.state.draftId)
        val fresh = store.write(owner, 0, draft().let { it.copy(state = it.state.copy(draftId = "new-draft")) })
        assertEquals(old.generation, fresh.generation)
        assertEquals("checkpoint_conflict", assertThrows(ImportCheckpointFailure::class.java) {
            store.write(owner, old.generation, old)
        }.code)
        assertEquals("checkpoint_conflict", assertThrows(ImportCheckpointFailure::class.java) {
            store.clear(owner, old.generation, old.state.draftId)
        }.code)
        assertEquals("new-draft", store.read(owner)!!.state.draftId)
    }

    @Test fun legacyIntentIsConservativelyUncertainAndNewPauseCancelFlagsAreStrictBooleans() {
        val original = org.json.JSONObject(String(ImportCheckpointCodec.encode(draft()), Charsets.UTF_8))
        original.remove("uploadStartIssued"); original.remove("transferPaused"); original.remove("cancelRequested")
        val legacy = ImportCheckpointCodec.decode(original.toString().toByteArray(), owner)
        assertTrue(legacy.uploadStartIssued); assertTrue(legacy.transferPaused); assertFalse(legacy.cancelRequested)
        for (key in listOf("uploadStartIssued", "transferPaused", "cancelRequested")) {
            val malformed = org.json.JSONObject(original.toString()).put(key, "true")
            assertThrows(IllegalArgumentException::class.java) {
                ImportCheckpointCodec.decode(malformed.toString().toByteArray(), owner)
            }
        }
    }

    @Test fun stalePendingFileNeverReplacesConfirmedCheckpointOnRecovery() {
        val root = temporary.newFolder("private"); val cipher = TestCipher()
        val store = PrivateImportCheckpointStore(root, cipher)
        store.write(owner, 0, draft())
        File(root, PrivateImportCheckpointStore.ownerScope(owner) + ".pending").writeBytes(byteArrayOf(1, 2, 3))
        assertEquals(1, PrivateImportCheckpointStore(root, cipher).read(owner)!!.generation)
        store.write(owner, 1, draft())
        assertEquals(2, store.read(owner)!!.generation)
        assertFalse(root.listFiles()!!.any { it.extension == "pending" })
    }

    @Test fun encodingRejectsRemoteUriOversizedCaptionAndBrokenState() {
        assertThrows(IllegalArgumentException::class.java) { ImportCheckpointCodec.encode(draft().copy(selectedContentUri = "https://foreign.invalid/file")) }
        val scheduling = draft(ImportPhase.SCHEDULING)
        assertThrows(IllegalArgumentException::class.java) { ImportCheckpointCodec.encode(scheduling.copy(state = scheduling.state.copy(
            scheduleIntent = scheduling.state.scheduleIntent!!.copy(caption = "x".repeat(2201))))) }
        assertThrows(IllegalArgumentException::class.java) { ImportCheckpointCodec.encode(scheduling.copy(state = scheduling.state.copy(upload = null))) }
        assertThrows(IllegalArgumentException::class.java) { ImportCheckpointCodec.decode(ImportCheckpointCodec.encode(draft()), other) }
        assertThrows(IllegalArgumentException::class.java) { ImportCheckpointCodec.decode(ByteArray(ImportCheckpointCodec.MAX_BYTES + 1), owner) }
    }
}
