package br.com.ia4tube.app.feature.calendar.imports

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import kotlin.math.roundToLong

enum class ImportPreparationPhase(val wire: String) {
    AWAITING_SELECTION("awaiting_selection"), QUEUED("queued"), DISPATCHING("dispatching"), PROCESSING("processing"),
    RECONCILIATION("reconciliation"), READY("ready"), ATTENTION("attention")
}

data class ImportPreparationIntent(val idempotencyKey: String, val sourceRevision: Long, val expectedMediaRevision: Long,
                                   val acceptedMediaRevision: Long? = null, val jobId: String? = null)

data class ImportPreparedMetadata(val target: ImportTarget, val sha256: String, val sourceSha256: String, val mimeType: String,
                                  val width: Int, val height: Int, val sizeBytes: Long, val durationMs: Long?,
                                  val audioMode: ImportAudioMode, val hasAudio: Boolean, val musicSha256: String? = null) {
    val kind: ImportMediaKind get() = if (mimeType == "video/mp4") ImportMediaKind.VIDEO else ImportMediaKind.IMAGE
}

data class ImportPreparationRecord(val assetId: String, val uploadId: String, val mediaRevision: Long, val currentRevision: Long,
                                   val jobId: String?, val phase: ImportPreparationPhase, val kind: ImportMediaKind?,
                                   val configuration: ImportConfiguration?, val testOnly: Boolean, val previewDigest: String?,
                                   val variants: List<ImportPreparedMetadata>, val errorCode: String? = null) {
    override fun toString() = "ImportPreparationRecord(phase=$phase, mediaRevision=$mediaRevision, content=redacted)"
}

class ImportPrivatePreviewPart internal constructor(val target: String, val kind: ImportMediaKind, val mimeType: String,
    val sha256: String, val sourceSha256: String, val width: Int, val height: Int, val sizeBytes: Long,
    val durationMs: Long?, val audioMode: ImportAudioMode, val hasAudio: Boolean, internal val url: HttpUrl) {
    override fun toString() = "ImportPrivatePreviewPart(target=$target, content=redacted)"
}
data class ImportPrivatePreview(val assetId: String, val mediaRevision: Long, val currentRevision: Long,
                                val previewDigest: String, val testOnly: Boolean,
                                val variants: List<ImportPrivatePreviewPart>, val thumbnail: ImportPrivatePreviewPart?, val scheduleId: String? = null) {
    override fun toString() = "ImportPrivatePreview(mediaRevision=$mediaRevision, content=redacted)"
}

/** Exact counterpart of the server's policy.js selection/fingerprint, not a claim of music rights. */
internal object ImportPreparationProtocol {
    private val hashPattern = Regex("[a-f0-9]{64}")
    fun selection(kind: ImportMediaKind, configuration: ImportConfiguration): JSONObject {
        require(GalleryImportPolicy.validateConfiguration(kind, configuration,
            configuration.musicTrackId?.let { listOf(AuthorizedImportTrack(it, true)) }.orEmpty()) == null)
        return JSONObject().put("kind", kind.wire).put("targets", JSONArray(configuration.targets.sortedBy { it.ordinal }.map { it.wire }))
            .put("audioMode", configuration.audioMode.wire).put("musicTrackId", configuration.musicTrackId ?: JSONObject.NULL)
            .put("musicalTargets", JSONArray(configuration.musicalTargets.sortedBy { it.ordinal }.map { it.wire }))
            .put("shareToFeed", configuration.shareToFeed)
    }
    fun parseRecord(json: JSONObject): ImportPreparationRecord {
        val asset = GalleryImportHttpApi.uuid(json.getString("assetId")); val upload = GalleryImportHttpApi.uuid(json.getString("uploadId"))
        val revision = json.integer("mediaRevision", 0, 999999)
        val phase = ImportPreparationPhase.entries.single { it.wire == json.getString("state") }
        require(json.flag("ready") == (phase == ImportPreparationPhase.READY))
        if (phase == ImportPreparationPhase.AWAITING_SELECTION) {
            require(revision == 0L && json.isNull("previewDigest") && !json.has("selection") && !json.has("variants"))
            return ImportPreparationRecord(asset, upload, 0, 0, null, phase, null, null, false, null, emptyList())
        }
        require(revision > 0)
        val current = json.integer("currentRevision", revision, 999999)
        val job = GalleryImportHttpApi.uuid(json.getString("jobId"))
        val chosen = json.getJSONObject("selection")
        require(chosen.keys().asSequence().all { it in setOf("kind", "targets", "audioMode", "musicTrackId", "musicalTargets", "shareToFeed") })
        val kind = ImportMediaKind.entries.single { it.wire == chosen.getString("kind") }
        val configuration = ImportConfiguration(chosen.targets("targets"), ImportAudioMode.entries.single { it.wire == chosen.getString("audioMode") },
            chosen.optionalString("musicTrackId"), chosen.targets("musicalTargets"), chosen.flag("shareToFeed"))
        selection(kind, configuration)
        val testOnly = json.flag("testOnly")
        val raw = json.getJSONObject("variants")
        val variants = raw.keys().asSequence().toList().map { target ->
            val parsedTarget = ImportTarget.entries.single { it.wire == target }
            val part = raw.getJSONObject(target)
            val audio = ImportAudioMode.entries.single { it.wire == part.getString("audioMode") }
            val mime = part.getString("mimeType")
            val duration = part.optionalSeconds("durationSeconds")
            ImportPreparedMetadata(parsedTarget, part.hash("sha256"), part.hash("sourceSha256"), mime,
                part.integer("width", 1080, 1080).toInt(), part.integer("height", 1, 1920).toInt(),
                part.integer("size", 1, if (mime == "video/mp4") GalleryImportPolicy.VIDEO_MAX_BYTES else 8L * 1024 * 1024),
                duration, audio, part.flag("hasAudio"), part.optionalString("musicSha256")?.also { require(hashPattern.matches(it)) })
        }.sortedBy { it.target.ordinal }
        val digest = json.optionalString("previewDigest")?.also { require(hashPattern.matches(it)) }
        if (phase == ImportPreparationPhase.READY) {
            require(digest != null)
            validateVariants(kind, configuration, variants)
            require(fingerprint(kind, configuration, testOnly, variants) == digest)
        } else require(variants.isEmpty() && digest == null)
        return ImportPreparationRecord(asset, upload, revision, current, job, phase, kind, configuration, testOnly, digest,
            variants, json.optionalString("errorCode")?.also { require(it.matches(Regex("[a-z0-9_]{1,100}"))) })
    }
    fun validateVariants(kind: ImportMediaKind, configuration: ImportConfiguration, variants: List<ImportPreparedMetadata>) {
        val expected = GalleryImportPolicy.variants(kind, configuration)
        require(variants.size == expected.size && variants.map { it.target }.toSet() == configuration.targets)
        require(variants.map { it.sourceSha256 }.distinct().size == 1)
        variants.forEach { part ->
            val wanted = expected.single { it.target == part.target }
            require(part.kind == wanted.kind && part.mimeType == wanted.mimeType && part.audioMode == wanted.audioMode &&
                part.width == 1080 && part.height == if (part.target == ImportTarget.FEED) 1350 else 1920)
            require(when (part.audioMode) {
                ImportAudioMode.NONE, ImportAudioMode.MUTED -> !part.hasAudio && part.musicSha256 == null
                ImportAudioMode.MUSIC -> part.hasAudio && part.musicSha256 != null
                ImportAudioMode.ORIGINAL -> part.musicSha256 == null
            })
            require(when {
                part.kind == ImportMediaKind.IMAGE -> part.durationMs == null
                kind == ImportMediaKind.IMAGE -> part.durationMs != null && part.durationMs in 14_750..15_250
                else -> part.durationMs != null && part.durationMs in 1..GalleryImportPolicy.PREPARED_VIDEO_MAX_DURATION_MS
            })
        }
    }
    fun fingerprint(kind: ImportMediaKind, config: ImportConfiguration, testOnly: Boolean, variants: List<ImportPreparedMetadata>): String {
        require(variants.isNotEmpty())
        // JSONObject iteration order is not portable. Match JSON.stringify's explicit key order.
        val chosen = "{\"kind\":${quote(kind.wire)},\"targets\":${targetJson(config.targets)},\"audioMode\":${quote(config.audioMode.wire)}," +
            "\"musicTrackId\":${config.musicTrackId?.let(::quote) ?: "null"},\"musicalTargets\":${targetJson(config.musicalTargets)},\"shareToFeed\":${config.shareToFeed}}"
        val references = variants.sortedBy { it.target.ordinal }.joinToString(",", "[", "]") { part ->
            "{\"target\":${quote(part.target.wire)},\"sha256\":${quote(part.sha256)},\"mimeType\":${quote(part.mimeType)}," +
                "\"audioMode\":${quote(part.audioMode.wire)},\"shareToFeed\":${part.target == ImportTarget.REEL && config.shareToFeed}}"
        }
        val wire = "{\"schema\":1,\"sourceSha256\":${quote(variants.first().sourceSha256)},\"selection\":$chosen,\"testOnly\":$testOnly,\"variants\":$references}"
        return MessageDigest.getInstance("SHA-256").digest(wire.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
    fun parsePreview(json: JSONObject, record: ImportPreparationRecord, origin: HttpUrl): ImportPrivatePreview {
        require(record.phase == ImportPreparationPhase.READY && record.previewDigest != null && record.mediaRevision == record.currentRevision)
        require(json.getString("assetId") == record.assetId && json.integer("mediaRevision", 1, 999999) == record.mediaRevision &&
            json.integer("currentRevision", 1, 999999) == record.currentRevision && json.hash("previewDigest") == record.previewDigest && json.flag("testOnly") == record.testOnly)
        val values = json.getJSONArray("variants"); require(values.length() == record.variants.size)
        val parts = (0 until values.length()).map { parsePreviewPart(values.getJSONObject(it), record, origin) }
        require(parts.map { it.target }.toSet() == record.variants.map { it.target.wire }.toSet())
        for (part in parts) {
            val expected = record.variants.single { it.target.wire == part.target }
            require(part.kind == expected.kind && part.mimeType == expected.mimeType && part.sha256 == expected.sha256 &&
                part.sourceSha256 == expected.sourceSha256 && part.width == expected.width && part.height == expected.height &&
                part.sizeBytes == expected.sizeBytes && part.durationMs == expected.durationMs && part.audioMode == expected.audioMode && part.hasAudio == expected.hasAudio)
        }
        val thumbnail = json.optJSONObject("thumbnail")?.let { parsePreviewPart(it, record, origin).also { part ->
            require(part.target == "thumbnail" && part.kind == ImportMediaKind.IMAGE && part.mimeType == "image/jpeg" &&
                part.sourceSha256 == record.variants.first().sourceSha256 && part.width == 1080 && part.height == 1920 &&
                part.audioMode == ImportAudioMode.NONE && !part.hasAudio && part.durationMs == null)
        } }
        require((record.variants.any { it.kind == ImportMediaKind.VIDEO }) == (thumbnail != null))
        return ImportPrivatePreview(record.assetId, record.mediaRevision, record.currentRevision, record.previewDigest, record.testOnly, parts, thumbnail)
    }
    private fun parsePreviewPart(json: JSONObject, record: ImportPreparationRecord, origin: HttpUrl): ImportPrivatePreviewPart {
        val target = json.getString("target"); require(target in setOf("feed", "story", "reel", "thumbnail"))
        val url = json.getString("url").toHttpUrl()
        val path = "/v1/social/calendar/imports/assets/${record.assetId}/revisions/${record.mediaRevision}/preview/$target"
        require(url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port && url.encodedPath == path &&
            url.query == null && url.fragment == null && url.username.isEmpty() && url.password.isEmpty())
        val kind = ImportMediaKind.entries.single { it.wire == json.getString("kind") }
        val mime = json.getString("mimeType"); require(mime == if (kind == ImportMediaKind.IMAGE) "image/jpeg" else "video/mp4")
        return ImportPrivatePreviewPart(target, kind, mime, json.hash("sha256"), json.hash("sourceSha256"),
            json.integer("width", 1, 1080).toInt(), json.integer("height", 1, 1920).toInt(),
            json.integer("sizeBytes", 1, if (kind == ImportMediaKind.IMAGE) 8L * 1024 * 1024 else GalleryImportPolicy.VIDEO_MAX_BYTES),
            if (json.isNull("durationMs")) null else json.integer("durationMs", 1, GalleryImportPolicy.PREPARED_VIDEO_MAX_DURATION_MS),
            ImportAudioMode.entries.single { it.wire == json.getString("audioMode") }, json.flag("hasAudio"), url)
    }
    private fun JSONObject.targets(key: String): Set<ImportTarget> {
        val raw = getJSONArray(key); require(raw.length() <= 3)
        val values = (0 until raw.length()).map { index -> ImportTarget.entries.single { it.wire == raw.getString(index) } }
        require(values.distinct().size == values.size); return values.toSet()
    }
    private fun JSONObject.optionalString(key: String) = if (!has(key) || isNull(key)) null else getString(key)
    private fun JSONObject.hash(key: String) = getString(key).also { require(hashPattern.matches(it)) }
    private fun JSONObject.flag(key: String) = get(key).also { require(it is Boolean) } as Boolean
    private fun JSONObject.integer(key: String, minimum: Long, maximum: Long): Long {
        val raw = get(key); require(raw is Number)
        val number = raw.toDouble(); require(number.isFinite() && number == raw.toLong().toDouble() && raw.toLong() in minimum..maximum)
        return raw.toLong()
    }
    private fun JSONObject.optionalSeconds(key: String): Long? {
        if (isNull(key)) return null
        val raw = get(key); require(raw is Number)
        val ms = raw.toDouble() * 1000; require(ms.isFinite() && ms >= 1.0 && ms <= GalleryImportPolicy.PREPARED_VIDEO_MAX_DURATION_MS.toDouble())
        return ms.roundToLong()
    }
    private fun targetJson(values: Set<ImportTarget>) = values.sortedBy { it.ordinal }.joinToString(",", "[", "]") { quote(it.wire) }
    // Android JSONObject.quote escapes '/' whereas JSON.stringify and the JVM
    // test implementation do not. The fingerprint must be identical on device.
    private fun quote(value: String) = buildString {
        append('"')
        value.forEach { character -> when (character) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000C' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (character.code < 32) append("\\u" + character.code.toString(16).padStart(4, '0')) else append(character)
        } }
        append('"')
    }
}
