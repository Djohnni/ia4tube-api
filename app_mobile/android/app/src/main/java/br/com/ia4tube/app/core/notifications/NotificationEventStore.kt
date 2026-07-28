package br.com.ia4tube.app.core.notifications

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

internal class NotificationEventStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE
    )

    fun markIfNew(eventId: String, nowMs: Long = System.currentTimeMillis()): Boolean {
        return synchronized(LOCK) {
            val result = NotificationEventLedger.mark(
                serialized = preferences.getString(KEY_EVENTS, "").orEmpty(),
                eventId = eventId,
                nowMs = nowMs
            )
            if (!result.isNew) return@synchronized false
            preferences.edit()
                .putString(KEY_EVENTS, result.serialized)
                .commit()
        }
    }

    fun forget(eventId: String): Boolean {
        return synchronized(LOCK) {
            val serialized = preferences.getString(KEY_EVENTS, "").orEmpty()
            preferences.edit()
                .putString(
                    KEY_EVENTS,
                    NotificationEventLedger.forget(serialized, eventId)
                )
                .commit()
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "ia4tube_notification_events"
        const val KEY_EVENTS = "seen_events"
        val LOCK = Any()
    }
}

internal object NotificationEventLedger {
    private const val MAX_EVENTS = 128
    private const val RETENTION_MS = 30L * 24L * 60L * 60L * 1_000L
    private val HASH_PATTERN = Regex("^[a-f0-9]{64}$")

    data class MarkResult(
        val isNew: Boolean,
        val serialized: String
    )

    fun mark(serialized: String, eventId: String, nowMs: Long): MarkResult {
        if (!ArtReadyNotificationPayload.isSafeEventId(eventId)) {
            return MarkResult(false, serialized)
        }
        val eventHash = hash(eventId)
        val cutoff = nowMs - RETENTION_MS
        val retained = load(serialized)
            .filter { it.seenAt >= cutoff }
            .associateByTo(linkedMapOf()) { it.hash }
        if (retained.containsKey(eventHash)) {
            return MarkResult(false, serialized)
        }

        retained[eventHash] = SeenEvent(eventHash, nowMs)
        val bounded = retained.values
            .sortedByDescending { it.seenAt }
            .take(MAX_EVENTS)
        val array = JSONArray()
        bounded.forEach { event ->
            array.put(
                JSONObject()
                    .put("hash", event.hash)
                    .put("seen_at", event.seenAt)
            )
        }
        return MarkResult(true, array.toString())
    }

    fun forget(serialized: String, eventId: String): String {
        if (!ArtReadyNotificationPayload.isSafeEventId(eventId)) return serialized
        val eventHash = hash(eventId)
        val array = JSONArray()
        load(serialized)
            .filterNot { it.hash == eventHash }
            .forEach { event ->
                array.put(
                    JSONObject()
                        .put("hash", event.hash)
                        .put("seen_at", event.seenAt)
                )
            }
        return array.toString()
    }

    private fun load(serialized: String): List<SeenEvent> {
        if (serialized.isBlank()) return emptyList()
        return runCatching {
            val array = JSONArray(serialized)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    val hash = item.optString("hash")
                    val seenAt = item.optLong("seen_at", 0L)
                    if (HASH_PATTERN.matches(hash) && seenAt > 0L) {
                        add(SeenEvent(hash, seenAt))
                    }
                }
            }
        }.getOrDefault(emptyList())
    }

    private fun hash(value: String): String {
        return MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    private data class SeenEvent(
        val hash: String,
        val seenAt: Long
    )
}
