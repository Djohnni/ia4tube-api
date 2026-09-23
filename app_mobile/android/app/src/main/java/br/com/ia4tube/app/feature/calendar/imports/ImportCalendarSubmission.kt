package br.com.ia4tube.app.feature.calendar.imports

import org.json.JSONObject

/** Optional date chosen before the one direct-calendar action. */
data class ImportCalendarSchedule(val date: String, val time: String, val timeZone: String = "America/Sao_Paulo")

/** Persisted before acceptance; independent of viewing or playing the prepared media. */
data class ImportCalendarSubmissionIntent(val idempotencyKey: String, val sourceRevision: Long,
    val expectedMediaRevision: Long, val caption: String = "", val schedule: ImportCalendarSchedule? = null)

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
        intent.schedule?.let(::validateSchedule)
    }
    fun validateSchedule(schedule: ImportCalendarSchedule) {
        require(schedule.date.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")) &&
            schedule.time.matches(Regex("([01][0-9]|2[0-3]):[0-5][0-9]")) && schedule.timeZone == "America/Sao_Paulo")
        require(java.time.LocalDate.parse(schedule.date).year in 1..9999)
        // Restore/retry must remain possible after this date. Fresh admission is checked by the server.
    }
    fun body(uploadId: String, intent: ImportCalendarSubmissionIntent, kind: ImportMediaKind,
             configuration: ImportConfiguration): JSONObject {
        validate(intent); GalleryImportHttpApi.uuid(uploadId)
        return JSONObject().put("uploadId", uploadId).put("idempotencyKey", intent.idempotencyKey)
            .put("expectedMediaRevision", intent.expectedMediaRevision)
            .put("selection", ImportPreparationProtocol.selection(kind, configuration)).also {
                // Blank means no caption override; an existing art keeps its server-side caption.
                if (intent.caption.isNotBlank()) it.put("caption", intent.caption)
                intent.schedule?.let { schedule -> it.put("schedule", JSONObject().put("date", schedule.date)
                    .put("time", schedule.time).put("timeZone", schedule.timeZone)) }
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
        // A later lookup may reflect an authorized calendar edit; the saved submission intent is unchanged.
        val caption = json.getString("caption"); require(caption.length <= 2200)
        val error = if (json.isNull("errorCode")) null else json.getString("errorCode")
        require(error == null || error.matches(Regex("[a-z0-9_]{1,100}")))
        return ImportCalendarSubmissionReceipt(id, assetId, uploadId, intent.idempotencyKey, state, item, revision, date, time, caption, error)
    }
}
