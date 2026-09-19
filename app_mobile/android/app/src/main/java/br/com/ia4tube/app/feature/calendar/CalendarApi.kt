package br.com.ia4tube.app.feature.calendar

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import java.time.LocalDate
import java.util.concurrent.TimeUnit
import br.com.ia4tube.app.feature.calendar.imports.ImportOwner
import br.com.ia4tube.app.feature.calendar.imports.ImportPrivatePreview

internal const val CALENDAR_ORIGIN = "https://ia4tube-api.onrender.com"

// Calendar reads may wait for the server; retain a bounded total and never retry writes.
internal fun calendarHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
    .readTimeout(60, TimeUnit.SECONDS).callTimeout(60, TimeUnit.SECONDS).build()
data class ScheduledArt(
    val id: String, val key: String, val date: String, val time: String, val caption: String,
    val revision: Long, val status: String, val statusLabel: String, val editable: Boolean,
    val automatic: Boolean, val imageUrl: String?, val username: String?, val scheduledAt: Long,
    val destination: String = "feed", val previews: Map<String, String> = emptyMap(),
    val formatsReady: Boolean = false, val publications: Map<String, String> = emptyMap(),
    val sourceKind: String = "generated", val media: ImportPrivatePreview? = null,
    val selectedTargets: List<String> = emptyList(), val shareToFeed: Boolean = false,
    val title: String = "Arte planejada", val localSimulation: Boolean = false
)
data class CalendarSnapshot(
    val enabled: Boolean = false, val automatic: Boolean = false, val preferenceRevision: Long = 0,
    val connected: Boolean = false, val username: String? = null, val operationsAllowed: Boolean = false,
    val items: List<ScheduledArt> = emptyList(), val next: ScheduledArt? = null,
    val storyEligible: Boolean = false, val identity: ImportOwner? = null
)
interface CalendarGateway {
    suspend fun list(): CalendarSnapshot
    suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot
    suspend fun edit(item: ScheduledArt, action: String, caption: String = "", date: String = "", time: String = ""): CalendarSnapshot
    suspend fun destination(item: ScheduledArt, destination: String): CalendarSnapshot = throw CalendarFailure(400)
    suspend fun automatic(item: ScheduledArt, enabled: Boolean): CalendarSnapshot = throw CalendarFailure(400)
}
internal fun galleryItems(items: List<ScheduledArt>, today: LocalDate): List<ScheduledArt> = items
    .filter { it.date >= today.toString() || (it.automatic && it.status != "published") }
    .sortedWith(compareBy<ScheduledArt> { it.scheduledAt }.thenBy { it.id })

internal fun parseCalendar(root: JSONObject): CalendarSnapshot {
    require(root.getBoolean("ok"))
    if (!root.getBoolean("enabled")) return CalendarSnapshot()
    val preferences = root.getJSONObject("preferences")
    val identity = root.optJSONObject("identity")?.let(::parseCalendarImportOwner)
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
        val destination = item.optString("destination", "feed"); require(destination in setOf("feed", "story", "both", "reel", "multiple"))
        val sourceKind = item.optString("sourceKind", "generated"); require(sourceKind in setOf("generated", "planning", "order", "upload"))
        val media = item.optJSONObject("media")?.let { parseScheduledImportPreview(it, id) }
        require(media != null || destination in setOf("feed", "story", "both"))
        require(media == null || (identity != null && sourceKind == "upload" && image == null))
        require(sourceKind != "upload" || media != null)
        val previews = mutableMapOf<String, String>()
        val rawPreviews = item.optJSONObject("previews")
        for (target in listOf("feed", "story")) rawPreviews?.optString(target)?.takeIf { it.isNotBlank() }?.let { url ->
            require(url == "/v1/social/calendar/items/$id/image?destination=$target"); previews[target] = url
        }
        val publications = mutableMapOf<String, String>()
        for (target in listOf("feed", "story", "reel")) item.optJSONObject("publications")?.optJSONObject(target)?.let {
            publications[target] = it.optString("status", "confirming")
        }
        val targets = item.optJSONArray("selectedTargets")?.let { raw ->
            require(raw.length() in 1..2)
            (0 until raw.length()).map { raw.getString(it).also { target -> require(target in setOf("feed", "story", "reel")) } }
                .also { require(it.distinct().size == it.size) }
        } ?: when (destination) { "both" -> listOf("feed", "story"); else -> listOf(destination) }
        require(media == null || targets.toSet() == media.variants.map { it.target }.toSet())
        val shareToFeed = item.optJSONObject("media")?.let { value ->
            value.get("shareToFeed").also { require(it is Boolean) } as Boolean
        } ?: false
        val localSimulation = if (item.has("localSimulation")) item.get("localSimulation").also { require(it is Boolean) } as Boolean else false
        if (media != null) {
            require(if (targets.size == 1) destination == targets.single()
                else destination == "multiple" || destination == "both" && targets.toSet() == setOf("feed", "story"))
            require(!shareToFeed || "reel" in targets && "feed" !in targets)
            require(!media.testOnly || localSimulation)
        }
        ScheduledArt(id, item.getString("key"), date, time, caption, revision,
            item.getString("status"), item.getString("statusLabel"), item.getBoolean("editable"),
            item.getBoolean("automatic"), image, item.optString("username").takeUnless { item.isNull("username") }, item.getLong("scheduledAt"),
            destination, previews, item.optBoolean("formatsReady", false), publications, sourceKind, media, targets,
            shareToFeed, item.optString("title", if (media != null) "Mídia da galeria" else "Arte planejada"), localSimulation)
    }
    require(items.map { it.id }.distinct().size == items.size)
    val connection = root.optJSONObject("connection")
    val nextId = root.optJSONObject("next")?.getString("id")
    return CalendarSnapshot(true, preferences.getBoolean("enabled"), preferences.getLong("revision"),
        connection != null, connection?.optString("username"), root.getBoolean("operationsAllowed"), items, items.find { it.id == nextId },
        connection?.optString("accountType") == "business", identity)
}

class CalendarApi internal constructor(private val token: String, private val origin: String,
    private val client: OkHttpClient) : CalendarGateway {
    constructor(token: String) : this(token, CALENDAR_ORIGIN, calendarHttpClient())
    private suspend fun request(path: String = "", body: JSONObject? = null): CalendarSnapshot = withContext(Dispatchers.IO) {
        require(token.isNotBlank())
        val request = Request.Builder().url("$origin/v1/social/calendar$path")
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
    override suspend fun destination(item: ScheduledArt, destination: String): CalendarSnapshot {
        require(destination in setOf("feed", "story", "both") && item.id.matches(Regex("[a-f0-9]{40}")))
        return request("/items/${item.id}", JSONObject().put("action", "destination").put("revision", item.revision)
            .put("destination", destination).put("confirmed", true))
    }
    override suspend fun automatic(item: ScheduledArt, enabled: Boolean): CalendarSnapshot {
        require(item.id.matches(Regex("[a-f0-9]{40}")))
        return request("/items/${item.id}", JSONObject().put("action", "automatic").put("revision", item.revision)
            .put("enabled", enabled).put("confirmed", true))
    }
    override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot {
        require(item.id.matches(Regex("[a-f0-9]{40}")) && action in setOf("caption", "schedule", "cancel"))
        return request("/items/${item.id}", JSONObject().put("action", action).put("revision", item.revision)
            .put("caption", caption).put("date", date).put("time", time))
    }
}
class CalendarFailure(val status: Int) : Exception("Não foi possível atualizar a programação.")
