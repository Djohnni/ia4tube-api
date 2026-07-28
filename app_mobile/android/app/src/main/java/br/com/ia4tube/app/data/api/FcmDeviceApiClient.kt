package br.com.ia4tube.app.data.api

import br.com.ia4tube.app.core.config.AppConfig
import br.com.ia4tube.app.data.models.ApiResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

interface FcmDeviceBackend {
    suspend fun register(
        authToken: String,
        fcmToken: String,
        previousToken: String = ""
    ): ApiResult<Unit>
    suspend fun deactivate(authToken: String, fcmToken: String): ApiResult<Unit>
}

class FcmDeviceApiClient(
    baseUrl: String = AppConfig.apiBase,
    private val client: OkHttpClient = defaultClient()
) : FcmDeviceBackend {
    private val normalizedBaseUrl = baseUrl.trim().trimEnd('/').also { value ->
        val parsed = value.toHttpUrlOrNull()
            ?: throw IllegalArgumentException("Base FCM invalida.")
        val loopback = parsed.host == "localhost" ||
            parsed.host == "127.0.0.1" ||
            parsed.host == "::1"
        require(parsed.isHttps || loopback) {
            "Base FCM deve usar HTTPS."
        }
    }

    override suspend fun register(
        authToken: String,
        fcmToken: String,
        previousToken: String
    ): ApiResult<Unit> {
        return execute(
            buildRequest(
                method = "POST",
                authToken = authToken,
                fcmToken = fcmToken,
                previousToken = previousToken
            )
        )
    }

    override suspend fun deactivate(
        authToken: String,
        fcmToken: String
    ): ApiResult<Unit> {
        return execute(
            buildRequest(
                method = "DELETE",
                authToken = authToken,
                fcmToken = fcmToken
            )
        )
    }

    private fun buildRequest(
        method: String,
        authToken: String,
        fcmToken: String,
        previousToken: String = ""
    ): Request {
        val bodyJson = JSONObject()
            .put("token", fcmToken)
            .put("platform", "android")
        if (method == "POST" && previousToken.isNotBlank()) {
            bodyJson.put("previous_token", previousToken)
        }
        val body = bodyJson
            .toString()
            .toRequestBody(JSON)
        val builder = Request.Builder()
            .url("$normalizedBaseUrl/me/fcm-token")
            .header("Authorization", "Bearer $authToken")
        return when (method) {
            "POST" -> builder.post(body).build()
            "DELETE" -> builder.delete(body).build()
            else -> error("Metodo FCM invalido.")
        }
    }

    private suspend fun execute(request: Request): ApiResult<Unit> = withContext(Dispatchers.IO) {
        try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                val json = runCatching {
                    if (text.isBlank()) JSONObject() else JSONObject(text)
                }.getOrElse {
                    return@withContext ApiResult.Failure(
                        message = GENERIC_FAILURE,
                        statusCode = response.code,
                        code = "fcm_response_invalid"
                    )
                }

                if (!response.isSuccessful || !json.optBoolean("ok", false)) {
                    return@withContext ApiResult.Failure(
                        message = GENERIC_FAILURE,
                        statusCode = response.code,
                        code = json.optString("code").ifBlank { "fcm_request_failed" }
                    )
                }
                ApiResult.Success(Unit)
            }
        } catch (error: IOException) {
            ApiResult.Failure(
                message = GENERIC_FAILURE,
                code = if (error is SocketTimeoutException) {
                    "network_timeout"
                } else {
                    "network_unavailable"
                }
            )
        } catch (_: Exception) {
            ApiResult.Failure(
                message = GENERIC_FAILURE,
                code = "fcm_request_failed"
            )
        }
    }

    private companion object {
        const val GENERIC_FAILURE = "Nao foi possivel atualizar as notificacoes."
        val JSON = "application/json; charset=utf-8".toMediaType()

        fun defaultClient(): OkHttpClient {
            return OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(5, TimeUnit.SECONDS)
                .writeTimeout(5, TimeUnit.SECONDS)
                .build()
        }
    }
}
