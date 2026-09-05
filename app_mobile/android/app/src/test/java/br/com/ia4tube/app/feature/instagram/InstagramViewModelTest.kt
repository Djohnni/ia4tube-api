package br.com.ia4tube.app.feature.instagram

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.Collections

/** Exercises the real ViewModel. Gateways are synthetic; no HTTP client is constructed. */
@OptIn(ExperimentalCoroutinesApi::class)
class InstagramViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() { Dispatchers.setMain(dispatcher) }
    @After fun tearDown() { Dispatchers.resetMain() }

    @Test fun doubleConfirmationCreatesOneDurableIntentBeforeTheOnlyPost() = runTest(dispatcher) {
        val events = Collections.synchronizedList(mutableListOf<String>())
        val store = MemoryIntentStore(events)
        val gateway = SyntheticGateway()
        gateway.onPublish = { mediaId, requestId ->
            events.add("publish")
            val durable = store.read(contextKey())
            assertNotNull("The durable intent must already exist when POST starts", durable)
            assertEquals(mediaId, durable!!.mediaId)
            assertEquals(requestId, durable.clientRequestId)
            assertEquals(CONNECTION.binding, durable.binding)
            assertNull(durable.publicationId)
            InstagramResult.Success(publicationFixture())
        }
        val model = model(gateway, store)
        prepareImageForPublication(model)

        model.requestPublicationConfirmation()
        model.confirmPublish()
        model.confirmPublish()
        model.awaitIdle()

        assertEquals(1, gateway.publishCalls.size)
        assertEquals(listOf(CONNECTION.binding), gateway.publishBindings)
        assertEquals(1, store.createCalls)
        assertTrue(events.indexOf("create-complete") < events.indexOf("publish"))
        assertEquals(store.read(contextKey())!!.clientRequestId, gateway.publishCalls.single().second)
        assertTrue(model.uiState.value.intent!!.confirmed)

        model.requestPublicationConfirmation()
        model.confirmPublish()
        assertEquals("A confirmed intent still needs an explicit new draft", 1, gateway.publishCalls.size)
    }

    @Test fun lostResponseIsNeverRetriedOrGuessedFromMatchingHistoryOnResume() = runTest(dispatcher) {
        val store = MemoryIntentStore()
        val gateway = SyntheticGateway().apply {
            onPublish = { _, _ -> InstagramResult.Failure(InstagramError.RESULT_UNKNOWN) }
        }
        val model = model(gateway, store)
        prepareImageForPublication(model)
        model.requestPublicationConfirmation()
        model.confirmPublish()
        model.awaitIdle()
        val original = store.read(contextKey())!!

        // A matching image and caption are insufficient to identify a lost response.
        gateway.history = InstagramHistory(listOf(publicationFixture()), true, true)
        model.refresh()
        model.awaitIdle()
        model.onResume()
        model.awaitIdle()
        model.startNewDraft()
        model.requestPublicationConfirmation()
        model.confirmPublish()
        model.requestContinuationConfirmation()
        model.continuePublicationConfirmation()

        assertEquals(1, gateway.publishCalls.size)
        assertEquals(0, gateway.reconcileCalls.size)
        assertEquals(1, store.createCalls)
        assertEquals(original, store.read(contextKey()))
        assertNull(model.uiState.value.intent!!.publicationId)
        assertTrue(model.uiState.value.hasUnresolvedIntent)
        assertFalse(model.uiState.value.canPublish)
        assertEquals(listOf(original.clientRequestId, original.clientRequestId), gateway.intentLookups)
    }

    @Test fun lostResponseIsRecoveredOnlyByOriginalIntentLookupWithoutPostingAgain() = runTest(dispatcher) {
        val store = MemoryIntentStore()
        val gateway = SyntheticGateway().apply {
            onPublish = { _, _ -> InstagramResult.Failure(InstagramError.RESULT_UNKNOWN) }
        }
        val model = model(gateway, store)
        prepareImageForPublication(model)
        model.requestPublicationConfirmation()
        model.confirmPublish()
        model.awaitIdle()
        val original = store.read(contextKey())!!
        gateway.intentResult = InstagramResult.Success(publicationFixture(confirmed = false))

        model.onResume()
        model.awaitIdle()

        val identified = store.read(contextKey())!!
        assertEquals(original.clientRequestId, identified.clientRequestId)
        assertEquals(original.binding, identified.binding)
        assertEquals(PUBLICATION_ID, identified.publicationId)
        assertFalse(identified.confirmed)
        assertEquals(listOf(original.clientRequestId), gateway.intentLookups)
        assertEquals(1, gateway.publishCalls.size)
        assertTrue(gateway.reconcileCalls.isEmpty())
        assertTrue(model.uiState.value.canContinueConfirmation)
    }

    @Test fun lookupWithDifferentBindingCannotAdoptPublicationOrReleaseWitness() = runTest(dispatcher) {
        val original = InstagramIntentPolicy.create(MEDIA.id, CONNECTION)
        val store = MemoryIntentStore().apply { seed(contextKey(), original) }
        val gateway = SyntheticGateway().apply {
            intentResult = InstagramResult.Success(publicationFixture().copy(
                binding = CONNECTION.binding!!.copy(connectionRevision = 5L)))
        }
        val model = model(gateway, store)
        model.onResume()
        model.awaitIdle()
        assertEquals(original, store.read(contextKey()))
        assertNull(model.uiState.value.intent!!.publicationId)
        assertTrue(gateway.publishCalls.isEmpty())
        assertTrue(gateway.reconcileCalls.isEmpty())
        assertFalse(model.uiState.value.canPublish)
    }

    @Test fun sessionChangeDiscardsStalePublicationResponseAndKeepsItsDurableRecord() = runTest(dispatcher) {
        val store = MemoryIntentStore()
        val publishStarted = CompletableDeferred<Unit>()
        val response = CompletableDeferred<InstagramResult<InstagramPublication>>()
        val oldGateway = SyntheticGateway().apply {
            onPublish = { _, _ -> publishStarted.complete(Unit); response.await() }
        }
        val newGateway = SyntheticGateway().apply {
            connection = CONNECTION.copy(connectionId = OTHER_CONNECTION_ID, username = "@outra_empresa")
            mediaItems = emptyList()
        }
        var currentToken = "synthetic-session-one"
        val capturedProviders = mutableListOf<() -> String>()
        val model = InstagramViewModel(
            tokenProvider = { currentToken }, intentStore = store, apiOrigin = ORIGIN,
            gatewayFactory = { captured ->
                capturedProviders.add(captured)
                if (captured() == "synthetic-session-one") oldGateway else newGateway
            }
        )
        prepareImageForPublication(model)
        val originalImage = model.uiState.value.draftJpeg!!
        model.requestPublicationConfirmation()
        model.confirmPublish()
        publishStarted.await()

        currentToken = "synthetic-session-two"
        response.complete(InstagramResult.Success(publicationFixture()))
        model.awaitIdle()

        assertNull(model.uiState.value.intent)
        assertTrue(model.uiState.value.history.isEmpty())
        assertNull(model.uiState.value.draftJpeg)
        assertTrue("Prior image bytes are cleared when the session changes", originalImage.all { it == 0.toByte() })
        assertNull(store.read(contextKey())!!.publicationId)
        assertEquals("Requests cannot adopt a replacement token", "synthetic-session-one", capturedProviders.first()())

        model.onResume()
        model.awaitIdle()
        assertEquals(OTHER_CONNECTION_ID, model.uiState.value.connection!!.connectionId)
        assertEquals("@outra_empresa", model.uiState.value.connection!!.username)
        assertTrue(model.uiState.value.history.isEmpty())
        assertNull(model.uiState.value.intent)
        assertEquals(1, oldGateway.publishCalls.size)
        assertTrue(newGateway.publishCalls.isEmpty())
    }

    @Test fun identifiedProviderConfirmationOnlyContinuesAfterExplicitConfirmationUsingSameId() = runTest(dispatcher) {
        val pending = publicationFixture(confirmed = false)
        val intent = InstagramIntentPolicy.create(MEDIA.id, CONNECTION).copy(publicationId = PUBLICATION_ID)
        val store = MemoryIntentStore().apply { seed(contextKey(), intent) }
        val gateway = SyntheticGateway().apply {
            history = InstagramHistory(listOf(pending), false, true)
            publicationResult = InstagramResult.Success(pending)
            onReconcile = { id ->
                assertEquals(PUBLICATION_ID, id)
                InstagramResult.Success(publicationFixture())
            }
        }
        val model = model(gateway, store)
        model.onResume()
        model.awaitIdle()
        model.refresh()
        model.awaitIdle()

        assertTrue(model.uiState.value.canContinueConfirmation)
        assertTrue(gateway.publishCalls.isEmpty())
        assertTrue(gateway.reconcileCalls.isEmpty())
        assertEquals(0, gateway.authorizeCalls)
        model.continuePublicationConfirmation()
        assertTrue("A direct handler call without the confirmation dialog is refused", gateway.reconcileCalls.isEmpty())

        model.requestContinuationConfirmation()
        model.continuePublicationConfirmation()
        model.continuePublicationConfirmation()
        model.awaitIdle()

        assertEquals(listOf(PUBLICATION_ID), gateway.reconcileCalls)
        assertEquals(listOf(intent.binding), gateway.reconcileBindings)
        assertTrue(gateway.publishCalls.isEmpty())
        assertEquals(0, store.createCalls)
        assertEquals(intent.clientRequestId, store.read(contextKey())!!.clientRequestId)
        assertTrue(store.read(contextKey())!!.confirmed)
    }

    @Test fun unavailableServiceOnOpenCannotStartAuthorizationOrPublication() = runTest(dispatcher) {
        val gateway = SyntheticGateway().apply {
            connectionFailure = InstagramError.UNAVAILABLE
        }
        val model = model(gateway, MemoryIntentStore())
        model.onResume()
        model.awaitIdle()
        model.connect()
        model.confirmPublish()
        model.continuePublicationConfirmation()
        assertEquals(InstagramAvailability.UNAVAILABLE, model.uiState.value.availability)
        assertEquals(InstagramError.UNAVAILABLE.message, model.uiState.value.error)
        assertEquals(0, gateway.authorizeCalls)
        assertTrue(gateway.publishCalls.isEmpty())
        assertTrue(gateway.reconcileCalls.isEmpty())
    }

    @Test fun freshChangedAccountOnSameConnectionBlocksExplicitContinuation() = runTest(dispatcher) {
        val pending = publicationFixture(confirmed = false)
        val intent = InstagramIntentPolicy.create(MEDIA.id, CONNECTION).copy(publicationId = PUBLICATION_ID)
        val store = MemoryIntentStore().apply { seed(contextKey(), intent) }
        val gateway = SyntheticGateway().apply {
            history = InstagramHistory(listOf(pending), false, true)
            publicationResult = InstagramResult.Success(pending)
        }
        val model = model(gateway, store)
        model.onResume()
        model.awaitIdle()
        assertTrue(model.uiState.value.canContinueConfirmation)

        // The visible state is still the original account when the user opens the dialog.
        gateway.connection = CONNECTION.copy(username = "@conta_reconectada", externalId = "987654321000000", connectionRevision = 5L)
        model.requestContinuationConfirmation()
        model.continuePublicationConfirmation()
        model.awaitIdle()

        assertTrue(gateway.reconcileCalls.isEmpty())
        assertTrue(gateway.publishCalls.isEmpty())
        assertEquals(intent, store.read(contextKey()))
        assertEquals("@conta_reconectada", model.uiState.value.connection!!.username)
        assertFalse(model.uiState.value.canContinueConfirmation)
        assertNotNull(model.uiState.value.error)
    }

    @Test fun failedOrThrowingDurableCreateNeverDispatchesPublication() = runTest(dispatcher) {
        for (throwFailure in listOf(false, true)) {
            val store = MemoryIntentStore().apply {
                createSucceeds = false
                throwOnCreate = throwFailure
            }
            val gateway = SyntheticGateway()
            val model = model(gateway, store)
            prepareImageForPublication(model)
            model.requestPublicationConfirmation()
            model.confirmPublish()
            model.awaitIdle()
            assertTrue(gateway.publishCalls.isEmpty())
            assertFalse(model.uiState.value.busy)
            assertFalse(model.uiState.value.storageAvailable)
            assertFalse(model.uiState.value.canPublish)
            assertNotNull(model.uiState.value.error)
        }
    }

    @Test fun serverConflictAfterAdvisoryRefreshKeepsOriginalBindingAndNeverRetries() = runTest(dispatcher) {
        val pending = publicationFixture(confirmed = false)
        val original = InstagramIntentPolicy.create(MEDIA.id, CONNECTION).copy(publicationId = PUBLICATION_ID)
        val store = MemoryIntentStore().apply { seed(contextKey(), original) }
        val gateway = SyntheticGateway().apply {
            history = InstagramHistory(listOf(pending), false, true)
            publicationResult = InstagramResult.Success(pending)
            onReconcile = {
                // Simulate another session reconnecting after the advisory GET returned.
                connection = CONNECTION.copy(externalId = "987654321000000", connectionRevision = 5L)
                InstagramResult.Failure(InstagramError.BINDING_CONFLICT)
            }
        }
        val model = model(gateway, store)
        model.onResume()
        model.awaitIdle()
        model.requestContinuationConfirmation()
        model.continuePublicationConfirmation()
        model.awaitIdle()
        assertEquals(listOf(original.binding), gateway.reconcileBindings)
        assertEquals(original, store.read(contextKey()))
        assertEquals(InstagramAvailability.UNAVAILABLE, model.uiState.value.availability)
        model.onResume()
        model.awaitIdle()
        model.requestContinuationConfirmation()
        model.continuePublicationConfirmation()
        assertEquals(1, gateway.reconcileCalls.size)
        assertTrue(gateway.publishCalls.isEmpty())
        assertFalse(model.uiState.value.canContinueConfirmation)
    }

    @Test fun legacyUsernameOnlyWitnessIsNotUpgradedFromCurrentAccount() = runTest(dispatcher) {
        val legacy = InstagramIntentPolicy.create(MEDIA.id, CONNECTION).copy(
            boundExternalId = null, expectedConnectionRevision = null, publicationId = PUBLICATION_ID)
        val store = MemoryIntentStore().apply { seed(contextKey(), legacy) }
        val gateway = SyntheticGateway().apply {
            publicationResult = InstagramResult.Success(publicationFixture(false).copy(binding = null))
        }
        val model = model(gateway, store)
        model.onResume()
        model.awaitIdle()
        model.requestContinuationConfirmation()
        model.continuePublicationConfirmation()
        assertEquals(legacy, store.read(contextKey()))
        assertFalse(model.uiState.value.canContinueConfirmation)
        assertTrue(gateway.intentLookups.isEmpty())
        assertTrue(gateway.reconcileCalls.isEmpty())
        assertTrue(gateway.publishCalls.isEmpty())
    }

    @Test fun unreadableLedgerFailsClosedWithoutAnyMutation() = runTest(dispatcher) {
        val gateway = SyntheticGateway()
        val model = model(gateway, MemoryIntentStore().apply { throwOnRead = true })
        model.onResume()
        model.awaitIdle()
        assertFalse(model.uiState.value.storageAvailable)
        assertFalse(model.uiState.value.canPublish)
        assertFalse(model.uiState.value.busy)
        assertNotNull(model.uiState.value.error)
        assertTrue(gateway.publishCalls.isEmpty())
        assertTrue(gateway.reconcileCalls.isEmpty())
    }

    @Test fun failedConfirmedRecordRemovalIsHandledAndPreservesOriginalIntent() = runTest(dispatcher) {
        val intent = InstagramIntentPolicy.create(MEDIA.id, CONNECTION).copy(
            publicationId = PUBLICATION_ID, confirmed = true
        )
        val store = MemoryIntentStore().apply {
            seed(contextKey(), intent)
            throwOnRemove = true
        }
        val gateway = SyntheticGateway().apply {
            history = InstagramHistory(listOf(publicationFixture()), true, true)
        }
        val model = model(gateway, store)
        model.onResume()
        model.awaitIdle()
        model.startNewDraft()
        model.awaitIdle()
        assertEquals(intent, model.uiState.value.intent)
        assertEquals(intent, store.read(contextKey()))
        assertFalse(model.uiState.value.storageAvailable)
        assertFalse(model.uiState.value.busy)
        assertNotNull(model.uiState.value.error)
        assertTrue(gateway.publishCalls.isEmpty())
    }

    @Test fun authoritativeAbsentConnectionClearsUnidentifiedPendingAuthorizationWithoutInventingCancellation() = runTest(dispatcher) {
        val gateway = SyntheticGateway().apply { connection = null }
        val model = model(gateway, MemoryIntentStore())
        model.onResume()
        model.awaitIdle()
        model.connect()
        model.awaitIdle()
        assertEquals("authorization_pending", model.uiState.value.authorizationStatus)
        assertFalse(model.uiState.value.canAuthorize)

        model.refresh()
        model.awaitIdle()
        assertNull(model.uiState.value.authorizationStatus)
        assertTrue(model.uiState.value.canAuthorize)
        assertEquals(1, gateway.authorizeCalls)
        assertTrue(gateway.publishCalls.isEmpty())
    }

    private fun model(gateway: SyntheticGateway, store: MemoryIntentStore) = InstagramViewModel(
        tokenProvider = { "synthetic-session-one" }, intentStore = store, apiOrigin = ORIGIN,
        gatewayFactory = { gateway }
    )

    private suspend fun TestScope.prepareImageForPublication(model: InstagramViewModel) {
        model.onResume()
        model.awaitIdle()
        assertTrue(model.uiState.value.canEditDraft)
        model.acceptJpeg(InstagramPoliciesTest.jpegEnvelope(), model.pickerSessionKey()!!)
        model.updateCaption("Legenda sintética para o teste local")
        assertTrue(model.uiState.value.canUpload)
        model.upload()
        model.awaitIdle()
        assertTrue(model.uiState.value.canPublish)
    }

    // IO persistence uses the production Dispatchers.IO. Await the actual state transition;
    // advancing the virtual clock alone cannot prove that a durable operation finished.
    private suspend fun InstagramViewModel.awaitIdle() { uiState.first { !it.busy } }

    private class MemoryIntentStore(
        private val events: MutableList<String> = Collections.synchronizedList(mutableListOf())
    ) : InstagramPublicationIntentStore {
        private val records = mutableMapOf<String, InstagramPublicationIntent>()
        var createCalls = 0
            private set
        var createSucceeds = true
        var throwOnCreate = false
        var throwOnRead = false
        var throwOnRemove = false

        @Synchronized fun seed(key: String, value: InstagramPublicationIntent) { records[key] = value }
        @Synchronized override fun read(contextKey: String): InstagramPublicationIntent? {
            check(!throwOnRead) { "Synthetic unreadable ledger" }
            return records[contextKey]
        }
        @Synchronized override fun create(contextKey: String, intent: InstagramPublicationIntent): Boolean {
            createCalls += 1
            check(!throwOnCreate) { "Synthetic durable write failure" }
            if (!createSucceeds || records.containsKey(contextKey)) return false
            records[contextKey] = intent
            events.add("create-complete")
            return true
        }
        @Synchronized override fun update(contextKey: String, intent: InstagramPublicationIntent): Boolean {
            val saved = records[contextKey] ?: return false
            if (!InstagramIntentPolicy.canUpdate(saved, intent)) return false
            records[contextKey] = intent
            return true
        }
        @Synchronized override fun removeConfirmed(contextKey: String, clientRequestId: String): Boolean {
            check(!throwOnRemove) { "Synthetic ledger removal failure" }
            val saved = records[contextKey] ?: return false
            if (!saved.confirmed || saved.clientRequestId != clientRequestId) return false
            records.remove(contextKey)
            return true
        }
    }

    private class SyntheticGateway : InstagramGateway {
        var connection: InstagramConnection? = CONNECTION
        var connectionFailure: InstagramError? = null
        var mediaItems = listOf(MEDIA)
        var history = InstagramHistory(emptyList(), true, true)
        var publicationResult: InstagramResult<InstagramPublication> = InstagramResult.Success(publicationFixture())
        var intentResult: InstagramResult<InstagramPublication?> = InstagramResult.Success(null)
        val intentLookups = mutableListOf<String>()
        var onPublish: suspend (String, String) -> InstagramResult<InstagramPublication> = { _, _ -> InstagramResult.Success(publicationFixture()) }
        var onReconcile: suspend (String) -> InstagramResult<InstagramPublication> = { InstagramResult.Success(publicationFixture()) }
        val publishCalls = mutableListOf<Pair<String, String>>()
        val reconcileCalls = mutableListOf<String>()
        val publishBindings = mutableListOf<InstagramConnectionBinding>()
        val reconcileBindings = mutableListOf<InstagramConnectionBinding>()
        var authorizeCalls = 0
            private set

        override suspend fun currentConnection(): InstagramResult<InstagramConnection?> =
            connectionFailure?.let { InstagramResult.Failure(it) } ?: InstagramResult.Success(connection)
        override suspend fun authorize(purpose: String): InstagramResult<InstagramAuthorization> {
            authorizeCalls += 1
            return InstagramResult.Failure(InstagramError.NETWORK)
        }
        override suspend fun authorizationStatus(connectionId: String): InstagramResult<InstagramAuthorizationStatus> =
            InstagramResult.Success(InstagramAuthorizationStatus(connectionId, "connect", "authorization_completed", null))
        override suspend fun media(): InstagramResult<List<InstagramMedia>> = InstagramResult.Success(mediaItems)
        override suspend fun uploadMedia(jpeg: ByteArray, caption: String): InstagramResult<InstagramMedia> = InstagramResult.Success(MEDIA)
        override suspend fun publications(): InstagramResult<InstagramHistory> = InstagramResult.Success(history)
        override suspend fun publication(publicationId: String): InstagramResult<InstagramPublication> = publicationResult
        override suspend fun publicationIntent(clientRequestId: String): InstagramResult<InstagramPublication?> {
            intentLookups.add(clientRequestId)
            return intentResult
        }
        override suspend fun publish(mediaId: String, clientRequestId: String, binding: InstagramConnectionBinding): InstagramResult<InstagramPublication> {
            publishBindings.add(binding)
            publishCalls.add(mediaId to clientRequestId)
            return onPublish(mediaId, clientRequestId)
        }
        override suspend fun reconcile(publicationId: String, binding: InstagramConnectionBinding): InstagramResult<InstagramPublication> {
            reconcileBindings.add(binding)
            reconcileCalls.add(publicationId)
            return onReconcile(publicationId)
        }
    }

    companion object {
        private const val ORIGIN = "https://ia4tube-api.onrender.com"
        private const val CONNECTION_ID = "11111111-1111-4111-8111-111111111111"
        private const val OTHER_CONNECTION_ID = "33333333-3333-4333-8333-333333333333"
        private const val PUBLICATION_ID = "22222222-2222-4222-8222-222222222222"
        private val CONNECTION = InstagramConnection(CONNECTION_ID, "connected", "healthy", "@empresa", "business", "123456789012345", 4L)
        private val MEDIA = InstagramMedia("reviewer-jpeg:" + "a".repeat(64), "Prévia sintética", 1080, 1080)
        private fun contextKey() = InstagramIntentPolicy.contextKey(ORIGIN, CONNECTION_ID)
        private fun publicationFixture(confirmed: Boolean = true) = InstagramPublication(
            PUBLICATION_ID, CONNECTION_ID, if (confirmed) "published" else "provider_confirming", MEDIA.id,
            "Legenda definitiva sintética", "@empresa", "business",
            if (confirmed) "123456789" else null,
            if (confirmed) "https://www.instagram.com/p/ABCDE12345/" else null,
            if (confirmed) "2026-09-05T12:00:00Z" else null,
            "2026-09-05T11:59:00Z", "2026-09-05T12:00:00Z", CONNECTION.binding
        )
    }
}
