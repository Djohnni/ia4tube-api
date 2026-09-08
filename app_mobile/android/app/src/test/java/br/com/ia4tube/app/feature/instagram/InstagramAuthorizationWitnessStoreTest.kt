package br.com.ia4tube.app.feature.instagram

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Uses the same encoded-store CAS implementation with memory storage; no Android, HTTP or provider. */
class InstagramAuthorizationWitnessStoreTest {
    private val contextKey = "a".repeat(64)
    private val otherContextKey = "b".repeat(64)
    private val attemptId = "11111111-1111-4111-8111-111111111111"
    private val otherAttemptId = "22222222-2222-4222-8222-222222222222"
    private val oldConnection = "33333333-3333-4333-8333-333333333333"
    private val newConnection = "44444444-4444-4444-8444-444444444444"
    private val oldExpiry = "2026-09-07T20:10:00.000Z"
    private val newExpiry = "2026-09-07T21:10:00.000Z"

    private fun witness(purpose: String = "connect") = InstagramAuthorizationWitness(
        attemptId, purpose, oldConnection, oldExpiry)
    private fun status(connectionId: String = newConnection, purpose: String = "connect",
        expiresAt: String? = newExpiry, state: String = "authorization_expired") =
        InstagramAuthorizationStatus(connectionId, purpose, state, expiresAt)

    @Test fun codecPreservesUnidentifiedAndIdentifiedMetadataAcrossReconstruction() {
        for (value in listOf(InstagramAuthorizationWitness(attemptId, "connect"), witness(),
            witness("reconnect"), witness().copy(connectionId = newConnection, expiresAt = newExpiry))) {
            val encoded = InstagramAuthorizationWitnessCodec.encode(value)
            assertEquals(value, InstagramAuthorizationWitnessCodec.decode(encoded))
            assertFalse(encoded.contains("https://"))
            assertFalse(encoded.contains("access_token"))
        }
    }

    @Test fun codecRejectsMalformedTruncatedExtraAndCredentialShapedInputWithoutEchoingIt() {
        val good = InstagramAuthorizationWitnessCodec.encode(witness())
        for (encoded in listOf("", "1|broken", good + "|extra", good.replaceFirst("1|", "2|"),
            good.replace(oldExpiry, "invalid-date"), good.replace("connect", "SYNTHETIC_SECRET_CANARY"),
            "x".repeat(513), good.replace(oldConnection, "https://invalid.example/?state=CANARY"))) {
            val error = assertThrows(IllegalArgumentException::class.java) { InstagramAuthorizationWitnessCodec.decode(encoded) }
            assertEquals("OAuth attempt record unavailable", error.message)
        }
        for (invalid in listOf(witness().copy(id = "bad"), witness().copy(purpose = "other"),
            witness().copy(previousConnectionId = null), witness().copy(connectionId = newConnection),
            witness().copy(expiresAt = newExpiry), witness().copy(previousExpiresAt = " invalid "),
            InstagramAuthorizationWitness(attemptId, "reconnect"))) {
            assertThrows(IllegalArgumentException::class.java) { InstagramAuthorizationWitnessCodec.encode(invalid) }
        }
    }

    @Test fun unidentifiedConnectRequiresNewIdentityOrStrictlyNewerExpiryOnSameIdentity() {
        val pending = witness()
        assertTrue(pending.matches(status()))
        assertTrue(pending.matches(status(oldConnection)))
        assertFalse(pending.matches(status(oldConnection, expiresAt = oldExpiry)))
        assertFalse(pending.matches(status(oldConnection, expiresAt = "2026-09-07T19:10:00.000Z")))
        assertFalse(pending.matches(status(oldConnection, expiresAt = null)))
        assertFalse(pending.copy(previousExpiresAt = null).matches(status(oldConnection)))
        assertTrue(InstagramAuthorizationWitness(attemptId, "connect").matches(status()))
    }

    @Test fun reconnectRecoveryRequiresMatchingPurposeAndNeverAdoptsTheOldTerminalResponse() {
        val pending = witness("reconnect")
        assertTrue(pending.matches(status(oldConnection, "reconnect")))
        assertFalse(pending.matches(status(oldConnection, "reconnect", oldExpiry)))
        assertFalse(pending.matches(status(oldConnection, "connect")))
        assertFalse(pending.matches(status(oldConnection, "reconnect", "not-a-date")))
    }

    @Test fun identifiedWitnessRequiresExactPurposeIdentityAndExpiryRegardlessOfObservedState() {
        val identified = witness().copy(connectionId = newConnection, expiresAt = newExpiry)
        for (state in listOf("authorization_pending", "authorization_processing", "authorization_completed",
            "authorization_expired", "authorization_failed", "authorization_cancelled")) {
            assertTrue(identified.matches(status(state = state)))
        }
        assertFalse(identified.matches(status(oldConnection)))
        assertFalse(identified.matches(status(purpose = "reconnect")))
        assertFalse(identified.matches(status(expiresAt = oldExpiry)))
        assertFalse(identified.matches(status(expiresAt = null)))
        assertFalse(identified.matches(status(state = "unknown")))
    }

    @Test fun createIsExclusiveAndExistingWitnessSurvivesStoreReconstruction() {
        val memory = MemoryStorage()
        val first = memory.store()
        assertTrue(first.create(contextKey, witness()))
        assertFalse(first.create(contextKey, witness().copy(id = otherAttemptId)))
        val restored = memory.store()
        assertEquals(witness(), restored.read(contextKey))
        assertFalse(restored.create(contextKey, witness()))
        assertEquals(1, memory.writes)
    }

    @Test fun storagePartitionsDoNotAdoptOrClearAnotherSessionsAttempt() {
        val memory = MemoryStorage()
        val store = memory.store()
        assertTrue(store.create(contextKey, witness()))
        assertNull(store.read(otherContextKey))
        assertFalse(store.clear(otherContextKey, attemptId))
        assertTrue(store.create(otherContextKey, witness().copy(id = otherAttemptId)))
        assertFalse(store.clear(contextKey, otherAttemptId))
        assertEquals(witness(), store.read(contextKey))
    }

    @Test fun concurrentCreatesAcrossInstancesHaveOnlyOneWinner() {
        val memory = MemoryStorage()
        val first = memory.store()
        val second = memory.store()
        val start = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val left = executor.submit<Boolean> { start.await(); first.create(contextKey, witness()) }
            val right = executor.submit<Boolean> { start.await(); second.create(contextKey, witness().copy(id = otherAttemptId)) }
            start.countDown()
            assertEquals(1, listOf(left.get(5, TimeUnit.SECONDS), right.get(5, TimeUnit.SECONDS)).count { it })
            assertEquals(1, memory.writes)
            assertNotNull(memory.store().read(contextKey))
        } finally {
            executor.shutdownNow()
        }
    }

    @Test fun initialCreateCannotPretendAnOldObservedSessionWasTheNewPostResponse() {
        val memory = MemoryStorage()
        val identified = witness().copy(connectionId = oldConnection, expiresAt = oldExpiry)
        assertThrows(IllegalStateException::class.java) { memory.store().create(contextKey, identified) }
        assertEquals(0, memory.writes)
    }

    @Test fun updateOnlyIdentifiesSameAttemptAndCannotReplaceItsBaselineOrKnownIdentity() {
        val store = MemoryStorage().store()
        val identified = witness().copy(connectionId = newConnection, expiresAt = newExpiry)
        assertFalse(store.update(contextKey, identified))
        assertTrue(store.create(contextKey, witness()))
        assertFalse(store.update(contextKey, identified.copy(id = otherAttemptId)))
        assertFalse(store.update(contextKey, identified.copy(purpose = "reconnect")))
        assertFalse(store.update(contextKey, identified.copy(previousConnectionId = newConnection)))
        assertFalse(store.update(contextKey, identified.copy(previousExpiresAt = newExpiry)))
        assertFalse(store.update(contextKey, witness()))
        assertTrue(store.update(contextKey, identified))
        assertTrue(store.update(contextKey, identified))
        assertFalse(store.update(contextKey, identified.copy(connectionId = oldConnection)))
        assertFalse(store.update(contextKey, identified.copy(expiresAt = oldExpiry)))
        assertFalse(store.update(contextKey, witness()))
        assertEquals(identified, store.read(contextKey))
    }

    @Test fun directPostCanIdentifyReconnectWithoutPriorExpiryButUncorrelatedGetCannot() {
        val initial = witness("reconnect").copy(previousExpiresAt = null)
        val store = MemoryStorage().store()
        assertTrue(store.create(contextKey, initial))
        assertFalse(initial.matches(status(oldConnection, "reconnect")))
        val identified = initial.copy(connectionId = oldConnection, expiresAt = newExpiry)
        assertTrue(store.update(contextKey, identified))
        assertTrue(store.read(contextKey)!!.matches(status(oldConnection, "reconnect")))
    }

    @Test fun clearIsCompareAndSetAndCannotRemoveALaterAttempt() {
        val store = MemoryStorage().store()
        assertTrue(store.create(contextKey, witness()))
        assertFalse(store.clear(contextKey, otherAttemptId))
        assertTrue(store.clear(contextKey, attemptId))
        assertNull(store.read(contextKey))
        assertTrue(store.create(contextKey, witness().copy(id = otherAttemptId)))
        assertFalse(store.clear(contextKey, attemptId))
        assertEquals(otherAttemptId, store.read(contextKey)!!.id)
    }

    @Test fun malformedStoredValueNeverBecomesAbsenceAndCannotBeOverwrittenOrCleared() {
        for (operation in listOf<(InstagramAuthorizationWitnessStore) -> Unit>(
            { it.read(contextKey) }, { it.create(contextKey, witness()) },
            { it.update(contextKey, witness().copy(connectionId = newConnection, expiresAt = newExpiry)) },
            { it.clear(contextKey, attemptId) })) {
            val memory = MemoryStorage().apply { values["attempt.$contextKey"] = "SYNTHETIC_SECRET_CANARY" }
            val error = assertThrows(IllegalStateException::class.java) { operation(memory.store()) }
            assertEquals("OAuth attempt record unavailable", error.message)
            assertEquals(0, memory.writes)
        }
    }

    @Test fun failedCommitPoisonsMemoryCacheAndNeverPermitsAnotherAttempt() {
        val memory = MemoryStorage().apply { commitSucceeds = false }
        val store = memory.store()
        assertFalse(store.create(contextKey, witness()))
        assertThrows(IllegalStateException::class.java) { store.read(contextKey) }
        assertThrows(IllegalStateException::class.java) { store.create(contextKey, witness()) }
        assertEquals(1, memory.writes)
    }

    @Test fun updateAndClearFailuresRemainClosedEvenIfMemoryCacheAlreadyChanged() {
        for (clear in listOf(false, true)) {
            val memory = MemoryStorage()
            val store = memory.store()
            assertTrue(store.create(contextKey, witness()))
            memory.commitSucceeds = false
            if (clear) assertFalse(store.clear(contextKey, attemptId))
            else assertFalse(store.update(contextKey, witness().copy(connectionId = newConnection, expiresAt = newExpiry)))
            assertThrows(IllegalStateException::class.java) { store.read(contextKey) }
            assertThrows(IllegalStateException::class.java) { store.create(contextKey, witness().copy(id = otherAttemptId)) }
        }
    }

    @Test fun readWriteExceptionsAndInvalidKeysHaveOnlySanitizedFailures() {
        val failingRead = EncodedInstagramAuthorizationWitnessStore(
            { throw IllegalArgumentException("SYNTHETIC_SECRET_CANARY") }, { _, _ -> true })
        assertEquals("OAuth attempt record unavailable",
            assertThrows(IllegalStateException::class.java) { failingRead.read(contextKey) }.message)
        val failingWrite = EncodedInstagramAuthorizationWitnessStore({ null },
            { _, _ -> throw IllegalArgumentException("SYNTHETIC_SECRET_CANARY") })
        assertEquals("OAuth attempt record unavailable",
            assertThrows(IllegalStateException::class.java) { failingWrite.create(contextKey, witness()) }.message)
        for (key in listOf("", "SYNTHETIC_SESSION_TOKEN", "A".repeat(64), "a".repeat(63), "a".repeat(65))) {
            val memory = MemoryStorage()
            assertThrows(IllegalStateException::class.java) { memory.store().create(key, witness()) }
            assertEquals(0, memory.writes)
        }
    }

    private class MemoryStorage {
        val values = mutableMapOf<String, String>()
        private val lock = Any()
        var writes = 0
        var commitSucceeds = true
        fun store() = EncodedInstagramAuthorizationWitnessStore(
            readValue = { values[it] },
            writeValue = { key, value ->
                writes += 1
                if (value == null) values.remove(key) else values[key] = value
                commitSucceeds
            }, lock = lock)
    }
}
