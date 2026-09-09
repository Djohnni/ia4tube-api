package br.com.ia4tube.app.feature.calendar

import br.com.ia4tube.app.core.art_cache.privateArtHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class CalendarTimeoutTest {
    @Test fun calendarAndImageClientAllowOneMinuteWithoutRelaxingConnectionPolicies() {
        for (client in listOf(calendarHttpClient(), privateArtHttpClient())) {
        assertEquals(60_000, client.readTimeoutMillis)
        assertEquals(60_000, client.callTimeoutMillis)
        assertEquals(10_000, client.connectTimeoutMillis)
        assertEquals(10_000, client.writeTimeoutMillis)
        assertFalse(client.followRedirects)
        assertFalse(client.followSslRedirects)
        assertFalse(client.retryOnConnectionFailure)
        assertNull(client.cache)
        }
    }

    @Test fun responseSlowerThanOldTenSecondLimitCompletesOnce() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeadersDelay(12, TimeUnit.SECONDS).setBody("synthetic-calendar"))
            server.start()
            val client = calendarHttpClient()
            try {
                client.newCall(Request.Builder().url(server.url("/synthetic-calendar")).build()).execute().use {
                    assertEquals(200, it.code)
                    assertEquals("synthetic-calendar", it.body!!.string())
                }
                assertEquals(1, server.requestCount)
            } finally {
                client.connectionPool.evictAll()
                client.dispatcher.executorService.shutdown()
            }
        }
    }
}
