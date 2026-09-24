package br.com.ia4tube.app.feature.calendar

import android.app.Application
import android.net.Uri
import androidx.media3.datasource.DataSpec
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
class CalendarVideoDataSourceTest {
    private val id = "a".repeat(40)
    private val path = "/v1/social/calendar/items/$id/video"
    private val video = GeneratedCalendarVideo(path, 9, "b".repeat(64), true)

    @Test fun videoRangeIsAuthenticatedAndReadFromTheOwnedRoute() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setResponseCode(206).addHeader("Content-Type", "video/mp4")
                .addHeader("Content-Range", "bytes 3-8/9").setBody("thetic"))
            val origin = server.url("/").toString().trimEnd('/')
            val source = CalendarVideoDataSource(video, "owner-token", origin)
            try {
                assertEquals(6L, source.open(DataSpec.Builder().setUri(Uri.parse("$origin$path")).setPosition(3).build()))
                val buffer = ByteArray(6)
                assertEquals(6, source.read(buffer, 0, buffer.size))
                assertEquals("thetic", String(buffer))
                val request = server.takeRequest(1, TimeUnit.SECONDS)!!
                assertEquals(path, request.path)
                assertEquals("bytes=3-8", request.getHeader("Range"))
                assertEquals("Bearer owner-token", request.getHeader("Authorization"))
            } finally { source.close() }
        }
    }

    @Test fun redirectNeverForwardsBearerToAnotherHost() {
        MockWebServer().use { sourceServer -> MockWebServer().use { otherServer ->
            sourceServer.start(); otherServer.start()
            sourceServer.enqueue(MockResponse().setResponseCode(302).addHeader("Location", otherServer.url("/stolen")))
            otherServer.enqueue(MockResponse().setResponseCode(200).addHeader("Content-Type", "video/mp4").setBody("synthetic"))
            val origin = sourceServer.url("/").toString().trimEnd('/')
            val source = CalendarVideoDataSource(video, "owner-token", origin)
            try {
                assertThrows(IOException::class.java) {
                    source.open(DataSpec(Uri.parse("$origin$path")))
                }
                assertEquals(1, sourceServer.requestCount)
                assertEquals(0, otherServer.requestCount)
            } finally { source.close() }
        } }
    }
}
