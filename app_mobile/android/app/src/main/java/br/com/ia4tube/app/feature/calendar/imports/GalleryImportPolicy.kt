package br.com.ia4tube.app.feature.calendar.imports

object GalleryImportPolicy {
    const val IMAGE_MAX_BYTES = 32L * 1024 * 1024
    const val VIDEO_MAX_BYTES = 100L * 1024 * 1024
    const val IMAGE_MAX_PIXELS = 25_000_000L
    const val VIDEO_MAX_PIXELS = 8_294_400L
    const val VIDEO_MAX_DIMENSION = 4096
    const val VIDEO_MAX_DURATION_MS = 60_000L
    const val MUSICAL_PHOTO_DURATION_MS = 15_000L
    const val PREPARED_DURATION_TOLERANCE_MS = 250L
    const val PREPARED_VIDEO_MAX_DURATION_MS = VIDEO_MAX_DURATION_MS + PREPARED_DURATION_TOLERANCE_MS
    const val CHUNK_BYTES = 5 * 1024 * 1024
    private val sha256Pattern = Regex("[a-fA-F0-9]{64}")
    private val identifierPattern = Regex("[A-Za-z0-9_-]{1,128}")

    fun validSha256(value: String): Boolean = sha256Pattern.matches(value)
    fun validId(value: String): Boolean = identifierPattern.matches(value)

    fun validateSelection(media: ImportSelection): ImportRejection? {
        if (!validId(media.selectionId)) return ImportRejection.INVALID_IDENTIFIER
        if (!validSha256(media.sha256)) return ImportRejection.INVALID_CHECKSUM
        val accepted = when (media.kind) {
            ImportMediaKind.IMAGE -> setOf("image/jpeg", "image/png", "image/webp")
            ImportMediaKind.VIDEO -> setOf("video/mp4", "video/quicktime")
        }
        if (media.mimeType !in accepted || media.byteCount <= 0) return ImportRejection.INVALID_FILE
        val maximum = if (media.kind == ImportMediaKind.IMAGE) IMAGE_MAX_BYTES else VIDEO_MAX_BYTES
        if (media.byteCount > maximum) return ImportRejection.FILE_TOO_LARGE
        if (media.width <= 0 || media.height <= 0) return ImportRejection.INVALID_DIMENSIONS
        if (media.kind == ImportMediaKind.IMAGE && media.width.toLong() * media.height.toLong() > IMAGE_MAX_PIXELS)
            return ImportRejection.INVALID_DIMENSIONS
        if (media.kind == ImportMediaKind.VIDEO && (media.width > VIDEO_MAX_DIMENSION || media.height > VIDEO_MAX_DIMENSION ||
                media.width.toLong() * media.height.toLong() > VIDEO_MAX_PIXELS)) return ImportRejection.INVALID_DIMENSIONS
        if (media.kind == ImportMediaKind.VIDEO && (media.durationMs == null || media.durationMs !in 1..VIDEO_MAX_DURATION_MS))
            return ImportRejection.INVALID_DURATION
        if (media.kind == ImportMediaKind.IMAGE && media.durationMs != null) return ImportRejection.INVALID_DURATION
        return null
    }

    fun validateConfiguration(
        kind: ImportMediaKind,
        config: ImportConfiguration,
        authorizedTracks: Collection<AuthorizedImportTrack>
    ): ImportRejection? {
        if (config.targets.isEmpty()) return ImportRejection.INVALID_TARGETS
        if (config.shareToFeed && ImportTarget.REEL !in config.targets) return ImportRejection.INVALID_TARGETS
        if (config.shareToFeed && ImportTarget.FEED in config.targets) return ImportRejection.INVALID_TARGETS
        if (kind == ImportMediaKind.VIDEO) {
            if (ImportTarget.FEED in config.targets) return ImportRejection.INVALID_TARGETS
            if (config.audioMode !in setOf(ImportAudioMode.ORIGINAL, ImportAudioMode.MUTED) ||
                config.musicTrackId != null || config.musicalTargets.isNotEmpty()) return ImportRejection.INVALID_AUDIO
            return null
        }
        if (config.audioMode == ImportAudioMode.NONE) {
            if (ImportTarget.REEL in config.targets) return ImportRejection.INVALID_TARGETS
            if (config.musicTrackId != null || config.musicalTargets.isNotEmpty()) return ImportRejection.INVALID_AUDIO
            return null
        }
        if (config.audioMode != ImportAudioMode.MUSIC) return ImportRejection.INVALID_AUDIO
        if (config.musicalTargets.isEmpty() || !config.targets.containsAll(config.musicalTargets) ||
            ImportTarget.FEED in config.musicalTargets ||
            (ImportTarget.REEL in config.targets && ImportTarget.REEL !in config.musicalTargets)) return ImportRejection.INVALID_TARGETS
        val trackId = config.musicTrackId
        if (trackId == null || !validId(trackId) || authorizedTracks.none { it.id == trackId && (it.commercialRightsConfirmed || it.testOnly) })
            return ImportRejection.MUSIC_NOT_AUTHORIZED
        return null
    }

    fun variants(kind: ImportMediaKind, config: ImportConfiguration): List<ImportVariantExpectation> =
        config.targets.sortedBy { it.ordinal }.map { target ->
            val effectiveKind = if (kind == ImportMediaKind.VIDEO || target in config.musicalTargets) ImportMediaKind.VIDEO else ImportMediaKind.IMAGE
            val audioMode = when {
                kind == ImportMediaKind.VIDEO -> config.audioMode
                target in config.musicalTargets -> ImportAudioMode.MUSIC
                else -> ImportAudioMode.NONE
            }
            ImportVariantExpectation(target, effectiveKind, if (effectiveKind == ImportMediaKind.VIDEO) "video/mp4" else "image/jpeg",
                audioMode, if (audioMode == ImportAudioMode.MUSIC) config.musicTrackId else null)
        }
}
