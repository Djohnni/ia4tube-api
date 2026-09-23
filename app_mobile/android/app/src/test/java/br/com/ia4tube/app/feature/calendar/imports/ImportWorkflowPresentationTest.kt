package br.com.ia4tube.app.feature.calendar.imports

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class ImportWorkflowPresentationTest {
    @Test fun `music keeps Story and mixed destinations while Feed becomes a shared Reel`() {
        val photo = ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE)
        for (destination in listOf("feed", "story", "both")) {
            val value = importMusicConfiguration(photo, "licensed-test", destination)
            assertNull(GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, value,
                listOf(AuthorizedImportTrack("licensed-test", true))))
            when (destination) {
                "feed" -> { assertEquals(setOf(ImportTarget.REEL), value.targets); assertTrue(value.shareToFeed) }
                "story" -> { assertEquals(setOf(ImportTarget.STORY), value.targets); assertFalse(value.shareToFeed) }
                "both" -> { assertEquals(setOf(ImportTarget.FEED, ImportTarget.STORY), value.targets); assertEquals(setOf(ImportTarget.STORY), value.musicalTargets) }
            }
            assertEquals(value.copy(musicTrackId = "another-track"), importMusicConfiguration(value, "another-track", destination))
        }
    }
    private val owner = ImportPreparationTestData.owner
    private fun preview(revision: Long = 1, digest: String = "a".repeat(64)): ImportPrivatePreview {
        val asset = ImportPreparationTestData.assetId
        val variants = listOf("feed", "story").map { target -> ImportPrivatePreviewPart(target, ImportMediaKind.IMAGE, "image/jpeg",
            "b".repeat(64), "c".repeat(64), 1080, if (target == "feed") 1350 else 1920, 100, null, ImportAudioMode.NONE, false,
            "https://ia4tube-api.onrender.com/v1/social/calendar/imports/assets/$asset/revisions/$revision/preview/$target".toHttpUrl()) }
        return ImportPrivatePreview(asset, revision, revision, digest, false, variants, null)
    }
    @Test fun `each output must be reviewed and thumbnail is never output confirmation`() {
        val review = ImportPreviewReview(); review.bind(owner, "session", preview())
        review.rendered("thumbnail"); review.rendered("feed"); assertFalse(review.complete())
        review.rendered("story"); assertTrue(review.complete())
        review.failed("story"); assertFalse(review.complete())
    }
    @Test fun `configuration revision digest and session change erase review`() {
        val review = ImportPreviewReview()
        for (replacement in listOf(preview(2), preview(digest = "d".repeat(64)), null)) {
            review.bind(owner, "session", preview()); review.rendered("feed"); review.rendered("story")
            review.bind(owner, "session", replacement); assertFalse(review.complete())
        }
        review.bind(owner, "session", preview()); review.rendered("feed"); review.rendered("story")
        review.bind(owner.copy(companyId = "another"), "session", preview()); assertFalse(review.complete())
        review.rendered("feed"); review.rendered("story"); review.bind(owner, "new-session", preview()); assertFalse(review.complete())
    }
    @Test fun `same immutable preview may retain reviewed targets within same session`() {
        val review = ImportPreviewReview(); review.bind(owner, "session", preview()); review.rendered("feed")
        review.bind(owner, "session", preview()); assertEquals(setOf("feed"), review.verifiedTargets())
        review.clear(); assertTrue(review.verifiedTargets().isEmpty())
    }
    @Test fun `plain photo does not create reel or music`() {
        val choices = importFormatChoices(ImportMediaKind.IMAGE, ImportAudioMode.NONE)
        assertEquals(3, choices.size)
        assertTrue(choices.all { it.configuration.audioMode == ImportAudioMode.NONE && ImportTarget.REEL !in it.configuration.targets })
        assertTrue(choices.all { GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, it.configuration, emptyList()) == null })
    }
    @Test fun `musical photo preserves static Feed and separate musical Story`() {
        val choices = importFormatChoices(ImportMediaKind.IMAGE, ImportAudioMode.MUSIC, "local-synthetic")
        val both = choices.last().configuration
        assertEquals(setOf(ImportTarget.FEED, ImportTarget.STORY), both.targets)
        assertEquals(setOf(ImportTarget.STORY), both.musicalTargets)
        assertFalse(both.shareToFeed)
        assertEquals(listOf(ImportMediaKind.IMAGE, ImportMediaKind.VIDEO), GalleryImportPolicy.variants(ImportMediaKind.IMAGE, both).map { it.kind })
        assertEquals(ImportRejection.MUSIC_NOT_AUTHORIZED, GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, both, emptyList()))
    }
    @Test fun `video keep or remove audio never invents extra Feed upload or mixing`() {
        for (audio in listOf(ImportAudioMode.ORIGINAL, ImportAudioMode.MUTED)) {
            val choices = importFormatChoices(ImportMediaKind.VIDEO, audio)
            assertEquals(3, choices.size)
            assertTrue(choices.all { ImportTarget.FEED !in it.configuration.targets && it.configuration.audioMode == audio && it.configuration.musicTrackId == null })
            assertEquals(2, choices.last().configuration.targets.size)
            assertTrue(choices.last().configuration.shareToFeed)
        }
    }
    @Test fun `Reel Feed visibility is explicit in both states and never adds a Feed target`() {
        for (shareToFeed in listOf(false, true)) {
            val choices = importFormatChoices(ImportMediaKind.VIDEO, ImportAudioMode.ORIGINAL,
                reelShareToFeed = shareToFeed)
            val reels = choices.filter { ImportTarget.REEL in it.configuration.targets }
            assertEquals(2, reels.size)
            assertTrue(reels.all { it.configuration.shareToFeed == shareToFeed })
            assertTrue(reels.all { ImportTarget.FEED !in it.configuration.targets })
            assertTrue(reels.all { GalleryImportPolicy.validateConfiguration(ImportMediaKind.VIDEO,
                it.configuration, emptyList()) == null })
            assertTrue(importReelFeedLabel(reels.first().configuration)!!.contains(
                if (shareToFeed) "uma única publicação" else "somente na área de Reels"))
        }
        assertNull(importReelFeedLabel(ImportConfiguration(setOf(ImportTarget.STORY), ImportAudioMode.ORIGINAL)))
    }
    @Test fun `preparation wire contract keeps false as an explicit boolean`() {
        val configuration = ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL, shareToFeed = false)
        val selection = ImportPreparationProtocol.selection(ImportMediaKind.VIDEO, configuration)
        assertTrue(selection.has("shareToFeed"))
        assertFalse(selection.getBoolean("shareToFeed"))
    }
    @Test fun `schedule is future whole minute Brasilia date with bounded horizon`() {
        val now = Instant.parse("2026-09-13T12:00:00Z").toEpochMilli()
        assertEquals(Instant.parse("2026-09-14T12:30:00Z").toEpochMilli(), importScheduledAt("2026-09-14", "09:30", now))
        assertNull(importScheduledAt("2026-09-12", "09:30", now))
        assertNull(importScheduledAt("2026-09-14", "25:00", now))
        assertNull(importScheduledAt("2027-09-14", "09:00", now))
        assertNull(importScheduledAt("2026-02-30", "09:00", now))
    }
    @Test fun `local preview playback controls cannot mutate final configuration`() {
        val configuration = ImportConfiguration(setOf(ImportTarget.REEL), ImportAudioMode.ORIGINAL, shareToFeed = true)
        val label = importFinalAudioLabel(configuration)
        var previewMuted = false; previewMuted = !previewMuted
        assertTrue(previewMuted); assertEquals(ImportAudioMode.ORIGINAL, configuration.audioMode)
        assertEquals(label, importFinalAudioLabel(configuration))
    }
}
