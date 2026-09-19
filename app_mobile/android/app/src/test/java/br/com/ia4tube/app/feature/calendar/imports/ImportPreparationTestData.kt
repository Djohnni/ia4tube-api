package br.com.ia4tube.app.feature.calendar.imports

import org.json.JSONArray
import org.json.JSONObject

/** Synthetic metadata only. No media or private service is fetched by these fixtures. */
internal object ImportPreparationTestData {
    val owner = ImportOwner("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
    const val uploadId = "33333333-3333-4333-8333-333333333333"
    const val assetId = "44444444-4444-4444-8444-444444444444"
    const val jobId = "55555555-5555-4555-8555-555555555555"
    val sourceSha = "a".repeat(64)
    val derivedSha = "b".repeat(64)
    val selection = ImportSelection("selected-1", ImportMediaKind.IMAGE, "image/png", 12, 10, 10, null, sourceSha)
    val config = ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE)
    val intent = ImportPreparationIntent("synthetic-preparation-key", 1, 0)
    // Independently computed by the actual backend policy.js previewDigest.
    const val knownDigest = "95ccfde5d1f51f6fb8be6b04821c85b09316a9ef43706eab2c15db0a4a3bc46d"
    fun capabilities(origin: String, enabled: Boolean = true) = JSONObject().put("ok", true).put("enabled", true)
        .put("identity", JSONObject().put("companyId", owner.companyId).put("userId", owner.userId))
        .put("upload", JSONObject().put("origin", origin).put("chunkBytes", GalleryImportPolicy.CHUNK_BYTES)
            .put("maxImageBytes", GalleryImportPolicy.IMAGE_MAX_BYTES).put("maxVideoBytes", GalleryImportPolicy.VIDEO_MAX_BYTES))
        .put("preparation", JSONObject().put("enabled", enabled).put("maxVideoSeconds", 60).put("photoMusicSeconds", 15))
        .put("scheduling", JSONObject().put("enabled", false))
    fun awaiting() = JSONObject().put("assetId", assetId).put("uploadId", uploadId).put("mediaRevision", 0)
        .put("state", "awaiting_selection").put("ready", false).put("previewDigest", JSONObject.NULL)
    fun part() = JSONObject().put("sha256", derivedSha).put("sourceSha256", sourceSha).put("mimeType", "image/jpeg")
        .put("width", 1080).put("height", 1350).put("size", 123).put("durationSeconds", JSONObject.NULL)
        .put("audioMode", "none").put("hasAudio", false)
    fun status(phase: String = "queued") = JSONObject().put("assetId", assetId).put("uploadId", uploadId)
        .put("mediaRevision", 1).put("currentRevision", 1).put("previousReadyRevision", JSONObject.NULL).put("jobId", jobId)
        .put("state", phase).put("ready", phase == "ready").put("errorCode", JSONObject.NULL)
        .put("selection", ImportPreparationProtocol.selection(ImportMediaKind.IMAGE, config)).put("testOnly", false)
        .put("previewDigest", if (phase == "ready") knownDigest else JSONObject.NULL)
        .put("variants", if (phase == "ready") JSONObject().put("feed", part()) else JSONObject())
        .put("createdAt", 1000).put("updatedAt", 2000)
    fun videoStatus(phase: String = "ready", seconds: Double = 20.0, audio: ImportAudioMode = ImportAudioMode.ORIGINAL): JSONObject {
        val config = ImportConfiguration(setOf(ImportTarget.STORY, ImportTarget.REEL), audio, shareToFeed = true)
        val variants = listOf(ImportTarget.STORY, ImportTarget.REEL).map { target -> ImportPreparedMetadata(target,
            (if (target == ImportTarget.STORY) "b" else "c").repeat(64), sourceSha, "video/mp4", 1080, 1920, 123,
            kotlin.math.round(seconds * 1000).toLong(), audio, audio == ImportAudioMode.ORIGINAL) }
        val json = status(phase).put("selection", ImportPreparationProtocol.selection(ImportMediaKind.VIDEO, config))
        if (phase == "ready") {
            json.put("variants", JSONObject().also { values -> variants.forEach { value -> values.put(value.target.wire,
                part().put("sha256", value.sha256).put("mimeType", "video/mp4").put("height", 1920)
                    .put("durationSeconds", seconds).put("audioMode", audio.wire).put("hasAudio", value.hasAudio)) } })
            json.put("previewDigest", ImportPreparationProtocol.fingerprint(ImportMediaKind.VIDEO, config, false, variants))
        }
        return json
    }
    fun preview(origin: String, record: ImportPreparationRecord = ImportPreparationProtocol.parseRecord(status("ready"))): JSONObject {
        val parts = record.variants.map { part -> JSONObject().put("target", part.target.wire).put("kind", part.kind.wire)
            .put("mimeType", part.mimeType).put("sha256", part.sha256).put("sourceSha256", part.sourceSha256)
            .put("width", part.width).put("height", part.height).put("sizeBytes", part.sizeBytes)
            .put("durationMs", part.durationMs ?: JSONObject.NULL).put("audioMode", part.audioMode.wire).put("hasAudio", part.hasAudio)
            .put("url", origin.trimEnd('/') + "/v1/social/calendar/imports/assets/${record.assetId}/revisions/${record.mediaRevision}/preview/${part.target.wire}") }
        val thumbnail = if (record.variants.any { it.kind == ImportMediaKind.VIDEO }) JSONObject()
            .put("target", "thumbnail").put("kind", "image").put("mimeType", "image/jpeg").put("sha256", "d".repeat(64))
            .put("sourceSha256", record.variants.first().sourceSha256).put("width", 1080).put("height", 1920).put("sizeBytes", 100)
            .put("durationMs", JSONObject.NULL).put("audioMode", "none").put("hasAudio", false)
            .put("url", origin.trimEnd('/') + "/v1/social/calendar/imports/assets/${record.assetId}/revisions/${record.mediaRevision}/preview/thumbnail") else null
        return JSONObject().put("assetId", record.assetId).put("mediaRevision", record.mediaRevision).put("currentRevision", record.currentRevision)
            .put("previewDigest", record.previewDigest).put("testOnly", record.testOnly).put("variants", JSONArray(parts)).put("thumbnail", thumbnail ?: JSONObject.NULL)
    }
}
