package br.com.ia4tube.app.feature.instagram

import br.com.ia4tube.app.feature.calendar.CalendarFailure
import br.com.ia4tube.app.feature.calendar.CalendarGateway
import br.com.ia4tube.app.feature.calendar.CalendarSnapshot
import br.com.ia4tube.app.feature.calendar.CalendarViewModel
import br.com.ia4tube.app.feature.calendar.ScheduledArt
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** The header refresh uses synthetic gateways only: no HTTP, device, OAuth or publication. */
@OptIn(ExperimentalCoroutinesApi::class)
class InstagramCalendarRefreshTest {
    private val dispatcher = StandardTestDispatcher()
    @Before fun before() { Dispatchers.setMain(dispatcher) }
    @After fun after() { Dispatchers.resetMain() }

    @Test fun oneClickRefreshesBothModelsAndRapidSecondClickCannotDuplicateWork() = runTest(dispatcher) {
        val host = Host()
        try {
            refreshInstagramAndCalendar(host.instagram, host.calendar, readingImage = false)
            refreshInstagramAndCalendar(host.instagram, host.calendar, readingImage = false)
            host.awaitIdle()
            assertEquals(1, host.instagramGateway.snapshots)
            assertEquals(1, host.instagramGateway.authorizationReads)
            assertEquals(1, host.instagramGateway.mediaReads)
            assertEquals(1, host.instagramGateway.historyReads)
            assertEquals(1, host.calendarGateway.reads)
            assertTrue(host.calendar.uiState.value.fresh)
            assertNull(host.instagram.uiState.value.error)
            host.assertNoMutations()
        } finally { host.close() }
    }

    @Test fun busyCalendarPreventsHeaderFromStartingEitherRefresh() = runTest(dispatcher) {
        val host = Host()
        try {
            val finish = CompletableDeferred<Unit>()
            host.calendarGateway.pending = finish
            host.calendar.refresh()
            runCurrent()
            refreshInstagramAndCalendar(host.instagram, host.calendar, readingImage = false)
            assertEquals(0, host.instagramGateway.snapshots)
            assertEquals(1, host.calendarGateway.reads)
            finish.complete(Unit)
            host.awaitIdle()
            host.assertNoMutations()
        } finally { host.close() }
    }

    @Test fun busyInstagramPreventsHeaderFromStartingCalendarOrAnotherRefresh() = runTest(dispatcher) {
        val host = Host()
        try {
            val finish = CompletableDeferred<Unit>()
            host.instagramGateway.pending = finish
            host.instagram.refresh()
            refreshInstagramAndCalendar(host.instagram, host.calendar, readingImage = false)
            assertEquals(0, host.calendarGateway.reads)
            finish.complete(Unit)
            host.awaitIdle()
            assertEquals(1, host.instagramGateway.snapshots)
            assertEquals(0, host.calendarGateway.reads)
            host.assertNoMutations()
        } finally { host.close() }
    }

    @Test fun readingLocalImageDoesNotStartEitherRefresh() = runTest(dispatcher) {
        val host = Host()
        try {
            refreshInstagramAndCalendar(host.instagram, host.calendar, readingImage = true)
            runCurrent()
            assertEquals(0, host.instagramGateway.snapshots)
            assertEquals(0, host.calendarGateway.reads)
            host.assertNoMutations()
        } finally { host.close() }
    }

    @Test fun explicitRefreshRecoversFailedCalendarReadWithoutAuthorizationOrPreferenceChange() = runTest(dispatcher) {
        val host = Host()
        try {
            host.calendarGateway.failure = CalendarFailure(503)
            refreshInstagramAndCalendar(host.instagram, host.calendar, readingImage = false)
            host.awaitIdle()
            assertNotNull(host.calendar.uiState.value.error)
            assertFalse(host.calendar.uiState.value.fresh)
            host.calendarGateway.failure = null
            refreshInstagramAndCalendar(host.instagram, host.calendar, readingImage = false)
            host.awaitIdle()
            assertEquals(2, host.calendarGateway.reads)
            assertEquals(2, host.instagramGateway.snapshots)
            assertTrue(host.calendar.uiState.value.fresh)
            assertNull(host.calendar.uiState.value.error)
            assertFalse(host.calendar.uiState.value.data.automatic)
            host.assertNoMutations()
        } finally { host.close() }
    }

    private class Host {
        val instagramGateway = InstagramFake()
        val calendarGateway = CalendarFake()
        val instagram = InstagramViewModel(
            { "synthetic-only" }, EmptyIntentStore(), "https://synthetic.invalid",
            { instagramGateway }, EmptyAuthorizationStore(), EmptyUploadStore())
        val calendar = CalendarViewModel({ "synthetic-only" }, "synthetic-only", calendarGateway)

        suspend fun awaitIdle() {
            instagram.uiState.first { !it.busy }
            calendar.uiState.first { !it.busy }
        }
        fun assertNoMutations() {
            assertEquals(0, instagramGateway.mutations)
            assertEquals(0, calendarGateway.mutations)
            assertNull(instagram.uiState.value.authorizationUrlToOpen)
        }
        fun close() { instagram.onRouteExit(); calendar.dispose() }
    }

    private class InstagramFake : InstagramGateway {
        var snapshots = 0
        var authorizationReads = 0
        var mediaReads = 0
        var historyReads = 0
        var mutations = 0
        var pending: CompletableDeferred<Unit>? = null
        private val connection = InstagramConnection("11111111-1111-4111-8111-111111111111",
            "connected", "healthy", "synthetic", "business", "123456789012345", 1)
        override suspend fun currentConnection() = InstagramResult.Success(connection)
        override suspend fun currentSnapshot(): InstagramResult<InstagramConnectionSnapshot> {
            snapshots++
            pending?.await()
            return InstagramResult.Success(InstagramConnectionSnapshot(connection, InstagramOperationalAvailability(false, false)))
        }
        override suspend fun authorizationStatus(connectionId: String): InstagramResult<InstagramAuthorizationStatus> {
            authorizationReads++
            return InstagramResult.Success(InstagramAuthorizationStatus(connectionId, "connect", "authorization_completed", null))
        }
        override suspend fun media(): InstagramResult<List<InstagramMedia>> {
            mediaReads++
            return InstagramResult.Success(emptyList())
        }
        override suspend fun publications(): InstagramResult<InstagramHistory> {
            historyReads++
            return InstagramResult.Success(InstagramHistory(emptyList(), false, false))
        }
        override suspend fun publication(publicationId: String) = InstagramResult.Failure(InstagramError.UNAVAILABLE)
        override suspend fun publicationIntent(clientRequestId: String) = InstagramResult.Success<InstagramPublication?>(null)
        private fun rejectMutation(): InstagramResult.Failure { mutations++; return InstagramResult.Failure(InstagramError.UNAVAILABLE) }
        override suspend fun authorize(purpose: String) = rejectMutation()
        override suspend fun uploadMedia(jpeg: ByteArray, caption: String) = rejectMutation()
        override suspend fun publish(mediaId: String, clientRequestId: String, binding: InstagramConnectionBinding) = rejectMutation()
        override suspend fun reconcile(publicationId: String, binding: InstagramConnectionBinding) = rejectMutation()
    }

    private class CalendarFake : CalendarGateway {
        var reads = 0
        var mutations = 0
        var pending: CompletableDeferred<Unit>? = null
        var failure: Exception? = null
        override suspend fun list(): CalendarSnapshot {
            reads++
            pending?.await()
            failure?.let { throw it }
            return CalendarSnapshot(enabled = true)
        }
        override suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot {
            mutations++; throw CalendarFailure(403)
        }
        override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot {
            mutations++; throw CalendarFailure(403)
        }
        override suspend fun destination(item: ScheduledArt, destination: String): CalendarSnapshot {
            mutations++; throw CalendarFailure(403)
        }
        override suspend fun automatic(item: ScheduledArt, enabled: Boolean): CalendarSnapshot {
            mutations++; throw CalendarFailure(403)
        }
    }

    private class EmptyIntentStore : InstagramPublicationIntentStore {
        override fun read(contextKey: String): InstagramPublicationIntent? = null
        override fun create(contextKey: String, intent: InstagramPublicationIntent): Boolean = error("No writes")
        override fun update(contextKey: String, intent: InstagramPublicationIntent): Boolean = error("No writes")
        override fun removeConfirmed(contextKey: String, clientRequestId: String): Boolean = error("No writes")
        override fun removeTerminalFailure(contextKey: String, clientRequestId: String, publication: InstagramPublication): Boolean = error("No writes")
    }
    private class EmptyAuthorizationStore : InstagramAuthorizationWitnessStore {
        override fun read(contextKey: String): InstagramAuthorizationWitness? = null
        override fun create(contextKey: String, witness: InstagramAuthorizationWitness): Boolean = error("No writes")
        override fun update(contextKey: String, witness: InstagramAuthorizationWitness): Boolean = error("No writes")
        override fun clear(contextKey: String, id: String): Boolean = error("No writes")
    }
    private class EmptyUploadStore : InstagramUploadWitnessStore {
        override fun read(contextKey: String): InstagramUploadWitness? = null
        override fun create(contextKey: String, witness: InstagramUploadWitness): Boolean = error("No writes")
        override fun update(contextKey: String, witness: InstagramUploadWitness): Boolean = error("No writes")
        override fun clearResolved(contextKey: String, id: String): Boolean = error("No writes")
    }
}
