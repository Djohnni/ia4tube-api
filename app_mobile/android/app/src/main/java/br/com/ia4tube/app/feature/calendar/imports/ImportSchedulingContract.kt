package br.com.ia4tube.app.feature.calendar.imports

import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Supplied only after the private player has verified and displayed every derived target. */
data class ImportPreviewConfirmation(val assetId: String, val mediaRevision: Long, val previewDigest: String,
    val verifiedTargets: Set<String>)

/** Durable request binding. No URL, bearer token, private thumbnail or fresh availability is saved. */
data class ImportScheduleBinding(val assetId: String, val mediaRevision: Long, val previewDigest: String,
    val date: String, val time: String, val localSimulation: Boolean = false)

data class ImportScheduleAvailability(val enabled: Boolean = false, val automaticAllowed: Boolean = false,
    val automaticPreference: Boolean = false, val accountLabel: String? = null, val reason: String? = null,
    val localSimulation: Boolean = false, val commercialReady: Boolean = false)

data class ImportScheduleReceipt(val id: String, val assetId: String, val mediaRevision: Long, val previewDigest: String,
    val idempotencyKey: String, val revision: Long, val phase: String, val date: String, val time: String,
    val automaticEnabled: Boolean, val localSimulation: Boolean = false) {
    override fun toString() = "ImportScheduleReceipt(phase=$phase, localSimulation=$localSimulation, content=redacted)"
}

internal object ImportSchedulingProtocol {
    val zone: ZoneId = ZoneId.of("America/Sao_Paulo")
    fun binding(preview: ImportPrivatePreview, scheduledAtEpochMs: Long, localSimulation: Boolean): ImportScheduleBinding {
        val time = Instant.ofEpochMilli(scheduledAtEpochMs).atZone(zone)
        require(time.second == 0 && time.nano == 0)
        return ImportScheduleBinding(preview.assetId, preview.mediaRevision, preview.previewDigest,
            time.toLocalDate().toString(), time.format(DateTimeFormatter.ofPattern("HH:mm")), localSimulation)
    }
    fun validate(binding: ImportScheduleBinding, intent: ImportScheduleIntent) {
        GalleryImportHttpApi.uuid(binding.assetId)
        require(binding.mediaRevision in 1..999999 && binding.previewDigest.matches(Regex("[a-f0-9]{64}")))
        require(binding.date.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")) && binding.time.matches(Regex("([01][0-9]|2[0-3]):[0-5][0-9]")))
        val instant = java.time.LocalDateTime.parse("${binding.date}T${binding.time}:00").atZone(zone).toInstant().toEpochMilli()
        require(instant == intent.scheduledAtEpochMs)
    }
    fun body(binding: ImportScheduleBinding, intent: ImportScheduleIntent): JSONObject {
        validate(binding, intent)
        return JSONObject().put("mediaRevision", binding.mediaRevision).put("previewDigest", binding.previewDigest)
            .put("idempotencyKey", intent.idempotencyKey).put("date", binding.date).put("time", binding.time)
            .put("caption", intent.caption).put("automatic", intent.automatic).put("confirmed", true)
    }
    fun parseAvailability(json: JSONObject, owner: ImportOwner, record: ImportPreparationRecord, allowLocal: Boolean): ImportScheduleAvailability {
        val local = json.optionalFlag("localSimulation", false); require(!local || allowLocal)
        val identity = json.getJSONObject("identity")
        require(identity.getString("companyId") == owner.companyId && identity.getString("userId") == owner.userId &&
            json.getString("assetId") == record.assetId && json.getLong("mediaRevision") == record.mediaRevision &&
            json.optionalString("previewDigest") == record.previewDigest)
        val label = json.optionalString("username")?.also { require(it.length in 1..160 && it.none { ch -> ch.code < 32 }) }
        val reason = json.optionalString("blockedReason")?.also { require(it.matches(Regex("[a-z0-9_]{1,100}"))) }
        val ready = json.flag("ready"); val connected = json.flag("connected"); val authorized = json.flag("authorized")
        val commercial = json.flag("commercialReady"); val preference = json.flag("automaticPreference")
        require(!local || !commercial)
        // A healthy connection and a saved preference do not prove that server gates are open.
        // Only historical, explicitly local fixtures may omit these operational fields.
        val saveAllowed = json.optionalFlag("calendarSaveAllowed", local && ready && authorized)
        val automaticAllowed = json.optionalFlag("automaticAllowed", local && ready && connected && authorized && preference)
        val enabled = ready && saveAllowed && (commercial || local)
        return ImportScheduleAvailability(enabled,
            enabled && automaticAllowed && connected && authorized && preference, preference, label, reason, local, commercial)
    }
    fun parseReceipt(json: JSONObject, binding: ImportScheduleBinding, intent: ImportScheduleIntent, allowLocal: Boolean): ImportScheduleReceipt {
        val local = json.optionalFlag("localSimulation", false)
        require(local == binding.localSimulation && (!local || allowLocal))
        val id = json.getString("id"); require(id.matches(Regex("[a-f0-9]{40}")))
        require(json.getString("assetId") == binding.assetId && json.getLong("mediaRevision") == binding.mediaRevision &&
            json.getString("previewDigest") == binding.previewDigest && json.getString("idempotencyKey") == intent.idempotencyKey)
        val revision = json.getLong("revision"); require(revision > 0)
        val phase = json.getString("phase"); require(phase in setOf("ready", "paused", "cancelled", "dispatching", "confirming", "published", "failed", "partial", "attention", "overdue", "scheduled"))
        val date = json.getString("date"); val time = json.getString("time")
        require(date.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")) && time.matches(Regex("([01][0-9]|2[0-3]):[0-5][0-9]")))
        // A retry may return the latest edited/paused/cancelled calendar record; the immutable import binding still matches.
        return ImportScheduleReceipt(id, binding.assetId, binding.mediaRevision, binding.previewDigest, intent.idempotencyKey,
            revision, phase, date, time, json.flag("automaticEnabled"), local)
    }
    private fun JSONObject.optionalString(key: String) = if (!has(key) || isNull(key)) null else getString(key)
    private fun JSONObject.flag(key: String) = get(key).also { require(it is Boolean) } as Boolean
    private fun JSONObject.optionalFlag(key: String, fallback: Boolean) = if (has(key)) flag(key) else fallback
}
