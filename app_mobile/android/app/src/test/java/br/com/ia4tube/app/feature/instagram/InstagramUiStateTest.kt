package br.com.ia4tube.app.feature.instagram

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InstagramUiStateTest {
    private val connection = InstagramConnection(CONNECTION_ID, "connected", "healthy", "@empresa", "business")
    private val media = InstagramMedia(MEDIA_ID, "Legenda confirmada no upload", 1080, 1080)
    private fun ready() = InstagramUiState(
        availability = InstagramAvailability.AVAILABLE,
        connection = connection,
        media = listOf(media),
        selectedMediaId = media.id,
        historyLoaded = true,
        freshPublicationAvailable = true
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
        assertFalse(ready().copy(selectedMediaId = "not-owned").canPublish)
    }

    @Test fun pendingAuthorizationCannotBeReopenedAsANewRequest() {
        val state = InstagramUiState(availability = InstagramAvailability.AVAILABLE)
        assertTrue(state.canAuthorize)
        assertFalse(state.copy(authorizationStatus = "authorization_pending").canAuthorize)
        assertFalse(state.copy(authorizationStatus = "authorization_processing").canAuthorize)
        assertTrue(state.copy(authorizationStatus = "authorization_cancelled").canAuthorize)
    }

    @Test fun serverPendingOrDisconnectingBlocksAuthorizationWithoutLocalStatus() {
        val state = InstagramUiState(availability = InstagramAvailability.AVAILABLE)
        assertFalse(state.copy(connection = connection.copy(state = "authorization_pending")).canAuthorize)
        assertFalse(state.copy(connection = connection.copy(state = "disconnecting")).canAuthorize)
        assertFalse(state.copy(connection = connection).canAuthorize)
        assertTrue(state.copy(connection = connection.copy(state = "disconnected", health = "disconnected")).canAuthorize)
        assertTrue(state.copy(connection = connection.copy(state = "failed", health = "failed")).canAuthorize)
        assertTrue(state.copy(connection = connection.copy(state = "reconnect_required", health = "reconnect_required")).canAuthorize)
        assertTrue(state.copy(connection = connection.copy(health = "reconnect_required")).canAuthorize)
    }

    @Test fun usernamesHaveExactlyOneAtSign() {
        assertEquals("@empresa", instagramUsernameLabel("@empresa"))
        assertEquals("@empresa", instagramUsernameLabel("empresa"))
        assertEquals("Conta não confirmada", instagramUsernameLabel(""))
    }

    @Test fun continuationRequiresIdentifiedMatchingProviderConfirmation() {
        val intent = InstagramIntentPolicy.create(MEDIA_ID, connection).copy(publicationId = PUBLICATION_ID)
        val publication = InstagramPublication(PUBLICATION_ID, CONNECTION_ID, "provider_confirming", MEDIA_ID,
            "Legenda", "@empresa", "business", null, null, null, "2026-09-05T12:00:00Z", "2026-09-05T12:00:00Z")
        val state = ready().copy(intent = intent, history = listOf(publication))
        assertTrue(state.canContinueConfirmation)
        assertFalse(state.canPublish)
        assertFalse(state.copy(intent = intent.copy(publicationId = null)).canContinueConfirmation)
        assertFalse(state.copy(history = listOf(publication.copy(state = "sending"))).canContinueConfirmation)
        assertFalse(state.copy(history = listOf(publication.copy(connectionId = PUBLICATION_ID))).canContinueConfirmation)
        assertFalse(state.copy(history = listOf(publication.copy(mediaId = "other-image"))).canContinueConfirmation)
        assertFalse(state.copy(connection = connection.copy(connectionId = PUBLICATION_ID)).canContinueConfirmation)
        assertFalse(state.copy(connection = connection.copy(health = "reconnect_required")).canContinueConfirmation)
        assertFalse(state.copy(connection = connection.copy(state = "disconnected")).canContinueConfirmation)
        assertFalse(state.copy(connection = connection.copy(accountType = "personal")).canContinueConfirmation)
        assertFalse(state.copy(busy = true).canContinueConfirmation)
        assertFalse(state.copy(storageAvailable = false).canContinueConfirmation)
        assertFalse(state.copy(availability = InstagramAvailability.UNAVAILABLE).canContinueConfirmation)
        assertFalse(state.copy(connection = connection.copy(username = "@another_account")).canContinueConfirmation)
        assertFalse(state.copy(connection = connection.copy(accountType = "creator")).canContinueConfirmation)
        assertFalse(state.copy(intent = intent.copy(accountUsername = null, accountType = null)).canContinueConfirmation)
        // The backend's pending history can be relabelled with the current account after reconnect.
        assertFalse(state.copy(connection = connection.copy(username = "@another_account"),
            history = listOf(publication.copy(username = "@another_account"))).canContinueConfirmation)
    }

    companion object {
        const val CONNECTION_ID = "11111111-1111-4111-8111-111111111111"
        const val PUBLICATION_ID = "22222222-2222-4222-8222-222222222222"
        val MEDIA_ID = "reviewer-jpeg:" + "a".repeat(64)
    }
}
