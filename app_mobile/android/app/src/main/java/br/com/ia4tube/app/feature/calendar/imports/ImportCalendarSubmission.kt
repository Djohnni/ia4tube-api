package br.com.ia4tube.app.feature.calendar.imports

import org.json.JSONObject

/** Persisted before acceptance; independent of viewing or playing the prepared media. */
data class ImportCalendarSubmissionIntent(val idempotencyKey: String, val sourceRevision: Long,
    val expectedMediaRevision: Long, val caption: String = "")

data class ImportCalendarSubmissionReceipt(val id: String, val assetId: String, val uploadId: String,
    val idempotencyKey: String, val state: String, val calendarItemId: String?, val mediaRevision: Long,
    val date: String, val time: String, val caption: String, val errorCode: String?) {
    override fun toString() = "ImportCalendarSubmissionReceipt(state=$state, content=redacted)"
}

internal object ImportCalendarSubmissionProtocol {
    fun validate(intent: ImportCalendarSubmissionIntent) {
        require(intent.idempotencyKey.matches(Regex("[A-Za-z0-9_-]{8,128}")) && intent.sourceRevision > 0 &&
            intent.expectedMediaRevision in 0..999998 && intent.caption.length <= 2200 &&
            intent.caption.none { it.code in 0..8 || it.code in 11..12 || it.code in 14..31 || it.code == 127 })
    }
    fun body(uploadId: String, intent: ImportCalendarSubmissionIntent, kind: ImportMediaKind,
             configuration: ImportConfiguration): JSONObject {
        validate(intent); GalleryImportHttpApi.uuid(uploadId)
        return JSONObject().put("uploadId", uploadId).put("idempotencyKey", intent.idempotencyKey)
            .put("expectedMediaRevision", intent.expectedMediaRevision)
            .put("selection", ImportPreparationProtocol.selection(kind, configuration)).also {
                // Blank means no caption override; an existing art keeps its server-side caption.
                if (intent.caption.isNotBlank()) it.put("caption", intent.caption)
            }
    }
    fun parse(json: JSONObject, assetId: String, uploadId: String,
              intent: ImportCalendarSubmissionIntent): ImportCalendarSubmissionReceipt {
        validate(intent)
        require(json.getString("assetId") == assetId && json.getString("uploadId") == uploadId &&
            json.getString("idempotencyKey") == intent.idempotencyKey)
        val id = json.getString("id"); require(id.matches(Regex("[a-f0-9]{40}")))
        val state = json.getString("state"); require(state in setOf("accepted", "preparing", "scheduled", "attention", "cancelled"))
        val item = if (json.isNull("calendarItemId")) null else json.getString("calendarItemId")
        require(item == null || item == id)
        require(state != "scheduled" || item != null)
        val revision = json.getLong("mediaRevision"); require(revision in 0..999999)
        val date = json.getString("date"); java.time.LocalDate.parse(date)
        val time = json.getString("time"); require(time.matches(Regex("([01][0-9]|2[0-3]):[0-5][0-9]")))
        val caption = json.getString("caption"); require(caption.length <= 2200)
        val error = if (json.isNull("errorCode")) null else json.getString("errorCode")
        require(error == null || error.matches(Regex("[a-z0-9_]{1,100}")))
        return ImportCalendarSubmissionReceipt(id, assetId, uploadId, intent.idempotencyKey, state, item, revision, date, time, caption, error)
    }
}
