package br.com.ia4tube.app.feature.instagram

import java.time.Instant

/** Local attempt metadata only. Never contains an authorization URL, state, code or token. */
data class InstagramAuthorizationWitness(
    val id: String,
    val purpose: String,
    val previousConnectionId: String? = null,
    val previousExpiresAt: String? = null,
    val connectionId: String? = null,
    val expiresAt: String? = null
) {
    val identified: Boolean get() = connectionId != null && expiresAt != null

    /** Observation matching does not imply completion or permission to start another attempt. */
    fun matches(status: InstagramAuthorizationStatus): Boolean =
        InstagramAuthorizationWitnessPolicy.matches(this, status)
}

interface InstagramAuthorizationWitnessStore {
    /** Corruption/read failure must throw, never appear to be an absent attempt. */
    fun read(contextKey: String): InstagramAuthorizationWitness?
    /** Must complete synchronously and durably before the caller issues the one POST. */
    fun create(contextKey: String, witness: InstagramAuthorizationWitness): Boolean
    /** Only identifies the same attempt; immutable baseline and identified values cannot change. */
    fun update(contextKey: String, witness: InstagramAuthorizationWitness): Boolean
    /** Caller must first establish the terminal result; removal is compare-and-set by local ID. */
    fun clear(contextKey: String, id: String): Boolean
}

object InstagramAuthorizationWitnessPolicy {
    private val purposes = setOf("connect", "reconnect")
    private val statuses = setOf("authorization_pending", "authorization_processing", "authorization_completed",
        "authorization_cancelled", "authorization_expired", "authorization_failed")

    fun valid(value: InstagramAuthorizationWitness): Boolean =
        InstagramPolicies.validUuid(value.id) && value.purpose in purposes &&
            (value.previousConnectionId == null || InstagramPolicies.validUuid(value.previousConnectionId)) &&
            (value.purpose != "reconnect" || value.previousConnectionId != null) &&
            (value.previousExpiresAt == null ||
                (value.previousConnectionId != null && validDate(value.previousExpiresAt))) &&
            ((value.connectionId == null && value.expiresAt == null) ||
                (value.connectionId != null && InstagramPolicies.validUuid(value.connectionId) &&
                    value.expiresAt != null && validDate(value.expiresAt)))

    fun canUpdate(previous: InstagramAuthorizationWitness, next: InstagramAuthorizationWitness): Boolean =
        valid(previous) && valid(next) && previous.id == next.id && previous.purpose == next.purpose &&
            previous.previousConnectionId == next.previousConnectionId &&
            previous.previousExpiresAt == next.previousExpiresAt && next.identified &&
            (!previous.identified || previous == next)

    fun matches(witness: InstagramAuthorizationWitness, status: InstagramAuthorizationStatus): Boolean {
        if (!valid(witness) || status.purpose != witness.purpose || status.status !in statuses ||
            !InstagramPolicies.validUuid(status.connectionId) || !validDate(status.expiresAt)) return false
        if (witness.identified) {
            return witness.connectionId == status.connectionId && witness.expiresAt == status.expiresAt
        }
        if (status.connectionId != witness.previousConnectionId) return true
        val previousExpiry = witness.previousExpiresAt ?: return false
        // The previous terminal response is not evidence about a later lost POST on the same connection.
        return Instant.parse(status.expiresAt).isAfter(Instant.parse(previousExpiry))
    }

    private fun validDate(value: String?): Boolean = try {
        value != null && value.length in 20..40 && value == value.trim() &&
            !value.contains('|') && Instant.parse(value).let { true }
    } catch (_: Exception) { false }
}

object InstagramAuthorizationWitnessCodec {
    fun encode(value: InstagramAuthorizationWitness): String {
        require(InstagramAuthorizationWitnessPolicy.valid(value)) { "OAuth attempt record unavailable" }
        return listOf("1", value.id, value.purpose, value.previousConnectionId.orEmpty(),
            value.previousExpiresAt.orEmpty(), value.connectionId.orEmpty(), value.expiresAt.orEmpty()).joinToString("|")
    }

    fun decode(encoded: String): InstagramAuthorizationWitness {
        require(encoded.length in 1..512) { "OAuth attempt record unavailable" }
        val fields = encoded.split('|')
        require(fields.size == 7 && fields[0] == "1") { "OAuth attempt record unavailable" }
        return InstagramAuthorizationWitness(fields[1], fields[2], fields[3].ifEmpty { null },
            fields[4].ifEmpty { null }, fields[5].ifEmpty { null }, fields[6].ifEmpty { null }).also {
            require(InstagramAuthorizationWitnessPolicy.valid(it)) { "OAuth attempt record unavailable" }
        }
    }
}

/** Small shared implementation so the actual CAS/error rules are testable without Android. */
internal class EncodedInstagramAuthorizationWitnessStore(
    private val readValue: (String) -> String?,
    private val writeValue: (String, String?) -> Boolean,
    private val lock: Any = Any()
) : InstagramAuthorizationWitnessStore {
    private var storageFailed = false

    private fun key(contextKey: String): String {
        check(Regex("^[0-9a-f]{64}$").matches(contextKey)) { "OAuth attempt record unavailable" }
        return "attempt.$contextKey"
    }

    private fun saved(storageKey: String): InstagramAuthorizationWitness? =
        readValue(storageKey)?.let(InstagramAuthorizationWitnessCodec::decode)

    private fun persist(storageKey: String, value: String?): Boolean {
        val committed = writeValue(storageKey, value)
        // SharedPreferences may change its memory cache even if disk commit fails. Do not trust it again.
        if (!committed) storageFailed = true
        return committed
    }

    private fun <T> guarded(operation: () -> T): T = synchronized(lock) {
        try {
            check(!storageFailed) { "OAuth attempt record unavailable" }
            operation()
        } catch (_: Exception) {
            storageFailed = true
            throw IllegalStateException("OAuth attempt record unavailable")
        }
    }

    override fun read(contextKey: String): InstagramAuthorizationWitness? = guarded { saved(key(contextKey)) }

    override fun create(contextKey: String, witness: InstagramAuthorizationWitness): Boolean = guarded {
        val storageKey = key(contextKey)
        val encoded = InstagramAuthorizationWitnessCodec.encode(witness)
        check(!witness.identified) { "OAuth attempt record unavailable" }
        if (saved(storageKey) != null) false else persist(storageKey, encoded)
    }

    override fun update(contextKey: String, witness: InstagramAuthorizationWitness): Boolean = guarded {
        val storageKey = key(contextKey)
        val previous = saved(storageKey)
        if (previous == null || !InstagramAuthorizationWitnessPolicy.canUpdate(previous, witness)) false
        else if (previous == witness) true
        else persist(storageKey, InstagramAuthorizationWitnessCodec.encode(witness))
    }

    override fun clear(contextKey: String, id: String): Boolean = guarded {
        val storageKey = key(contextKey)
        check(InstagramPolicies.validUuid(id)) { "OAuth attempt record unavailable" }
        if (saved(storageKey)?.id != id) false else persist(storageKey, null)
    }
}
