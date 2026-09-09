package br.com.ia4tube.app.feature.instagram

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.time.Instant
import java.util.concurrent.TimeUnit

/** Uses the official app session. No reviewer credentials, redirects, logging or automatic retries. */
class InstagramApiClient private constructor(
    private val tokenProvider: () -> String,
    private val apiBase: String,
    private val transportBase: String,
    private val client: OkHttpClient
) : InstagramGateway {
    constructor(tokenProvider: () -> String, apiBase: String) :
        this(tokenProvider, apiBase, apiBase.trimEnd('/'), defaultClient())

    override suspend fun currentConnection(): InstagramResult<InstagramConnection?> =
        request("/v1/social/connections/instagram") { root ->
            require(root.has("connection"))
            if (root.isNull("connection")) null else parseConnection(root.getJSONObject("connection"))
        }

    override suspend fun authorize(purpose: String): InstagramResult<InstagramAuthorization> {
        if (purpose !in setOf("connect", "reconnect")) return invalidInput()
        return request("/v1/social/connections/instagram/authorization", "POST",
            jsonBody(JSONObject().put("purpose", purpose))) { root ->
            require(root.getString("provider") == "instagram" && root.getString("status") == "authorization_pending")
            val url = root.requiredText("authorizationUrl", 8192)
            require(InstagramPolicies.isOfficialAuthorizationUrl(url))
            InstagramAuthorization(root.requiredUuid("connectionId"), url, root.requiredDate("expiresAt"))
        }
    }

    override suspend fun authorizationStatus(connectionId: String): InstagramResult<InstagramAuthorizationStatus> {
        if (!InstagramPolicies.validUuid(connectionId)) return invalidInput()
        return request("/v1/social/connections/instagram/$connectionId/authorization") { root ->
            val value = root.getJSONObject("authorization")
            val id = value.requiredUuid("connectionId")
            val purpose = value.requiredText("purpose", 12)
            val status = value.requiredText("status", 40)
            require(id.equals(connectionId, true) && purpose in setOf("connect", "reconnect"))
            require(status in AUTHORIZATION_STATES)
            InstagramAuthorizationStatus(id, purpose, status, value.nullableDate("expiresAt"))
        }
    }

    override suspend fun media(): InstagramResult<List<InstagramMedia>> =
        request("/v1/social/reviewer/media") { root ->
            require(root.getBoolean("contentOwnerDerivedFromSession"))
            root.getJSONArray("media").objects(20).map(::parseMedia)
        }

    override suspend fun uploadMedia(jpeg: ByteArray, caption: String): InstagramResult<InstagramMedia> {
        val trace = InstagramUploadRequestTrace()
        if (!InstagramPolicies.validCaption(caption) || !InstagramPolicies.validateJpeg(jpeg)) {
            return uploadFailure(InstagramError.INVALID_INPUT, trace, InstagramRequestStage.LOCAL_VALIDATION,
                "local_invalid_input", false)
        }
        val body = try {
            MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("jpeg", "preview_ia4tube.jpg", jpeg.toRequestBody("image/jpeg".toMediaType()))
                .addFormDataPart("caption", caption).build()
        } catch (_: Exception) {
            return uploadFailure(InstagramError.INVALID_INPUT, trace, InstagramRequestStage.LOCAL_VALIDATION,
                "local_request_failed", false)
        }
        return requestUpload(body, trace)
    }

    /** Only the upload receives diagnostics; all other endpoint/result contracts remain unchanged. */
    private suspend fun requestUpload(body: RequestBody, trace: InstagramUploadRequestTrace): InstagramResult<InstagramMedia> =
        withContext(Dispatchers.IO) {
            if (!InstagramPolicies.isOfficialApiBase(apiBase)) return@withContext uploadFailure(
                InstagramError.UNAVAILABLE, trace, InstagramRequestStage.LOCAL_VALIDATION, "local_unavailable", false)
            val token = try { tokenProvider() } catch (_: Exception) { "" }
            if (token.isBlank() || token.length > 8192 || token.any { it <= ' ' || it == '\u007f' }) {
                return@withContext uploadFailure(InstagramError.SESSION_REQUIRED, trace,
                    InstagramRequestStage.LOCAL_VALIDATION, "local_session_required", false)
            }
            try {
                val request = Request.Builder().url(transportBase + "/v1/social/reviewer/media")
                    .header("Authorization", "Bearer $token").header("Accept", "application/json")
                    .header("Cache-Control", "no-store").post(body).build()
                val call = client.newCall(request)
                trace.startRequest()
                call.execute().use { response ->
                    trace.receiveResponse(response.code)
                    if (response.code !in 100..599) return@withContext uploadInvalidResponse(trace)
                    if (tokenProvider() != token) return@withContext uploadFailure(InstagramError.SESSION_REQUIRED,
                        trace, InstagramRequestStage.HTTP_RESPONSE, "session_changed", true)
                    // A redirect is not an acknowledgement of this endpoint's storage contract.
                    if (response.code in 300..399) return@withContext uploadFailure(InstagramError.UNAVAILABLE,
                        trace, InstagramRequestStage.HTTP_RESPONSE, "http_redirect_refused", true)
                    val responseBody = response.body ?: return@withContext uploadInvalidResponse(trace)
                    if (responseBody.contentLength() > MAX_RESPONSE_BYTES) return@withContext uploadInvalidResponse(trace)
                    val source = responseBody.source()
                    source.request(MAX_RESPONSE_BYTES + 1)
                    if (source.buffer.size > MAX_RESPONSE_BYTES) return@withContext uploadInvalidResponse(trace)
                    val json = try { JSONObject(source.buffer.readUtf8()) }
                        catch (_: Exception) { return@withContext uploadInvalidResponse(trace) }
                    if (response.code in 500..599 || (response.code in 400..499 && json.opt("ok") == false)) {
                        val code = InstagramRequestDiagnostic.normalizedServerCode(json.opt("code"), response.code)
                        val error = when (response.code) {
                            401 -> InstagramError.SESSION_REQUIRED
                            403, 404, 405, 501 -> InstagramError.UNAVAILABLE
                            else -> mapError(response.code, code, false)
                        }
                        return@withContext uploadFailure(error, trace, InstagramRequestStage.HTTP_RESPONSE,
                            code, response.code >= 500)
                    }
                    if (!response.isSuccessful || json.opt("ok") != true) return@withContext uploadInvalidResponse(trace)
                    require(json.opt("contentOwnerDerivedFromSession") == true)
                    InstagramResult.Success(parseMedia(json.getJSONObject("media")),
                        trace.diagnostic(InstagramRequestStage.HTTP_RESPONSE, "http_success", false))
                }
            } catch (cancelled: CancellationException) {
                // The caller's pre-request durable witness remains uncertain; never swallow cancellation.
                throw cancelled
            } catch (_: InterruptedIOException) {
                uploadFailure(InstagramError.NETWORK, trace, InstagramRequestStage.TRANSPORT, "transport_timeout", true)
            } catch (_: IOException) {
                uploadFailure(InstagramError.NETWORK, trace, InstagramRequestStage.TRANSPORT, "transport_failure", true)
            } catch (_: Exception) {
                if (trace.requestStarted) uploadInvalidResponse(trace)
                else uploadFailure(InstagramError.UNAVAILABLE, trace, InstagramRequestStage.LOCAL_VALIDATION,
                    "local_request_failed", false)
            }
        }

    private fun uploadFailure(error: InstagramError, trace: InstagramUploadRequestTrace,
        stage: InstagramRequestStage, code: String, unknown: Boolean) =
        InstagramResult.Failure(error, trace.diagnostic(stage, code, unknown))

    private fun uploadInvalidResponse(trace: InstagramUploadRequestTrace) = uploadFailure(
        InstagramError.INVALID_RESPONSE, trace, InstagramRequestStage.INVALID_RESPONSE, "response_invalid", true)

    override suspend fun publications(): InstagramResult<InstagramHistory> =
        request("/v1/social/reviewer/publications") { root ->
            require(root.getBoolean("canonicalPersistence"))
            val items = root.getJSONArray("publications").objects(100).map(::parsePublication)
            val available = root.getBoolean("freshPublicationAvailable")
            require(!available || items.none { it.pending })
            InstagramHistory(items, available, root.getBoolean("independentReview"))
        }

    override suspend fun publication(publicationId: String): InstagramResult<InstagramPublication> {
        if (!InstagramPolicies.validUuid(publicationId)) return invalidInput()
        return request("/v1/social/reviewer/publications/$publicationId") { root ->
            parsePublication(root.getJSONObject("publication")).also {
                require(it.publicationId.equals(publicationId, true))
            }
        }
    }

    override suspend fun publish(mediaId: String, clientRequestId: String, binding: InstagramConnectionBinding): InstagramResult<InstagramPublication> {
        if (!InstagramPolicies.validMediaId(mediaId) || !InstagramPolicies.validUuid(clientRequestId) || !binding.valid) return invalidInput()
        return request("/v1/social/reviewer/publications", "POST", jsonBody(JSONObject()
            .put("mediaId", mediaId).put("clientRequestId", clientRequestId).withBinding(binding)), publicationMutation = true) { root ->
            parsePublication(root.getJSONObject("publication")).also { require(it.mediaId == mediaId && it.binding == binding) }
        }
    }

    override suspend fun currentSnapshot(): InstagramResult<InstagramConnectionSnapshot> =
        request("/v1/social/connections/instagram") { root ->
            require(root.has("connection"))
            val connection = if (root.isNull("connection")) null else parseConnection(root.getJSONObject("connection"))
            val operational = root.optJSONObject("operationalAvailability")
            // Missing/older or malformed responses are unknown, never implicitly allowed.
            val connectionAllowed = operational?.opt("connectionAllowed") as? Boolean
            val publicationAllowed = operational?.opt("publicationAllowed") as? Boolean
            val availability = if (connectionAllowed != null && publicationAllowed != null)
                InstagramOperationalAvailability(connectionAllowed, publicationAllowed) else null
            InstagramConnectionSnapshot(connection, availability)
        }

    override suspend fun publicationIntent(clientRequestId: String): InstagramResult<InstagramPublication?> {
        if (!InstagramPolicies.validUuid(clientRequestId)) return invalidInput()
        return request("/v1/social/reviewer/publication-intents/$clientRequestId") { root ->
            require(root.getBoolean("canonicalPersistence") && root.has("publication"))
            if (root.isNull("publication")) null else parsePublication(root.getJSONObject("publication"))
        }
    }

    override suspend fun reconcile(publicationId: String, binding: InstagramConnectionBinding): InstagramResult<InstagramPublication> {
        if (!InstagramPolicies.validUuid(publicationId) || !binding.valid) return invalidInput()
        return request("/v1/social/reviewer/publications/$publicationId/reconcile", "POST",
            jsonBody(JSONObject().withBinding(binding)), publicationMutation = true) { root ->
            parsePublication(root.getJSONObject("publication")).also {
                require(it.publicationId.equals(publicationId, true) && it.binding == binding)
            }
        }
    }

    private suspend fun <T> request(
        path: String,
        method: String = "GET",
        body: RequestBody? = null,
        publicationMutation: Boolean = false,
        parse: (JSONObject) -> T
    ): InstagramResult<T> = withContext(Dispatchers.IO) {
        if (!InstagramPolicies.isOfficialApiBase(apiBase)) return@withContext unavailable()
        val token = try { tokenProvider() } catch (_: Exception) { "" }
        if (token.isBlank() || token.length > 8192 || token.any { it <= ' ' || it == '\u007f' }) {
            return@withContext InstagramResult.Failure(InstagramError.SESSION_REQUIRED)
        }
        try {
            val request = Request.Builder().url(transportBase + path)
                .header("Authorization", "Bearer $token").header("Accept", "application/json")
                .header("Cache-Control", "no-store").method(method, body).build()
            client.newCall(request).execute().use { response ->
                if (tokenProvider() != token) return@withContext InstagramResult.Failure(InstagramError.SESSION_REQUIRED)
                // Never follow a redirect, including redirects to another IA4Tube environment.
                if (response.code in 300..399) return@withContext unavailable()
                if (response.code == 401) return@withContext InstagramResult.Failure(InstagramError.SESSION_REQUIRED)
                if (response.code in setOf(403, 404, 405, 501)) return@withContext unavailable()
                val responseBody = response.body ?: return@withContext invalidResponse(publicationMutation)
                if (responseBody.contentLength() > MAX_RESPONSE_BYTES) return@withContext invalidResponse(publicationMutation)
                val source = responseBody.source()
                source.request(MAX_RESPONSE_BYTES + 1)
                if (source.buffer.size > MAX_RESPONSE_BYTES) return@withContext invalidResponse(publicationMutation)
                val json = try { JSONObject(source.buffer.readUtf8()) } catch (_: Exception) {
                    return@withContext if (response.code == 503) unavailable() else invalidResponse(publicationMutation)
                }
                if (!response.isSuccessful || json.opt("ok") != true) {
                    return@withContext InstagramResult.Failure(mapError(response.code, json.optString("code"), publicationMutation))
                }
                InstagramResult.Success(parse(json))
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: IOException) {
            InstagramResult.Failure(if (publicationMutation) InstagramError.RESULT_UNKNOWN else InstagramError.NETWORK)
        } catch (_: Exception) {
            invalidResponse(publicationMutation)
        }
    }

    private fun parseConnection(value: JSONObject): InstagramConnection {
        require(value.getString("provider") == "instagram")
        val state = value.requiredText("state", 40)
        val health = value.requiredText("health", 40)
        require(state in CONNECTION_STATES)
        require(if (state == "connected") health in setOf("healthy", "reconnect_required") else health == state)
        val username = value.nullableText("username", 31)
        val type = value.nullableText("accountType", 12)
        validateAccount(username, type)
        require(state != "connected" || username != null)
        val externalId = value.nullableText("externalId", 64)
        require(externalId == null || InstagramPolicies.validExternalId(externalId))
        val revision = value.requiredRevision("connectionRevision")
        require(state != "connected" || externalId != null)
        return InstagramConnection(value.requiredUuid("connectionId"), state, health, username, type, externalId, revision)
    }

    private fun parseMedia(value: JSONObject): InstagramMedia {
        val id = value.requiredText("id", 200)
        val caption = value.requiredText("caption", 2200, multiline = true)
        require(InstagramPolicies.validMediaId(id) && InstagramPolicies.validPublishedCaption(caption))
        require(value.getString("mimeType") == "image/jpeg")
        require(value.getInt("width") == 1080 && value.getInt("height") == 1080)
        val thumbnail = value.nullableText("thumbnailUrl", 1000)
        require(thumbnail == null || InstagramPolicies.isOfficialThumbnail(thumbnail))
        return InstagramMedia(id, caption, 1080, 1080, thumbnail)
    }

    private fun parsePublication(value: JSONObject): InstagramPublication {
        val state = value.requiredText("state", 40)
        require(state in PUBLICATION_STATES)
        val media = value.getJSONObject("media")
        val mediaId = media.requiredText("id", 200)
        require(InstagramPolicies.validMediaId(mediaId) && media.getString("mimeType") == "image/jpeg")
        val caption = value.requiredText("caption", 2200, multiline = true)
        require(InstagramPolicies.validPublishedCaption(caption))
        val account = if (value.isNull("account")) null else value.getJSONObject("account")
        val username = account?.requiredText("username", 31)
        val type = account?.requiredText("accountType", 12)
        validateAccount(username, type)
        val providerId = value.nullableText("providerMediaId", 64)
        val permalink = value.nullableText("permalink", 200)
        val publishedAt = value.nullableDate("publishedAt")
        val destination = value.optString("destination", "feed")
        require(destination in setOf("feed", "story"))
        if (state == "published") {
            require(providerId != null && Regex("^[0-9]{5,64}$").matches(providerId))
            require(publishedAt != null && if (permalink == null) destination == "story" else InstagramPolicies.isOfficialPermalink(permalink))
        } else require(providerId == null && permalink == null && publishedAt == null)
        val connectionId = value.requiredUuid("connectionId")
        require(value.has("binding"))
        val binding = if (value.isNull("binding")) null else value.getJSONObject("binding").let {
            InstagramConnectionBinding(it.requiredUuid("connectionId"), it.requiredText("externalId", 64),
                it.requiredRevision("connectionRevision")).also { bound -> require(bound.valid && bound.connectionId == connectionId) }
        }
        return InstagramPublication(value.requiredUuid("publicationId"), connectionId,
            state, mediaId, caption, username, type, providerId, permalink, publishedAt,
            value.requiredDate("createdAt"), value.requiredDate("updatedAt"), binding, destination)
    }

    private fun validateAccount(username: String?, type: String?) {
        require((username == null) == (type == null))
        if (username != null) require(Regex("^@[a-zA-Z0-9._]{1,30}$").matches(username) && type in setOf("business", "creator"))
    }

    private fun JSONObject.requiredText(key: String, maximum: Int, multiline: Boolean = false): String {
        val value = get(key)
        require(value is String && value.length in 1..maximum)
        require(value.none { it == '\u007f' || (it < ' ' && !(multiline && it in setOf('\n', '\r', '\t'))) })
        return value
    }

    private fun JSONObject.nullableText(key: String, maximum: Int): String? {
        require(has(key))
        return if (isNull(key)) null else requiredText(key, maximum)
    }
    private fun JSONObject.requiredUuid(key: String) = requiredText(key, 36).also { require(InstagramPolicies.validUuid(it)) }.lowercase()
    private fun JSONObject.requiredRevision(key: String): Long {
        val value = get(key)
        require(value is Int || value is Long)
        return (value as Number).toLong().also { require(InstagramPolicies.validConnectionRevision(it)) }
    }
    private fun JSONObject.withBinding(binding: InstagramConnectionBinding): JSONObject =
        put("expectedConnectionId", binding.connectionId).put("expectedExternalId", binding.externalId)
            .put("expectedConnectionRevision", binding.connectionRevision)
    private fun JSONObject.requiredDate(key: String) = requiredText(key, 40).also { Instant.parse(it) }
    private fun JSONObject.nullableDate(key: String): String? {
        require(has(key))
        return if (isNull(key)) null else requiredDate(key)
    }
    private fun JSONArray.objects(maximum: Int): List<JSONObject> {
        require(length() <= maximum)
        return (0 until length()).map { getJSONObject(it) }
    }

    private fun mapError(status: Int, code: String, publicationMutation: Boolean): InstagramError = when {
        code in setOf("publication_binding_conflict", "connection_binding_conflict", "publication_connection_binding_conflict") -> InstagramError.BINDING_CONFLICT
        code in setOf("external_capability_disabled", "social_instagram_configuration_invalid", "social_instagram_publication_forbidden") -> InstagramError.UNAVAILABLE
        status == 409 -> InstagramError.CONFLICT
        status in setOf(400, 413, 422) -> InstagramError.INVALID_INPUT
        publicationMutation && (status >= 500 || code == "provider_result_unknown") -> InstagramError.RESULT_UNKNOWN
        status == 503 -> InstagramError.UNAVAILABLE
        status >= 500 -> InstagramError.NETWORK
        else -> InstagramError.REJECTED
    }

    private fun jsonBody(value: JSONObject) = value.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
    private fun invalidInput() = InstagramResult.Failure(InstagramError.INVALID_INPUT)
    private fun unavailable() = InstagramResult.Failure(InstagramError.UNAVAILABLE)
    private fun invalidResponse(publicationMutation: Boolean = false) = InstagramResult.Failure(
        if (publicationMutation) InstagramError.RESULT_UNKNOWN else InstagramError.INVALID_RESPONSE)

    companion object {
        private const val MAX_RESPONSE_BYTES = 1024L * 1024L
        private val CONNECTION_STATES = setOf("disconnected", "authorization_pending", "connected", "reconnect_required", "disconnecting", "failed")
        private val AUTHORIZATION_STATES = setOf("authorization_pending", "authorization_processing", "authorization_completed", "authorization_cancelled", "authorization_expired", "authorization_failed")
        private val PUBLICATION_STATES = setOf("sending", "provider_confirming", "published", "failed_temporary", "failed_permanent")
        private fun defaultClient() = OkHttpClient.Builder()
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS)
            .writeTimeout(45, TimeUnit.SECONDS).callTimeout(60, TimeUnit.SECONDS).build()

        /** Explicit JVM fixture boundary. The public constructor can only reach the production origin. */
        internal fun forLocalTests(tokenProvider: () -> String, loopbackBase: String, timeoutMillis: Long = 60_000L): InstagramApiClient {
            val url = loopbackBase.toHttpUrl()
            require(url.scheme == "http" && url.host == "127.0.0.1" && url.username.isEmpty() &&
                url.password.isEmpty() && url.encodedPath == "/" && url.query == null && url.fragment == null)
            require(timeoutMillis in 1L..60_000L)
            return InstagramApiClient(tokenProvider, InstagramPolicies.OFFICIAL_API_ORIGIN,
                url.toString().trimEnd('/'), defaultClient().newBuilder().callTimeout(timeoutMillis, TimeUnit.MILLISECONDS).build())
        }
    }
}
