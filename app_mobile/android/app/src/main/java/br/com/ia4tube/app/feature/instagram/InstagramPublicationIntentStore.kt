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
    val accountType: String? = null,
    val boundExternalId: String? = null,
    val expectedConnectionRevision: Long? = null
) {
    val binding: InstagramConnectionBinding? get() = if (boundExternalId != null && expectedConnectionRevision != null)
        InstagramConnectionBinding(connectionId, boundExternalId, expectedConnectionRevision).takeIf { it.valid } else null
}

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
            accountUsername = connection.username, accountType = connection.accountType,
            boundExternalId = connection.externalId, expectedConnectionRevision = connection.connectionRevision).also {
            require(hasAccountBinding(it))
        }
    }

    internal fun hasDisplayAccount(intent: InstagramPublicationIntent): Boolean =
        intent.accountUsername?.let { Regex("^@[a-zA-Z0-9._]{1,30}$").matches(it) } == true &&
            intent.accountType in setOf("business", "creator")

    fun hasAccountBinding(intent: InstagramPublicationIntent): Boolean = intent.binding != null

    /** Local gating uses the original stable identity; the server must enforce it atomically. */
    fun matchesAccount(intent: InstagramPublicationIntent, connection: InstagramConnection?): Boolean =
        connection != null && hasAccountBinding(intent) &&
            intent.binding == connection.binding

    fun canUpdate(previous: InstagramPublicationIntent, next: InstagramPublicationIntent): Boolean =
        previous.clientRequestId == next.clientRequestId && previous.mediaId == next.mediaId &&
            previous.connectionId == next.connectionId && previous.accountUsername == next.accountUsername &&
            previous.accountType == next.accountType && previous.boundExternalId == next.boundExternalId &&
            previous.expectedConnectionRevision == next.expectedConnectionRevision &&
            (previous.publicationId == null || previous.publicationId == next.publicationId) &&
            (!previous.confirmed || next.confirmed)

    /** Only a response from POST or lookup by the original clientRequestId may identify this intent. */
    fun identify(intent: InstagramPublicationIntent, publication: InstagramPublication): InstagramPublicationIntent? =
        if (hasAccountBinding(intent) && publication.binding == intent.binding &&
            publication.connectionId == intent.connectionId && publication.mediaId == intent.mediaId &&
            (intent.publicationId == null || intent.publicationId == publication.publicationId))
            intent.copy(publicationId = publication.publicationId, confirmed = publication.confirmed) else null

    /** A lost response cannot be identified by a coincidentally equal image or caption. */
    fun observe(intent: InstagramPublicationIntent, publication: InstagramPublication): InstagramPublicationIntent? {
        if (intent.publicationId == null || intent.publicationId != publication.publicationId ||
            intent.connectionId != publication.connectionId || intent.mediaId != publication.mediaId ||
            (hasAccountBinding(intent) && intent.binding != publication.binding)
        ) return null
        return intent.copy(confirmed = publication.confirmed)
    }
}

/** v1/v2 records remain readable, but missing stable identity/revision never authorize continuation. */
object InstagramIntentCodec {
    fun encode(intent: InstagramPublicationIntent): String {
        require(valid(intent)) { "Publication intent unavailable" }
        return listOf("3", intent.clientRequestId, intent.mediaId, intent.connectionId,
            intent.publicationId.orEmpty(), if (intent.confirmed) "1" else "0",
            intent.accountUsername.orEmpty(), intent.accountType.orEmpty(), intent.boundExternalId.orEmpty(),
            intent.expectedConnectionRevision?.toString().orEmpty()).joinToString("|")
    }

    fun decode(encoded: String): InstagramPublicationIntent {
        val fields = encoded.split('|')
        require((fields.size == 6 && fields[0] == "1") || (fields.size == 8 && fields[0] == "2") ||
            (fields.size == 10 && fields[0] == "3")) {
            "Publication intent unavailable"
        }
        require(fields[5] in setOf("0", "1")) { "Publication intent unavailable" }
        val revision = fields.getOrNull(9)?.ifBlank { null }?.let {
            require(Regex("^[1-9][0-9]{0,15}$").matches(it)) { "Publication intent unavailable" }
            it.toLongOrNull() ?: throw IllegalArgumentException("Publication intent unavailable")
        }
        val value = InstagramPublicationIntent(fields[1], fields[2], fields[3],
            fields[4].ifBlank { null }, fields[5] == "1",
            fields.getOrNull(6)?.ifBlank { null }, fields.getOrNull(7)?.ifBlank { null },
            fields.getOrNull(8)?.ifBlank { null }, revision)
        require(valid(value)) { "Publication intent unavailable" }
        return value
    }

    private fun valid(intent: InstagramPublicationIntent): Boolean =
        InstagramPolicies.validUuid(intent.clientRequestId) && InstagramPolicies.validUuid(intent.connectionId) &&
            InstagramPolicies.validMediaId(intent.mediaId) &&
            (intent.publicationId == null || InstagramPolicies.validUuid(intent.publicationId)) &&
            (!intent.confirmed || intent.publicationId != null) &&
            ((intent.accountUsername == null && intent.accountType == null) || InstagramIntentPolicy.hasDisplayAccount(intent)) &&
            ((intent.boundExternalId == null && intent.expectedConnectionRevision == null) || InstagramIntentPolicy.hasAccountBinding(intent))
}
