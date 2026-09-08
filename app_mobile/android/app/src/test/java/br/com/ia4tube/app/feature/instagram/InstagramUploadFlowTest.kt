package br.com.ia4tube.app.feature.instagram

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.util.concurrent.TimeUnit

/**
 * Crosses the same ViewModel handler bound by InstagramScreen into the real HTTP client.
 * MockWebServer is loopback-only; these tests never contact IA4Tube, Instagram or production.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InstagramUploadFlowTest {
    private val dispatcher = StandardTestDispatcher()
    private lateinit var server: MockWebServer

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        server = MockWebServer()
        server.start(InetAddress.getByName("127.0.0.1"), 0)
    }

    @After fun tearDown() {
        server.shutdown()
        Dispatchers.resetMain()
    }

    @Test fun screenUploadBlockedByClosedPublicationGateShowsTheActualReasonWithoutPosting() =
        runTest(dispatcher) {
            val model = model()
            prepareReadyScreen(model, publicationAllowed = false)
            selectDraft(model)
            assertFalse(model.uiState.value.canUpload)

            // InstagramScreen binds this exact handler as Button(onClick = viewModel::upload).
            model.upload()

            assertEquals(InstagramError.UNAVAILABLE.message, model.uiState.value.error)
            assertEquals("local_unavailable", model.uiState.value.uploadLocalDiagnostic?.code)
            assertEquals(4, server.requestCount)
        }

    @Test fun sameCaptionNotificationAfterUploadErrorKeepsErrorAndEarlierMediaReference() =
        runTest(dispatcher) {
            val model = model()
            prepareReadyScreen(model)
            selectDraft(model)

            enqueueJson(
                JSONObject().put("ok", false).put("code", "reviewer_media_invalid")
                    .put("error", "synthetic secret body that must never reach state"),
                status = 422
            )
            model.upload()
            model.awaitIdle()
            val failed = model.uiState.value
            assertEquals(InstagramError.INVALID_INPUT.message, failed.error)
            assertNull(failed.selectedMediaId)
            assertEquals(InstagramUploadPhase.REJECTED, failed.uploadWitness?.phase)
            assertEquals(422, failed.uploadWitness?.diagnostic?.httpStatus)
            assertFalse(failed.uploadWitness?.diagnostic?.outcomeUnknown ?: true)

            model.updateCaption(CAPTION)

            assertEquals(failed.error, model.uiState.value.error)
            assertEquals(failed.selectedMediaId, model.uiState.value.selectedMediaId)
            assertEquals(failed.message, model.uiState.value.message)
            assertEquals(failed.uploadFeedback, model.uiState.value.uploadFeedback)
            assertEquals(failed.uploadWitness, model.uiState.value.uploadWitness)

            model.updateCaption(EDITED_CAPTION)
            assertEquals(EDITED_CAPTION, model.uiState.value.draftCaption)
            assertEquals(failed.error, model.uiState.value.error)
            assertEquals(failed.message, model.uiState.value.message)
            assertEquals(failed.uploadFeedback, model.uiState.value.uploadFeedback)
            assertEquals(failed.selectedMediaId, model.uiState.value.selectedMediaId)
            assertEquals(failed.uploadWitness, model.uiState.value.uploadWitness)
            assertEquals(5, server.requestCount)
        }

    @Test fun sameCaptionNotificationAfterUploadSuccessKeepsResultAndSelectedMediaReference() =
        runTest(dispatcher) {
            val model = model()
            prepareReadyScreen(model)
            selectDraft(model)

            enqueueJson(uploadSuccess(MEDIA_ONE))
            model.upload()
            model.awaitIdle()
            val succeeded = model.uiState.value
            assertEquals(MEDIA_ONE, succeeded.selectedMediaId)
            assertNotNull(succeeded.message)

            model.updateCaption(CAPTION)

            assertEquals(succeeded.error, model.uiState.value.error)
            assertEquals(succeeded.message, model.uiState.value.message)
            assertEquals(succeeded.uploadFeedback, model.uiState.value.uploadFeedback)
            assertEquals(succeeded.selectedMediaId, model.uiState.value.selectedMediaId)
            assertEquals(InstagramUploadPhase.CONFIRMED, model.uiState.value.uploadWitness?.phase)
            assertTrue(model.uiState.value.canPublish)

            // Review may be opened, but only the separate explicit confirmation may POST a publication.
            model.requestPublicationConfirmation()
            assertTrue(model.uiState.value.confirmationOpen)
            assertEquals(5, server.requestCount)
            val upload = server.takeRequest()
            assertEquals("POST", upload.method)
            assertEquals("/v1/social/reviewer/media", upload.path)
        }

    @Test fun fiveHundredResponseBecomesDurableUnknownAndRefreshBlocksABlindRetry() =
        runTest(dispatcher) {
            val uploadStore = inMemoryUploadWitnessStore()
            val model = model(uploadStore = uploadStore)
            prepareReadyScreen(model)
            val jpeg = selectDraft(model)
            enqueueJson(
                JSONObject().put("ok", false).put("code", "reviewer_media_storage_unavailable")
                    .put("error", "synthetic-token synthetic-caption synthetic-jpeg"),
                status = 500
            )

            model.upload()
            model.awaitIdle()
            val unknown = model.uiState.value
            assertEquals(InstagramError.NETWORK.message, unknown.error)
            assertEquals(InstagramUploadPhase.UNKNOWN, unknown.uploadWitness?.phase)
            assertEquals(InstagramRequestStage.HTTP_RESPONSE, unknown.uploadWitness?.diagnostic?.stage)
            assertEquals(500, unknown.uploadWitness?.diagnostic?.httpStatus)
            assertTrue(unknown.uploadWitness?.diagnostic?.outcomeUnknown == true)
            assertFalse(unknown.canUpload)
            assertFalse(unknown.toString().contains("synthetic-token"))
            assertFalse(unknown.toString().contains("synthetic-caption"))
            assertFalse(unknown.toString().contains("synthetic-jpeg"))
            assertEquals("/v1/social/reviewer/media", server.takeRequest().path)

            enqueueRefresh()
            model.refresh()
            model.awaitIdle()
            consumeRefreshRequests()
            val restored = model.uiState.value
            assertEquals(unknown.uploadWitness, restored.uploadWitness)
            assertTrue(jpeg.contentEquals(restored.draftJpeg))
            assertFalse(restored.canUpload)

            model.upload()
            assertEquals(unknown.uploadWitness, model.uiState.value.uploadWitness)
            assertEquals("local_unavailable", model.uiState.value.uploadLocalDiagnostic?.code)
            assertEquals(9, server.requestCount)
        }

    @Test fun successfulHttpWithInvalidJsonPreservesUnknownInsteadOfInventingAResult() =
        runTest(dispatcher) {
            val model = model()
            prepareReadyScreen(model)
            selectDraft(model)
            server.enqueue(
                MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json")
                    .setBody("{not-valid-json")
            )

            model.upload()
            model.awaitIdle()

            val state = model.uiState.value
            assertEquals(InstagramError.INVALID_RESPONSE.message, state.error)
            assertEquals(InstagramUploadPhase.UNKNOWN, state.uploadWitness?.phase)
            assertEquals(InstagramRequestStage.INVALID_RESPONSE, state.uploadWitness?.diagnostic?.stage)
            assertEquals("response_invalid", state.uploadWitness?.diagnostic?.code)
            assertEquals(200, state.uploadWitness?.diagnostic?.httpStatus)
            assertTrue(state.uploadWitness?.diagnostic?.outcomeUnknown == true)
            assertNull(state.selectedMediaId)
            assertEquals(5, server.requestCount)
        }

    @Test fun timeoutBeforeResponseHeadersRecordsNoFabricatedHttpStatusAndBlocksRetry() =
        runTest(dispatcher) {
            val model = model(timeoutMillis = SHORT_TIMEOUT_MILLIS)
            prepareReadyScreen(model)
            selectDraft(model)
            server.enqueue(
                MockResponse().setResponseCode(200)
                    .setHeadersDelay(SLOW_RESPONSE_MILLIS, TimeUnit.MILLISECONDS)
                    .setHeader("Content-Type", "application/json")
                    .setBody(uploadSuccess(MEDIA_ONE).toString())
            )

            model.upload()
            model.awaitIdle()

            val diagnostic = model.uiState.value.uploadWitness?.diagnostic
            assertEquals(InstagramUploadPhase.UNKNOWN, model.uiState.value.uploadWitness?.phase)
            assertEquals(InstagramRequestStage.TRANSPORT, diagnostic?.stage)
            assertEquals("transport_timeout", diagnostic?.code)
            assertTrue(diagnostic?.requestStarted == true)
            assertFalse(diagnostic?.responseReceived ?: true)
            assertNull(diagnostic?.httpStatus)
            assertTrue(diagnostic?.outcomeUnknown == true)
            assertFalse(model.uiState.value.canUpload)
            assertEquals(5, server.requestCount)
        }

    @Test fun timeoutWhileReadingBodyKeepsReceivedStatusButStillMarksOutcomeUnknown() =
        runTest(dispatcher) {
            val model = model(timeoutMillis = SHORT_TIMEOUT_MILLIS)
            prepareReadyScreen(model)
            selectDraft(model)
            server.enqueue(
                MockResponse().setResponseCode(200)
                    .setHeader("Content-Type", "application/json")
                    .setBodyDelay(SLOW_RESPONSE_MILLIS, TimeUnit.MILLISECONDS)
                    .setBody(uploadSuccess(MEDIA_ONE).toString())
            )

            model.upload()
            model.awaitIdle()

            val diagnostic = model.uiState.value.uploadWitness?.diagnostic
            assertEquals(InstagramUploadPhase.UNKNOWN, model.uiState.value.uploadWitness?.phase)
            assertEquals(InstagramRequestStage.TRANSPORT, diagnostic?.stage)
            assertEquals("transport_timeout", diagnostic?.code)
            assertTrue(diagnostic?.requestStarted == true)
            assertTrue(diagnostic?.responseReceived == true)
            assertEquals(200, diagnostic?.httpStatus)
            assertTrue(diagnostic?.outcomeUnknown == true)
            assertFalse(model.uiState.value.canUpload)
            assertEquals(5, server.requestCount)
        }

    @Test fun realCaptionEditKeepsConfirmedWitnessButDoesNotAttachItsMediaToNewDraft() =
        runTest(dispatcher) {
            val model = model()
            prepareReadyScreen(model)
            selectDraft(model)
            enqueueJson(uploadSuccess(MEDIA_ONE))
            model.upload()
            model.awaitIdle()
            val previous = model.uiState.value
            assertEquals(InstagramUploadPhase.CONFIRMED, previous.uploadWitness?.phase)
            assertEquals(MEDIA_ONE, previous.selectedMediaId)
            assertTrue(previous.uploadDraftMatches)

            model.updateCaption(EDITED_CAPTION)

            val edited = model.uiState.value
            assertEquals(EDITED_CAPTION, edited.draftCaption)
            assertEquals(previous.uploadWitness, edited.uploadWitness)
            assertEquals(previous.uploadFeedback, edited.uploadFeedback)
            assertEquals(previous.message, edited.message)
            assertEquals(previous.error, edited.error)
            assertFalse(edited.uploadDraftMatches)
            assertNull(edited.selectedMediaId)
            assertFalse(edited.canPublish)
            assertTrue(edited.canUpload)
            assertEquals(5, server.requestCount)
        }

    @Test fun duplicateScreenTapDuringUploadKeepsOriginalProgressAndMakesOnlyOnePost() =
        runTest(dispatcher) {
            val model = model()
            prepareReadyScreen(model)
            selectDraft(model)
            server.enqueue(
                MockResponse().setResponseCode(200)
                    .setHeadersDelay(SLOW_RESPONSE_MILLIS, TimeUnit.MILLISECONDS)
                    .setHeader("Content-Type", "application/json")
                    .setBody(uploadSuccess(MEDIA_ONE).toString())
            )

            model.upload()
            val inFlight = model.uiState.first {
                it.uploadWitness?.phase == InstagramUploadPhase.IN_FLIGHT
            }
            val request = server.takeRequest(2, TimeUnit.SECONDS)
            assertNotNull(request)
            assertEquals("POST", request!!.method)
            assertTrue(inFlight.busy)
            assertEquals(InstagramUploadPhase.IN_FLIGHT, inFlight.uploadWitness?.phase)

            model.upload()

            assertEquals(inFlight.uploadWitness, model.uiState.value.uploadWitness)
            assertEquals(inFlight.uploadFeedback, model.uiState.value.uploadFeedback)
            assertEquals(5, server.requestCount)
            model.awaitIdle()
            assertEquals(InstagramUploadPhase.CONFIRMED, model.uiState.value.uploadWitness?.phase)
            assertEquals(5, server.requestCount)
        }

    @Test fun delayedUploadResponseFromOldSessionCannotOverwriteTheNewAccountState() =
        runTest(dispatcher) {
            var session = SESSION
            val model = model(tokenProvider = { session })
            prepareReadyScreen(model)
            selectDraft(model)
            server.enqueue(
                MockResponse().setResponseCode(200)
                    .setBodyDelay(SLOW_RESPONSE_MILLIS, TimeUnit.MILLISECONDS)
                    .setHeader("Content-Type", "application/json")
                    .setBody(uploadSuccess(MEDIA_ONE).toString())
            )
            model.upload()
            model.uiState.first { it.uploadWitness?.phase == InstagramUploadPhase.IN_FLIGHT }
            assertNotNull(server.takeRequest(2, TimeUnit.SECONDS))

            enqueueRefresh(connectionId = OTHER_CONNECTION)
            session = OTHER_SESSION
            model.onResume()
            model.awaitIdle()
            consumeRefreshRequests(OTHER_CONNECTION)
            withContext(Dispatchers.IO) { Thread.sleep(SLOW_RESPONSE_MILLIS + 150L) }
            testScheduler.runCurrent()

            val current = model.uiState.value
            assertEquals(OTHER_CONNECTION, current.connection?.connectionId)
            assertNull(current.uploadWitness)
            assertNull(current.selectedMediaId)
            assertTrue(current.media.none { it.id == MEDIA_ONE })
            assertEquals(9, server.requestCount)
        }

    @Test fun refreshAndPauseResumePreserveTheSelectedJpegAndApprovedCaption() =
        runTest(dispatcher) {
            val model = model()
            prepareReadyScreen(model)
            val jpeg = selectDraft(model)
            assertTrue(model.uiState.value.canUpload)

            enqueueRefresh()
            model.refresh()
            model.awaitIdle()
            consumeRefreshRequests()
            assertTrue(jpeg.contentEquals(model.uiState.value.draftJpeg))
            assertEquals(CAPTION, model.uiState.value.draftCaption)
            assertTrue(model.uiState.value.canUpload)

            model.onPause()
            enqueueRefresh()
            model.onResume()
            model.awaitIdle()
            consumeRefreshRequests()
            assertTrue(jpeg.contentEquals(model.uiState.value.draftJpeg))
            assertEquals(CAPTION, model.uiState.value.draftCaption)
            assertTrue(model.uiState.value.canUpload)
            assertEquals(12, server.requestCount)
        }

    @Test fun accountBindingChangeClearsOldFeedbackWithoutDeletingItsDurableWitness() =
        runTest(dispatcher) {
            val uploadStore = inMemoryUploadWitnessStore()
            val model = model(uploadStore = uploadStore)
            prepareReadyScreen(model)
            selectDraft(model)
            enqueueJson(uploadSuccess(MEDIA_ONE))
            model.upload()
            model.awaitIdle()
            val oldWitness = model.uiState.value.uploadWitness
            assertNotNull(oldWitness)
            assertNotNull(model.uiState.value.message)
            assertNotNull(model.uiState.value.uploadFeedback)
            assertEquals("/v1/social/reviewer/media", server.takeRequest().path)

            enqueueRefresh(connectionId = OTHER_CONNECTION)
            model.refresh()
            model.awaitIdle()
            consumeRefreshRequests(OTHER_CONNECTION)

            val rebound = model.uiState.value
            assertEquals(OTHER_CONNECTION, rebound.connection?.connectionId)
            assertNull(rebound.uploadWitness)
            assertNull(rebound.error)
            assertNull(rebound.message)
            assertNull(rebound.uploadFeedback)
            assertNull(rebound.selectedMediaId)
            assertFalse(rebound.uploadDraftMatches)
            assertEquals(
                oldWitness,
                uploadStore.read(
                    InstagramIntentPolicy.contextKey(
                        InstagramPolicies.OFFICIAL_API_ORIGIN,
                        CONNECTION
                    )
                )
            )
            assertEquals(9, server.requestCount)
        }

    @Test fun sameConnectionWithNewRevisionKeepsPriorBindingWitnessButCannotPublish() =
        runTest(dispatcher) {
            val uploadStore = inMemoryUploadWitnessStore()
            val model = model(uploadStore = uploadStore)
            prepareReadyScreen(model)
            selectDraft(model)
            enqueueJson(uploadSuccess(MEDIA_ONE))
            model.upload()
            model.awaitIdle()
            val previous = model.uiState.value.uploadWitness
            assertEquals(CONNECTION_REVISION, previous?.binding?.connectionRevision)
            assertEquals(InstagramUploadPhase.CONFIRMED, previous?.phase)
            assertEquals("/v1/social/reviewer/media", server.takeRequest().path)

            enqueueRefresh(connectionRevision = NEW_CONNECTION_REVISION)
            model.refresh()
            model.awaitIdle()
            consumeRefreshRequests()

            val rebound = model.uiState.value
            assertEquals(CONNECTION, rebound.connection?.connectionId)
            assertEquals(NEW_CONNECTION_REVISION, rebound.connection?.binding?.connectionRevision)
            assertEquals(previous, rebound.uploadWitness)
            assertEquals(CONNECTION_REVISION, rebound.uploadWitness?.binding?.connectionRevision)
            assertTrue(rebound.uploadFeedback.orEmpty().contains("vínculo anterior"))
            assertNull(rebound.draftJpeg)
            assertNull(rebound.selectedMediaId)
            assertFalse(rebound.uploadDraftMatches)
            assertFalse(rebound.canUpload)
            assertFalse(rebound.canPublish)

            model.requestPublicationConfirmation()
            assertFalse(model.uiState.value.confirmationOpen)
            assertEquals(9, server.requestCount)
        }

    @Test fun genericMediaIdInSuccessfulResponseBecomesUnknownWithoutExposingThatId() =
        runTest(dispatcher) {
            val model = model()
            prepareReadyScreen(model)
            selectDraft(model)
            enqueueJson(uploadSuccess(GENERIC_MEDIA_ID))

            model.upload()
            model.awaitIdle()

            val state = model.uiState.value
            assertEquals(InstagramUploadPhase.UNKNOWN, state.uploadWitness?.phase)
            assertNull(state.uploadWitness?.mediaId)
            assertTrue(state.uploadWitness?.diagnostic?.outcomeUnknown == true)
            assertNull(state.selectedMediaId)
            assertTrue(state.media.none { it.id == GENERIC_MEDIA_ID })
            assertFalse(state.canUpload)
            assertFalse(state.canPublish)
            assertNotNull(state.error)
            assertFalse(state.error.orEmpty().contains(GENERIC_MEDIA_ID))
            assertFalse(state.message.orEmpty().contains(GENERIC_MEDIA_ID))
            assertFalse(state.uploadFeedback.orEmpty().contains(GENERIC_MEDIA_ID))
            assertFalse(state.uploadWitness.toString().contains(GENERIC_MEDIA_ID))
            assertEquals(5, server.requestCount)
        }

    @Test fun failedResultStoreCasNeverAttributesRejectedResultAndBlocksBothActions() =
        runTest(dispatcher) {
            val uploadStore = ResultUpdateFailingUploadStore()
            val model = model(uploadStore = uploadStore)
            prepareReadyScreen(model)
            selectDraft(model)
            enqueueJson(
                JSONObject().put("ok", false).put("code", "reviewer_media_invalid")
                    .put("error", "canary-result-body"),
                status = 422
            )

            model.upload()
            model.awaitIdle()

            val state = model.uiState.value
            assertEquals(InstagramUploadPhase.IN_FLIGHT, uploadStore.saved?.phase)
            assertEquals(InstagramUploadPhase.UNKNOWN, state.uploadWitness?.phase)
            assertTrue(state.uploadWitness?.diagnostic?.outcomeUnknown == true)
            assertFalse(state.uploadStorageAvailable)
            assertFalse(state.canUpload)
            assertFalse(state.canPublish)
            assertNull(state.selectedMediaId)
            assertNotNull(state.error)
            assertFalse(state.error == InstagramError.INVALID_INPUT.message)
            assertFalse(state.error.orEmpty().contains("canary-result-body"))
            assertFalse(state.message.orEmpty().contains("canary-result-body"))
            assertFalse(state.uploadFeedback.orEmpty().contains("canary-result-body"))
            assertEquals(5, server.requestCount)
        }

    @Test fun recreatedViewModelRestoresUnknownLedgerAndBlocksUploadEvenWithoutJpeg() =
        runTest(dispatcher) {
            val uploadStore = inMemoryUploadWitnessStore()
            val first = model(uploadStore = uploadStore)
            prepareReadyScreen(first)
            selectDraft(first)
            enqueueJson(
                JSONObject().put("ok", false).put("code", "reviewer_media_storage_unavailable"),
                status = 500
            )
            first.upload()
            first.awaitIdle()
            val unknown = first.uiState.value.uploadWitness
            assertEquals(InstagramUploadPhase.UNKNOWN, unknown?.phase)
            assertEquals("/v1/social/reviewer/media", server.takeRequest().path)

            val recreated = model(uploadStore = uploadStore)
            prepareReadyScreen(recreated)
            val restored = recreated.uiState.value
            assertEquals(unknown, restored.uploadWitness)
            assertEquals(InstagramUploadPhase.UNKNOWN, restored.uploadWitness?.phase)
            assertNull(restored.draftJpeg)
            assertNull(restored.selectedMediaId)
            assertFalse(restored.canUpload)
            assertFalse(restored.canPublish)
            assertNotNull(restored.uploadFeedback)

            recreated.upload()
            assertEquals(unknown, recreated.uiState.value.uploadWitness)
            assertEquals("local_unavailable", recreated.uiState.value.uploadLocalDiagnostic?.code)
            assertEquals(9, server.requestCount)
        }

    private fun model(
        tokenProvider: () -> String = { SESSION },
        uploadStore: InstagramUploadWitnessStore = inMemoryUploadWitnessStore(),
        timeoutMillis: Long = 60_000L
    ) = InstagramViewModel(
        tokenProvider = tokenProvider,
        intentStore = MemoryIntentStore(),
        apiOrigin = InstagramPolicies.OFFICIAL_API_ORIGIN,
        gatewayFactory = { capturedSession ->
            InstagramApiClient.forLocalTests(
                capturedSession,
                "http://127.0.0.1:${server.port}/",
                timeoutMillis
            )
        },
        authorizationStore = MemoryAuthorizationStore(),
        uploadStore = uploadStore
    )

    private suspend fun prepareReadyScreen(
        model: InstagramViewModel,
        publicationAllowed: Boolean = true,
        connectionId: String = CONNECTION,
        media: List<JSONObject> = emptyList()
    ) {
        enqueueRefresh(publicationAllowed = publicationAllowed, connectionId = connectionId, media = media)

        model.onResume()
        model.awaitIdle()
        assertEquals(InstagramAvailability.AVAILABLE, model.uiState.value.availability)
        consumeRefreshRequests(connectionId)
    }

    private fun enqueueRefresh(
        publicationAllowed: Boolean = true,
        connectionId: String = CONNECTION,
        connectionRevision: Long = CONNECTION_REVISION,
        media: List<JSONObject> = emptyList()
    ) {
        enqueueJson(
            JSONObject()
                .put("ok", true)
                .put("connection", connection(connectionId, connectionRevision))
                .put(
                    "operationalAvailability",
                    JSONObject()
                        .put("connectionAllowed", true)
                        .put("publicationAllowed", publicationAllowed)
                )
        )
        enqueueJson(
            JSONObject().put(
                "ok",
                true
            ).put(
                "authorization",
                JSONObject()
                    .put("connectionId", connectionId)
                    .put("purpose", "connect")
                    .put("status", "authorization_completed")
                    .put("expiresAt", JSONObject.NULL)
            )
        )
        enqueueJson(
            JSONObject()
                .put("ok", true)
                .put("contentOwnerDerivedFromSession", true)
                .put("media", JSONArray().apply { media.forEach { put(it) } })
        )
        enqueueJson(
            JSONObject()
                .put("ok", true)
                .put("canonicalPersistence", true)
                .put("independentReview", true)
                .put("freshPublicationAvailable", true)
                .put("publications", JSONArray())
        )
    }

    private fun consumeRefreshRequests(connectionId: String = CONNECTION) {
        assertEquals(
            listOf(
                "/v1/social/connections/instagram",
                "/v1/social/connections/instagram/$connectionId/authorization",
                "/v1/social/reviewer/media",
                "/v1/social/reviewer/publications"
            ),
            (1..4).map { server.takeRequest().path }
        )
    }

    private fun selectDraft(model: InstagramViewModel, caption: String = CAPTION): ByteArray {
        val pickerSession = model.pickerSessionKey()
        assertNotNull(pickerSession)
        val jpeg = InstagramPoliciesTest.jpegEnvelope()
        model.acceptJpeg(jpeg, pickerSession!!)
        model.updateCaption(caption)
        assertNotNull(model.uiState.value.draftJpeg)
        assertEquals(caption, model.uiState.value.draftCaption)
        return jpeg
    }

    private fun enqueueJson(body: JSONObject, status: Int = 200) {
        server.enqueue(
            MockResponse()
                .setResponseCode(status)
                .setHeader("Content-Type", "application/json")
                .setBody(body.toString())
        )
    }

    private fun connection(
        connectionId: String = CONNECTION,
        connectionRevision: Long = CONNECTION_REVISION
    ) = JSONObject()
        .put("connectionId", connectionId)
        .put("provider", "instagram")
        .put("state", "connected")
        .put("health", "healthy")
        .put("username", "@fixture_account")
        .put("accountType", "business")
        .put("externalId", if (connectionId == CONNECTION) EXTERNAL_ID else EXTERNAL_ID_TWO)
        .put("connectionRevision", connectionRevision)

    private fun media(mediaId: String, caption: String = CAPTION) = JSONObject()
        .put("id", mediaId)
        .put("mimeType", "image/jpeg")
        .put("caption", "$caption\n\n#IA4TubeReview_fixture")
        .put("width", 1080)
        .put("height", 1080)
        .put("thumbnailUrl", JSONObject.NULL)

    private fun uploadSuccess(mediaId: String, caption: String = CAPTION) = JSONObject()
        .put("ok", true)
        .put("contentOwnerDerivedFromSession", true)
        .put("media", media(mediaId, caption))

    private suspend fun InstagramViewModel.awaitIdle() {
        uiState.first { !it.busy }
    }

    private class MemoryIntentStore : InstagramPublicationIntentStore {
        override fun read(contextKey: String): InstagramPublicationIntent? = null
        override fun create(contextKey: String, intent: InstagramPublicationIntent): Boolean = true
        override fun update(contextKey: String, intent: InstagramPublicationIntent): Boolean = true
        override fun removeConfirmed(contextKey: String, clientRequestId: String): Boolean = true
    }

    private class MemoryAuthorizationStore : InstagramAuthorizationWitnessStore {
        override fun read(contextKey: String): InstagramAuthorizationWitness? = null
        override fun create(contextKey: String, witness: InstagramAuthorizationWitness): Boolean = true
        override fun update(contextKey: String, witness: InstagramAuthorizationWitness): Boolean = true
        override fun clear(contextKey: String, id: String): Boolean = true
    }

    /** Accepts the dispatch transition, then simulates a refused durable result CAS. */
    private class ResultUpdateFailingUploadStore : InstagramUploadWitnessStore {
        private var savedContextKey: String? = null

        @Volatile
        var saved: InstagramUploadWitness? = null
            private set

        @Synchronized
        override fun read(contextKey: String): InstagramUploadWitness? =
            saved.takeIf { savedContextKey == contextKey }

        @Synchronized
        override fun create(contextKey: String, witness: InstagramUploadWitness): Boolean {
            if (saved != null || witness.phase != InstagramUploadPhase.PREPARED) return false
            savedContextKey = contextKey
            saved = witness
            return true
        }

        @Synchronized
        override fun update(contextKey: String, witness: InstagramUploadWitness): Boolean {
            val previous = saved ?: return false
            if (savedContextKey != contextKey || witness.phase != InstagramUploadPhase.IN_FLIGHT ||
                !InstagramUploadWitnessPolicy.canUpdate(previous, witness)) return false
            saved = witness
            return true
        }

        override fun clearResolved(contextKey: String, id: String): Boolean = false
    }

    private companion object {
        const val SESSION = "synthetic-local-session"
        const val OTHER_SESSION = "synthetic-other-session"
        const val CAPTION = "Legenda sintética aprovada para o teste local"
        const val EDITED_CAPTION = "Legenda sintética realmente editada para o teste local"
        const val CONNECTION = "11111111-1111-4111-8111-111111111111"
        const val OTHER_CONNECTION = "22222222-2222-4222-8222-222222222222"
        const val EXTERNAL_ID = "123456789012345"
        const val EXTERNAL_ID_TWO = "543210987654321"
        const val CONNECTION_REVISION = 4L
        const val NEW_CONNECTION_REVISION = 5L
        const val MEDIA_ONE = "reviewer-jpeg:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        const val GENERIC_MEDIA_ID = "generic-media-identifier-12345"
        const val SHORT_TIMEOUT_MILLIS = 100L
        const val SLOW_RESPONSE_MILLIS = 400L
    }
}
