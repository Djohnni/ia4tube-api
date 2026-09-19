package br.com.ia4tube.app.feature.calendar.imports

import org.junit.Assert.*
import org.junit.Test

class GalleryImportPolicyTest {
    private val photo = ImportSelection("local-selection", ImportMediaKind.IMAGE, "image/jpeg", 123,
        1080, 1350, null, "a".repeat(64))
    private val video = photo.copy(kind = ImportMediaKind.VIDEO, mimeType = "video/mp4", durationMs = 15_000)
    private val plain = ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE)
    private val track = AuthorizedImportTrack("licensed-pilot-track", true)
    private val musical = ImportConfiguration(setOf(ImportTarget.FEED, ImportTarget.STORY), ImportAudioMode.MUSIC,
        track.id, setOf(ImportTarget.STORY))

    @Test fun supportedImagesHaveFiniteSizeAndPixelLimits() {
        listOf("image/jpeg", "image/png", "image/webp").forEach { mime ->
            assertNull(GalleryImportPolicy.validateSelection(photo.copy(mimeType = mime, byteCount = GalleryImportPolicy.IMAGE_MAX_BYTES)))
        }
        assertEquals(ImportRejection.FILE_TOO_LARGE, GalleryImportPolicy.validateSelection(photo.copy(byteCount = GalleryImportPolicy.IMAGE_MAX_BYTES + 1)))
        assertEquals(ImportRejection.INVALID_DIMENSIONS, GalleryImportPolicy.validateSelection(photo.copy(width = 50_000, height = 50_000)))
        assertEquals(ImportRejection.INVALID_DIMENSIONS, GalleryImportPolicy.validateSelection(photo.copy(width = Int.MAX_VALUE, height = Int.MAX_VALUE)))
    }

    @Test fun supportedVideosHaveFiniteSizeAndDurationLimits() {
        listOf("video/mp4", "video/quicktime").forEach { mime ->
            assertNull(GalleryImportPolicy.validateSelection(video.copy(mimeType = mime, byteCount = GalleryImportPolicy.VIDEO_MAX_BYTES, durationMs = 60_000)))
        }
        assertEquals(ImportRejection.FILE_TOO_LARGE, GalleryImportPolicy.validateSelection(video.copy(byteCount = GalleryImportPolicy.VIDEO_MAX_BYTES + 1)))
        for (duration in listOf(null, 0L, -1L, 60_001L))
            assertEquals(ImportRejection.INVALID_DURATION, GalleryImportPolicy.validateSelection(video.copy(durationMs = duration)))
    }

    @Test fun unknownOrMislabelledMediaDoNotEnterFlow() {
        listOf("image/heic", "image/gif", "video/mp4", "application/octet-stream").forEach { mime ->
            assertEquals(ImportRejection.INVALID_FILE, GalleryImportPolicy.validateSelection(photo.copy(mimeType = mime)))
        }
        assertEquals(ImportRejection.INVALID_FILE, GalleryImportPolicy.validateSelection(photo.copy(byteCount = 0)))
        assertEquals(ImportRejection.INVALID_FILE, GalleryImportPolicy.validateSelection(photo.copy(byteCount = -2)))
        assertEquals(ImportRejection.INVALID_DIMENSIONS, GalleryImportPolicy.validateSelection(photo.copy(width = 0)))
        assertEquals(ImportRejection.INVALID_DURATION, GalleryImportPolicy.validateSelection(photo.copy(durationMs = 100)))
    }

    @Test fun checksumAndOpaqueLocalReferenceAreRequired() {
        assertEquals(ImportRejection.INVALID_CHECKSUM, GalleryImportPolicy.validateSelection(photo.copy(sha256 = "bad")))
        assertEquals(ImportRejection.INVALID_IDENTIFIER, GalleryImportPolicy.validateSelection(photo.copy(selectionId = "content://personal/file")))
        assertFalse(photo.toString().contains(photo.sha256))
        assertFalse(photo.toString().contains(photo.selectionId))
    }

    @Test fun plainPhotoSupportsFeedStoryAndBothWithoutVideo() {
        listOf(setOf(ImportTarget.FEED), setOf(ImportTarget.STORY), setOf(ImportTarget.FEED, ImportTarget.STORY)).forEach { targets ->
            val config = plain.copy(targets = targets)
            assertNull(GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, config, emptyList()))
            assertTrue(GalleryImportPolicy.variants(ImportMediaKind.IMAGE, config).all { it.mimeType == "image/jpeg" })
        }
    }

    @Test fun photoFeedAndMusicalStoryHaveIndependentTypedVariants() {
        assertNull(GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, musical, listOf(track)))
        val variants = GalleryImportPolicy.variants(ImportMediaKind.IMAGE, musical).associateBy { it.target }
        assertEquals("image/jpeg", variants.getValue(ImportTarget.FEED).mimeType)
        assertEquals("video/mp4", variants.getValue(ImportTarget.STORY).mimeType)
        assertEquals(15_000L, GalleryImportPolicy.MUSICAL_PHOTO_DURATION_MS)
    }

    @Test fun musicIsNotOfferedWithoutVerifiedCatalogRights() {
        listOf(emptyList(), listOf(track.copy(commercialRightsConfirmed = false)), listOf(track.copy(id = "different"))).forEach { tracks ->
            assertEquals(ImportRejection.MUSIC_NOT_AUTHORIZED, GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, musical, tracks))
        }
        assertEquals(ImportRejection.MUSIC_NOT_AUTHORIZED, GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, musical.copy(musicTrackId = null), listOf(track)))
    }

    @Test fun musicalPhotoInFeedMeansReelSharedToFeedNotNativePhotoMusic() {
        val config = musical.copy(targets = setOf(ImportTarget.REEL), musicalTargets = setOf(ImportTarget.REEL), shareToFeed = true)
        assertNull(GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, config, listOf(track)))
        assertEquals(listOf(ImportTarget.REEL), GalleryImportPolicy.variants(ImportMediaKind.IMAGE, config).map { it.target })
        assertEquals(ImportRejection.INVALID_TARGETS, GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE,
            musical.copy(musicalTargets = setOf(ImportTarget.FEED)), listOf(track)))
    }

    @Test fun unsupportedAudioAndTargetsAreRejected() {
        assertEquals(ImportRejection.INVALID_TARGETS, GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, plain.copy(targets = emptySet()), emptyList()))
        assertEquals(ImportRejection.INVALID_TARGETS, GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, plain.copy(shareToFeed = true), emptyList()))
        assertEquals(ImportRejection.INVALID_TARGETS, GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, plain.copy(targets = setOf(ImportTarget.REEL)), emptyList()))
        assertEquals(ImportRejection.INVALID_AUDIO, GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, plain.copy(audioMode = ImportAudioMode.ORIGINAL), emptyList()))
        assertEquals(ImportRejection.INVALID_AUDIO, GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, plain.copy(musicTrackId = track.id), listOf(track)))
        assertEquals(ImportRejection.INVALID_TARGETS, GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, musical.copy(musicalTargets = setOf(ImportTarget.REEL)), listOf(track)))
    }

    @Test fun ownVideoKeepsAudioOrMutesAndNeverCreatesExtraFeedPost() {
        for (audio in listOf(ImportAudioMode.ORIGINAL, ImportAudioMode.MUTED)) {
            val config = ImportConfiguration(setOf(ImportTarget.STORY, ImportTarget.REEL), audio, shareToFeed = true)
            assertNull(GalleryImportPolicy.validateConfiguration(ImportMediaKind.VIDEO, config, emptyList()))
            assertEquals(2, GalleryImportPolicy.variants(ImportMediaKind.VIDEO, config).size)
        }
        assertEquals(ImportRejection.INVALID_TARGETS, GalleryImportPolicy.validateConfiguration(ImportMediaKind.VIDEO,
            ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.ORIGINAL), emptyList()))
        assertEquals(ImportRejection.INVALID_AUDIO, GalleryImportPolicy.validateConfiguration(ImportMediaKind.VIDEO,
            ImportConfiguration(setOf(ImportTarget.STORY), ImportAudioMode.MUSIC, track.id), listOf(track)))
    }

    @Test fun feedPhotoPlusReelSharedToFeedCannotDuplicateFeedDelivery() {
        val duplicate = musical.copy(targets = setOf(ImportTarget.FEED, ImportTarget.REEL),
            musicalTargets = setOf(ImportTarget.REEL), shareToFeed = true)
        assertEquals(ImportRejection.INVALID_TARGETS, GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, duplicate, listOf(track)))
        assertNull(GalleryImportPolicy.validateConfiguration(ImportMediaKind.IMAGE, duplicate.copy(shareToFeed = false), listOf(track)))
    }

    @Test fun videoGeometryMatchesPilotPreparerBoundsWithoutGuessingCodecOrColor() {
        assertNull(GalleryImportPolicy.validateSelection(video.copy(width = 3840, height = 2160)))
        assertNull(GalleryImportPolicy.validateSelection(video.copy(width = 2160, height = 3840)))
        assertEquals(ImportRejection.INVALID_DIMENSIONS, GalleryImportPolicy.validateSelection(video.copy(width = 4097, height = 1000)))
        assertEquals(ImportRejection.INVALID_DIMENSIONS, GalleryImportPolicy.validateSelection(video.copy(width = 1000, height = 4097)))
        assertEquals(ImportRejection.INVALID_DIMENSIONS, GalleryImportPolicy.validateSelection(video.copy(width = 4096, height = 2160)))
    }
}
