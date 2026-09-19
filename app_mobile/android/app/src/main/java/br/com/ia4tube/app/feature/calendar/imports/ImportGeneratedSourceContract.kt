package br.com.ia4tube.app.feature.calendar.imports

data class ImportGeneratedSourceIntent(val calendarItemId: String, val revision: Long, val idempotencyKey: String) {
    init {
        require(calendarItemId.matches(Regex("[a-f0-9]{40}")) && revision > 0 && idempotencyKey.matches(Regex("[A-Za-z0-9_-]{8,128}")))
    }
    override fun toString() = "ImportGeneratedSourceIntent(content=redacted)"
}
data class ImportGeneratedSource(val upload: ImportUploadRecord, val selection: ImportSelection,
    val original: ImportGeneratedSourceIntent)
