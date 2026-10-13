package br.com.ia4tube.app.feature.calendar

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.net.SocketTimeoutException

@OptIn(ExperimentalCoroutinesApi::class)
class CalendarAutomaticConfirmationTest {
    private val dispatcher = StandardTestDispatcher()
    @Before fun before() { Dispatchers.setMain(dispatcher) }
    @After fun after() { Dispatchers.resetMain() }

    private class Fake(var snapshot: CalendarSnapshot = CalendarConsentFixtures.snapshot()) : CalendarGateway {
        var reads = 0
        val writes = mutableListOf<Pair<Boolean, Long>>()
        var pending: CompletableDeferred<Unit>? = null
        var failure: Exception? = null
        var response: CalendarSnapshot? = null
        override suspend fun list(): CalendarSnapshot { reads++; return snapshot }
        override suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot {
            writes += enabled to revision
            pending?.await()
            failure?.let { throw it }
            return response ?: snapshot.copy(automatic = enabled, preferenceRevision = revision + 1,
                preferenceBinding = snapshot.connectionBinding)
        }
        override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot =
            error("Consent tests must not edit or publish an art")
    }

    @Test fun renewalAfterReconnectNeedsOneExplicitConfirmationAndNoFollowupRequest() = runTest(dispatcher) {
        val fake = Fake(); val model = CalendarViewModel({ "synthetic" }, "synthetic", fake)
        try {
            model.refresh(); advanceUntilIdle()
            assertTrue(model.uiState.value.data.requiresConsentRenewal)
            assertTrue(fake.writes.isEmpty())
            val target = model.uiState.value.data.automaticConfirmationTarget()!!
            model.confirmAutomatic(target); advanceUntilIdle()
            assertEquals(listOf(true to 8L), fake.writes)
            assertTrue(model.uiState.value.fresh)
            assertTrue(model.uiState.value.data.automaticAuthorized)
            assertEquals(CalendarConsentFixtures.current, model.uiState.value.data.preferenceBinding)
            assertEquals(9L, model.uiState.value.data.preferenceRevision)
            advanceTimeBy(180_000); runCurrent()
            assertEquals(1, fake.reads)
            assertEquals(1, fake.writes.size)
        } finally { model.dispose() }
    }

    @Test fun merelyCapturingOrCancellingConsentAndLegacyEnableDoNotWrite() = runTest(dispatcher) {
        val fake = Fake(); val model = CalendarViewModel({ "synthetic" }, "synthetic", fake)
        try {
            model.refresh(); advanceUntilIdle()
            assertNotNull(model.uiState.value.data.automaticConfirmationTarget())
            model.preferences(true)
            advanceTimeBy(180_000); runCurrent()
            assertTrue(fake.writes.isEmpty())
            assertEquals(1, fake.reads)
            assertTrue(model.uiState.value.data.requiresConsentRenewal)
        } finally { model.dispose() }
    }

    @Test fun anExplicitPauseRemainsAvailableWithoutRenewingOrEnablingConsent() = runTest(dispatcher) {
        val fake = Fake(); val model = CalendarViewModel({ "synthetic" }, "synthetic", fake)
        try {
            model.refresh(); advanceUntilIdle(); model.preferences(false); advanceUntilIdle()
            assertEquals(listOf(false to 8L), fake.writes)
            assertFalse(model.uiState.value.data.automatic)
            assertFalse(model.uiState.value.data.automaticAuthorized)
            assertFalse(model.uiState.value.data.requiresConsentRenewal)
        } finally { model.dispose() }
    }

    @Test fun twoClicksBeforeTheResponseSendExactlyOnePreferenceMutation() = runTest(dispatcher) {
        val fake = Fake().apply { pending = CompletableDeferred() }
        val model = CalendarViewModel({ "synthetic" }, "synthetic", fake)
        try {
            model.refresh(); advanceUntilIdle()
            val target = model.uiState.value.data.automaticConfirmationTarget()!!
            model.confirmAutomatic(target); model.confirmAutomatic(target); runCurrent()
            assertEquals(1, fake.writes.size)
            assertTrue(model.uiState.value.busy)
            fake.pending!!.complete(Unit); advanceUntilIdle()
            assertTrue(model.uiState.value.data.automaticAuthorized)
            assertEquals(1, fake.writes.size)
        } finally { model.dispose() }
    }

    @Test fun noConfirmationBeforeAReadOrAfterPause() = runTest(dispatcher) {
        val fake = Fake(); val model = CalendarViewModel({ "synthetic" }, "synthetic", fake)
        val target = fake.snapshot.automaticConfirmationTarget()!!
        try {
            model.confirmAutomatic(target); advanceUntilIdle()
            assertTrue(fake.writes.isEmpty())
            model.refresh(); advanceUntilIdle(); model.onPause()
            model.confirmAutomatic(target); advanceUntilIdle()
            assertTrue(fake.writes.isEmpty())
            assertFalse(model.uiState.value.fresh)
        } finally { model.dispose() }
    }

    @Test fun changedAccountBindingPreferenceRevisionOrOwnerRejectsTheCapturedTargetLocally() = runTest(dispatcher) {
        val before = CalendarConsentFixtures.snapshot()
        val variants = listOf(before.copy(connectionBinding = CalendarConsentFixtures.other),
            before.copy(connectionBinding = CalendarConsentFixtures.current.copy(connectionRevision = 73)),
            before.copy(connectionBinding = CalendarConsentFixtures.current.copy(externalId = CalendarConsentFixtures.other.externalId)),
            before.copy(connectionBinding = CalendarConsentFixtures.current.copy(connectionId = CalendarConsentFixtures.other.connectionId)),
            before.copy(preferenceRevision = 9), before.copy(username = "other_synthetic"),
            before.copy(identity = CalendarConsentFixtures.owner.copy(userId = "55555555-5555-4555-8555-555555555555")),
            before.copy(connectionBinding = null), before.copy(connected = false))
        for (changed in variants) {
            val fake = Fake(before); val model = CalendarViewModel({ "synthetic" }, "synthetic", fake)
            try {
                model.refresh(); advanceUntilIdle()
                val target = model.uiState.value.data.automaticConfirmationTarget()!!
                fake.snapshot = changed; model.refresh(); advanceUntilIdle()
                model.confirmAutomatic(target); advanceUntilIdle()
                assertTrue("A stale target cannot write", fake.writes.isEmpty())
                assertFalse(model.uiState.value.fresh)
                assertNotNull(model.uiState.value.error)
            } finally { model.dispose() }
        }
    }

    @Test fun timeoutAndConflictRemainUnconfirmedWithoutAutomaticReadOrRetry() = runTest(dispatcher) {
        for (failure in listOf(SocketTimeoutException(), CalendarFailure(409))) {
            val fake = Fake().apply { this.failure = failure }
            val model = CalendarViewModel({ "synthetic" }, "synthetic", fake)
            try {
                model.refresh(); advanceUntilIdle()
                val target = model.uiState.value.data.automaticConfirmationTarget()!!
                model.confirmAutomatic(target); advanceUntilIdle()
                assertFalse(model.uiState.value.fresh)
                assertFalse(model.uiState.value.data.automaticAuthorized)
                assertNotNull(model.uiState.value.error)
                model.confirmAutomatic(target); advanceTimeBy(180_000); runCurrent()
                assertEquals(1, fake.writes.size)
                assertEquals(1, fake.reads)
            } finally { model.dispose() }
        }
    }

    @Test fun wrongSuccessBindingAccountOwnerOrRevisionIsNotAcceptedAsConsent() = runTest(dispatcher) {
        val success = CalendarConsentFixtures.snapshot().copy(preferenceBinding = CalendarConsentFixtures.current, preferenceRevision = 9)
        val variants = listOf(success.copy(preferenceBinding = CalendarConsentFixtures.previous),
            success.copy(preferenceBinding = CalendarConsentFixtures.other, connectionBinding = CalendarConsentFixtures.other),
            success.copy(connectionBinding = null), success.copy(automatic = false),
            success.copy(preferenceRevision = 8), success.copy(preferenceRevision = 10),
            success.copy(username = "other_synthetic"), success.copy(identity = null))
        for (wrong in variants) {
            val fake = Fake().apply { response = wrong }
            val model = CalendarViewModel({ "synthetic" }, "synthetic", fake)
            try {
                model.refresh(); advanceUntilIdle()
                val before = model.uiState.value.data
                model.confirmAutomatic(before.automaticConfirmationTarget()!!); advanceUntilIdle()
                assertEquals(before, model.uiState.value.data)
                assertFalse(model.uiState.value.fresh)
                assertNotNull(model.uiState.value.error)
                assertEquals(1, fake.writes.size)
                assertEquals(1, fake.reads)
            } finally { model.dispose() }
        }
    }

    @Test fun changedSessionBeforeConfirmationCannotWriteAndLateSuccessCannotLeak() = runTest(dispatcher) {
        var token = "first-synthetic"
        val fake = Fake().apply { pending = CompletableDeferred() }
        val model = CalendarViewModel({ token }, token, fake)
        try {
            model.refresh(); advanceUntilIdle()
            val target = model.uiState.value.data.automaticConfirmationTarget()!!
            token = "second-synthetic"
            model.confirmAutomatic(target); advanceUntilIdle()
            assertTrue(fake.writes.isEmpty())
            assertEquals(CalendarUiState(), model.uiState.value)
        } finally { model.dispose() }

        token = "first-synthetic"
        val lateModel = CalendarViewModel({ token }, token, fake)
        try {
            lateModel.refresh(); advanceUntilIdle()
            lateModel.confirmAutomatic(lateModel.uiState.value.data.automaticConfirmationTarget()!!); runCurrent()
            token = "second-synthetic"
            fake.pending!!.complete(Unit); advanceUntilIdle()
            assertEquals(1, fake.writes.size)
            assertEquals(CalendarUiState(), lateModel.uiState.value)
        } finally { lateModel.dispose() }
    }

    @Test fun invalidatingConsentOnlyRefreshesOnceAndNeverEnablesIt() = runTest(dispatcher) {
        val fake = Fake(); val model = CalendarViewModel({ "synthetic" }, "synthetic", fake)
        try {
            model.refresh(); advanceUntilIdle()
            model.invalidateConsent(); advanceUntilIdle()
            assertEquals(2, fake.reads)
            assertTrue(fake.writes.isEmpty())
            assertTrue(model.uiState.value.data.requiresConsentRenewal)
        } finally { model.dispose() }
    }
}
