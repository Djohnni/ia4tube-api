package br.com.ia4tube.app.feature.instagram

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class InstagramJpegSelectionUiStateTest {
    private val connection = InstagramConnection(
        CONNECTION_ID, "connected", "healthy", "@empresa", "business", "123456789012345", 4L
    )
    private val media = InstagramMedia(MEDIA_ID, "Legenda sintética já revisada", 1080, 1080)

    private fun ready() = InstagramUiState(
        availability = InstagramAvailability.AVAILABLE,
        authorizationChecked = true,
        operationalAvailability = InstagramOperationalAvailability(true, true),
        connection = connection,
        media = listOf(media),
        selectedMediaId = media.id,
        uploadDraftMatches = true,
        uploadWitness = InstagramUploadWitness("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "b".repeat(64),
            connection.binding!!, 1, InstagramUploadPhase.CONFIRMED, media.id),
        historyLoaded = true,
        freshPublicationAvailable = true,
        draftJpeg = InstagramPoliciesTest.jpegEnvelope(),
        draftCaption = "Legenda sintética local"
    )

    private fun unuploaded(state: InstagramUiState) = state.copy(
        uploadWitness = null, uploadDraftMatches = false, selectedMediaId = null)

    @Test fun pendingSelectionBlocksOldDraftAndServerMediaWithoutBlockingLocalEditing() {
        val original = ready()
        assertTrue(original.canEditDraft)
        assertFalse("Confirmed content must not be uploaded twice", original.canUpload)
        assertTrue(unuploaded(original).canUpload)
        assertTrue(original.canPublish)

        val pending = original.copy(jpegSelectionPending = true, confirmationOpen = true)
        assertTrue("A pending selection must still allow local replacement or cancellation", pending.canEditDraft)
        assertFalse("The previous valid JPEG must not be uploaded during selection", pending.canUpload)
        assertFalse("Even an unuploaded draft must wait for selection", unuploaded(pending).canUpload)
        assertFalse("The previous reviewed media must not be published during selection", pending.canPublish)
        assertSame(original.draftJpeg, pending.draftJpeg)
        assertEquals(original.draftCaption, pending.draftCaption)
        assertEquals(original.selectedMedia, pending.selectedMedia)
    }

    @Test fun endingSelectionRestoresActionsOnlyForAnOtherwiseReadyState() {
        val pending = ready().copy(jpegSelectionPending = true)
        assertFalse(pending.canUpload)
        assertFalse(pending.canPublish)

        val completed = pending.copy(jpegSelectionPending = false)
        assertTrue(completed.canEditDraft)
        assertTrue(unuploaded(completed).canUpload)
        assertFalse(completed.canUpload)
        assertTrue(completed.canPublish)
    }

    @Test fun closedOrUnknownPublicationPermissionStillAllowsOnlyLocalEditing() {
        for (permission in listOf(
            null,
            InstagramOperationalAvailability(false, false),
            InstagramOperationalAvailability(true, false)
        )) {
            for (pending in listOf(false, true)) {
                val state = ready().copy(
                    operationalAvailability = permission,
                    jpegSelectionPending = pending
                )
                assertTrue(state.canEditDraft)
                assertFalse(state.canUpload)
                assertFalse(unuploaded(state).canUpload)
                assertFalse(state.canPublish)
            }
        }
    }

    @Test fun selectionFlagNeverBypassesBusyOrUnknownRuntimeAvailability() {
        for (pending in listOf(false, true)) {
            val state = ready().copy(jpegSelectionPending = pending)
            val blocked = listOf(
                state.copy(busy = true),
                state.copy(availability = InstagramAvailability.CHECKING),
                state.copy(availability = InstagramAvailability.UNAVAILABLE),
                state.copy(availability = InstagramAvailability.SESSION_REQUIRED)
            )
            for (candidate in blocked) {
                assertFalse(candidate.canEditDraft)
                assertFalse(candidate.canUpload)
                assertFalse(unuploaded(candidate).canUpload)
                assertFalse(candidate.canPublish)
            }
        }
    }

    @Test fun selectionFlagNeverBypassesAccountBindingOrExistingIntent() {
        val savedIntent = InstagramIntentPolicy.create(MEDIA_ID, connection)
        for (pending in listOf(false, true)) {
            val state = ready().copy(jpegSelectionPending = pending)
            val blocked = listOf(
                state.copy(connection = null),
                state.copy(connection = connection.copy(health = "reconnect_required")),
                state.copy(connection = connection.copy(externalId = null)),
                state.copy(connection = connection.copy(connectionRevision = null)),
                state.copy(storageAvailable = false),
                state.copy(intent = savedIntent),
                state.copy(intent = savedIntent.copy(confirmed = true))
            )
            for (candidate in blocked) {
                assertFalse(candidate.canEditDraft)
                assertFalse(candidate.canUpload)
                assertFalse(unuploaded(candidate).canUpload)
                assertFalse(candidate.canPublish)
            }
        }
    }

    @Test fun endingSelectionDoesNotReplaceCaptionMediaHistoryOrAuthorizationGuards() {
        val completed = ready().copy(jpegSelectionPending = true).copy(jpegSelectionPending = false)
        assertTrue(unuploaded(completed).canUpload)
        assertFalse(completed.canUpload)
        assertTrue(completed.canPublish)

        assertFalse(unuploaded(completed).copy(draftJpeg = null).canUpload)
        assertFalse(unuploaded(completed).copy(draftCaption = "   ").canUpload)
        assertFalse(completed.copy(selectedMediaId = null).canPublish)
        assertFalse(completed.copy(selectedMediaId = "not-owned").canPublish)
        assertFalse(completed.copy(historyLoaded = false).canPublish)
        assertFalse(completed.copy(freshPublicationAvailable = false).canPublish)
        assertFalse(completed.copy(authorizationUrlToOpen = "https://www.instagram.com/oauth/authorize").canPublish)
    }

    companion object {
        private const val CONNECTION_ID = "11111111-1111-4111-8111-111111111111"
        private val MEDIA_ID = "reviewer-jpeg:" + "a".repeat(64)
    }
}
