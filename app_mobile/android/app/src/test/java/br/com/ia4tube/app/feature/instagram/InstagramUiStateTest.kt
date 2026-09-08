package br.com.ia4tube.app.feature.instagram

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InstagramUiStateTest {
    private val connection = InstagramConnection(CONNECTION_ID, "connected", "healthy", "@empresa", "business", "123456789012345", 4L)
    private val media = InstagramMedia(MEDIA_ID, "Legenda confirmada no upload", 1080, 1080)
    private fun ready() = InstagramUiState(
        availability = InstagramAvailability.AVAILABLE,
        authorizationChecked = true,
        operationalAvailability = InstagramOperationalAvailability(true, true),
        connection = connection,
        media = listOf(media),
        selectedMediaId = media.id,
        uploadDraftMatches = true,
        uploadWitness = InstagramUploadWitness("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a".repeat(64),
            connection.binding!!, 1, InstagramUploadPhase.CONFIRMED, media.id),
        historyLoaded = true,
        freshPublicationAvailable = true
    )

    private val pendingInitialConnection = InstagramConnection(
        CONNECTION_ID, "authorization_pending", "authorization_pending", null, null
    )

    private fun authorizationState(
        current: InstagramConnection? = null,
        status: String? = null,
        purpose: String = "connect"
    ) = ready().copy(
        connection = current,
        authorizationStatus = status,
        authorization = status?.let {
            InstagramAuthorizationStatus(CONNECTION_ID, purpose, it, "2026-09-07T12:10:00Z")
        }
    )

    @Test fun serverMustPermitANewPublication() {
        assertTrue(ready().canPublish)
        assertFalse(ready().copy(historyLoaded = false).canPublish)
        assertFalse(ready().copy(freshPublicationAvailable = false).canPublish)
    }

    @Test fun unavailableOrExpiredSessionNeverEnablesMutations() {
        listOf(InstagramAvailability.CHECKING, InstagramAvailability.UNAVAILABLE, InstagramAvailability.SESSION_REQUIRED).forEach {
            val state = ready().copy(availability = it, draftJpeg = byteArrayOf(1), draftCaption = "Legenda")
            assertFalse(state.canPublish)
            assertFalse(state.canUpload)
            assertFalse(state.canAuthorize)
        }
    }

    @Test fun unresolvedIntentBlocksEditsAndAllNewPublications() {
        val pending = InstagramIntentPolicy.create(MEDIA_ID, CONNECTION_ID)
        val state = ready().copy(intent = pending)
        assertTrue(state.hasUnresolvedIntent)
        assertFalse(state.canPublish)
        assertFalse(state.canEditDraft)
        assertFalse(state.canUpload)
    }

    @Test fun confirmedIntentStillRequiresExplicitNewDraft() {
        val intent = InstagramIntentPolicy.create(MEDIA_ID, CONNECTION_ID).copy(
            publicationId = PUBLICATION_ID, confirmed = true
        )
        val state = ready().copy(intent = intent)
        assertFalse(state.hasUnresolvedIntent)
        assertFalse(state.canPublish)
    }

    @Test fun busyAndUnwritableLedgerBlockPublication() {
        assertFalse(ready().copy(busy = true).canPublish)
        assertFalse(ready().copy(storageAvailable = false).canPublish)
        assertFalse(ready().copy(authorizationUrlToOpen = "https://www.instagram.com/oauth/authorize").canPublish)
    }

    @Test fun professionalHealthyAccountAndServerMediaAreRequired() {
        assertFalse(ready().copy(connection = null).canPublish)
        assertFalse(ready().copy(connection = connection.copy(accountType = "personal")).canPublish)
        assertFalse(ready().copy(connection = connection.copy(health = "reconnect_required")).canPublish)
        assertFalse(ready().copy(connection = connection.copy(externalId = null)).canPublish)
        assertFalse(ready().copy(connection = connection.copy(connectionRevision = null)).canPublish)
        assertFalse(ready().copy(selectedMediaId = "not-owned").canPublish)
    }

    @Test fun pendingAuthorizationCannotBeReopenedAsANewRequest() {
        val state = authorizationState()
        assertTrue(state.canAuthorize)
        assertEquals("connect", state.authorizationPurpose)
        for (current in listOf(null, pendingInitialConnection)) {
            for (status in listOf("authorization_pending", "authorization_processing")) {
                val pending = authorizationState(current, status)
                assertNull(pending.authorizationPurpose)
                assertFalse(pending.canAuthorize)
            }
        }
        assertTrue(authorizationState(status = "authorization_cancelled").canAuthorize)
    }

    @Test fun serverPendingOrDisconnectingBlocksAuthorizationWithoutLocalStatus() {
        val state = authorizationState()
        assertFalse(state.copy(connection = connection.copy(state = "authorization_pending")).canAuthorize)
        assertFalse(state.copy(connection = connection.copy(state = "disconnecting")).canAuthorize)
        assertFalse(state.copy(connection = connection).canAuthorize)
        assertTrue(state.copy(connection = connection.copy(state = "disconnected", health = "disconnected")).canAuthorize)
        assertFalse(state.copy(connection = connection.copy(state = "failed", health = "failed")).canAuthorize)
        assertTrue(state.copy(connection = connection.copy(state = "reconnect_required", health = "reconnect_required")).canAuthorize)
        assertTrue(state.copy(connection = connection.copy(health = "reconnect_required")).canAuthorize)
    }

    @Test fun authoritativeTerminalInitialAttemptUsesConnectWithoutAnAccount() {
        for (status in listOf("authorization_expired", "authorization_cancelled", "authorization_failed")) {
            for (current in listOf(null, pendingInitialConnection,
                pendingInitialConnection.copy(state = "failed", health = "failed"))) {
                val state = authorizationState(current, status)
                assertEquals("connect", state.authorizationPurpose)
                assertTrue(state.canAuthorize)
                assertFalse(state.canPublish)
            }
        }
    }

    @Test fun terminalReconnectAttemptPreservesReconnectPurposeAndExistingAccount() {
        val pendingReconnect = connection.copy(state = "authorization_pending", health = "authorization_pending")
        val state = authorizationState(pendingReconnect, "authorization_expired", "reconnect")
        assertEquals("reconnect", state.authorizationPurpose)
        assertTrue(state.canAuthorize)
        assertFalse(state.canPublish)
        assertEquals(connection.externalId, state.connection?.externalId)
        assertEquals(connection.connectionRevision, state.connection?.connectionRevision)
    }

    @Test fun expiredTimestampOrLabelAloneDoesNotResolveAnUnfinishedAttempt() {
        val checkedTerminal = authorizationState(pendingInitialConnection, "authorization_expired")
        val notProven = listOf(
            checkedTerminal.copy(authorizationChecked = false),
            checkedTerminal.copy(authorizationOutcomeUnknown = true),
            checkedTerminal.copy(authorization = null),
            checkedTerminal.copy(authorizationStatus = null),
            authorizationState(pendingInitialConnection),
            authorizationState(pendingInitialConnection, "authorization_pending"),
            authorizationState(pendingInitialConnection.copy(state = "failed", health = "failed"))
        )
        for (state in notProven) {
            assertNull(state.authorizationPurpose)
            assertFalse(state.canAuthorize)
        }
        // No connection is not proof that an unacknowledged authorize request was never accepted.
        assertFalse(authorizationState().copy(authorizationOutcomeUnknown = true).canAuthorize)
        assertFalse(authorizationState().copy(authorizationChecked = false).canAuthorize)
    }

    @Test fun divergentAuthorizationSnapshotCannotReleaseThePendingConnection() {
        val state = authorizationState(pendingInitialConnection, "authorization_expired")
        val proof = state.authorization!!
        for (divergent in listOf(
            proof.copy(connectionId = PUBLICATION_ID),
            proof.copy(status = "authorization_cancelled"),
            proof.copy(purpose = "disconnect")
        )) {
            val blocked = state.copy(authorization = divergent)
            assertNull(blocked.authorizationPurpose)
            assertFalse(blocked.canAuthorize)
        }
    }

    @Test fun initialConnectCannotDiscardAnExistingOrPartiallyKnownAccount() {
        for (current in listOf(
            pendingInitialConnection.copy(username = "@empresa"),
            pendingInitialConnection.copy(externalId = connection.externalId),
            connection.copy(state = "authorization_pending", health = "authorization_pending"),
            connection.copy(state = "failed", health = "failed")
        )) {
            val state = authorizationState(current, "authorization_expired", "connect")
            assertNull(state.authorizationPurpose)
            assertFalse(state.canAuthorize)
        }
    }

    @Test fun healthyConnectedAccountDoesNotOfferANewAuthorizationAfterTerminalAttempt() {
        for (purpose in listOf("connect", "reconnect")) {
            val state = authorizationState(connection, "authorization_expired", purpose)
            assertNull(state.authorizationPurpose)
            assertFalse(state.canAuthorize)
        }
    }

    @Test fun terminalPurposeIsIndependentOfGateAndBusyButExecutionIsNot() {
        val state = authorizationState(pendingInitialConnection, "authorization_expired")
        val gateClosed = state.copy(operationalAvailability = InstagramOperationalAvailability(false, false))
        val gateUnknown = state.copy(operationalAvailability = null)
        val busy = state.copy(busy = true)
        for (blocked in listOf(gateClosed, gateUnknown, busy)) {
            assertEquals("connect", blocked.authorizationPurpose)
            assertFalse(blocked.canAuthorize)
        }
        assertTrue(gateClosed.copy(operationalAvailability = InstagramOperationalAvailability(true, false)).canAuthorize)
        assertTrue(busy.copy(busy = false).canAuthorize)
        for (availability in listOf(InstagramAvailability.CHECKING, InstagramAvailability.UNAVAILABLE,
            InstagramAvailability.SESSION_REQUIRED)) {
            assertFalse(state.copy(availability = availability).canAuthorize)
        }
    }

    @Test fun unconsumedAuthorizationUrlBlocksAnotherAuthorizationEvenAfterTerminalSnapshot() {
        val state = authorizationState(pendingInitialConnection, "authorization_expired")
            .copy(authorizationUrlToOpen = "https://www.instagram.com/oauth/authorize")
        assertNull(state.authorizationPurpose)
        assertFalse(state.canAuthorize)
    }

    @Test fun usernamesHaveExactlyOneAtSign() {
        assertEquals("@empresa", instagramUsernameLabel("@empresa"))
        assertEquals("@empresa", instagramUsernameLabel("empresa"))
        assertEquals("Conta não confirmada", instagramUsernameLabel(""))
    }

    @Test fun operationalPermissionMustBeExplicitAndIndependentForEachAction() {
        val editable = ready().copy(draftJpeg = byteArrayOf(1), draftCaption = "Legenda")
        for (permission in listOf(null, InstagramOperationalAvailability(false, false))) {
            val unknownOrBlocked = editable.copy(operationalAvailability = permission)
            assertFalse(unknownOrBlocked.canPublish)
            assertFalse(unknownOrBlocked.canUpload)
            assertFalse(unknownOrBlocked.copy(connection = null).canAuthorize)
        }
        assertTrue(editable.copy(operationalAvailability = InstagramOperationalAvailability(false, true)).canPublish)
        assertTrue(editable.copy(connection = null,
            operationalAvailability = InstagramOperationalAvailability(true, false)).canAuthorize)
        assertFalse(editable.copy(operationalAvailability = InstagramOperationalAvailability(true, false)).canPublish)
    }

    @Test fun continuationRequiresIdentifiedMatchingProviderConfirmation() {
        val intent = InstagramIntentPolicy.create(MEDIA_ID, connection).copy(publicationId = PUBLICATION_ID)
        val publication = InstagramPublication(PUBLICATION_ID, CONNECTION_ID, "provider_confirming", MEDIA_ID,
            "Legenda", "@empresa", "business", null, null, null, "2026-09-05T12:00:00Z", "2026-09-05T12:00:00Z", connection.binding)
        val state = ready().copy(intent = intent, history = listOf(publication))
        assertTrue(state.canContinueConfirmation)
        assertFalse(state.canPublish)
        assertFalse(state.copy(intent = intent.copy(publicationId = null)).canContinueConfirmation)
        assertFalse(state.copy(history = listOf(publication.copy(state = "sending"))).canContinueConfirmation)
        assertFalse(state.copy(history = listOf(publication.copy(connectionId = PUBLICATION_ID))).canContinueConfirmation)
        assertFalse(state.copy(history = listOf(publication.copy(mediaId = "other-image"))).canContinueConfirmation)
        assertFalse(state.copy(history = listOf(publication.copy(binding = null))).canContinueConfirmation)
        assertFalse(state.copy(history = listOf(publication.copy(binding = connection.binding!!.copy(connectionRevision = 5L)))).canContinueConfirmation)
        assertFalse(state.copy(connection = connection.copy(connectionId = PUBLICATION_ID)).canContinueConfirmation)
        assertFalse(state.copy(connection = connection.copy(health = "reconnect_required")).canContinueConfirmation)
        assertFalse(state.copy(connection = connection.copy(state = "disconnected")).canContinueConfirmation)
        assertFalse(state.copy(connection = connection.copy(accountType = "personal")).canContinueConfirmation)
        assertFalse(state.copy(busy = true).canContinueConfirmation)
        assertFalse(state.copy(storageAvailable = false).canContinueConfirmation)
        assertFalse(state.copy(availability = InstagramAvailability.UNAVAILABLE).canContinueConfirmation)
        assertTrue(state.copy(connection = connection.copy(username = "@renamed_account")).canContinueConfirmation)
        assertTrue(state.copy(connection = connection.copy(accountType = "creator")).canContinueConfirmation)
        assertFalse(state.copy(connection = connection.copy(externalId = "987654321000000")).canContinueConfirmation)
        assertFalse(state.copy(connection = connection.copy(connectionRevision = 5L)).canContinueConfirmation)
        assertFalse(state.copy(intent = intent.copy(boundExternalId = null, expectedConnectionRevision = null)).canContinueConfirmation)
        // The backend's pending history can be relabelled with the current account after reconnect.
        assertFalse(state.copy(connection = connection.copy(username = "@another_account", externalId = "987654321000000"),
            history = listOf(publication.copy(username = "@another_account"))).canContinueConfirmation)
    }

    companion object {
        const val CONNECTION_ID = "11111111-1111-4111-8111-111111111111"
        const val PUBLICATION_ID = "22222222-2222-4222-8222-222222222222"
        val MEDIA_ID = "reviewer-jpeg:" + "a".repeat(64)
    }
}
