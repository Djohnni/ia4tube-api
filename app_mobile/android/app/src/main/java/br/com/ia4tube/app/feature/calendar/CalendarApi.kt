package br.com.ia4tube.app.feature.calendar

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneId
import java.util.concurrent.TimeUnit

internal const val CALENDAR_ORIGIN = "https://ia4tube-api.onrender.com"
data class ScheduledArt(
    val id: String, val key: String, val date: String, val time: String, val caption: String,
    val revision: Long, val status: String, val statusLabel: String, val editable: Boolean,
    val automatic: Boolean, val imageUrl: String?, val username: String?, val scheduledAt: Long
)
data class CalendarSnapshot(
    val enabled: Boolean = false, val automatic: Boolean = false, val preferenceRevision: Long = 0,
    val connected: Boolean = false, val username: String? = null, val operationsAllowed: Boolean = false,
    val items: List<ScheduledArt> = emptyList(), val next: ScheduledArt? = null
)
interface CalendarGateway {
    suspend fun list(): CalendarSnapshot
    suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot
    suspend fun edit(item: ScheduledArt, action: String, caption: String = "", date: String = "", time: String = ""): CalendarSnapshot
}
internal fun galleryItems(items: List<ScheduledArt>, today: LocalDate): List<ScheduledArt> = items
    .filter { it.date >= today.toString() || (it.automatic && it.status != "published") }
    .sortedWith(compareBy<ScheduledArt> { it.scheduledAt }.thenBy { it.id })

internal fun parseCalendar(root: JSONObject): CalendarSnapshot {
    require(root.getBoolean("ok"))
    if (!root.getBoolean("enabled")) return CalendarSnapshot()
    val preferences = root.getJSONObject("preferences")
    val rawItems = root.getJSONArray("items"); require(rawItems.length() <= 1000)
    val items = (0 until rawItems.length()).map { index ->
        val item = rawItems.getJSONObject(index)
        val id = item.getString("id"); require(id.matches(Regex("[a-f0-9]{40}")))
        val caption = item.getString("caption"); require(caption.length <= 2200)
        val image = item.optString("imageUrl").takeIf { !item.isNull("imageUrl") && it.isNotBlank() }
        require(image == null || image == "/v1/social/calendar/items/$id/image")
        val date = item.getString("date"); LocalDate.parse(date)
        val time = item.getString("time"); require(time.matches(Regex("([01]\\d|2[0-3]):[0-5]\\d")))
        val revision = item.getLong("revision"); require(revision > 0)
        ScheduledArt(id, item.getString("key"), date, time, caption, revision,
            item.getString("status"), item.getString("statusLabel"), item.getBoolean("editable"),
            item.getBoolean("automatic"), image, item.optString("username").takeUnless { item.isNull("username") }, item.getLong("scheduledAt"))
    }
    require(items.map { it.id }.distinct().size == items.size)
    val connection = root.optJSONObject("connection")
    val nextId = root.optJSONObject("next")?.getString("id")
    return CalendarSnapshot(true, preferences.getBoolean("enabled"), preferences.getLong("revision"),
        connection != null, connection?.optString("username"), root.getBoolean("operationsAllowed"), items, items.find { it.id == nextId })
}

class CalendarApi(private val token: String) : CalendarGateway {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).callTimeout(30, TimeUnit.SECONDS).build()
    private suspend fun request(path: String = "", body: JSONObject? = null): CalendarSnapshot = withContext(Dispatchers.IO) {
        require(token.isNotBlank())
        val request = Request.Builder().url("$CALENDAR_ORIGIN/v1/social/calendar$path")
            .header("Authorization", "Bearer $token").header("Cache-Control", "no-store")
        if (body != null) request.post(body.toString().toRequestBody("application/json".toMediaType()))
        client.newCall(request.build()).execute().use { response ->
            if (response.code == 404 && body == null && path.isEmpty()) return@withContext CalendarSnapshot()
            if (!response.isSuccessful) throw CalendarFailure(response.code)
            val bodyStream = response.body ?: throw CalendarFailure(503)
            val output = java.io.ByteArrayOutputStream()
            val input = bodyStream.byteStream(); val buffer = ByteArray(8192)
            while (true) { val count = input.read(buffer); if (count < 0) break
                require(output.size() + count <= 4 * 1024 * 1024); output.write(buffer, 0, count) }
            val bytes = output.toByteArray()
            parseCalendar(JSONObject(String(bytes, Charsets.UTF_8)))
        }
    }
    override suspend fun list() = request()
    override suspend fun preferences(enabled: Boolean, revision: Long) = request("/preferences",
        JSONObject().put("enabled", enabled).put("revision", revision).put("confirmed", true))
    override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot {
        require(item.id.matches(Regex("[a-f0-9]{40}")) && action in setOf("caption", "schedule", "cancel"))
        return request("/items/${item.id}", JSONObject().put("action", action).put("revision", item.revision)
            .put("caption", caption).put("date", date).put("time", time))
    }
}
class CalendarFailure(val status: Int) : Exception("Não foi possível atualizar a programação.")
