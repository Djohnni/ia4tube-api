package br.com.ia4tube.app.core.monthly_planning

import android.content.Context
import br.com.ia4tube.app.data.models.MonthlyPlanningPostDto
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

class MonthlyPlanningCalendarCacheStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun load(token: String): List<MonthlyPlanningPostDto> {
        val raw = preferences.getString(cacheKey(token), "").orEmpty()
        if (raw.isBlank()) return emptyList()

        return runCatching {
            val array = JSONArray(raw)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    add(item.toMonthlyPlanningPostDto())
                }
            }
        }.getOrDefault(emptyList())
    }

    fun save(token: String, posts: List<MonthlyPlanningPostDto>) {
        val array = JSONArray()
        posts.forEach { post -> array.put(post.toJson()) }
        preferences.edit()
            .putString(cacheKey(token), array.toString())
            .apply()
    }

    fun remove(token: String, itemKey: String) {
        val updated = load(token).filterNot { post -> post.matchesCalendarItem(itemKey) }
        save(token, updated)
    }

    fun upsert(token: String, oldItemKey: String, post: MonthlyPlanningPostDto) {
        val updated = load(token)
            .filterNot { cached ->
                cached.matchesCalendarItem(oldItemKey) ||
                    cached.matchesCalendarItem(post.calendarItemKey()) ||
                    (post.pedidoId.isNotBlank() && cached.pedidoId == post.pedidoId)
            }
            .plus(post)
        save(token, updated)
    }

    private fun cacheKey(token: String): String {
        return "$KEY_CALENDAR_PREFIX${token.sha256().take(24)}"
    }

    private fun MonthlyPlanningPostDto.toJson(): JSONObject {
        return JSONObject()
            .put("number", number)
            .put("item_id", itemId)
            .put("planning_id", planningId)
            .put("planejamento_item_id", planejamentoItemId)
            .put("date", date)
            .put("time", time)
            .put("theme", theme)
            .put("objective", objective)
            .put("status", status)
            .put("status_label", statusLabel)
            .put("caption", caption)
            .put("pedido_id", pedidoId)
            .put("image_ready", imageReady)
            .put("image_text", imageText)
            .put("thumbnail_url", thumbnailUrl)
    }

    private fun JSONObject.toMonthlyPlanningPostDto(): MonthlyPlanningPostDto {
        return MonthlyPlanningPostDto(
            number = optInt("number", 0),
            itemId = optString("item_id"),
            planningId = optString("planning_id"),
            planejamentoItemId = optString("planejamento_item_id"),
            date = optString("date"),
            time = optString("time"),
            theme = optString("theme"),
            objective = optString("objective"),
            status = optString("status"),
            statusLabel = optString("status_label"),
            caption = optString("caption"),
            pedidoId = optString("pedido_id"),
            imageReady = optBoolean("image_ready", false),
            imageText = optString("image_text"),
            thumbnailUrl = optString("thumbnail_url")
        )
    }

    private fun MonthlyPlanningPostDto.matchesCalendarItem(itemKey: String): Boolean {
        if (itemKey.isBlank()) return false
        return itemKey == calendarItemKey() ||
            itemKey == itemId ||
            itemKey == planejamentoItemId ||
            itemKey == pedidoId
    }

    private fun MonthlyPlanningPostDto.calendarItemKey(): String {
        val effectiveItemId = planejamentoItemId.ifBlank { itemId }
            .ifBlank { pedidoId }
            .ifBlank { number.toString() }
        return listOf(planningId, effectiveItemId)
            .filter { it.isNotBlank() }
            .joinToString(":")
            .ifBlank { itemId.ifBlank { number.toString() } }
    }

    private fun String.sha256(): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { byte -> "%02x".format(byte) }
    }

    private companion object {
        const val PREFERENCES_NAME = "ia4tube_monthly_planning_calendar_cache"
        const val KEY_CALENDAR_PREFIX = "calendar_"
    }
}
