package br.com.ia4tube.app.feature.edit

import br.com.ia4tube.app.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit

internal data class EditCalendarTicket(val ticket: String, val expiresAt: String)
internal class EditCalendarException(val code: String) : Exception(code)

internal class EditCalendarClient(
    private val baseUrl: String = BuildConfig.API_BASE,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS).readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).build(),
) {
    suspend fun create(token: String, requestId: String, schedule: EditCalendarSchedule): EditCalendarTicket = withContext(Dispatchers.IO) {
        if (token.isBlank()) throw EditCalendarException("auth_required")
        if (!EditCalendarPolicy.validRequestId(requestId) || !schedule.isFuture()) throw EditCalendarException("invalid_schedule")
        val body = JSONObject().put("requestId", requestId).put("date", schedule.date)
            .put("time", schedule.time).put("destination", "reel")
        val request = Request.Builder().url(baseUrl.trimEnd('/') + "/empresa/edit/context")
            .header("Authorization", "Bearer $token").header("Cache-Control", "no-store")
            .post(body.toString().toRequestBody("application/json; charset=utf-8".toMediaType())).build()
        try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (response.code == 401) throw EditCalendarException("auth_required")
                if (!response.isSuccessful || text.length > 8192) throw EditCalendarException("calendar_unavailable")
                val result = JSONObject(text)
                val ticket = result.optString("ticket")
                val expiry = result.optString("expiresAt")
                if (!result.optBoolean("ok") || !EditCalendarPolicy.validTicket(ticket) ||
                    !Instant.parse(expiry).isAfter(Instant.now())) throw EditCalendarException("invalid_calendar_response")
                EditCalendarTicket(ticket, expiry)
            }
        } catch (error: EditCalendarException) { throw error }
        catch (_: Exception) { throw EditCalendarException("calendar_unavailable") }
    }
}
