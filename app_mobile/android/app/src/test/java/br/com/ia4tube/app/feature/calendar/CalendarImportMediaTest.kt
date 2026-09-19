package br.com.ia4tube.app.feature.calendar

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class CalendarImportMediaTest {
    private val id = "a".repeat(40)
    private fun part(target: String, video: Boolean = false) = JSONObject().put("target", target)
        .put("kind", if (video) "video" else "image").put("mimeType", if (video) "video/mp4" else "image/jpeg")
        .put("sha256", "b".repeat(64)).put("sourceSha256", "c".repeat(64)).put("width", 1080)
        .put("height", if (target == "feed") 1350 else 1920).put("sizeBytes", 3000)
        .put("durationMs", if (video) 15000 else JSONObject.NULL).put("audioMode", if (video) "muted" else "none")
        .put("hasAudio", false).put("url", "$CALENDAR_ORIGIN/v1/social/calendar/imports/schedules/$id/preview/$target")
    private fun preview(video: Boolean = false) = JSONObject().put("assetId", UUID.randomUUID().toString())
        .put("mediaRevision", 1).put("currentRevision", 1).put("previewDigest", "d".repeat(64)).put("testOnly", false)
        .put("variants", JSONArray().put(part(if (video) "reel" else "feed", video)))
        .put("thumbnail", if (video) part("thumbnail") else JSONObject.NULL)
    private fun reject(action: () -> Unit) { try { action(); fail("must reject") } catch (_: IllegalArgumentException) {} }

    @Test fun scheduledPreviewReadsImmutableRevisionWithStrictTypedTargets() {
        val image = parseScheduledImportPreview(preview(), id); assertEquals("feed", image.variants.single().target)
        assertNull(image.thumbnail)
        val video = parseScheduledImportPreview(preview(true), id); assertEquals("reel", video.variants.single().target)
        assertEquals("thumbnail", video.thumbnail!!.target); assertFalse(video.variants.single().hasAudio)
    }
    @Test fun previewCannotBorrowDifferentScheduledItemOrOrigin() {
        for (url in listOf("https://attacker.invalid/v1/social/calendar/imports/schedules/$id/preview/feed",
            "$CALENDAR_ORIGIN/v1/social/calendar/imports/schedules/${"e".repeat(40)}/preview/feed",
            "$CALENDAR_ORIGIN/v1/social/calendar/imports/schedules/$id/preview/feed?token=bad",
            "$CALENDAR_ORIGIN/v1/social/calendar/imports/schedules/$id/preview/feed#bad")) {
            val value = preview(); value.getJSONArray("variants").getJSONObject(0).put("url", url)
            reject { parseScheduledImportPreview(value, id) }
        }
    }
    @Test fun typedPreviewRejectsIncorrectAudioSizeGeometryAndDuplicateTargets() {
        val bad = preview(true); bad.getJSONArray("variants").getJSONObject(0).put("hasAudio", true)
        reject { parseScheduledImportPreview(bad, id) }
        val oversized = preview(); oversized.getJSONArray("variants").getJSONObject(0).put("sizeBytes", 9 * 1024 * 1024)
        reject { parseScheduledImportPreview(oversized, id) }
        val wrongShape = preview(); wrongShape.getJSONArray("variants").getJSONObject(0).put("height", 1920)
        reject { parseScheduledImportPreview(wrongShape, id) }
        val duplicate = preview(); duplicate.getJSONArray("variants").put(part("feed"))
        reject { parseScheduledImportPreview(duplicate, id) }
    }
    @Test fun ownerRequiresRealTypedIdsAndThumbnailCannotBeForeignSource() {
        reject { parseCalendarImportOwner(JSONObject().put("companyId", "anything").put("userId", UUID.randomUUID().toString())) }
        val value = preview(true); value.getJSONObject("thumbnail").put("sourceSha256", "e".repeat(64))
        reject { parseScheduledImportPreview(value, id) }
    }
    @Test fun aReelCannotBePresentedAsAnExtraFeedPhoto() {
        val value = preview(true); value.getJSONArray("variants").put(part("feed"))
        reject { parseScheduledImportPreview(value, id) }
    }
}
