package br.com.ia4tube.app.feature.calendar

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** Authenticated calendar video reads reject every HTTP redirect, including HTTPS to HTTPS. */
internal class CalendarVideoDataSource(private val video: GeneratedCalendarVideo, private val token: String,
    private val origin: String = CALENDAR_ORIGIN,
    private val client: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).connectTimeout(10, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()
) : BaseDataSource(true) {
    private val expectedUrl = origin + video.url
    private var response: Response? = null
    private var stream: InputStream? = null
    private var remaining = 0L
    private var opened = false

    init {
        require(video.url.matches(Regex("/v1/social/calendar/items/[a-f0-9]{40}/video")))
        require(token.isNotBlank())
    }

    override fun open(dataSpec: DataSpec): Long {
        if (opened || dataSpec.uri.toString() != expectedUrl || dataSpec.position !in 0 until video.sizeBytes)
            throw IOException("Vídeo do calendário inválido")
        transferInitializing(dataSpec)
        val start = dataSpec.position
        val requested = dataSpec.length
        if (requested != C.LENGTH_UNSET.toLong() && requested <= 0) throw IOException("Intervalo inválido")
        val end = if (requested == C.LENGTH_UNSET.toLong()) video.sizeBytes - 1
            else (start + requested - 1).coerceAtMost(video.sizeBytes - 1)
        val builder = Request.Builder().url(expectedUrl).get()
            .header("Authorization", "Bearer $token")
            .header("Cache-Control", "no-store")
            .header("Accept-Encoding", "identity")
        val range = start > 0 || requested != C.LENGTH_UNSET.toLong()
        if (range) builder.header("Range", "bytes=$start-$end")
        val result = client.newCall(builder.build()).execute()
        try {
            if (result.code !in setOf(200, 206) || range && result.code != 206 || !range && result.code != 200)
                throw IOException("Resposta de vídeo inválida")
            if (result.header("Content-Type")?.substringBefore(';')?.trim()?.lowercase() != "video/mp4")
                throw IOException("Tipo de vídeo inválido")
            val expectedLength = end - start + 1
            val body = result.body ?: throw IOException("Vídeo vazio")
            val length = body.contentLength()
            if (length != -1L && length != expectedLength) throw IOException("Tamanho de vídeo inválido")
            if (range) {
                val match = Regex("bytes (\\d+)-(\\d+)/(\\d+)").matchEntire(result.header("Content-Range").orEmpty())
                    ?: throw IOException("Intervalo de vídeo inválido")
                if (match.groupValues[1].toLong() != start || match.groupValues[2].toLong() != end ||
                    match.groupValues[3].toLong() != video.sizeBytes) throw IOException("Intervalo de vídeo inválido")
            }
            response = result
            stream = body.byteStream()
            remaining = expectedLength
            opened = true
            transferStarted(dataSpec)
            return remaining
        } catch (error: Exception) {
            result.close()
            throw error
        }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (!opened) throw IOException("Vídeo fechado")
        if (remaining == 0L) return C.RESULT_END_OF_INPUT
        val count = stream!!.read(buffer, offset, minOf(length.toLong(), remaining).toInt())
        if (count < 0) throw IOException("Vídeo incompleto")
        remaining -= count
        bytesTransferred(count)
        return count
    }

    override fun getUri(): Uri? = if (opened) Uri.parse(expectedUrl) else null
    override fun getResponseHeaders(): Map<String, List<String>> = response?.headers?.toMultimap() ?: emptyMap()
    override fun close() {
        val wasOpen = opened
        opened = false
        remaining = 0
        stream = null
        response?.close()
        response = null
        if (wasOpen) transferEnded()
    }

    class Factory(private val video: GeneratedCalendarVideo, private val token: String) : DataSource.Factory {
        override fun createDataSource(): DataSource = CalendarVideoDataSource(video, token)
    }
}
