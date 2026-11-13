package br.com.ia4tube.app.data.api

import br.com.ia4tube.app.core.config.AppConfig
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.LoginResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Uses only the existing Google authentication routes. Never follows redirects with an ID token. */
internal class GoogleAuthApiClient(
    private val baseUrl: String = AppConfig.apiBase,
    client: OkHttpClient = OkHttpClient()
) {
    private val http = client.newBuilder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()

    suspend fun clientId(): ApiResult<String> = withContext(Dispatchers.IO) {
        try {
            http.newCall(Request.Builder().url("${baseUrl.trimEnd('/')}/auth/google-config")
                .header("Cache-Control", "no-store").get().build()).execute().use { response ->
                if (!response.isSuccessful) return@withContext ApiResult.Failure(ERROR, response.code)
                val json = JSONObject(response.body?.string().orEmpty())
                val id = json.optString("client_id").trim()
                if (!json.optBoolean("ok") || !Regex("^[0-9]+-[a-zA-Z0-9_-]+\\.apps\\.googleusercontent\\.com$").matches(id))
                    return@withContext ApiResult.Failure(ERROR)
                ApiResult.Success(id)
            }
        } catch (_: Exception) { ApiResult.Failure(ERROR) }
    }

    suspend fun signIn(idToken: String): ApiResult<LoginResponse> = withContext(Dispatchers.IO) {
        if (idToken.isBlank() || idToken.length > 16_384) return@withContext ApiResult.Failure(ERROR)
        try {
            val body = JSONObject().put("id_token", idToken).toString()
                .toRequestBody("application/json; charset=utf-8".toMediaType())
            http.newCall(Request.Builder().url("${baseUrl.trimEnd('/')}/auth/google")
                .header("Cache-Control", "no-store").post(body).build()).execute().use { response ->
                if (!response.isSuccessful) return@withContext ApiResult.Failure(ERROR, response.code)
                val json = JSONObject(response.body?.string().orEmpty())
                val token = json.optString("token").trim()
                if (!json.optBoolean("ok") || token.isBlank()) return@withContext ApiResult.Failure(ERROR)
                ApiResult.Success(LoginResponse(token, json.optString("nome_time"), json.optDouble("saldo", 0.0)))
            }
        } catch (_: Exception) { ApiResult.Failure(ERROR) }
    }

    private companion object { const val ERROR = "Não foi possível entrar com Google. Tente novamente." }
}
