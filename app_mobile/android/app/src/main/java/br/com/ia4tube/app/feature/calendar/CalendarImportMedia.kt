package br.com.ia4tube.app.feature.calendar

import br.com.ia4tube.app.feature.calendar.imports.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject

private val calendarImportUuid = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
private val calendarImportHash = Regex("[a-f0-9]{64}")
internal fun parseCalendarImportOwner(value: JSONObject): ImportOwner {
    val company = value.getString("companyId"); val user = value.getString("userId")
    require(calendarImportUuid.matches(company) && calendarImportUuid.matches(user))
    return ImportOwner(company, user)
}

/** A calendar preview is bound to the scheduled immutable revision, not the editor's latest draft. */
internal fun parseScheduledImportPreview(json: JSONObject, scheduleId: String): ImportPrivatePreview {
    require(scheduleId.matches(Regex("[a-f0-9]{40}")))
    val asset = json.getString("assetId"); require(calendarImportUuid.matches(asset))
    val revision = json.number("mediaRevision", 1, 999999)
    val current = json.number("currentRevision", revision, revision)
    val digest = json.digest("previewDigest"); val testOnly = json.boolean("testOnly")
    val raw = json.getJSONArray("variants"); require(raw.length() in 1..2)
    val variants = (0 until raw.length()).map { parsePart(raw.getJSONObject(it), scheduleId) }
    require(variants.none { it.target == "thumbnail" } && variants.map { it.target }.distinct().size == variants.size)
    require(variants.map { it.sourceSha256 }.distinct().size == 1)
    require(!(variants.any { it.target == "feed" } && variants.any { it.target == "reel" }))
    val thumbnail = json.optJSONObject("thumbnail")?.let { parsePart(it, scheduleId) }
    require((variants.any { it.kind == ImportMediaKind.VIDEO }) == (thumbnail != null))
    require(thumbnail == null || (thumbnail.target == "thumbnail" && thumbnail.sourceSha256 == variants.first().sourceSha256))
    return ImportPrivatePreview(asset, revision, current, digest, testOnly, variants, thumbnail, scheduleId = scheduleId)
}

private fun parsePart(json: JSONObject, scheduleId: String): ImportPrivatePreviewPart {
    val target = json.getString("target"); require(target in setOf("feed", "story", "reel", "thumbnail"))
    val kind = ImportMediaKind.entries.single { it.wire == json.getString("kind") }
    val mime = json.getString("mimeType"); require(mime == if (kind == ImportMediaKind.IMAGE) "image/jpeg" else "video/mp4")
    require(target != "feed" || kind == ImportMediaKind.IMAGE)
    require(target != "reel" || kind == ImportMediaKind.VIDEO)
    val url = json.getString("url").toHttpUrl(); val origin = CALENDAR_ORIGIN.toHttpUrl()
    require(url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port &&
        url.encodedPath == "/v1/social/calendar/imports/schedules/$scheduleId/preview/$target" &&
        url.query == null && url.fragment == null && url.username.isEmpty() && url.password.isEmpty())
    val width = json.number("width", 1080, 1080).toInt()
    val height = json.number("height", if (target == "feed") 1350 else 1920, if (target == "feed") 1350 else 1920).toInt()
    val audio = ImportAudioMode.entries.single { it.wire == json.getString("audioMode") }; val hasAudio = json.boolean("hasAudio")
    val duration = if (json.isNull("durationMs")) null else json.number("durationMs", 1, GalleryImportPolicy.PREPARED_VIDEO_MAX_DURATION_MS)
    require(if (kind == ImportMediaKind.IMAGE) duration == null && audio == ImportAudioMode.NONE && !hasAudio
        else duration != null && audio in setOf(ImportAudioMode.MUSIC, ImportAudioMode.ORIGINAL, ImportAudioMode.MUTED))
    require(audio != ImportAudioMode.MUSIC || hasAudio && duration != null && duration in 14750L..15250L)
    require(audio != ImportAudioMode.MUTED || !hasAudio)
    require(target != "thumbnail" || kind == ImportMediaKind.IMAGE)
    return ImportPrivatePreviewPart(target, kind, mime, json.digest("sha256"), json.digest("sourceSha256"), width, height,
        json.number("sizeBytes", 1, if (kind == ImportMediaKind.IMAGE) 8L * 1024 * 1024 else GalleryImportPolicy.VIDEO_MAX_BYTES),
        duration, audio, hasAudio, url)
}
private fun JSONObject.number(key: String, min: Long, max: Long): Long {
    val value = get(key); require(value is Number && value.toDouble().isFinite() && value.toDouble() == value.toLong().toDouble())
    return value.toLong().also { require(it in min..max) }
}
private fun JSONObject.boolean(key: String): Boolean = get(key).also { require(it is Boolean) } as Boolean
private fun JSONObject.digest(key: String): String = getString(key).also { require(calendarImportHash.matches(it)) }
