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
        publishedAt = "2026-09-05T12:00:00Z", createdAt = "2026-09-05T11:59:00Z", updatedAt = "2026-09-05T12:00:00Z",
        binding = InstagramConnectionBinding(connectionId, "123456789012345", 4L)
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
        val connection = InstagramConnection(connectionId, "connected", "healthy", "@empresa", "business", "123456789012345", 4L)
        val intent = InstagramIntentPolicy.create(mediaId, connection)
        assertEquals("@empresa", intent.accountUsername)
        assertEquals("business", intent.accountType)
        assertTrue(InstagramIntentPolicy.matchesAccount(intent, connection))
        assertTrue(InstagramIntentPolicy.matchesAccount(intent, connection.copy(username = "@EMPRESA")))
        assertFalse(InstagramIntentPolicy.matchesAccount(intent, null))
        assertTrue(InstagramIntentPolicy.matchesAccount(intent, connection.copy(username = "@renamed_account")))
        assertTrue(InstagramIntentPolicy.matchesAccount(intent, connection.copy(accountType = "creator")))
        assertFalse(InstagramIntentPolicy.matchesAccount(intent, connection.copy(externalId = "987654321000000")))
        assertFalse(InstagramIntentPolicy.matchesAccount(intent, connection.copy(connectionRevision = 5L)))
        assertFalse(InstagramIntentPolicy.matchesAccount(intent, connection.copy(connectionId = publicationId)))
        assertFalse(InstagramIntentPolicy.matchesAccount(InstagramIntentPolicy.create(mediaId, connectionId), connection))
    }

    @Test fun boundIntentSurvivesRestartAndConfirmationWithoutChangingItsAccount() {
        val connection = InstagramConnection(connectionId, "connected", "healthy", "@empresa", "business", "123456789012345", 4L)
        val intent = InstagramIntentPolicy.create(mediaId, connection).copy(publicationId = publicationId)
        val encoded = InstagramIntentCodec.encode(intent)
        assertTrue(encoded.startsWith("3|"))
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
            InstagramConnection(connectionId, "connected", "healthy", "@empresa", "business", "123456789012345", 4L)))
    }

    @Test fun damagedOrPartialBindingsAreNotMistakenForEmptyLedger() {
        val connection = InstagramConnection(connectionId, "connected", "healthy", "@empresa", "business", "123456789012345", 4L)
        val intent = InstagramIntentPolicy.create(mediaId, connection)
        assertThrows(IllegalArgumentException::class.java) { InstagramIntentCodec.decode("damaged") }
        assertThrows(IllegalArgumentException::class.java) { InstagramIntentCodec.encode(intent.copy(accountType = null)) }
        assertThrows(IllegalArgumentException::class.java) { InstagramIntentCodec.encode(intent.copy(accountUsername = "@x|injected")) }
        assertThrows(IllegalArgumentException::class.java) { InstagramIntentCodec.encode(intent.copy(accountType = "personal")) }
        assertThrows(IllegalArgumentException::class.java) { InstagramIntentCodec.encode(intent.copy(boundExternalId = null)) }
        assertThrows(IllegalArgumentException::class.java) { InstagramIntentCodec.encode(intent.copy(expectedConnectionRevision = 0L)) }
        assertThrows(IllegalArgumentException::class.java) { InstagramIntentCodec.encode(intent.copy(expectedConnectionRevision = 9007199254740992L)) }
        assertThrows(IllegalArgumentException::class.java) { InstagramIntentCodec.decode(InstagramIntentCodec.encode(intent).dropLast(1) + "4.0") }
    }

    @Test fun versionTwoRemainsReadableWithoutPromotingDisplayNameIntoIdentity() {
        val legacy = "2|44444444-4444-4444-8444-444444444444|$mediaId|$connectionId|$publicationId|0|@empresa|business"
        val restored = InstagramIntentCodec.decode(legacy)
        assertEquals("@empresa", restored.accountUsername)
        assertNull(restored.binding)
        assertEquals(restored, InstagramIntentCodec.decode(InstagramIntentCodec.encode(restored)))
        assertFalse(InstagramIntentPolicy.matchesAccount(restored,
            InstagramConnection(connectionId, "connected", "healthy", "@empresa", "business", "123456789012345", 4L)))
        assertNull(InstagramIntentPolicy.identify(restored, publication()))
    }

    @Test fun durableUpdatesCannotReplaceBindingOrOriginalIdentityAndConfirmationIsMonotonic() {
        val original = InstagramIntentPolicy.create(mediaId,
            InstagramConnection(connectionId, "connected", "healthy", "@empresa", "business", "123456789012345", 4L))
        val identified = InstagramIntentPolicy.identify(original, publication())!!
        assertTrue(InstagramIntentPolicy.canUpdate(original, identified))
        assertFalse(InstagramIntentPolicy.canUpdate(original, original.copy(boundExternalId = "987654321000000")))
        assertFalse(InstagramIntentPolicy.canUpdate(original, original.copy(expectedConnectionRevision = 5L)))
        assertFalse(InstagramIntentPolicy.canUpdate(original, original.copy(clientRequestId = publicationId)))
        assertFalse(InstagramIntentPolicy.canUpdate(original, original.copy(accountUsername = "@other")))
        assertFalse(InstagramIntentPolicy.canUpdate(identified, identified.copy(confirmed = false)))
        assertFalse(InstagramIntentPolicy.canUpdate(identified, identified.copy(publicationId = connectionId)))
    }

    @Test fun originalStableBindingMustMatchForLookupAndKnownPublicationObservation() {
        val original = InstagramIntentPolicy.create(mediaId,
            InstagramConnection(connectionId, "connected", "healthy", "@empresa", "business", "123456789012345", 4L))
        for (changed in listOf(null, publication().binding!!.copy(connectionRevision = 5L),
            publication().binding!!.copy(externalId = "987654321000000"))) {
            assertNull(InstagramIntentPolicy.identify(original, publication().copy(binding = changed)))
            assertNull(InstagramIntentPolicy.observe(original.copy(publicationId = publicationId), publication().copy(binding = changed)))
        }
        assertEquals(original.clientRequestId, InstagramIntentPolicy.identify(original, publication())!!.clientRequestId)
    }
}
