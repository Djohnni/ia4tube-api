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

    @Test fun jpegReturnedDuringResumeRefreshSurvivesWithoutOpeningPublicationGate() = runTest(dispatcher) {
        val gateway = SyntheticGateway().apply { operational = InstagramOperationalAvailability(false, false) }
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); model.awaitIdle()
        val pickerKey = model.pickerSessionKey()!!
        val started = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        gateway.beforeSnapshot = { started.complete(Unit); finish.await() }
        model.onPause()
        model.onResume()
        started.await()
        val jpeg = InstagramPoliciesTest.jpegEnvelope()
        model.acceptJpeg(jpeg, pickerKey)
        assertFalse(model.uiState.value.canUpload)
        assertFalse(model.uiState.value.canPublish)
        finish.complete(Unit); model.awaitIdle()

        assertNotNull("Version 34 silently discards the JPEG while resume refresh is busy", model.uiState.value.draftJpeg)
        assertTrue(jpeg.contentEquals(model.uiState.value.draftJpeg))
        model.updateCaption("Legenda sintética da seleção local")
        model.upload()
        model.connect()
        model.requestPublicationConfirmation(); model.confirmPublish()
        assertFalse(model.uiState.value.canUpload)
        assertFalse(model.uiState.value.canPublish)
        assertEquals(0, gateway.uploadCalls)
        assertEquals(0, gateway.authorizeCalls)
        assertTrue(gateway.publishCalls.isEmpty())
        assertTrue(gateway.reconcileCalls.isEmpty())
    }

    @Test fun expiredInitialAuthorizationAllowsOneExplicitConnectWithoutDeletingConnection() = runTest(dispatcher) {
        val expiredConnection = InstagramConnection(CONNECTION_ID, "authorization_pending", "authorization_pending", null, null)
        val gateway = SyntheticGateway().apply {
            connection = expiredConnection
            authorizationResult = InstagramResult.Success(InstagramAuthorizationStatus(
                CONNECTION_ID, "connect", "authorization_pending", "2026-09-07T12:10:00Z"))
        }
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); model.awaitIdle()
        assertFalse(model.uiState.value.canAuthorize)
        model.connect()
        assertEquals(0, gateway.authorizeCalls)

        gateway.authorizationResult = InstagramResult.Success(InstagramAuthorizationStatus(
            CONNECTION_ID, "connect", "authorization_expired", "2026-09-07T12:10:00Z"))
        model.refresh(); model.awaitIdle()
        assertEquals(expiredConnection, model.uiState.value.connection)
        assertTrue("Version 33 incorrectly leaves the expired initial connection disabled", model.uiState.value.canAuthorize)
        assertEquals(0, gateway.authorizeCalls)
        model.connect(); model.connect(); model.awaitIdle()
        assertEquals(listOf("connect"), gateway.authorizePurposes)
    }

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

    @Test fun jpegCallbackBeforeResumeWaitsForFreshContextAndCallbackAfterRefreshWorks() = runTest(dispatcher) {
        for (beforeResume in listOf(true, false)) {
            val gateway = SyntheticGateway()
            val model = model(gateway, MemoryIntentStore())
            model.onResume(); model.awaitIdle()
            val key = model.pickerSessionKey()!!
            val jpeg = InstagramPoliciesTest.jpegEnvelope()
            model.onPause()
            if (beforeResume) {
                model.acceptJpeg(jpeg, key)
                assertNull(model.uiState.value.draftJpeg)
                assertTrue(model.uiState.value.jpegSelectionPending)
            }
            model.onResume(); model.awaitIdle()
            if (!beforeResume) model.acceptJpeg(jpeg, key)
            assertTrue(jpeg.contentEquals(model.uiState.value.draftJpeg))
            assertFalse(model.uiState.value.jpegSelectionPending)
            assertNoExternalWrites(gateway)
        }
    }

    @Test fun jpegPendingSurvivesNetworkFailureButCannotUploadBeforeSuccessfulRefresh() = runTest(dispatcher) {
        val gateway = SyntheticGateway()
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); model.awaitIdle()
        model.updateCaption("Legenda sintética válida")
        val key = model.pickerSessionKey()!!
        val jpeg = InstagramPoliciesTest.jpegEnvelope()
        model.onPause(); model.acceptJpeg(jpeg, key)
        gateway.connectionFailure = InstagramError.NETWORK
        model.onResume(); model.awaitIdle()
        assertTrue(model.uiState.value.jpegSelectionPending)
        assertNull(model.uiState.value.draftJpeg)
        assertTrue(jpeg.any { it != 0.toByte() })
        model.upload(); model.confirmPublish()
        assertNoExternalWrites(gateway)

        gateway.connectionFailure = null
        model.refresh(); model.awaitIdle()
        assertTrue(jpeg.contentEquals(model.uiState.value.draftJpeg))
        assertFalse(model.uiState.value.jpegSelectionPending)
        assertTrue(model.uiState.value.canUpload)
        assertNoExternalWrites(gateway)
    }

    @Test fun jpegPendingCannotAdoptAnyChangedAccountBindingOrDisconnectedAccount() = runTest(dispatcher) {
        val changedConnections = listOf(
            CONNECTION.copy(connectionId = OTHER_CONNECTION_ID),
            CONNECTION.copy(externalId = "987654321000000"),
            CONNECTION.copy(connectionRevision = 5L),
            CONNECTION.copy(state = "disconnected"), null
        )
        for (changed in changedConnections) {
            val gateway = SyntheticGateway()
            val model = model(gateway, MemoryIntentStore())
            model.onResume(); model.awaitIdle()
            val key = model.pickerSessionKey()!!
            val jpeg = InstagramPoliciesTest.jpegEnvelope()
            model.onPause(); model.acceptJpeg(jpeg, key)
            gateway.connection = changed
            model.onResume(); model.awaitIdle()
            assertNull(model.uiState.value.draftJpeg)
            assertFalse(model.uiState.value.jpegSelectionPending)
            assertTrue(jpeg.all { it == 0.toByte() })
            val late = InstagramPoliciesTest.jpegEnvelope()
            model.acceptJpeg(late, key)
            assertTrue(late.all { it == 0.toByte() })
            assertNull(model.uiState.value.draftJpeg)
            assertNoExternalWrites(gateway)
        }
    }

    @Test fun changedSessionDiscardsPendingJpegAndOldCallbackEvenIfTokenReturns() = runTest(dispatcher) {
        val gateway = SyntheticGateway()
        var token = "synthetic-old-company"
        val model = InstagramViewModel({ token }, MemoryIntentStore(), ORIGIN, { gateway }, MemoryAuthorizationStore())
        model.onResume(); model.awaitIdle()
        val key = model.pickerSessionKey()!!
        val jpeg = InstagramPoliciesTest.jpegEnvelope()
        model.onPause(); model.acceptJpeg(jpeg, key)
        token = "synthetic-new-company"
        model.onResume(); model.awaitIdle()
        assertTrue(jpeg.all { it == 0.toByte() })
        assertNull(model.uiState.value.draftJpeg)
        token = "synthetic-old-company"
        model.onPause(); model.onResume(); model.awaitIdle()
        val late = InstagramPoliciesTest.jpegEnvelope()
        model.acceptJpeg(late, key)
        model.showSelectionError(key, "Erro antigo")
        assertTrue(late.all { it == 0.toByte() })
        assertNull(model.uiState.value.draftJpeg)
        assertNull(model.uiState.value.error)
        assertNoExternalWrites(gateway)
    }

    @Test fun pendingJpegWaitsForLedgerAndIsDiscardedIfIntentWasDiscovered() = runTest(dispatcher) {
        for (unreadable in listOf(false, true)) {
            val gateway = SyntheticGateway()
            val store = MemoryIntentStore()
            val model = model(gateway, store)
            model.onResume(); model.awaitIdle()
            val key = model.pickerSessionKey()!!
            val jpeg = InstagramPoliciesTest.jpegEnvelope()
            val started = CompletableDeferred<Unit>()
            val finish = CompletableDeferred<Unit>()
            gateway.beforePublications = { started.complete(Unit); finish.await() }
            if (unreadable) store.throwOnRead = true
            else store.seed(contextKey(), InstagramIntentPolicy.create(MEDIA.id, CONNECTION))
            model.onPause(); model.onResume(); started.await()
            model.acceptJpeg(jpeg, key)
            assertNull(model.uiState.value.draftJpeg)
            model.upload(); model.confirmPublish()
            finish.complete(Unit); model.awaitIdle()
            assertNull(model.uiState.value.draftJpeg)
            assertFalse(model.uiState.value.canUpload)
            assertFalse(model.uiState.value.canPublish)
            if (!unreadable) {
                assertFalse(model.uiState.value.jpegSelectionPending)
                assertTrue(jpeg.all { it == 0.toByte() })
                assertNotNull(model.uiState.value.intent)
            }
            assertNoExternalWrites(gateway)
        }
    }

    @Test fun staleRefreshCannotAcceptPendingJpegAfterAnotherPause() = runTest(dispatcher) {
        val gateway = SyntheticGateway()
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); model.awaitIdle()
        val key = model.pickerSessionKey()!!
        val jpeg = InstagramPoliciesTest.jpegEnvelope()
        val started = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        gateway.beforeSnapshot = { started.complete(Unit); finish.await() }
        model.onPause(); model.onResume(); started.await()
        model.acceptJpeg(jpeg, key)
        model.onPause(); model.onResume()
        finish.complete(Unit); model.awaitIdle()
        assertNull(model.uiState.value.draftJpeg)
        assertTrue(model.uiState.value.jpegSelectionPending)
        assertFalse(model.uiState.value.canUpload)
        gateway.beforeSnapshot = {}
        model.refresh(); model.awaitIdle()
        assertTrue(jpeg.contentEquals(model.uiState.value.draftJpeg))
        assertNoExternalWrites(gateway)
    }

    @Test fun cancelledOrFailedPickerPreservesPreviousDraftAndCannotConsumeNewTicket() = runTest(dispatcher) {
        val gateway = SyntheticGateway()
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); model.awaitIdle()
        val previous = InstagramPoliciesTest.jpegEnvelope()
        model.acceptJpeg(previous, model.pickerSessionKey()!!)
        model.updateCaption("Legenda anterior")
        val cancelled = model.pickerSessionKey()!!
        model.cancelJpegSelection(cancelled)
        assertTrue(previous.contentEquals(model.uiState.value.draftJpeg))
        assertEquals("Legenda anterior", model.uiState.value.draftCaption)
        assertFalse(model.uiState.value.jpegSelectionPending)
        val next = model.pickerSessionKey()!!
        assertTrue(cancelled != next)
        model.cancelJpegSelection(cancelled)
        model.showSelectionError(cancelled, "Erro atrasado")
        val late = InstagramPoliciesTest.jpegEnvelope()
        model.acceptJpeg(late, cancelled)
        assertTrue(late.all { it == 0.toByte() })
        assertTrue(model.uiState.value.jpegSelectionPending)
        assertNull(model.uiState.value.error)
        model.showSelectionError(next)
        assertFalse(model.uiState.value.jpegSelectionPending)
        assertNotNull(model.uiState.value.error)
        assertTrue(previous.contentEquals(model.uiState.value.draftJpeg))
        assertNoExternalWrites(gateway)
    }

    @Test fun replacementAndDuplicatePickerResultsNeverOverwriteNewSelection() = runTest(dispatcher) {
        val gateway = SyntheticGateway()
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); model.awaitIdle()
        val oldKey = model.pickerSessionKey()!!
        val oldJpeg = InstagramPoliciesTest.jpegEnvelope()
        model.onPause(); model.acceptJpeg(oldJpeg, oldKey)
        model.onResume(); model.awaitIdle()
        val newKey = model.pickerSessionKey()!!
        val newJpeg = InstagramPoliciesTest.jpegEnvelope()
        model.acceptJpeg(newJpeg, newKey)
        assertTrue(oldJpeg.all { it == 0.toByte() })
        val late = InstagramPoliciesTest.jpegEnvelope()
        model.acceptJpeg(late, oldKey)
        val duplicate = InstagramPoliciesTest.jpegEnvelope()
        model.acceptJpeg(duplicate, newKey)
        assertTrue(late.all { it == 0.toByte() })
        assertTrue(duplicate.all { it == 0.toByte() })
        assertTrue(newJpeg.contentEquals(model.uiState.value.draftJpeg))
        assertNoExternalWrites(gateway)
    }

    @Test fun doublePickerLaunchIsRefusedAndExplicitCancelReleasesPendingBytes() = runTest(dispatcher) {
        val gateway = SyntheticGateway()
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); model.awaitIdle()
        val first = model.pickerSessionKey()!!
        assertNull(model.pickerSessionKey())
        val bytes = InstagramPoliciesTest.jpegEnvelope()
        model.onPause(); model.acceptJpeg(bytes, first)
        model.cancelPendingJpegSelection()
        assertTrue(bytes.all { it == 0.toByte() })
        assertFalse(model.uiState.value.jpegSelectionPending)
        model.onResume(); model.awaitIdle()
        val second = model.pickerSessionKey()!!
        assertTrue(first != second)
        assertNull(model.pickerSessionKey())
        model.cancelJpegSelection(first)
        assertTrue(model.uiState.value.jpegSelectionPending)
        model.cancelJpegSelection(second)
        assertFalse(model.uiState.value.jpegSelectionPending)
        assertNoExternalWrites(gateway)
    }

    @Test fun invalidPickerJpegsRemainRejectedAndZeroed() = runTest(dispatcher) {
        val gateway = SyntheticGateway()
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); model.awaitIdle()
        for (invalid in listOf(InstagramPoliciesTest.jpegEnvelope(width = 1079),
            InstagramPoliciesTest.jpegEnvelope(height = 1079), byteArrayOf(1, 2, 3),
            ByteArray(InstagramPolicies.MAX_JPEG_BYTES + 1) { 1 })) {
            model.acceptJpeg(invalid, model.pickerSessionKey()!!)
            assertTrue(invalid.all { it == 0.toByte() })
            assertNull(model.uiState.value.draftJpeg)
            assertFalse(model.uiState.value.jpegSelectionPending)
            assertNotNull(model.uiState.value.error)
        }
        assertNoExternalWrites(gateway)
    }

    private fun assertNoExternalWrites(gateway: SyntheticGateway) {
        assertEquals(0, gateway.uploadCalls)
        assertEquals(0, gateway.authorizeCalls)
        assertTrue(gateway.publishCalls.isEmpty())
        assertTrue(gateway.reconcileCalls.isEmpty())
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
            authorizationStore = MemoryAuthorizationStore(), gatewayFactory = { captured ->
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

    @Test fun absentConnectionCannotClearAnUnidentifiedPostOrInventCancellation() = runTest(dispatcher) {
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
        assertEquals("authorization_pending", model.uiState.value.authorizationStatus)
        assertFalse(model.uiState.value.canAuthorize)
        model.connect()
        assertEquals(1, gateway.authorizeCalls)
        assertTrue(gateway.publishCalls.isEmpty())
    }

    private fun model(gateway: SyntheticGateway, store: MemoryIntentStore,
        authorizationStore: InstagramAuthorizationWitnessStore = MemoryAuthorizationStore()) = InstagramViewModel(
        tokenProvider = { "synthetic-session-one" }, intentStore = store, apiOrigin = ORIGIN,
        gatewayFactory = { gateway }, authorizationStore = authorizationStore
    )

    @Test fun blockedUnknownAndFailureCanRefreshToAllowedWithoutOAuthProbe() = runTest(dispatcher) {
        val gateway = SyntheticGateway().apply { connection = null; operational = InstagramOperationalAvailability(false, false) }
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); model.awaitIdle()
        assertEquals(false, model.uiState.value.operationalAvailability?.connectionAllowed)
        assertNull(model.uiState.value.error)
        model.connect()
        assertEquals(0, gateway.authorizeCalls)
        gateway.operational = null
        model.refresh(); model.awaitIdle()
        assertNull(model.uiState.value.operationalAvailability)
        assertFalse(model.uiState.value.canAuthorize)
        gateway.connectionFailure = InstagramError.NETWORK
        model.refresh(); model.awaitIdle()
        assertEquals(InstagramError.NETWORK.message, model.uiState.value.error)
        assertNull(model.uiState.value.operationalAvailability)
        gateway.connectionFailure = null
        gateway.operational = InstagramOperationalAvailability(true, false)
        model.refresh(); model.awaitIdle()
        assertTrue(model.uiState.value.canAuthorize)
        assertNull(model.uiState.value.error)
        assertEquals(4, gateway.snapshotCalls)
        assertEquals(0, gateway.authorizeCalls)
        // Only this explicit, synthetic click reaches authorization; no retry/probe took place.
        model.connect(); model.awaitIdle()
        assertEquals(1, gateway.authorizeCalls)
        assertTrue(gateway.publishCalls.isEmpty())
    }

    @Test fun refreshAndResumeInvalidatePriorPermissionBeforeTheNextResponse() = runTest(dispatcher) {
        val gateway = SyntheticGateway().apply { connection = null }
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); model.awaitIdle()
        assertTrue(model.uiState.value.canAuthorize)
        val started = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        gateway.beforeSnapshot = { started.complete(Unit); finish.await() }
        model.onPause()
        assertNull(model.uiState.value.operationalAvailability)
        model.onResume()
        assertEquals(InstagramAvailability.CHECKING, model.uiState.value.availability)
        assertFalse(model.uiState.value.canAuthorize)
        started.await()
        gateway.operational = InstagramOperationalAvailability(false, false)
        finish.complete(Unit); model.awaitIdle()
        assertFalse(model.uiState.value.canAuthorize)
        assertEquals(false, model.uiState.value.operationalAvailability?.connectionAllowed)
        assertEquals(0, gateway.authorizeCalls)
    }

    @Test fun responseFromBeforeBackgroundCannotRestoreOperationalPermission() = runTest(dispatcher) {
        val gateway = SyntheticGateway().apply { connection = null }
        val started = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        gateway.beforeSnapshot = { started.complete(Unit); finish.await() }
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); started.await()
        model.onPause(); model.onResume()
        finish.complete(Unit); model.awaitIdle()
        assertNull(model.uiState.value.operationalAvailability)
        assertFalse(model.uiState.value.canAuthorize)
        gateway.beforeSnapshot = {}
        model.refresh(); model.awaitIdle()
        assertTrue(model.uiState.value.canAuthorize)
        assertEquals(2, gateway.snapshotCalls)
        assertEquals(0, gateway.authorizeCalls)
    }

    @Test fun newSessionCannotReusePreviousCompanyOperationalPermission() = runTest(dispatcher) {
        val first = SyntheticGateway().apply { connection = null }
        val second = SyntheticGateway().apply { connection = null; operational = InstagramOperationalAvailability(false, false) }
        var token = "synthetic-first"
        val model = InstagramViewModel({ token }, MemoryIntentStore(), ORIGIN,
            { captured -> if (captured() == "synthetic-first") first else second }, MemoryAuthorizationStore())
        model.onResume(); model.awaitIdle()
        assertTrue(model.uiState.value.canAuthorize)
        token = "synthetic-second"
        model.connect()
        assertNull(model.uiState.value.operationalAvailability)
        assertEquals(0, first.authorizeCalls)
        assertEquals(0, second.authorizeCalls)
        model.onResume(); model.awaitIdle()
        assertEquals(false, model.uiState.value.operationalAvailability?.connectionAllowed)
        assertFalse(model.uiState.value.canAuthorize)
    }

    @Test fun newlyBlockedPublicationCannotBeContinuedAfterAdvisoryRefresh() = runTest(dispatcher) {
        val pending = publicationFixture(confirmed = false)
        val intent = InstagramIntentPolicy.create(MEDIA.id, CONNECTION).copy(publicationId = PUBLICATION_ID)
        val store = MemoryIntentStore().apply { seed(contextKey(), intent) }
        val gateway = SyntheticGateway().apply {
            history = InstagramHistory(listOf(pending), false, true)
            publicationResult = InstagramResult.Success(pending)
        }
        val model = model(gateway, store)
        model.onResume(); model.awaitIdle()
        assertTrue(model.uiState.value.canContinueConfirmation)
        model.requestContinuationConfirmation()
        gateway.operational = InstagramOperationalAvailability(true, false)
        model.continuePublicationConfirmation(); model.awaitIdle()
        assertFalse(model.uiState.value.canContinueConfirmation)
        assertTrue(gateway.reconcileCalls.isEmpty())
        assertEquals(intent, store.read(contextKey()))
    }

    @Test fun failedContinuationRefreshClearsPriorPermissionWithoutSending() = runTest(dispatcher) {
        for (error in listOf(InstagramError.NETWORK, InstagramError.SESSION_REQUIRED, InstagramError.INVALID_RESPONSE)) {
            val pending = publicationFixture(confirmed = false)
            val intent = InstagramIntentPolicy.create(MEDIA.id, CONNECTION).copy(publicationId = PUBLICATION_ID)
            val store = MemoryIntentStore().apply { seed(contextKey(), intent) }
            val gateway = SyntheticGateway().apply {
                history = InstagramHistory(listOf(pending), false, true)
                publicationResult = InstagramResult.Success(pending)
            }
            val model = model(gateway, store)
            model.onResume(); model.awaitIdle()
            assertTrue(model.uiState.value.canContinueConfirmation)
            model.requestContinuationConfirmation()
            gateway.connectionFailure = error
            model.continuePublicationConfirmation(); model.awaitIdle()
            assertNull(model.uiState.value.operationalAvailability)
            assertFalse(model.uiState.value.canContinueConfirmation)
            assertEquals(error.message, model.uiState.value.error)
            assertTrue(gateway.reconcileCalls.isEmpty())
            assertEquals(intent, store.read(contextKey()))
        }
    }

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
        var uploadCalls = 0
        var connection: InstagramConnection? = CONNECTION
        var connectionFailure: InstagramError? = null
        var operational: InstagramOperationalAvailability? = InstagramOperationalAvailability(true, true)
        var beforeSnapshot: suspend () -> Unit = {}
        var beforePublications: suspend () -> Unit = {}
        var snapshotCalls = 0
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
        val authorizePurposes = mutableListOf<String>()
        var authorizationResult: InstagramResult<InstagramAuthorizationStatus>? = null
        var onAuthorize: suspend (String) -> InstagramResult<InstagramAuthorization> = { InstagramResult.Failure(InstagramError.NETWORK) }
        var beforeAuthorizationStatus: suspend () -> Unit = {}
        val authorizationLookups = mutableListOf<String>()

        override suspend fun currentConnection(): InstagramResult<InstagramConnection?> =
            connectionFailure?.let { InstagramResult.Failure(it) } ?: InstagramResult.Success(connection)
        override suspend fun currentSnapshot(): InstagramResult<InstagramConnectionSnapshot> {
            snapshotCalls += 1
            beforeSnapshot()
            return connectionFailure?.let { InstagramResult.Failure(it) } ?:
                InstagramResult.Success(InstagramConnectionSnapshot(connection, operational))
        }
        override suspend fun authorize(purpose: String): InstagramResult<InstagramAuthorization> {
            authorizeCalls += 1
            authorizePurposes.add(purpose)
            return onAuthorize(purpose)
        }
        override suspend fun authorizationStatus(connectionId: String): InstagramResult<InstagramAuthorizationStatus> {
            authorizationLookups.add(connectionId)
            beforeAuthorizationStatus()
            return authorizationResult ?: InstagramResult.Success(InstagramAuthorizationStatus(connectionId, "connect", "authorization_completed", null))
        }
        override suspend fun media(): InstagramResult<List<InstagramMedia>> = InstagramResult.Success(mediaItems)
        override suspend fun uploadMedia(jpeg: ByteArray, caption: String): InstagramResult<InstagramMedia> {
            uploadCalls += 1
            return InstagramResult.Success(MEDIA)
        }
        override suspend fun publications(): InstagramResult<InstagramHistory> {
            beforePublications()
            return InstagramResult.Success(history)
        }
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

    private class MemoryAuthorizationStore : InstagramAuthorizationWitnessStore {
        private val records = mutableMapOf<String, InstagramAuthorizationWitness>()
        var createSucceeds = true
        override fun read(contextKey: String) = records[contextKey]
        override fun create(contextKey: String, witness: InstagramAuthorizationWitness): Boolean {
            if (!createSucceeds || records.containsKey(contextKey)) return false
            records[contextKey] = witness
            return true
        }
        override fun update(contextKey: String, witness: InstagramAuthorizationWitness): Boolean {
            if (records[contextKey]?.id != witness.id) return false
            records[contextKey] = witness
            return true
        }
        override fun clear(contextKey: String, id: String): Boolean {
            if (records[contextKey]?.id != id) return false
            records.remove(contextKey)
            return true
        }
    }

    private fun expiredGateway(purpose: String = "connect") = SyntheticGateway().apply {
        connection = if (purpose == "connect")
            InstagramConnection(CONNECTION_ID, "authorization_pending", "authorization_pending", null, null)
        else CONNECTION.copy(state = "authorization_pending", health = "authorization_pending")
        authorizationResult = InstagramResult.Success(InstagramAuthorizationStatus(
            CONNECTION_ID, purpose, "authorization_expired", "2026-09-07T12:10:00Z"))
    }

    @Test fun expiredStateSurvivesNavigationAndProcessRecreationWithoutChangingServerRecord() = runTest(dispatcher) {
        val gateway = expiredGateway()
        val witnessStore = MemoryAuthorizationStore()
        val first = model(gateway, MemoryIntentStore(), witnessStore)
        first.onResume(); first.awaitIdle()
        assertTrue(first.uiState.value.canAuthorize)
        first.onPause()
        assertFalse(first.uiState.value.canAuthorize)
        first.onResume(); first.awaitIdle()
        assertTrue(first.uiState.value.canAuthorize)
        val restarted = model(gateway, MemoryIntentStore(), witnessStore)
        assertFalse(restarted.uiState.value.canAuthorize)
        restarted.onResume(); restarted.awaitIdle()
        assertTrue(restarted.uiState.value.canAuthorize)
        assertEquals(first.uiState.value.connection, restarted.uiState.value.connection)
        assertEquals(0, gateway.authorizeCalls)
    }

    @Test fun expiredStateStillRequiresFreshPositiveOperationalPermission() = runTest(dispatcher) {
        val gateway = expiredGateway().apply { operational = InstagramOperationalAvailability(false, false) }
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); model.awaitIdle()
        assertFalse(model.uiState.value.canAuthorize)
        model.connect(); assertEquals(0, gateway.authorizeCalls)
        gateway.operational = InstagramOperationalAvailability(true, false)
        model.refresh(); model.awaitIdle()
        assertTrue(model.uiState.value.canAuthorize)
        assertFalse(model.uiState.value.canPublish)
        model.connect(); model.awaitIdle()
        assertEquals(listOf("connect"), gateway.authorizePurposes)
    }

    @Test fun failedStatusRefreshCannotReuseEarlierExpiryOrEnableOnNetworkError() = runTest(dispatcher) {
        val gateway = expiredGateway()
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); model.awaitIdle()
        assertTrue(model.uiState.value.canAuthorize)
        for (error in listOf(InstagramError.NETWORK, InstagramError.REJECTED, InstagramError.INVALID_RESPONSE)) {
            gateway.authorizationResult = InstagramResult.Failure(error)
            model.refresh(); model.awaitIdle()
            assertFalse(model.uiState.value.canAuthorize)
            model.connect()
        }
        assertEquals(0, gateway.authorizeCalls)
        gateway.authorizationResult = InstagramResult.Success(InstagramAuthorizationStatus(
            CONNECTION_ID, "connect", "authorization_expired", "2026-09-07T12:10:00Z"))
        model.refresh(); model.awaitIdle()
        assertTrue(model.uiState.value.canAuthorize)
    }

    @Test fun confirmedCancellationAndFailureRequireExplicitActionAndPreservePurpose() = runTest(dispatcher) {
        for (purpose in listOf("connect", "reconnect")) {
            for (status in listOf("authorization_cancelled", "authorization_failed", "authorization_expired")) {
                val gateway = expiredGateway(purpose).apply {
                    authorizationResult = InstagramResult.Success(InstagramAuthorizationStatus(
                        CONNECTION_ID, purpose, status, "2026-09-07T12:10:00Z"))
                }
                val model = model(gateway, MemoryIntentStore())
                model.onResume(); model.awaitIdle()
                assertTrue(model.uiState.value.canAuthorize)
                assertEquals(0, gateway.authorizeCalls)
                model.connect(); model.connect(); model.awaitIdle()
                assertEquals(listOf(purpose), gateway.authorizePurposes)
            }
        }
    }

    @Test fun lostNewPostCannotBeReleasedByOldExpiredSnapshotEvenAfterRestart() = runTest(dispatcher) {
        val gateway = expiredGateway()
        val witnessStore = MemoryAuthorizationStore()
        val first = model(gateway, MemoryIntentStore(), witnessStore)
        first.onResume(); first.awaitIdle(); first.connect(); first.awaitIdle()
        assertFalse(first.uiState.value.canAuthorize)
        first.refresh(); first.awaitIdle()
        assertFalse(first.uiState.value.canAuthorize)
        val restarted = model(gateway, MemoryIntentStore(), witnessStore)
        restarted.onResume(); restarted.awaitIdle()
        restarted.connect()
        assertFalse(restarted.uiState.value.canAuthorize)
        assertEquals(1, gateway.authorizeCalls)

        // Observing the NEW same-connection attempt, not the prior expired one, identifies it.
        gateway.authorizationResult = InstagramResult.Success(InstagramAuthorizationStatus(
            CONNECTION_ID, "connect", "authorization_pending", "2026-09-07T12:30:00Z"))
        restarted.refresh(); restarted.awaitIdle()
        assertFalse(restarted.uiState.value.canAuthorize)
        gateway.authorizationResult = InstagramResult.Success(InstagramAuthorizationStatus(
            CONNECTION_ID, "connect", "authorization_expired", "2026-09-07T12:30:00Z"))
        restarted.refresh(); restarted.awaitIdle()
        assertTrue(restarted.uiState.value.canAuthorize)
        assertEquals(1, gateway.authorizeCalls)
        restarted.connect(); restarted.awaitIdle()
        assertEquals(listOf("connect", "connect"), gateway.authorizePurposes)
    }

    @Test fun unidentifiedInitialPostRemainsUnknownAcrossRecreationAndNullSnapshot() = runTest(dispatcher) {
        val gateway = SyntheticGateway().apply { connection = null }
        val witnessStore = MemoryAuthorizationStore()
        val first = model(gateway, MemoryIntentStore(), witnessStore)
        first.onResume(); first.awaitIdle(); first.connect(); first.awaitIdle()
        val restarted = model(gateway, MemoryIntentStore(), witnessStore)
        restarted.onResume(); restarted.awaitIdle()
        restarted.connect()
        assertTrue(restarted.uiState.value.authorizationOutcomeUnknown)
        assertFalse(restarted.uiState.value.canAuthorize)
        assertEquals(listOf("connect"), gateway.authorizePurposes)
    }

    @Test fun explicitNewAttemptUsesFreshNavigationEventOnceAndRejectsOldTerminalResponse() = runTest(dispatcher) {
        val gateway = expiredGateway().apply {
            onAuthorize = { InstagramResult.Success(InstagramAuthorization(CONNECTION_ID,
                InstagramPoliciesTest.authorizationUrl(), "2026-09-07T12:30:00Z")) }
        }
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); model.awaitIdle(); model.connect(); model.connect(); model.awaitIdle()
        assertEquals(listOf("connect"), gateway.authorizePurposes)
        assertNotNull(model.takeAuthorizationUrl())
        assertNull(model.takeAuthorizationUrl())
        model.refresh(); model.awaitIdle()
        assertFalse(model.uiState.value.canAuthorize)
        assertTrue(model.uiState.value.authorizationOutcomeUnknown)
        gateway.authorizationResult = InstagramResult.Success(InstagramAuthorizationStatus(
            CONNECTION_ID, "connect", "authorization_completed", "2026-09-07T12:30:00Z"))
        gateway.connection = CONNECTION
        model.onPause(); model.onResume(); model.awaitIdle()
        assertFalse(model.uiState.value.canAuthorize)
        assertFalse(model.uiState.value.authorizationOutcomeUnknown)
        assertTrue(model.uiState.value.connection!!.canPublish)
        assertEquals(1, gateway.authorizeCalls)
    }

    @Test fun cancellationWhilePostIsUncertainPreservesWitnessAndCannotAutoRetry() = runTest(dispatcher) {
        val gateway = expiredGateway().apply {
            onAuthorize = { throw kotlinx.coroutines.CancellationException("Synthetic cancellation") }
        }
        val witnessStore = MemoryAuthorizationStore()
        val model = model(gateway, MemoryIntentStore(), witnessStore)
        model.onResume(); model.awaitIdle(); model.connect(); model.awaitIdle()
        model.refresh(); model.awaitIdle(); model.connect()
        assertFalse(model.uiState.value.canAuthorize)
        assertEquals(1, gateway.authorizeCalls)
        val restarted = model(gateway, MemoryIntentStore(), witnessStore)
        restarted.onResume(); restarted.awaitIdle()
        assertFalse(restarted.uiState.value.canAuthorize)
    }

    @Test fun failedDurableWitnessCreationPreventsThePost() = runTest(dispatcher) {
        val gateway = expiredGateway()
        val witnessStore = MemoryAuthorizationStore().apply { createSucceeds = false }
        val model = model(gateway, MemoryIntentStore(), witnessStore)
        model.onResume(); model.awaitIdle(); model.connect(); model.awaitIdle()
        assertEquals(0, gateway.authorizeCalls)
        assertFalse(model.uiState.value.canAuthorize)
    }

    @Test fun delayedAuthorizationResponseFromOldUserCannotOverwriteNewSession() = runTest(dispatcher) {
        val started = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        val oldGateway = expiredGateway().apply {
            onAuthorize = {
                started.complete(Unit)
                kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { finish.await() }
                InstagramResult.Success(InstagramAuthorization(CONNECTION_ID,
                    InstagramPoliciesTest.authorizationUrl(), "2026-09-07T12:30:00Z"))
            }
        }
        val newGateway = SyntheticGateway().apply {
            connection = CONNECTION.copy(connectionId = OTHER_CONNECTION_ID)
        }
        var token = "synthetic-old-company"
        val model = InstagramViewModel({ token }, MemoryIntentStore(), ORIGIN,
            { captured -> if (captured() == "synthetic-old-company") oldGateway else newGateway }, MemoryAuthorizationStore())
        model.onResume(); model.awaitIdle(); model.connect(); started.await()
        token = "synthetic-new-company"
        model.onResume(); model.awaitIdle()
        finish.complete(Unit)
        testScheduler.runCurrent()
        assertEquals(OTHER_CONNECTION_ID, model.uiState.value.connection?.connectionId)
        assertNull(model.takeAuthorizationUrl())
        assertFalse(model.uiState.value.canAuthorize)
        assertEquals(1, oldGateway.authorizeCalls)
        assertEquals(0, newGateway.authorizeCalls)
    }

    @Test fun delayedStatusFromBeforePauseDoesNotReenableNewAction() = runTest(dispatcher) {
        val gateway = expiredGateway()
        val started = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        gateway.beforeAuthorizationStatus = { started.complete(Unit); finish.await() }
        val model = model(gateway, MemoryIntentStore())
        model.onResume(); started.await(); model.onPause(); model.onResume()
        finish.complete(Unit); model.awaitIdle()
        assertFalse(model.uiState.value.canAuthorize)
        assertFalse(model.uiState.value.authorizationChecked)
        assertEquals(0, gateway.authorizeCalls)
        gateway.beforeAuthorizationStatus = {}
        model.refresh(); model.awaitIdle()
        assertTrue(model.uiState.value.canAuthorize)
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
