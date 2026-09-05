package br.com.ia4tube.app.feature.instagram

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class InstagramIntentPolicyTest {
    private val connectionId = InstagramUiStateTest.CONNECTION_ID
    private val mediaId = InstagramUiStateTest.MEDIA_ID
    private val publicationId = InstagramUiStateTest.PUBLICATION_ID
    private fun publication() = InstagramPublication(
        publicationId = publicationId, connectionId = connectionId, state = "published",
        mediaId = mediaId, caption = "Legenda definitiva", username = "@empresa", accountType = "business",
        providerMediaId = "123456789", permalink = "https://www.instagram.com/p/ABCDE12345/",
        publishedAt = "2026-09-05T12:00:00Z", createdAt = "2026-09-05T11:59:00Z", updatedAt = "2026-09-05T12:00:00Z"
    )

    @Test fun storagePartitionDependsOnOriginAndServerConnectionNotRawSessionToken() {
        val key = InstagramIntentPolicy.contextKey(InstagramPolicies.OFFICIAL_API_ORIGIN, connectionId)
        assertTrue(Regex("[0-9a-f]{64}").matches(key))
        assertFalse(key.contains(connectionId))
        assertEquals(key, InstagramIntentPolicy.contextKey(InstagramPolicies.OFFICIAL_API_ORIGIN + "/", connectionId))
        assertNotEquals(key, InstagramIntentPolicy.contextKey("https://other.example", connectionId))
        assertNotEquals(key, InstagramIntentPolicy.contextKey(InstagramPolicies.OFFICIAL_API_ORIGIN, publicationId))
    }

    @Test fun lostResponseIsNeverMatchedByMediaOrCaption() {
        val uncertain = InstagramIntentPolicy.create(mediaId, connectionId)
        assertNull(uncertain.publicationId)
        assertNull(InstagramIntentPolicy.observe(uncertain, publication()))
    }

    @Test fun onlyExactPublicationAndContextCanResolveIntent() {
        val intent = InstagramIntentPolicy.create(mediaId, connectionId).copy(publicationId = publicationId)
        assertNull(InstagramIntentPolicy.observe(intent, publication().copy(connectionId = publicationId)))
        assertNull(InstagramIntentPolicy.observe(intent, publication().copy(mediaId = "reviewer-jpeg:" + "b".repeat(64))))
        assertNull(InstagramIntentPolicy.observe(intent, publication().copy(publicationId = connectionId)))
    }

    @Test fun serverConfirmationKeepsOriginalIdempotencyKey() {
        val intent = InstagramIntentPolicy.create(mediaId, connectionId).copy(publicationId = publicationId)
        val resolved = InstagramIntentPolicy.observe(intent, publication())!!
        assertTrue(resolved.confirmed)
        assertEquals(intent.clientRequestId, resolved.clientRequestId)
    }

    @Test fun pendingOrUnconfirmedProviderResultDoesNotReleaseIntent() {
        val intent = InstagramIntentPolicy.create(mediaId, connectionId).copy(publicationId = publicationId)
        val pending = publication().copy(state = "sending", providerMediaId = null, permalink = null, publishedAt = null)
        assertTrue(pending.pending)
        assertFalse(InstagramIntentPolicy.observe(intent, pending)!!.confirmed)
        assertFalse(InstagramIntentPolicy.observe(intent, publication().copy(permalink = null))!!.confirmed)
    }

    @Test fun intentCapturesConfirmedAccountAndRejectsSameConnectionWithDifferentAccount() {
        val connection = InstagramConnection(connectionId, "connected", "healthy", "@empresa", "business")
        val intent = InstagramIntentPolicy.create(mediaId, connection)
        assertEquals("@empresa", intent.accountUsername)
        assertEquals("business", intent.accountType)
        assertTrue(InstagramIntentPolicy.matchesAccount(intent, connection))
        assertTrue(InstagramIntentPolicy.matchesAccount(intent, connection.copy(username = "@EMPRESA")))
        assertFalse(InstagramIntentPolicy.matchesAccount(intent, null))
        assertFalse(InstagramIntentPolicy.matchesAccount(intent, connection.copy(username = "@other_account")))
        assertFalse(InstagramIntentPolicy.matchesAccount(intent, connection.copy(accountType = "creator")))
        assertFalse(InstagramIntentPolicy.matchesAccount(intent, connection.copy(connectionId = publicationId)))
        assertFalse(InstagramIntentPolicy.matchesAccount(InstagramIntentPolicy.create(mediaId, connectionId), connection))
    }

    @Test fun boundIntentSurvivesRestartAndConfirmationWithoutChangingItsAccount() {
        val connection = InstagramConnection(connectionId, "connected", "healthy", "@empresa", "business")
        val intent = InstagramIntentPolicy.create(mediaId, connection).copy(publicationId = publicationId)
        val encoded = InstagramIntentCodec.encode(intent)
        assertTrue(encoded.startsWith("2|"))
        val restored = InstagramIntentCodec.decode(encoded)
        assertEquals(intent, restored)
        val observed = InstagramIntentPolicy.observe(restored, publication())!!
        assertEquals(intent.accountUsername, observed.accountUsername)
        assertEquals(intent.accountType, observed.accountType)
        assertTrue(observed.confirmed)
    }

    @Test fun legacyIntentRemainsBlockedAndCannotAcquireAccountFromHistory() {
        val legacy = "1|44444444-4444-4444-8444-444444444444|$mediaId|$connectionId|$publicationId|0"
        val restored = InstagramIntentCodec.decode(legacy)
        assertNull(restored.accountUsername)
        assertNull(restored.accountType)
        assertFalse(InstagramIntentPolicy.hasAccountBinding(restored))
        val observed = InstagramIntentPolicy.observe(restored, publication())!!
        assertNull(observed.accountUsername)
        assertNull(observed.accountType)
        assertFalse(InstagramIntentPolicy.matchesAccount(observed,
            InstagramConnection(connectionId, "connected", "healthy", "@empresa", "business")))
    }

    @Test fun damagedOrPartialBindingsAreNotMistakenForEmptyLedger() {
        val connection = InstagramConnection(connectionId, "connected", "healthy", "@empresa", "business")
        val intent = InstagramIntentPolicy.create(mediaId, connection)
        assertThrows(IllegalArgumentException::class.java) { InstagramIntentCodec.decode("damaged") }
        assertThrows(IllegalArgumentException::class.java) { InstagramIntentCodec.encode(intent.copy(accountType = null)) }
        assertThrows(IllegalArgumentException::class.java) { InstagramIntentCodec.encode(intent.copy(accountUsername = "@x|injected")) }
        assertThrows(IllegalArgumentException::class.java) { InstagramIntentCodec.encode(intent.copy(accountType = "personal")) }
    }
}
