package br.com.ia4tube.app.feature.calendar

import br.com.ia4tube.app.core.art_cache.isPrivateArtUrl
import br.com.ia4tube.app.core.art_cache.privateArtKey
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class CalendarDestinationTest {
    private val id = "a".repeat(40)
    private val path = "/v1/social/calendar/items/$id/image"
    private fun payload(): JSONObject {
        val item = JSONObject().put("id", id).put("key", "synthetic:1")
            .put("date", "2026-09-10").put("time", "18:30").put("caption", "Legenda do Feed")
            .put("revision", 2).put("status", "scheduled").put("statusLabel", "Programada")
            .put("editable", true).put("automatic", true).put("imageUrl", path)
            .put("username", "synthetic").put("scheduledAt", 1789077000000)
            .put("destination", "both").put("formatsReady", true)
            .put("previews", JSONObject().put("feed", "$path?destination=feed").put("story", "$path?destination=story"))
            .put("publications", JSONObject().put("feed", JSONObject().put("status", "published")))
        return JSONObject().put("ok", true).put("enabled", true).put("operationsAllowed", false)
            .put("preferences", JSONObject().put("enabled", true).put("revision", 2))
            .put("connection", JSONObject().put("username", "synthetic").put("accountType", "business"))
            .put("items", JSONArray().put(item)).put("next", item)
    }
    @Test fun bothPreviewsAndPerArtPreferenceAreDistinctFromActualAvailability() {
        val snapshot = parseCalendar(payload()); val art = snapshot.items.single()
        assertEquals("both", art.destination); assertTrue(art.automatic); assertTrue(art.formatsReady)
        assertFalse(snapshot.operationsAllowed); assertTrue(snapshot.storyEligible)
        assertEquals(2, art.previews.size); assertEquals("published", art.publications["feed"])
        assertEquals("Legenda do Feed", art.caption)
    }
    @Test fun foreignPreviewAndUnknownDestinationAreRejected() {
        for (bad in listOf("https://foreign.invalid/image", "/v1/social/calendar/items/${"b".repeat(40)}/image?destination=feed", "$path?destination=story")) {
            val body = payload(); body.getJSONArray("items").getJSONObject(0).getJSONObject("previews").put("feed", bad)
            assertThrows(IllegalArgumentException::class.java) { parseCalendar(body) }
        }
        val body = payload(); body.getJSONArray("items").getJSONObject(0).put("destination", "reel")
        assertThrows(IllegalArgumentException::class.java) { parseCalendar(body) }
    }
    @Test fun variantCacheKeepsOwnerAndPlacementSeparatedAndDoesNotPermitOtherQueries() {
        val origin = CALENDAR_ORIGIN.toHttpUrl()
        val feed = "$CALENDAR_ORIGIN$path?destination=feed".toHttpUrl()
        val story = "$CALENDAR_ORIGIN$path?destination=story".toHttpUrl()
        assertTrue(isPrivateArtUrl(feed, origin)); assertTrue(isPrivateArtUrl(story, origin))
        assertNotEquals(privateArtKey("a", feed), privateArtKey("a", story))
        assertNotEquals(privateArtKey("a", feed), privateArtKey("b", feed))
        for (suffix in listOf("?destination=reel", "?destination=feed&destination=story", "?destination=story&token=x"))
            assertFalse(isPrivateArtUrl("$CALENDAR_ORIGIN$path$suffix".toHttpUrl(), origin))
    }
    @Test fun confirmedDestinationAndPauseAreSingleRevisionBoundPosts() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.enqueue(MockResponse().setBody(payload().toString())); server.enqueue(MockResponse().setBody(payload().toString()))
            val client = calendarHttpClient()
            try {
                val api = CalendarApi("synthetic-only", server.url("/").toString().trimEnd('/'), client)
                val item = parseCalendar(payload()).items.single()
                api.destination(item, "story"); api.automatic(item, false)
                val first = JSONObject(server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8())
                assertEquals("destination", first.getString("action")); assertEquals("story", first.getString("destination"))
                assertEquals(2, first.getInt("revision")); assertTrue(first.getBoolean("confirmed"))
                val second = JSONObject(server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8())
                assertEquals("automatic", second.getString("action")); assertFalse(second.getBoolean("enabled"))
                assertEquals(2, server.requestCount); assertNull(server.takeRequest(100, TimeUnit.MILLISECONDS))
            } finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
        }
    }
}
