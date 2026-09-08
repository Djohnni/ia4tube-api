package br.com.ia4tube.app.feature.instagram

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap

/** Route lifetime only: synthetic gateways and local metadata, with no HTTP/device access. */
@OptIn(ExperimentalCoroutinesApi::class)
class InstagramRouteExitTest {
    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() { Dispatchers.setMain(dispatcher) }
    @After fun tearDown() { Dispatchers.resetMain() }

    @Test fun routeExitKeepsExactDraftButReturnNeedsFreshClosedGateSnapshot() = runTest(dispatcher) {
        val gateway = Gateway().apply { allowed = false }
        val model = model(gateway)
        model.onResume(); model.awaitIdle()
        val jpeg = selectDraft(model)
        val before = jpeg.copyOf()
        model.onRouteExit()
        assertArrayEquals(before, model.uiState.value.draftJpeg)
        assertEquals(CAPTION, model.uiState.value.draftCaption)
        assertNull(model.uiState.value.operationalAvailability)
        assertFalse(model.uiState.value.canUpload)
        assertFalse(model.uiState.value.canPublish)
        model.onResume(); model.awaitIdle()
        assertArrayEquals(before, model.uiState.value.draftJpeg)
        assertEquals(CAPTION, model.uiState.value.draftCaption)
        assertEquals(2, gateway.snapshotCalls)
        assertFalse(model.uiState.value.canUpload)
        assertEquals(0, gateway.uploadCalls)
        assertEquals(0, gateway.authorizeCalls)
        assertEquals(0, gateway.publishCalls)
    }

    @Test fun oldRefreshAndFinallyCannotOverwriteReturnedEntryOrItsBusyState() = runTest(dispatcher) {
        val gateway = Gateway()
        val model = model(gateway)
        model.onResume(); model.awaitIdle()
        val jpeg = selectDraft(model).copyOf()
        val oldStarted = CompletableDeferred<Unit>()
        val oldFinish = CompletableDeferred<Unit>()
        gateway.snapshotResponse = {
            oldStarted.complete(Unit)
            withContext(NonCancellable) { oldFinish.await() }
            InstagramResult.Success(InstagramConnectionSnapshot(CONNECTION.copy(connectionId = OTHER_ID),
                InstagramOperationalAvailability(true, true)))
        }
        model.refresh(); oldStarted.await()
        model.onRouteExit()
        val newStarted = CompletableDeferred<Unit>()
        val newFinish = CompletableDeferred<Unit>()
        gateway.snapshotResponse = {
            newStarted.complete(Unit)
            newFinish.await()
            InstagramResult.Success(InstagramConnectionSnapshot(CONNECTION,
                InstagramOperationalAvailability(false, false)))
        }
        model.onResume(); newStarted.await()
        oldFinish.complete(Unit); testScheduler.runCurrent()
        assertTrue(model.uiState.value.busy)
        assertNull(model.uiState.value.operationalAvailability)
        assertEquals(CONNECTION, model.uiState.value.connection)
        assertArrayEquals(jpeg, model.uiState.value.draftJpeg)
        newFinish.complete(Unit); model.awaitIdle()
        assertArrayEquals(jpeg, model.uiState.value.draftJpeg)
        assertEquals(CAPTION, model.uiState.value.draftCaption)
        assertFalse(model.uiState.value.canUpload)
        assertEquals(0, gateway.uploadCalls)
    }

    @Test fun definitiveExitRejectsOldPickerTicketWithoutErasingPreviousDraft() = runTest(dispatcher) {
        val model = model(Gateway())
        model.onResume(); model.awaitIdle()
        val original = selectDraft(model).copyOf()
        val oldTicket = model.pickerSessionKey()!!
        model.onRouteExit()
        assertFalse(model.uiState.value.jpegSelectionPending)
        val lateBytes = InstagramPoliciesTest.jpegEnvelope()
        model.acceptJpeg(lateBytes, oldTicket)
        assertTrue(lateBytes.all { it == 0.toByte() })
        assertArrayEquals(original, model.uiState.value.draftJpeg)
        model.onResume(); model.awaitIdle()
        val newTicket = model.pickerSessionKey()
        assertNotNull(newTicket)
        assertNotEquals(oldTicket, newTicket)
    }

    @Test fun pickerPauseIsNotDefinitiveExitAndKeepsItsTicket() = runTest(dispatcher) {
        val model = model(Gateway().apply { allowed = false })
        model.onResume(); model.awaitIdle()
        val ticket = model.pickerSessionKey()!!
        model.onPause()
        val jpeg = InstagramPoliciesTest.jpegEnvelope()
        val expected = jpeg.copyOf()
        model.acceptJpeg(jpeg, ticket)
        assertTrue(model.uiState.value.jpegSelectionPending)
        model.onResume(); model.awaitIdle()
        assertArrayEquals(expected, model.uiState.value.draftJpeg)
        assertFalse(model.uiState.value.jpegSelectionPending)
        assertFalse(model.uiState.value.canUpload)
    }

    @Test fun routeExitDropsQueuedBrowserEventWithoutCreatingAnotherAuthorization() = runTest(dispatcher) {
        val gateway = Gateway().apply { connection = null }
        val model = model(gateway)
        model.onResume(); model.awaitIdle()
        model.connect(); model.awaitIdle()
        assertNotNull(model.uiState.value.authorizationUrlToOpen)
        model.onRouteExit()
        assertNull(model.takeAuthorizationUrl())
        model.onResume(); model.awaitIdle()
        assertNull(model.takeAuthorizationUrl())
        assertEquals(1, gateway.authorizeCalls)
    }

    @Test fun lateNonCancellableAuthorizationCannotOpenBrowserInReturnedEntry() = runTest(dispatcher) {
        val started = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        val gateway = Gateway().apply {
            connection = null
            authorizeResponse = {
                started.complete(Unit)
                withContext(NonCancellable) { finish.await() }
                authorization()
            }
        }
        val authStore = AuthorizationStore()
        val model = model(gateway, authStore = authStore)
        model.onResume(); model.awaitIdle()
        model.connect(); started.await()
        model.onRouteExit()
        model.onResume(); model.awaitIdle()
        finish.complete(Unit); testScheduler.runCurrent()
        assertNull(model.takeAuthorizationUrl())
        assertTrue(model.uiState.value.authorizationOutcomeUnknown)
        assertFalse(model.uiState.value.canAuthorize)
        assertEquals(1, authStore.values.size)
        assertEquals(1, gateway.authorizeCalls)
    }

    @Test fun lateUploadPersistsOnlyOriginalWitnessWithoutPromotingNewEntry() = runTest(dispatcher) {
        val started = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        val gateway = Gateway().apply {
            uploadResponse = {
                started.complete(Unit)
                withContext(NonCancellable) { finish.await() }
                uploadSuccess()
            }
        }
        val delegate = inMemoryUploadWitnessStore()
        val confirmed = CompletableDeferred<Unit>()
        val store = object : InstagramUploadWitnessStore by delegate {
            override fun update(contextKey: String, witness: InstagramUploadWitness): Boolean =
                delegate.update(contextKey, witness).also {
                    if (it && witness.phase == InstagramUploadPhase.CONFIRMED) confirmed.complete(Unit)
                }
        }
        val model = model(gateway, uploadStore = store)
        model.onResume(); model.awaitIdle(); selectDraft(model)
        model.upload(); started.await()
        val originalId = model.uiState.value.uploadWitness!!.id
        model.onRouteExit()
        gateway.allowed = false
        model.onResume(); model.awaitIdle()
        assertEquals(InstagramUploadPhase.UNKNOWN, model.uiState.value.uploadWitness?.phase)
        finish.complete(Unit); confirmed.await(); testScheduler.runCurrent()
        val key = InstagramIntentPolicy.contextKey(ORIGIN, CONNECTION_ID)
        assertEquals(originalId, store.read(key)?.id)
        assertEquals(InstagramUploadPhase.CONFIRMED, store.read(key)?.phase)
        assertEquals(InstagramUploadPhase.UNKNOWN, model.uiState.value.uploadWitness?.phase)
        assertNull(model.uiState.value.selectedMediaId)
        assertFalse(model.uiState.value.canUpload)
        assertFalse(model.uiState.value.canPublish)
        model.upload()
        assertEquals(1, gateway.uploadCalls)
        assertEquals(0, gateway.publishCalls)
    }

    @Test fun routeRetentionDoesNotPreserveDraftAcrossNewSessionOrNewAccountBinding() = runTest(dispatcher) {
        for (changeSession in listOf(false, true)) {
            val gateway = Gateway()
            var token = "synthetic-route-session-one"
            val model = model(gateway, token = { token })
            model.onResume(); model.awaitIdle()
            val bytes = selectDraft(model)
            model.onRouteExit()
            if (changeSession) token = "synthetic-route-session-two"
            else gateway.connection = CONNECTION.copy(connectionRevision = 5)
            model.onResume(); model.awaitIdle()
            assertNull(model.uiState.value.draftJpeg)
            assertEquals("", model.uiState.value.draftCaption)
            assertTrue(bytes.all { it == 0.toByte() })
            assertEquals(0, gateway.uploadCalls)
        }
    }

    private fun model(gateway: Gateway, token: () -> String = { "synthetic-route-session" },
        authStore: AuthorizationStore = AuthorizationStore(),
        uploadStore: InstagramUploadWitnessStore = inMemoryUploadWitnessStore()) = InstagramViewModel(
        token, IntentStore(), ORIGIN, { gateway }, authStore, uploadStore)

    private fun selectDraft(model: InstagramViewModel): ByteArray {
        val bytes = InstagramPoliciesTest.jpegEnvelope()
        model.acceptJpeg(bytes, model.pickerSessionKey()!!)
        model.updateCaption(CAPTION)
        assertNotNull(model.uiState.value.draftJpeg)
        return bytes
    }

    private suspend fun InstagramViewModel.awaitIdle() { uiState.first { !it.busy } }

    private class Gateway : InstagramGateway {
        var connection: InstagramConnection? = CONNECTION
        var allowed = true
        var snapshotCalls = 0
        var authorizeCalls = 0
        var uploadCalls = 0
        var publishCalls = 0
        var snapshotResponse: (suspend () -> InstagramResult<InstagramConnectionSnapshot>)? = null
        var authorizeResponse: suspend () -> InstagramResult<InstagramAuthorization> = { authorization() }
        var uploadResponse: suspend () -> InstagramResult<InstagramMedia> = { uploadSuccess() }
        override suspend fun currentConnection() = InstagramResult.Success(connection)
        override suspend fun currentSnapshot(): InstagramResult<InstagramConnectionSnapshot> {
            snapshotCalls++
            return snapshotResponse?.invoke() ?: InstagramResult.Success(InstagramConnectionSnapshot(
                connection, InstagramOperationalAvailability(allowed, allowed)))
        }
        override suspend fun authorize(purpose: String): InstagramResult<InstagramAuthorization> {
            authorizeCalls++; return authorizeResponse()
        }
        override suspend fun authorizationStatus(connectionId: String) = InstagramResult.Success(
            InstagramAuthorizationStatus(connectionId, "connect",
                if (connection == null) "authorization_pending" else "authorization_completed", EXPIRES))
        override suspend fun media() = InstagramResult.Success(emptyList<InstagramMedia>())
        override suspend fun uploadMedia(jpeg: ByteArray, caption: String): InstagramResult<InstagramMedia> {
            uploadCalls++; return uploadResponse()
        }
        override suspend fun publications() = InstagramResult.Success(InstagramHistory(emptyList(), true, true))
        override suspend fun publication(publicationId: String) = InstagramResult.Failure(InstagramError.UNAVAILABLE)
        override suspend fun publicationIntent(clientRequestId: String) = InstagramResult.Success<InstagramPublication?>(null)
        override suspend fun publish(mediaId: String, clientRequestId: String, binding: InstagramConnectionBinding): InstagramResult<InstagramPublication> {
            publishCalls++; return InstagramResult.Failure(InstagramError.UNAVAILABLE)
        }
        override suspend fun reconcile(publicationId: String, binding: InstagramConnectionBinding) =
            InstagramResult.Failure(InstagramError.UNAVAILABLE)
    }

    private class AuthorizationStore : InstagramAuthorizationWitnessStore {
        val values = ConcurrentHashMap<String, InstagramAuthorizationWitness>()
        override fun read(contextKey: String) = values[contextKey]
        override fun create(contextKey: String, witness: InstagramAuthorizationWitness) = values.putIfAbsent(contextKey, witness) == null
        override fun update(contextKey: String, witness: InstagramAuthorizationWitness): Boolean {
            val previous = values[contextKey] ?: return false
            return InstagramAuthorizationWitnessPolicy.canUpdate(previous, witness) && values.replace(contextKey, previous, witness)
        }
        override fun clear(contextKey: String, id: String): Boolean {
            val previous = values[contextKey]?.takeIf { it.id == id } ?: return false
            return values.remove(contextKey, previous)
        }
    }

    private class IntentStore : InstagramPublicationIntentStore {
        override fun read(contextKey: String): InstagramPublicationIntent? = null
        override fun create(contextKey: String, intent: InstagramPublicationIntent) = false
        override fun update(contextKey: String, intent: InstagramPublicationIntent) = false
        override fun removeConfirmed(contextKey: String, clientRequestId: String) = false
    }

    companion object {
        private const val ORIGIN = "https://ia4tube-api.onrender.com"
        private const val CONNECTION_ID = "11111111-1111-4111-8111-111111111111"
        private const val OTHER_ID = "22222222-2222-4222-8222-222222222222"
        private const val CAPTION = "Legenda sintética exata da navegação"
        private const val EXPIRES = "2026-09-08T12:30:00Z"
        private val CONNECTION = InstagramConnection(CONNECTION_ID, "connected", "healthy", "fixture",
            "business", "123456789012345", 4)
        private val MEDIA = InstagramMedia("reviewer-jpeg:" + "a".repeat(64), CAPTION, 1080, 1080)
        private fun authorization() = InstagramResult.Success(InstagramAuthorization(CONNECTION_ID,
            InstagramPoliciesTest.authorizationUrl(), EXPIRES))
        private fun uploadSuccess() = InstagramResult.Success(MEDIA,
            InstagramRequestDiagnostic(true, true, 201, "http_success", InstagramRequestStage.HTTP_RESPONSE, 1, 1, false))
    }
}
