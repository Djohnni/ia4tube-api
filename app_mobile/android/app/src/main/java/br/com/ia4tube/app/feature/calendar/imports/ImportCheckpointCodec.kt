package br.com.ia4tube.app.feature.calendar.imports

import org.json.JSONArray
import org.json.JSONObject

data class ImportDurableCheckpoint(
    val generation: Long,
    val state: GalleryImportState,
    val selectedContentUri: String?,
    val uploadStartIdempotencyKey: String,
    val uploadStartIssued: Boolean = false,
    val transferPaused: Boolean = true,
    val cancelRequested: Boolean = false,
    val preparationIntent: ImportPreparationIntent? = null,
    val preparationBaseRevision: Long = 0,
    val scheduleBinding: ImportScheduleBinding? = null,
    val generatedSource: ImportGeneratedSourceIntent? = null,
    val calendarSubmission: ImportCalendarSubmissionIntent? = null
) {
    override fun toString() = "ImportDurableCheckpoint(generation=$generation, content=redacted)"
}

/** Explicit, versioned format. It never serializes bearer tokens, grants or signed remote URLs. */
object ImportCheckpointCodec {
    const val MAX_BYTES = 256 * 1024
    fun encode(value: ImportDurableCheckpoint): ByteArray {
        validate(value)
        val state = value.state
        val json = JSONObject().put("schema", 1).put("generation", value.generation)
            .put("owner", JSONObject().put("companyId", state.owner.companyId).put("userId", state.owner.userId))
            .put("draftId", state.draftId).put("revision", state.revision).put("phase", state.phase.name)
            .put("selection", JSONObject().put("selectionId", state.selection.selectionId).put("kind", state.selection.kind.name)
                .put("mimeType", state.selection.mimeType).put("byteCount", state.selection.byteCount)
                .put("width", state.selection.width).put("height", state.selection.height)
                .put("durationMs", state.selection.durationMs ?: JSONObject.NULL).put("sha256", state.selection.sha256))
            .put("configuration", JSONObject().put("targets", JSONArray(state.configuration.targets.map { it.name }))
                .put("audioMode", state.configuration.audioMode.name).put("musicTrackId", state.configuration.musicTrackId ?: JSONObject.NULL)
                .put("musicalTargets", JSONArray(state.configuration.musicalTargets.map { it.name })).put("shareToFeed", state.configuration.shareToFeed))
            .put("selectedContentUri", value.selectedContentUri ?: JSONObject.NULL)
            .put("uploadStartIdempotencyKey", value.uploadStartIdempotencyKey)
            .put("uploadStartIssued", value.uploadStartIssued).put("transferPaused", value.transferPaused)
            .put("cancelRequested", value.cancelRequested)
            .put("preparationBaseRevision", value.preparationBaseRevision)
            .put("calendarItemId", state.calendarItemId ?: JSONObject.NULL)
            .put("failure", state.failure?.name ?: JSONObject.NULL)
        value.preparationIntent?.let { intent ->
            json.put("preparationIntent", JSONObject().put("idempotencyKey", intent.idempotencyKey)
                .put("sourceRevision", intent.sourceRevision).put("expectedMediaRevision", intent.expectedMediaRevision)
                .put("acceptedMediaRevision", intent.acceptedMediaRevision ?: JSONObject.NULL).put("jobId", intent.jobId ?: JSONObject.NULL))
        } ?: json.put("preparationIntent", JSONObject.NULL)
        value.scheduleBinding?.let { binding ->
            json.put("scheduleBinding", JSONObject().put("assetId", binding.assetId).put("mediaRevision", binding.mediaRevision)
                .put("previewDigest", binding.previewDigest).put("date", binding.date).put("time", binding.time)
                .put("localSimulation", binding.localSimulation))
        } ?: json.put("scheduleBinding", JSONObject.NULL)
        value.generatedSource?.let { source -> json.put("generatedSource", JSONObject().put("calendarItemId", source.calendarItemId)
            .put("revision", source.revision).put("idempotencyKey", source.idempotencyKey)) } ?: json.put("generatedSource", JSONObject.NULL)
        value.calendarSubmission?.let { intent -> json.put("calendarSubmission", JSONObject()
            .put("idempotencyKey", intent.idempotencyKey).put("sourceRevision", intent.sourceRevision)
            .put("expectedMediaRevision", intent.expectedMediaRevision).put("caption", intent.caption).also { value ->
                intent.schedule?.let { schedule -> value.put("schedule", JSONObject().put("date", schedule.date)
                    .put("time", schedule.time).put("timeZone", schedule.timeZone)) }
            })
        } ?: json.put("calendarSubmission", JSONObject.NULL)
        state.upload?.let { progress ->
            json.put("upload", JSONObject().put("uploadId", progress.ticket.uploadId).put("assetId", progress.ticket.assetId)
                .put("selectionSha256", progress.ticket.selectionSha256).put("totalBytes", progress.ticket.totalBytes)
                .put("chunkBytes", progress.ticket.chunkBytes).put("serverVerified", progress.serverVerified).put("receipts", JSONArray(progress.receipts.map { part ->
                    JSONObject().put("part", part.part).put("bytes", part.bytes).put("sha256", part.sha256)
                })))
        } ?: json.put("upload", JSONObject.NULL)
        json.put("prepared", JSONArray(state.prepared.map { variant ->
            JSONObject().put("target", variant.target.name).put("kind", variant.kind.name).put("mimeType", variant.mimeType)
                .put("assetId", variant.assetId).put("sha256", variant.sha256).put("audioMode", variant.audioMode.name)
                .put("musicTrackId", variant.musicTrackId ?: JSONObject.NULL).put("durationMs", variant.durationMs ?: JSONObject.NULL)
        }))
        state.scheduleIntent?.let { intent ->
            json.put("scheduleIntent", JSONObject().put("idempotencyKey", intent.idempotencyKey).put("revision", intent.revision)
                .put("scheduledAtEpochMs", intent.scheduledAtEpochMs).put("caption", intent.caption).put("automatic", intent.automatic))
        } ?: json.put("scheduleIntent", JSONObject.NULL)
        // Availability and preview acknowledgement are deliberately not persisted as fresh evidence.
        val bytes = json.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_BYTES)
        return bytes
    }

    fun decode(bytes: ByteArray, owner: ImportOwner): ImportDurableCheckpoint {
        require(bytes.isNotEmpty() && bytes.size <= MAX_BYTES)
        val json = JSONObject(String(bytes, Charsets.UTF_8))
        require(json.getInt("schema") == 1)
        requireKeys(json, setOf("schema", "generation", "owner", "draftId", "revision", "phase", "selection", "configuration",
            "selectedContentUri", "uploadStartIdempotencyKey", "uploadStartIssued", "transferPaused", "cancelRequested",
            "calendarItemId", "failure", "upload", "prepared", "scheduleIntent", "preparationIntent", "preparationBaseRevision", "scheduleBinding", "generatedSource", "calendarSubmission"))
        val savedOwner = json.getJSONObject("owner")
        require(savedOwner.getString("companyId") == owner.companyId && savedOwner.getString("userId") == owner.userId)
        val media = json.getJSONObject("selection")
        val selection = ImportSelection(media.getString("selectionId"), ImportMediaKind.valueOf(media.getString("kind")), media.getString("mimeType"),
            media.getLong("byteCount"), media.getInt("width"), media.getInt("height"), media.nullableLong("durationMs"), media.getString("sha256"))
        val conf = json.getJSONObject("configuration")
        val configuration = ImportConfiguration(conf.targets("targets"), ImportAudioMode.valueOf(conf.getString("audioMode")),
            conf.nullableString("musicTrackId"), conf.targets("musicalTargets"), conf.getBoolean("shareToFeed"))
        val upload = json.optJSONObject("upload")?.let { value ->
            val parts = value.getJSONArray("receipts"); require(parts.length() <= 20)
            ImportUploadProgress(ImportUploadTicket(value.getString("uploadId"), value.getString("assetId"), value.getString("selectionSha256"),
                value.getLong("totalBytes"), value.getInt("chunkBytes")), (0 until parts.length()).map { index ->
                val part = parts.getJSONObject(index); ImportPartReceipt(part.getInt("part"), part.getInt("bytes"), part.getString("sha256"))
            }, value.optBoolean("serverVerified", false))
        }
        val prepared = json.getJSONArray("prepared"); require(prepared.length() <= 3)
        val variants = (0 until prepared.length()).map { index ->
            val item = prepared.getJSONObject(index)
            ImportPreparedVariant(ImportTarget.valueOf(item.getString("target")), ImportMediaKind.valueOf(item.getString("kind")),
                item.getString("mimeType"), item.getString("assetId"), item.getString("sha256"), ImportAudioMode.valueOf(item.getString("audioMode")),
                item.nullableString("musicTrackId"), item.nullableLong("durationMs"))
        }
        val intent = json.optJSONObject("scheduleIntent")?.let {
            ImportScheduleIntent(it.getString("idempotencyKey"), it.getLong("revision"), it.getLong("scheduledAtEpochMs"), it.getString("caption"), it.getBoolean("automatic"))
        }
        val phase = ImportPhase.valueOf(json.getString("phase"))
        val state = GalleryImportState(owner, json.getString("draftId"), selection, configuration, json.getLong("revision"), phase,
            upload = upload, prepared = variants, scheduleIntent = intent, scheduleResultUncertain = phase == ImportPhase.SCHEDULING,
            calendarItemId = json.nullableString("calendarItemId"), failure = json.nullableString("failure")?.let(ImportRejection::valueOf))
        return ImportDurableCheckpoint(json.getLong("generation"), state, json.nullableString("selectedContentUri"),
            json.getString("uploadStartIdempotencyKey"),
            // Old checkpoints cannot prove that an EDITING start was never sent.
            // Conservatively reconcile the existing idempotency key, never mint another.
            json.strictOptionalBoolean("uploadStartIssued", true), json.strictOptionalBoolean("transferPaused", true),
            json.strictOptionalBoolean("cancelRequested", false), json.strictOptionalObject("preparationIntent")?.let { value ->
                requireKeys(value, setOf("idempotencyKey", "sourceRevision", "expectedMediaRevision", "acceptedMediaRevision", "jobId"))
                ImportPreparationIntent(value.getString("idempotencyKey"), value.getLong("sourceRevision"), value.getLong("expectedMediaRevision"),
                    value.nullableLong("acceptedMediaRevision"), value.nullableString("jobId"))
            }, if (json.has("preparationBaseRevision")) json.getLong("preparationBaseRevision") else 0,
            json.strictOptionalObject("scheduleBinding")?.let { value ->
                requireKeys(value, setOf("assetId", "mediaRevision", "previewDigest", "date", "time", "localSimulation"))
                ImportScheduleBinding(value.getString("assetId"), value.getLong("mediaRevision"), value.getString("previewDigest"),
                    value.getString("date"), value.getString("time"), value.strictOptionalBoolean("localSimulation", false))
            }, json.strictOptionalObject("generatedSource")?.let { value ->
                requireKeys(value, setOf("calendarItemId", "revision", "idempotencyKey"))
                ImportGeneratedSourceIntent(value.getString("calendarItemId"), value.getLong("revision"), value.getString("idempotencyKey"))
            }, json.strictOptionalObject("calendarSubmission")?.let { value ->
                requireKeys(value, setOf("idempotencyKey", "sourceRevision", "expectedMediaRevision", "caption", "schedule"))
                ImportCalendarSubmissionIntent(value.getString("idempotencyKey"), value.getLong("sourceRevision"),
                    value.getLong("expectedMediaRevision"), value.getString("caption"), value.strictOptionalObject("schedule")?.let { schedule ->
                        requireKeys(schedule, setOf("date", "time", "timeZone"))
                        ImportCalendarSchedule(schedule.getString("date"), schedule.getString("time"), schedule.getString("timeZone"))
                    })
            }).also(::validate)
    }

    fun validate(checkpoint: ImportDurableCheckpoint) {
        require(checkpoint.generation > 0 && checkpoint.uploadStartIdempotencyKey.matches(Regex("[A-Za-z0-9_-]{8,128}")))
        checkpoint.selectedContentUri?.let { uri ->
            require(uri.length <= 8192 && uri.startsWith("content://") && uri.none { it == '\r' || it == '\n' || it == '\u0000' })
        }
        val state = checkpoint.state
        checkpoint.calendarSubmission?.let { intent ->
            ImportCalendarSubmissionProtocol.validate(intent)
            require(intent.sourceRevision == state.revision && state.upload?.serverVerified == true &&
                state.phase in setOf(ImportPhase.UPLOADED, ImportPhase.PREPARING, ImportPhase.READY) &&
                !checkpoint.cancelRequested && checkpoint.scheduleBinding == null && state.scheduleIntent == null)
        }
        require(checkpoint.preparationBaseRevision in 0..999998)
        checkpoint.generatedSource?.let { source ->
            require(checkpoint.selectedContentUri == null && state.selection.kind == ImportMediaKind.IMAGE &&
                state.selection.selectionId == "generated-${source.calendarItemId}" && state.upload?.serverVerified == true &&
                checkpoint.uploadStartIdempotencyKey == source.idempotencyKey)
        }
        checkpoint.preparationIntent?.let { intent ->
            require(intent.idempotencyKey.matches(Regex("[A-Za-z0-9_-]{8,128}")) && intent.sourceRevision == state.revision &&
                intent.expectedMediaRevision in 0..999998 && state.upload?.serverVerified == true && !checkpoint.cancelRequested)
            require((intent.acceptedMediaRevision == null) == (intent.jobId == null))
            intent.acceptedMediaRevision?.let { require(it == intent.expectedMediaRevision + 1) }
            intent.jobId?.let { GalleryImportHttpApi.uuid(it) }
            require(state.phase in setOf(ImportPhase.PREPARING, ImportPhase.READY, ImportPhase.SCHEDULING, ImportPhase.SCHEDULED))
        }
        require(state.owner.companyId.length <= 128 && state.owner.userId.length <= 128)
        require(GalleryImportPolicy.validId(state.draftId) && state.revision > 0)
        require(GalleryImportPolicy.validateSelection(state.selection) == null)
        // Only syntax is recovered here. Current licence/availability must be reconfirmed with the server.
        val structuralTracks = state.configuration.musicTrackId?.let { listOf(AuthorizedImportTrack(it, true)) }.orEmpty()
        require(GalleryImportPolicy.validateConfiguration(state.selection.kind, state.configuration, structuralTracks) == null)
        state.upload?.let { upload ->
            require(GalleryImportPolicy.validId(upload.ticket.uploadId) && GalleryImportPolicy.validId(upload.ticket.assetId))
            require(upload.ticket.totalBytes == state.selection.byteCount && upload.ticket.chunkBytes == GalleryImportPolicy.CHUNK_BYTES)
            require(upload.ticket.selectionSha256.equals(state.selection.sha256, true) && upload.receipts.size <= 20)
            var acknowledged = 0L
            upload.receipts.forEachIndexed { index, receipt ->
                require(receipt.part == index && GalleryImportPolicy.validSha256(receipt.sha256))
                val expected = minOf(upload.ticket.chunkBytes.toLong(), upload.ticket.totalBytes - acknowledged)
                require(expected > 0 && receipt.bytes.toLong() == expected)
                acknowledged += receipt.bytes
            }
        }
        val needsUpload = state.phase in setOf(ImportPhase.INITIALIZING, ImportPhase.UPLOADING, ImportPhase.VERIFYING, ImportPhase.UPLOADED,
            ImportPhase.PREPARING, ImportPhase.READY, ImportPhase.SCHEDULING, ImportPhase.SCHEDULED, ImportPhase.CANCEL_PENDING)
        require(!needsUpload || state.upload != null)
        val needsPrepared = state.phase in setOf(ImportPhase.READY, ImportPhase.SCHEDULING, ImportPhase.SCHEDULED)
        require(!needsPrepared || state.prepared.isNotEmpty())
        require(needsPrepared || state.prepared.isEmpty())
        if (state.phase in setOf(ImportPhase.UPLOADED, ImportPhase.PREPARING, ImportPhase.READY, ImportPhase.SCHEDULING, ImportPhase.SCHEDULED))
            require(state.upload?.complete == true)
        require(state.prepared.size <= 3 && state.prepared.map { it.target }.distinct().size == state.prepared.size)
        state.prepared.forEach { variant ->
            require(GalleryImportPolicy.validId(variant.assetId) && GalleryImportPolicy.validSha256(variant.sha256))
            val expected = GalleryImportPolicy.variants(state.selection.kind, state.configuration).singleOrNull { it.target == variant.target }
            require(expected != null && expected.kind == variant.kind && expected.mimeType == variant.mimeType &&
                expected.audioMode == variant.audioMode && expected.musicTrackId == variant.musicTrackId)
            require(when {
                variant.kind == ImportMediaKind.IMAGE -> variant.durationMs == null
                state.selection.kind == ImportMediaKind.IMAGE -> variant.durationMs != null && variant.durationMs in 14_750L..15_250L
                else -> variant.durationMs != null && variant.durationMs in 1..GalleryImportPolicy.PREPARED_VIDEO_MAX_DURATION_MS &&
                    state.selection.durationMs != null && kotlin.math.abs(variant.durationMs - state.selection.durationMs) <= GalleryImportPolicy.PREPARED_DURATION_TOLERANCE_MS
            })
        }
        if (needsPrepared) require(state.prepared.map { it.target }.toSet() == state.configuration.targets)
        require((state.phase in setOf(ImportPhase.SCHEDULING, ImportPhase.SCHEDULED)) == (state.scheduleIntent != null))
        state.scheduleIntent?.let { intent ->
            require(GalleryImportPolicy.validId(intent.idempotencyKey) && intent.revision == state.revision && intent.scheduledAtEpochMs > 0)
            require(intent.caption.length <= 2200 &&
                (state.configuration.targets == setOf(ImportTarget.STORY) || intent.caption.isNotBlank()))
        }
        checkpoint.scheduleBinding?.let { binding ->
            val intent = requireNotNull(state.scheduleIntent)
            ImportSchedulingProtocol.validate(binding, intent)
            require(binding.assetId == state.upload?.ticket?.assetId && binding.mediaRevision == checkpoint.preparationIntent?.acceptedMediaRevision)
        }
        require((state.phase == ImportPhase.SCHEDULED) == (state.calendarItemId != null))
        state.calendarItemId?.let { require(GalleryImportPolicy.validId(it)) }
    }

    private fun JSONObject.nullableString(key: String) = if (isNull(key)) null else getString(key)
    private fun JSONObject.strictOptionalObject(key: String): JSONObject? {
        if (!has(key) || isNull(key)) return null
        return getJSONObject(key)
    }
    private fun JSONObject.strictOptionalBoolean(key: String, fallback: Boolean): Boolean {
        if (!has(key)) return fallback
        return get(key).also { require(it is Boolean) } as Boolean
    }
    private fun JSONObject.nullableLong(key: String) = if (isNull(key)) null else getLong(key)
    private fun JSONObject.targets(key: String): Set<ImportTarget> {
        val array = getJSONArray(key); require(array.length() <= 3)
        val values = (0 until array.length()).map { ImportTarget.valueOf(array.getString(it)) }
        require(values.distinct().size == values.size)
        return values.toSet()
    }
    private fun requireKeys(json: JSONObject, allowed: Set<String>) { require(json.keys().asSequence().all { it in allowed }) }
}
