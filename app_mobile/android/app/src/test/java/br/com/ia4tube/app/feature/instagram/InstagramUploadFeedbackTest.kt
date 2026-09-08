package br.com.ia4tube.app.feature.instagram

import org.junit.Assert.*
import org.junit.Test

class InstagramUploadFeedbackTest {
    private val connection = InstagramConnection("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "connected", "healthy", "fixture", "business", "123456789012345", 1)
    private val media = InstagramMedia("reviewer-jpeg:" + "a".repeat(64), "Legenda", 1080, 1080)
    private val witness = InstagramUploadWitness("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "b".repeat(64), connection.binding!!, 1, InstagramUploadPhase.CONFIRMED, media.id)
    private fun ready() = InstagramUiState(availability = InstagramAvailability.AVAILABLE,
        connection = connection, operationalAvailability = InstagramOperationalAvailability(false, true),
        draftJpeg = InstagramPoliciesTest.jpegEnvelope(), draftCaption = "Legenda", media = listOf(media),
        selectedMediaId = media.id, historyLoaded = true, freshPublicationAvailable = true,
        uploadWitness = witness, uploadDraftMatches = true, uploadFeedback = "Resultado anterior preservado.")

    @Test fun fingerprintsBindExactBytesAndExactCaptionWithoutChangingInputs() {
        val jpeg = InstagramPoliciesTest.jpegEnvelope()
        val copy = jpeg.copyOf()
        val first = instagramUploadFingerprint(jpeg, "Legenda")
        assertEquals(first, instagramUploadFingerprint(copy, "Legenda"))
        assertNotEquals(first, instagramUploadFingerprint(copy, "Legenda "))
        copy[8] = (copy[8].toInt() xor 1).toByte()
        assertNotEquals(first, instagramUploadFingerprint(copy, "Legenda"))
        assertArrayEquals(InstagramPoliciesTest.jpegEnvelope(), jpeg)
        assertTrue(Regex("[0-9a-f]{64}").matches(first))
    }

    @Test fun currentDisabledReasonAndPreviousResultAreBothPresented() {
        val state = ready().copy(operationalAvailability = InstagramOperationalAvailability(false, false))
        assertEquals(InstagramError.UNAVAILABLE.message, state.uploadMessages.first())
        assertTrue(state.uploadMessages.contains("Resultado anterior preservado."))
        assertFalse(state.canUpload)
        assertFalse(state.canPublish)
        assertEquals(1, state.copy(uploadFeedback = state.uploadBlockReason).uploadMessages.size)
    }

    @Test fun unchangedConfirmedContentCannotBeUploadedTwiceButExplicitPublishIsStillSeparate() {
        assertFalse(ready().canUpload)
        assertTrue(ready().canPublish)
        assertNull(ready().intent)
        assertFalse(ready().confirmationOpen)
    }

    @Test fun unknownOrInflightAttemptNeverAllowsBlindUploadOrPublish() {
        listOf(InstagramUploadPhase.PREPARED, InstagramUploadPhase.IN_FLIGHT, InstagramUploadPhase.UNKNOWN).forEach {
            val state = ready().copy(uploadWitness = witness.copy(phase = it, mediaId = null))
            assertFalse(state.canUpload)
            assertFalse(state.canPublish)
            assertNotNull(state.uploadBlockReason)
        }
    }

    @Test fun changedContentOrBindingDoesNotInheritThePreviousPublicationPermission() {
        assertFalse(ready().copy(uploadDraftMatches = false, selectedMediaId = null).canPublish)
        val changedAccount = ready().copy(connection = connection.copy(connectionRevision = 2))
        assertFalse(changedAccount.canUpload)
        assertFalse(changedAccount.canPublish)
        assertTrue(changedAccount.uploadBlockReason!!.contains("conta vinculada"))
    }

    @Test fun invalidCaptionIsExplainedWithoutTrimmingTheApprovedText() {
        val state = ready().copy(draftCaption = " Legenda ", uploadDraftMatches = false)
        assertFalse(state.canUpload)
        assertTrue(state.uploadMessages.first().contains("legenda"))
        assertEquals(" Legenda ", state.draftCaption)
        assertEquals(witness, state.uploadWitness)
    }

    @Test fun unavailableDurableStoreFailsClosedWithoutDeletingEvidence() {
        val state = ready().copy(uploadStorageAvailable = false)
        assertFalse(state.canUpload)
        assertFalse(state.canPublish)
        assertEquals(witness, state.uploadWitness)
        assertTrue(state.uploadMessages.first().contains("registro local"))
    }
}
