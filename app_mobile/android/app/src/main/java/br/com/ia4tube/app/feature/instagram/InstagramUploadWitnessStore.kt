package br.com.ia4tube.app.feature.instagram

import java.security.MessageDigest

enum class InstagramUploadPhase { PREPARED, IN_FLIGHT, CONFIRMED, REJECTED, UNKNOWN }

/** Private upload metadata only: no JPEG, caption, URL, session or credential. */
data class InstagramUploadWitness(
    val id: String,
    val contentFingerprint: String,
    val binding: InstagramConnectionBinding,
    val startedAtEpochMillis: Long,
    val phase: InstagramUploadPhase = InstagramUploadPhase.PREPARED,
    val mediaId: String? = null,
    val diagnostic: InstagramRequestDiagnostic? = null
)

interface InstagramUploadWitnessStore {
    /** Failure/corruption must throw, never look like an absent upload. */
    fun read(contextKey: String): InstagramUploadWitness?
    /** Exclusive synchronous durable creation, required before dispatch. */
    fun create(contextKey: String, witness: InstagramUploadWitness): Boolean
    /** Keeps identity/content/account immutable and completion monotonic. */
    fun update(contextKey: String, witness: InstagramUploadWitness): Boolean
    /** Only a resolved upload with this exact local ID may be removed. */
    fun clearResolved(contextKey: String, id: String): Boolean
}

private const val UPLOAD_RECORD_UNAVAILABLE = "Upload attempt record unavailable"

object InstagramUploadWitnessPolicy {
    private val fingerprint = Regex("^[0-9a-f]{64}$")
    private val media = Regex("^reviewer-jpeg:[0-9a-f]{64}$")

    fun valid(value: InstagramUploadWitness): Boolean =
        InstagramPolicies.validUuid(value.id) && fingerprint.matches(value.contentFingerprint) &&
            value.binding.valid && value.startedAtEpochMillis > 0 &&
            (value.diagnostic == null || InstagramRequestDiagnostic.isAllowedCode(value.diagnostic.code)) &&
            when (value.phase) {
                InstagramUploadPhase.PREPARED -> value.mediaId == null && value.diagnostic == null
                InstagramUploadPhase.REJECTED -> value.mediaId == null &&
                    (value.diagnostic == null || localRejection(value.diagnostic) || httpRejection(value.diagnostic))
                InstagramUploadPhase.CONFIRMED -> value.mediaId?.let(media::matches) == true &&
                    (value.diagnostic == null || (value.diagnostic.requestStarted &&
                        value.diagnostic.responseReceived && !value.diagnostic.outcomeUnknown &&
                        value.diagnostic.stage == InstagramRequestStage.HTTP_RESPONSE &&
                        value.diagnostic.httpStatus?.let { it in 200..299 } == true))
                else -> value.mediaId == null
            }

    fun isResolved(value: InstagramUploadWitness): Boolean =
        value.phase in setOf(InstagramUploadPhase.CONFIRMED, InstagramUploadPhase.REJECTED)

    fun canUpdate(previous: InstagramUploadWitness, next: InstagramUploadWitness): Boolean {
        if (!valid(previous) || !valid(next) || previous.id != next.id ||
            previous.contentFingerprint != next.contentFingerprint || previous.binding != next.binding ||
            previous.startedAtEpochMillis != next.startedAtEpochMillis) return false
        if (previous == next) return true
        // A late callback cannot erase or replace a terminal result, resource or diagnostic.
        if (isResolved(previous)) return false
        if (previous.diagnostic != null && next.diagnostic == null) return false
        if (previous.diagnostic?.responseReceived == true && next.diagnostic?.responseReceived != true) return false
        if (previous.diagnostic?.httpStatus != null && previous.diagnostic.httpStatus != next.diagnostic?.httpStatus) return false
        val localRejection = localRejection(next.diagnostic)
        val httpRejection = httpRejection(next.diagnostic)
        return when (previous.phase) {
            InstagramUploadPhase.PREPARED -> when (next.phase) {
                InstagramUploadPhase.IN_FLIGHT, InstagramUploadPhase.UNKNOWN -> true
                InstagramUploadPhase.REJECTED -> next.diagnostic == null || localRejection
                else -> false
            }
            InstagramUploadPhase.IN_FLIGHT -> when (next.phase) {
                InstagramUploadPhase.IN_FLIGHT, InstagramUploadPhase.UNKNOWN, InstagramUploadPhase.CONFIRMED -> true
                InstagramUploadPhase.REJECTED -> localRejection || httpRejection
                else -> false
            }
            InstagramUploadPhase.UNKNOWN -> when (next.phase) {
                InstagramUploadPhase.UNKNOWN, InstagramUploadPhase.CONFIRMED -> true
                InstagramUploadPhase.REJECTED -> httpRejection
                else -> false
            }
            else -> false
        }
    }

    private fun localRejection(value: InstagramRequestDiagnostic?): Boolean = value?.let {
        it.stage == InstagramRequestStage.LOCAL_VALIDATION && !it.requestStarted &&
            !it.responseReceived && !it.outcomeUnknown && it.httpStatus == null
    } == true

    private fun httpRejection(value: InstagramRequestDiagnostic?): Boolean = value?.let {
        it.stage == InstagramRequestStage.HTTP_RESPONSE && it.requestStarted && it.responseReceived &&
            !it.outcomeUnknown && it.httpStatus?.let { status -> status in 400..499 } == true
    } == true
}

/** Context binding and checksum detect misplaced/damaged records, not malicious app-private rewrites. */
object InstagramUploadWitnessCodec {
    fun encode(contextKey: String, value: InstagramUploadWitness): String {
        require(validContext(contextKey) && InstagramUploadWitnessPolicy.valid(value)) { UPLOAD_RECORD_UNAVAILABLE }
        val diagnostic = value.diagnostic
        val fields = mutableListOf("1", contextKey, value.id, value.contentFingerprint,
            value.binding.connectionId, value.binding.externalId, value.binding.connectionRevision.toString(),
            value.startedAtEpochMillis.toString(), value.phase.name, value.mediaId.orEmpty(),
            if (diagnostic == null) "0" else "1")
        fields += if (diagnostic == null) List(8) { "" } else listOf(
            bit(diagnostic.requestStarted), bit(diagnostic.responseReceived), diagnostic.httpStatus?.toString().orEmpty(),
            diagnostic.code, diagnostic.stage.name, diagnostic.startedAtEpochMillis.toString(),
            diagnostic.durationMillis.toString(), bit(diagnostic.outcomeUnknown))
        val body = fields.joinToString("|")
        return "$body|${checksum(body)}"
    }

    fun decode(contextKey: String, encoded: String): InstagramUploadWitness = try {
        require(validContext(contextKey) && encoded.length in 1..1200)
        val fields = encoded.split('|')
        require(fields.size == 20 && fields[0] == "1" && fields[1] == contextKey)
        require(fields[19] == checksum(fields.take(19).joinToString("|")))
        val diagnostic = when (fields[10]) {
            "0" -> { require(fields.subList(11, 19).all(String::isEmpty)); null }
            "1" -> InstagramRequestDiagnostic(boolean(fields[11]), boolean(fields[12]),
                fields[13].ifEmpty { null }?.toInt(), fields[14], InstagramRequestStage.valueOf(fields[15]),
                fields[16].toLong(), fields[17].toLong(), boolean(fields[18]))
            else -> throw IllegalArgumentException()
        }
        val result = InstagramUploadWitness(fields[2], fields[3],
            InstagramConnectionBinding(fields[4], fields[5], fields[6].toLong()), fields[7].toLong(),
            InstagramUploadPhase.valueOf(fields[8]), fields[9].ifEmpty { null }, diagnostic)
        require(encode(contextKey, result) == encoded)
        result
    } catch (_: Exception) {
        throw IllegalArgumentException(UPLOAD_RECORD_UNAVAILABLE)
    }

    internal fun validContext(value: String): Boolean = Regex("^[0-9a-f]{64}$").matches(value)
    private fun bit(value: Boolean): String = if (value) "1" else "0"
    private fun boolean(value: String): Boolean = when (value) {
        "1" -> true
        "0" -> false
        else -> throw IllegalArgumentException()
    }
    private fun checksum(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 0xff) }
}

/** Shared across Android instances, so a failed disk commit cannot be hidden by VM recreation. */
internal class InstagramUploadStorageGuard(val lock: Any = Any()) {
    var failed = false
}

internal class EncodedInstagramUploadWitnessStore(
    private val readValue: (String) -> String?,
    private val writeValue: (String, String?) -> Boolean,
    private val guard: InstagramUploadStorageGuard = InstagramUploadStorageGuard()
) : InstagramUploadWitnessStore {
    private fun key(contextKey: String): String {
        check(InstagramUploadWitnessCodec.validContext(contextKey)) { UPLOAD_RECORD_UNAVAILABLE }
        return "upload.$contextKey"
    }

    private fun saved(contextKey: String): InstagramUploadWitness? =
        readValue(key(contextKey))?.let { InstagramUploadWitnessCodec.decode(contextKey, it) }

    private fun persist(storageKey: String, value: String?): Boolean {
        val committed = writeValue(storageKey, value)
        // SharedPreferences may already have changed its memory cache when commit returns false.
        if (!committed) guard.failed = true
        return committed
    }

    private fun <T> guarded(operation: () -> T): T = synchronized(guard.lock) {
        try {
            check(!guard.failed) { UPLOAD_RECORD_UNAVAILABLE }
            operation()
        } catch (_: Exception) {
            guard.failed = true
            throw IllegalStateException(UPLOAD_RECORD_UNAVAILABLE)
        }
    }

    override fun read(contextKey: String): InstagramUploadWitness? = guarded { saved(contextKey) }

    override fun create(contextKey: String, witness: InstagramUploadWitness): Boolean = guarded {
        val storageKey = key(contextKey)
        val encoded = InstagramUploadWitnessCodec.encode(contextKey, witness)
        check(witness.phase == InstagramUploadPhase.PREPARED) { UPLOAD_RECORD_UNAVAILABLE }
        if (saved(contextKey) != null) false else persist(storageKey, encoded)
    }

    override fun update(contextKey: String, witness: InstagramUploadWitness): Boolean = guarded {
        val previous = saved(contextKey)
        if (previous == null || !InstagramUploadWitnessPolicy.canUpdate(previous, witness)) false
        else if (previous == witness) true
        else persist(key(contextKey), InstagramUploadWitnessCodec.encode(contextKey, witness))
    }

    override fun clearResolved(contextKey: String, id: String): Boolean = guarded {
        check(InstagramPolicies.validUuid(id)) { UPLOAD_RECORD_UNAVAILABLE }
        val previous = saved(contextKey)
        if (previous == null || previous.id != id || !InstagramUploadWitnessPolicy.isResolved(previous)) false
        else persist(key(contextKey), null)
    }
}

/** Explicit test dependency only; production must receive AndroidInstagramUploadWitnessStore. */
internal fun inMemoryUploadWitnessStore(): InstagramUploadWitnessStore {
    val values = mutableMapOf<String, String>()
    return EncodedInstagramUploadWitnessStore({ values[it] }, { key, value ->
        if (value == null) values.remove(key) else values[key] = value
        true
    })
}
