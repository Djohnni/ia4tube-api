package br.com.ia4tube.app.feature.instagram

import java.security.MessageDigest
import java.util.UUID

/** Stores intent identifiers and the account shown at confirmation; never images, captions or tokens. */
data class InstagramPublicationIntent(
    val clientRequestId: String,
    val mediaId: String,
    val connectionId: String,
    val publicationId: String? = null,
    val confirmed: Boolean = false,
    val accountUsername: String? = null,
    val accountType: String? = null
)

interface InstagramPublicationIntentStore {
    /** A damaged record must throw, never be mistaken for an empty ledger. */
    fun read(contextKey: String): InstagramPublicationIntent?
    fun create(contextKey: String, intent: InstagramPublicationIntent): Boolean
    fun update(contextKey: String, intent: InstagramPublicationIntent): Boolean
    fun removeConfirmed(contextKey: String, clientRequestId: String): Boolean
}

object InstagramIntentPolicy {
    fun contextKey(apiOrigin: String, connectionId: String): String = MessageDigest
        .getInstance("SHA-256")
        .digest("instagram-publication-v1\n${apiOrigin.trimEnd('/')}\n$connectionId".toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    fun create(mediaId: String, connectionId: String): InstagramPublicationIntent =
        InstagramPublicationIntent(UUID.randomUUID().toString(), mediaId, connectionId)

    fun create(mediaId: String, connection: InstagramConnection): InstagramPublicationIntent {
        require(connection.canPublish && InstagramPolicies.validUuid(connection.connectionId))
        require(InstagramPolicies.validMediaId(mediaId))
        return InstagramPublicationIntent(UUID.randomUUID().toString(), mediaId, connection.connectionId,
            accountUsername = connection.username, accountType = connection.accountType).also {
            require(hasAccountBinding(it))
        }
    }

    fun hasAccountBinding(intent: InstagramPublicationIntent): Boolean =
        intent.accountUsername?.let { Regex("^@[a-zA-Z0-9._]{1,30}$").matches(it) } == true &&
            intent.accountType in setOf("business", "creator")

    /**
     * Conservative local check only: usernames are mutable, not stable account identifiers.
     * Production activation still requires a server-side expected stable account/revision check
     * performed atomically with publication. Pending history can reflect a reconnected account.
     */
    fun matchesAccount(intent: InstagramPublicationIntent, connection: InstagramConnection?): Boolean =
        connection != null && hasAccountBinding(intent) &&
            intent.connectionId.equals(connection.connectionId, ignoreCase = true) &&
            intent.accountUsername.equals(connection.username, ignoreCase = true) &&
            intent.accountType == connection.accountType

    /** A lost response cannot be identified by a coincidentally equal image or caption. */
    fun observe(intent: InstagramPublicationIntent, publication: InstagramPublication): InstagramPublicationIntent? {
        if (intent.publicationId == null || intent.publicationId != publication.publicationId ||
            intent.connectionId != publication.connectionId || intent.mediaId != publication.mediaId
        ) return null
        return intent.copy(confirmed = publication.confirmed)
    }
}

/** v1 records remain readable but have no account binding and can never authorize continuation. */
object InstagramIntentCodec {
    fun encode(intent: InstagramPublicationIntent): String {
        require(valid(intent)) { "Publication intent unavailable" }
        return listOf("2", intent.clientRequestId, intent.mediaId, intent.connectionId,
            intent.publicationId.orEmpty(), if (intent.confirmed) "1" else "0",
            intent.accountUsername.orEmpty(), intent.accountType.orEmpty()).joinToString("|")
    }

    fun decode(encoded: String): InstagramPublicationIntent {
        val fields = encoded.split('|')
        require((fields.size == 6 && fields[0] == "1") || (fields.size == 8 && fields[0] == "2")) {
            "Publication intent unavailable"
        }
        require(fields[5] in setOf("0", "1")) { "Publication intent unavailable" }
        val value = InstagramPublicationIntent(fields[1], fields[2], fields[3],
            fields[4].ifBlank { null }, fields[5] == "1",
            fields.getOrNull(6)?.ifBlank { null }, fields.getOrNull(7)?.ifBlank { null })
        require(valid(value)) { "Publication intent unavailable" }
        return value
    }

    private fun valid(intent: InstagramPublicationIntent): Boolean =
        InstagramPolicies.validUuid(intent.clientRequestId) && InstagramPolicies.validUuid(intent.connectionId) &&
            InstagramPolicies.validMediaId(intent.mediaId) &&
            (intent.publicationId == null || InstagramPolicies.validUuid(intent.publicationId)) &&
            (!intent.confirmed || intent.publicationId != null) &&
            ((intent.accountUsername == null && intent.accountType == null) || InstagramIntentPolicy.hasAccountBinding(intent))
}
