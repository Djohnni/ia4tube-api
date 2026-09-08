package br.com.ia4tube.app.feature.instagram

import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Same CAS/codec as Android, with memory IO only; no device, provider, credential or media payload. */
class InstagramUploadWitnessStoreTest {
    private val binding = InstagramConnectionBinding(CONNECTION_ID, "123456789012345", 4L)
    private val contextKey = InstagramIntentPolicy.contextKey(InstagramPolicies.OFFICIAL_API_ORIGIN, CONNECTION_ID)
    private val otherKey = InstagramIntentPolicy.contextKey(InstagramPolicies.OFFICIAL_API_ORIGIN, OTHER_ID)
    private fun prepared() = InstagramUploadWitness(ATTEMPT_ID, "a".repeat(64), binding, STARTED_AT)
    private fun diagnostic(stage: InstagramRequestStage, code: String, status: Int? = null,
        unknown: Boolean = false) = InstagramRequestDiagnostic(
        stage != InstagramRequestStage.LOCAL_VALIDATION, status != null, status, code, stage, STARTED_AT, 25L, unknown)
    private fun inFlight() = prepared().copy(phase = InstagramUploadPhase.IN_FLIGHT,
        diagnostic = diagnostic(InstagramRequestStage.REQUEST_INITIATED, "request_started", unknown = true))
    private fun unknown() = prepared().copy(phase = InstagramUploadPhase.UNKNOWN,
        diagnostic = diagnostic(InstagramRequestStage.TRANSPORT, "transport_timeout", unknown = true))
    private fun confirmed() = prepared().copy(phase = InstagramUploadPhase.CONFIRMED, mediaId = MEDIA_ID,
        diagnostic = diagnostic(InstagramRequestStage.HTTP_RESPONSE, "http_success", 201))
    private fun rejected() = prepared().copy(phase = InstagramUploadPhase.REJECTED,
        diagnostic = diagnostic(InstagramRequestStage.HTTP_RESPONSE, "http_rejected", 400))
    private fun locallyRejected() = prepared().copy(phase = InstagramUploadPhase.REJECTED,
        diagnostic = diagnostic(InstagramRequestStage.LOCAL_VALIDATION, "local_invalid_input"))

    @Test fun codecRoundTripsEveryPhaseAndOnlyAllowlistedMetadata() {
        for (value in listOf(prepared(), inFlight(), unknown(), confirmed(), rejected(), locallyRejected())) {
            val encoded = InstagramUploadWitnessCodec.encode(contextKey, value)
            assertEquals(value, InstagramUploadWitnessCodec.decode(contextKey, encoded))
            for (forbidden in listOf("https://", "caption", "jpegBytes", "access_token", "Bearer ", "SYNTHETIC_SECRET")) {
                assertFalse(encoded.contains(forbidden))
            }
        }
    }

    @Test fun codecRejectsTruncationExtrasUnknownVersionChecksumDamageAndWrongContext() {
        val good = InstagramUploadWitnessCodec.encode(contextKey, prepared())
        val invalid = listOf("", "1|broken", good.dropLast(1), good + "|extra", "x".repeat(1201),
            good.replace("a".repeat(64), "b".repeat(64)), rewrite(good, 0, "2"), rewrite(good, 7, "+$STARTED_AT"))
        for (encoded in invalid) assertDecodeFails(contextKey, encoded)
        assertDecodeFails(otherKey, good)
    }

    @Test fun codecRejectsSecretShapedFieldsEvenWithARecomputedChecksumWithoutEchoingThem() {
        val good = InstagramUploadWitnessCodec.encode(contextKey, confirmed())
        val canary = "SYNTHETIC_SECRET_CANARY_32HEX_0123456789abcdef0123456789abcdef"
        for ((field, value) in listOf(2 to canary, 3 to canary, 4 to canary, 5 to canary,
            6 to "01", 7 to "-1", 8 to canary, 9 to canary, 9 to "https://invalid.example/?token=$canary",
            10 to "2", 11 to "true", 12 to "yes", 13 to canary, 14 to canary, 15 to canary,
            16 to "-1", 17 to "-1", 18 to "true")) {
            assertDecodeFails(contextKey, rewrite(good, field, value))
        }
        val absentDiagnostic = InstagramUploadWitnessCodec.encode(contextKey, prepared())
        assertDecodeFails(contextKey, rewrite(absentDiagnostic, 14, canary))
    }

    @Test fun codecRejectsInvalidWitnessAndDoesNotTurnMediaOrFingerprintIntoFreeText() {
        for (value in listOf(prepared().copy(id = "not-a-uuid"), prepared().copy(contentFingerprint = "A".repeat(64)),
            prepared().copy(contentFingerprint = "a".repeat(63)), prepared().copy(startedAtEpochMillis = 0),
            prepared().copy(binding = binding.copy(connectionRevision = 0)),
            prepared().copy(binding = binding.copy(externalId = "SYNTHETIC_SECRET_CANARY")),
            prepared().copy(mediaId = MEDIA_ID), confirmed().copy(mediaId = null),
            confirmed().copy(mediaId = "reviewer-jpeg:" + "A".repeat(64)),
            confirmed().copy(diagnostic = unknown().diagnostic))) {
            val error = assertThrows(IllegalArgumentException::class.java) { InstagramUploadWitnessCodec.encode(contextKey, value) }
            assertEquals(UNAVAILABLE, error.message)
            assertNull(error.cause)
        }
    }

    @Test fun rejectedCodecCannotConvertUnknownOrSuccessfulEvidenceIntoADefinitiveRejection() {
        val contradictory = listOf(unknown(), inFlight(),
            unknown().copy(diagnostic = diagnostic(InstagramRequestStage.HTTP_RESPONSE, "http_server_error", 503, true)),
            unknown().copy(diagnostic = diagnostic(InstagramRequestStage.INVALID_RESPONSE, "response_invalid", 400, true)),
            unknown().copy(diagnostic = confirmed().diagnostic))
        for (source in contradictory) {
            val error = assertThrows(IllegalArgumentException::class.java) {
                InstagramUploadWitnessCodec.encode(contextKey, source.copy(phase = InstagramUploadPhase.REJECTED))
            }
            assertEquals(UNAVAILABLE, error.message)
            assertDecodeFails(contextKey, rewrite(InstagramUploadWitnessCodec.encode(contextKey, source),
                8, InstagramUploadPhase.REJECTED.name))
        }
        for (safe in listOf(locallyRejected(), rejected(), prepared().copy(phase = InstagramUploadPhase.REJECTED))) {
            assertEquals(safe, InstagramUploadWitnessCodec.decode(contextKey,
                InstagramUploadWitnessCodec.encode(contextKey, safe)))
        }
    }

    @Test fun createIsExclusiveAndSynchronousAcrossStoreReconstruction() {
        val memory = MemoryStorage()
        val first = memory.store()
        assertNull(first.read(contextKey))
        assertTrue(first.create(contextKey, prepared()))
        assertEquals(1, memory.writes)
        assertEquals(prepared(), memory.store().read(contextKey))
        assertFalse(memory.store().create(contextKey, prepared().copy(id = OTHER_ID)))
        assertEquals(1, memory.writes)
    }

    @Test fun pendingAndUnknownWitnessesSurviveRefreshOrRecreationAndCannotBeCleared() {
        for (value in listOf(prepared(), inFlight(), unknown())) {
            val memory = MemoryStorage()
            val store = memory.store()
            assertTrue(store.create(contextKey, prepared()))
            if (value != prepared()) assertTrue(store.update(contextKey, value))
            val restored = memory.store()
            assertEquals(value, restored.read(contextKey))
            assertFalse(restored.clearResolved(contextKey, ATTEMPT_ID))
            assertFalse(restored.create(contextKey, prepared().copy(id = OTHER_ID)))
        }
    }

    @Test fun partitionDoesNotAdoptAnotherContextAndCopiedRecordFailsClosed() {
        val memory = MemoryStorage()
        val store = memory.store()
        assertTrue(store.create(contextKey, prepared()))
        assertNull(store.read(otherKey))
        assertFalse(store.clearResolved(otherKey, ATTEMPT_ID))
        memory.values["upload.$otherKey"] = memory.values.getValue("upload.$contextKey")
        val error = assertThrows(IllegalStateException::class.java) { memory.store().read(otherKey) }
        assertEquals(UNAVAILABLE, error.message)
        assertThrows(IllegalStateException::class.java) { store.read(contextKey) }
        assertEquals(1, memory.writes)
    }

    @Test fun concurrentCreatesAcrossInstancesCommitExactlyOneAttempt() {
        val memory = MemoryStorage()
        val first = memory.store()
        val second = memory.store()
        val start = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val left = executor.submit<Boolean> { start.await(); first.create(contextKey, prepared()) }
            val right = executor.submit<Boolean> { start.await(); second.create(contextKey, prepared().copy(id = OTHER_ID)) }
            start.countDown()
            assertEquals(1, listOf(left.get(5, TimeUnit.SECONDS), right.get(5, TimeUnit.SECONDS)).count { it })
            assertEquals(1, memory.writes)
            assertNotNull(memory.store().read(contextKey))
        } finally { executor.shutdownNow() }
    }

    @Test fun createNeverImportsAnAlreadyStartedOrResolvedAttemptAsANewUpload() {
        for (value in listOf(inFlight(), unknown(), confirmed(), rejected())) {
            val memory = MemoryStorage()
            assertThrows(IllegalStateException::class.java) { memory.store().create(contextKey, value) }
            assertEquals(0, memory.writes)
        }
    }

    @Test fun updateCannotChangeAttemptContentAccountRevisionOrStartTime() {
        val store = inMemoryUploadWitnessStore()
        assertFalse(store.update(contextKey, inFlight()))
        assertTrue(store.create(contextKey, prepared()))
        for (changed in listOf(inFlight().copy(id = OTHER_ID), inFlight().copy(contentFingerprint = "b".repeat(64)),
            inFlight().copy(binding = binding.copy(connectionId = OTHER_ID)),
            inFlight().copy(binding = binding.copy(externalId = "987654321000000")),
            inFlight().copy(binding = binding.copy(connectionRevision = 5)),
            inFlight().copy(startedAtEpochMillis = STARTED_AT + 1))) {
            assertFalse(store.update(contextKey, changed))
        }
        assertEquals(prepared(), store.read(contextKey))
        assertTrue(store.update(contextKey, inFlight()))
        assertTrue(store.update(contextKey, inFlight()))
        assertFalse(store.update(contextKey, prepared()))
        assertFalse(store.update(contextKey, inFlight().copy(diagnostic = null)))
    }

    @Test fun unknownCannotReturnToPreparedOrInFlightNorResolveFromALaterLocalFailure() {
        val store = inMemoryUploadWitnessStore()
        assertTrue(store.create(contextKey, prepared()))
        assertTrue(store.update(contextKey, unknown()))
        assertFalse(store.update(contextKey, prepared()))
        assertFalse(store.update(contextKey, inFlight()))
        assertFalse(store.update(contextKey, locallyRejected()))
        assertFalse(store.update(contextKey, prepared().copy(phase = InstagramUploadPhase.REJECTED)))
        assertFalse(store.update(contextKey, unknown().copy(phase = InstagramUploadPhase.REJECTED)))
        assertEquals(unknown(), store.read(contextKey))
    }

    @Test fun explicitLocalRejectionIsAllowedOnlyBeforeUncertaintyIsEstablished() {
        for (started in listOf(false, true)) {
            val store = inMemoryUploadWitnessStore()
            assertTrue(store.create(contextKey, prepared()))
            if (started) assertTrue(store.update(contextKey, inFlight()))
            assertTrue(store.update(contextKey, locallyRejected()))
            assertTrue(store.clearResolved(contextKey, ATTEMPT_ID))
        }
    }

    @Test fun unknownCanResolveOnlyThroughOriginalResourceOrKnownHttpRejection() {
        for (resolved in listOf(confirmed(), rejected())) {
            val store = inMemoryUploadWitnessStore()
            assertTrue(store.create(contextKey, prepared()))
            assertTrue(store.update(contextKey, unknown()))
            assertTrue(store.update(contextKey, resolved))
            assertEquals(resolved, store.read(contextKey))
        }
        val serverUnknown = diagnostic(InstagramRequestStage.HTTP_RESPONSE, "http_server_error", 503, true)
        val malformed = diagnostic(InstagramRequestStage.INVALID_RESPONSE, "response_invalid", 400, true)
        for (evidence in listOf(serverUnknown, malformed)) {
            assertFalse(InstagramUploadWitnessPolicy.canUpdate(unknown(), rejected().copy(diagnostic = evidence)))
        }
    }

    @Test fun uncertainUpdateCannotEraseOrReplaceAlreadyObservedHttpStatus() {
        val received = unknown().copy(diagnostic = diagnostic(
            InstagramRequestStage.INVALID_RESPONSE, "response_invalid", 201, true))
        val store = inMemoryUploadWitnessStore()
        assertTrue(store.create(contextKey, prepared()))
        assertTrue(store.update(contextKey, received))
        assertFalse(store.update(contextKey, unknown()))
        assertFalse(store.update(contextKey, rejected()))
        assertEquals(received, store.read(contextKey))
        assertTrue(store.update(contextKey, confirmed()))
    }

    @Test fun resolvedWitnessIsImmutableAndClearIsCompareAndSet() {
        for (resolved in listOf(confirmed(), rejected())) {
            val memory = MemoryStorage()
            val store = memory.store()
            assertTrue(store.create(contextKey, prepared()))
            assertTrue(store.update(contextKey, inFlight()))
            assertTrue(store.update(contextKey, resolved))
            val writes = memory.writes
            assertTrue(store.update(contextKey, resolved))
            assertEquals(writes, memory.writes)
            assertFalse(store.update(contextKey, unknown()))
            assertFalse(store.update(contextKey, resolved.copy(diagnostic = null)))
            assertFalse(store.update(contextKey, confirmed().copy(mediaId = "reviewer-jpeg:" + "b".repeat(64))))
            assertFalse(store.clearResolved(contextKey, OTHER_ID))
            assertTrue(store.clearResolved(contextKey, ATTEMPT_ID))
            assertNull(store.read(contextKey))
            assertTrue(store.create(contextKey, prepared().copy(id = OTHER_ID)))
            assertFalse(store.clearResolved(contextKey, ATTEMPT_ID))
        }
    }

    @Test fun malformedStoredDataCannotBeTreatedAsAbsenceByAnyOperation() {
        for (operation in listOf<(InstagramUploadWitnessStore) -> Unit>(
            { it.read(contextKey) }, { it.create(contextKey, prepared()) },
            { it.update(contextKey, inFlight()) }, { it.clearResolved(contextKey, ATTEMPT_ID) })) {
            val memory = MemoryStorage().apply { values["upload.$contextKey"] = "SYNTHETIC_SECRET_CANARY" }
            val error = assertThrows(IllegalStateException::class.java) { operation(memory.store()) }
            assertEquals(UNAVAILABLE, error.message)
            assertNull(error.cause)
            assertEquals(0, memory.writes)
        }
    }

    @Test fun failedCreateCommitPoisonsAllInstancesIncludingARecreatedViewModelStore() {
        val memory = MemoryStorage().apply { commitSucceeds = false }
        val first = memory.store()
        val second = memory.store()
        assertFalse(first.create(contextKey, prepared()))
        for (store in listOf(first, second, memory.store())) {
            assertThrows(IllegalStateException::class.java) { store.read(contextKey) }
            assertThrows(IllegalStateException::class.java) { store.create(contextKey, prepared()) }
        }
        assertEquals(1, memory.writes)
    }

    @Test fun failedUpdateOrClearNeverTrustsChangedMemoryEvenAfterRecreation() {
        for (clear in listOf(false, true)) {
            val memory = MemoryStorage()
            val store = memory.store()
            assertTrue(store.create(contextKey, prepared()))
            assertTrue(store.update(contextKey, inFlight()))
            if (clear) assertTrue(store.update(contextKey, confirmed()))
            memory.commitSucceeds = false
            if (clear) assertFalse(store.clearResolved(contextKey, ATTEMPT_ID))
            else assertFalse(store.update(contextKey, unknown()))
            assertThrows(IllegalStateException::class.java) { memory.store().read(contextKey) }
            assertThrows(IllegalStateException::class.java) { memory.store().create(contextKey, prepared().copy(id = OTHER_ID)) }
        }
    }

    @Test fun invalidKeysAndStorageExceptionsNeverEchoSecretCanariesOrPermitWrites() {
        for (key in listOf("", "SYNTHETIC_SESSION_TOKEN", "A".repeat(64), "a".repeat(63), "a".repeat(65))) {
            val memory = MemoryStorage()
            val error = assertThrows(IllegalStateException::class.java) { memory.store().create(key, prepared()) }
            assertEquals(UNAVAILABLE, error.message)
            assertEquals(0, memory.writes)
        }
        val readFailure = EncodedInstagramUploadWitnessStore(
            { throw IllegalArgumentException("SYNTHETIC_SECRET_CANARY") }, { _, _ -> true })
        val writeFailure = EncodedInstagramUploadWitnessStore({ null },
            { _, _ -> throw IllegalArgumentException("SYNTHETIC_SECRET_CANARY") })
        for (operation in listOf<() -> Unit>({ readFailure.read(contextKey) }, { writeFailure.create(contextKey, prepared()) })) {
            val error = assertThrows(IllegalStateException::class.java) { operation() }
            assertEquals(UNAVAILABLE, error.message)
            assertNull(error.cause)
        }
    }

    private fun assertDecodeFails(key: String, encoded: String) {
        val error = assertThrows(IllegalArgumentException::class.java) { InstagramUploadWitnessCodec.decode(key, encoded) }
        assertEquals(UNAVAILABLE, error.message)
        assertNull(error.cause)
    }

    private fun rewrite(encoded: String, index: Int, value: String): String {
        val fields = encoded.split('|').take(19).toMutableList()
        fields[index] = value
        val body = fields.joinToString("|")
        val checksum = MessageDigest.getInstance("SHA-256").digest(body.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        return "$body|$checksum"
    }

    private class MemoryStorage {
        val values = mutableMapOf<String, String>()
        val guard = InstagramUploadStorageGuard()
        var writes = 0
        var commitSucceeds = true
        fun store() = EncodedInstagramUploadWitnessStore({ values[it] }, { key, value ->
            writes++
            if (value == null) values.remove(key) else values[key] = value
            commitSucceeds
        }, guard)
    }

    companion object {
        private const val ATTEMPT_ID = "11111111-1111-4111-8111-111111111111"
        private const val OTHER_ID = "22222222-2222-4222-8222-222222222222"
        private const val CONNECTION_ID = "33333333-3333-4333-8333-333333333333"
        private const val STARTED_AT = 1_788_845_000_000L
        private const val UNAVAILABLE = "Upload attempt record unavailable"
        private val MEDIA_ID = "reviewer-jpeg:" + "a".repeat(64)
    }
}
