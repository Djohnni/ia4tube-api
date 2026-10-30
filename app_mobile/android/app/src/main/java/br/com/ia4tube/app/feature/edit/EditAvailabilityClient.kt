package br.com.ia4tube.app.feature.edit

import br.com.ia4tube.app.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

internal data class EditAvailabilitySnapshot(
    val canImage: Boolean?, val canVideo: Boolean?, val observedAt: Long, val validUntil: Long,
)
internal class EditAvailabilityException(val code: String) : Exception(code)

internal class EditAvailabilityClient(
    private val baseUrl: String = BuildConfig.API_BASE,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).build(),
) {
    suspend fun read(token: String): EditAvailabilitySnapshot = withContext(Dispatchers.IO) {
        if (token.isBlank()) throw EditAvailabilityException("auth_required")
        val request = Request.Builder().url(baseUrl.trimEnd('/') + "/empresa/edit/availability")
            .header("Authorization", "Bearer $token").header("Cache-Control", "no-store").get().build()
        try {
            client.newCall(request).execute().use { response ->
                if (response.code == 401) throw EditAvailabilityException("auth_required")
                if (!response.isSuccessful) throw EditAvailabilityException("availability_unavailable")
                val source = response.body?.source() ?: throw EditAvailabilityException("invalid_availability_response")
                source.request(8193)
                if (source.buffer.size > 8192) throw EditAvailabilityException("invalid_availability_response")
                parse(source.readUtf8())
            }
        } catch (error: EditAvailabilityException) { throw error }
        catch (_: Exception) { throw EditAvailabilityException("availability_unavailable") }
    }

    companion object {
        internal fun parse(text: String): EditAvailabilitySnapshot {
            try {
                val result = JSONObject(text)
                if (result.length() != 2 || result.opt("ok") != true) invalid()
                val value = result.optJSONObject("availability") ?: invalid()
                val keys = setOf("schemaVersion", "canImage", "canVideo", "observedAt", "validUntil")
                if (value.keys().asSequence().toSet() != keys || value.opt("schemaVersion") != 1) invalid()
                fun flag(key: String): Boolean? = when (val raw = value.get(key)) {
                    JSONObject.NULL -> null
                    is Boolean -> raw
                    else -> invalid()
                }
                fun timestamp(key: String): Long {
                    val raw = value.get(key)
                    if (raw !is Long && raw !is Int) invalid()
                    return (raw as Number).toLong().takeIf { it in 1..9_007_199_254_740_991L } ?: invalid()
                }
                val observed = timestamp("observedAt")
                val until = timestamp("validUntil")
                if (until - observed !in 1..30_000L) invalid()
                return EditAvailabilitySnapshot(flag("canImage"), flag("canVideo"), observed, until)
            } catch (error: EditAvailabilityException) { throw error }
            catch (_: Exception) { invalid() }
        }
        private fun invalid(): Nothing = throw EditAvailabilityException("invalid_availability_response")
    }
}
