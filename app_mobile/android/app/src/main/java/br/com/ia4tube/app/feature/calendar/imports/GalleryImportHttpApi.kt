package br.com.ia4tube.app.feature.calendar.imports

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.CancellationException
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class ImportCapabilities(
    val enabled: Boolean,
    val identity: ImportOwner? = null,
    val uploadOrigin: String? = null,
    val chunkBytes: Int = GalleryImportPolicy.CHUNK_BYTES,
    val maxImageBytes: Long = 0,
    val maxVideoBytes: Long = 0,
    val preparationEnabled: Boolean = false,
    val schedulingEnabled: Boolean = false,
    val localSimulation: Boolean = false,
    val musicTracks: List<AuthorizedImportTrack> = emptyList()
)

data class ImportUploadRecord(
    val uploadId: String,
    val assetId: String,
    val kind: ImportMediaKind,
    val mimeType: String,
    val sizeBytes: Long,
    val chunkBytes: Int,
    val partCount: Int,
    val phase: ImportServerPhase,
    val verifiedSha256: String?,
    val completedParts: List<ImportPartReceipt> = emptyList(),
    val errorCode: String? = null
)

data class ImportPartAuthorization(
    val uploadId: String,
    val partNumber: Int,
    val sizeBytes: Int,
    val authorizationId: String,
    val expiresAtEpochMs: Long
) { override fun toString() = "ImportPartAuthorization(redacted)" }

class ImportPartGrant internal constructor(
    internal val url: HttpUrl,
    internal val headers: Map<String, String>,
    val sizeBytes: Int,
    val expiresAtEpochMs: Long,
    internal val sessionBinding: String
) { override fun toString() = "ImportPartGrant(redacted)" }

data class ImportPartChecksums(val sha256: String, val md5Base64: String, val sha256Base64: String) {
    companion object {
        fun calculate(bytes: ByteArray): ImportPartChecksums {
            require(bytes.isNotEmpty() && bytes.size <= GalleryImportPolicy.CHUNK_BYTES)
            val sha = MessageDigest.getInstance("SHA-256").digest(bytes)
            return ImportPartChecksums(sha.joinToString("") { "%02x".format(it) },
                Base64.getEncoder().encodeToString(MessageDigest.getInstance("MD5").digest(bytes)), Base64.getEncoder().encodeToString(sha))
        }
    }
}

class ImportApiFailure(val code: String, val status: Int? = null, val resultUncertain: Boolean = false) :
    Exception(if (resultUncertain) "O resultado do envio precisa ser conferido. Não inicie outro envio."
    else "Não foi possível continuar a importação. Confira a sessão e tente consultar novamente.")

/** Authenticated metadata only. Media PUTs use a separate client with no credentials or redirects. */
class GalleryImportHttpApi internal constructor(
    private val tokenProvider: () -> String,
    private val sessionToken: String,
    private val apiOrigin: HttpUrl,
    private val metadataClient: OkHttpClient,
    private val mediaClient: OkHttpClient,
    private val now: () -> Long = System::currentTimeMillis,
    private val allowLoopbackForTests: Boolean = false
) {
    constructor(tokenProvider: () -> String) : this(tokenProvider, tokenProvider(),
        "https://ia4tube-api.onrender.com".toHttpUrl(), metadataClient(), mediaClient())

    @Volatile private var currentCapabilities: ImportCapabilities? = null
    private val path = "/v1/social/calendar/imports"

    init {
        require(apiOrigin.encodedPath == "/" && apiOrigin.query == null && apiOrigin.fragment == null && apiOrigin.username.isEmpty() && apiOrigin.password.isEmpty())
        require(apiOrigin.isHttps || (allowLoopbackForTests && apiOrigin.host in setOf("127.0.0.1", "localhost")))
        require(!metadataClient.followRedirects && !metadataClient.followSslRedirects && !metadataClient.retryOnConnectionFailure)
        require(!mediaClient.followRedirects && !mediaClient.followSslRedirects && !mediaClient.retryOnConnectionFailure &&
            mediaClient.cookieJar === CookieJar.NO_COOKIES && mediaClient.interceptors.isEmpty() && mediaClient.networkInterceptors.isEmpty() &&
            mediaClient.authenticator === Authenticator.NONE && mediaClient.proxyAuthenticator === Authenticator.NONE)
    }

    suspend fun capabilities(): ImportCapabilities = guarded(false) {
        val json = request("/capabilities")
        val enabled = json.getBoolean("enabled")
        if (!enabled) return@guarded ImportCapabilities(false).also { currentCapabilities = it }
        val identity = json.getJSONObject("identity")
        val owner = ImportOwner(uuid(identity.getString("companyId")), uuid(identity.getString("userId")))
        val upload = json.getJSONObject("upload")
        val origin = upload.getString("origin").toHttpUrl()
        requireOrigin(origin)
        val chunkBytes = upload.getInt("chunkBytes"); require(chunkBytes == GalleryImportPolicy.CHUNK_BYTES)
        val imageBytes = upload.getLong("maxImageBytes"); require(imageBytes in 1..GalleryImportPolicy.IMAGE_MAX_BYTES)
        val videoBytes = upload.getLong("maxVideoBytes"); require(videoBytes in 1..GalleryImportPolicy.VIDEO_MAX_BYTES)
        val preparation = json.getJSONObject("preparation")
        require(preparation.getInt("maxVideoSeconds") in 1..60 && preparation.getInt("photoMusicSeconds") == 15)
        val local = if (json.has("localSimulation")) json.get("localSimulation").also { require(it is Boolean) } as Boolean else false
        require(!local || allowLoopbackForTests)
        val catalogue = json.optJSONArray("musicTracks")
        require(catalogue == null || catalogue.length() <= 100)
        val tracks = (0 until (catalogue?.length() ?: 0)).map { index ->
            val track = catalogue!!.getJSONObject(index)
            val id = track.getString("id"); require(GalleryImportPolicy.validId(id))
            val commercial = track.get("commercialRightsConfirmed").also { require(it is Boolean) } as Boolean
            val test = track.get("testOnly").also { require(it is Boolean) } as Boolean
            require(commercial != test && (!test || local))
            val name = if (track.has("displayName")) track.getString("displayName") else id
            require(name.isNotBlank() && name == name.trim() && name.length <= 80 &&
                name.none { it.code in 0..31 || it.code in 127..159 || it.code in 0x202a..0x202e || it.code in 0x2066..0x2069 })
            AuthorizedImportTrack(id, commercial, test, name)
        }
        require(tracks.map { it.id }.distinct().size == tracks.size)
        ImportCapabilities(true, owner, origin.toString().trimEnd('/'), chunkBytes, imageBytes, videoBytes,
            preparation.getBoolean("enabled"), json.getJSONObject("scheduling").getBoolean("enabled"), local, tracks).also { currentCapabilities = it }
    }

    suspend fun start(owner: ImportOwner, media: ImportSelection, idempotencyKey: String): ImportUploadRecord = guarded(true) {
        ensureOwner(owner)
        require(GalleryImportPolicy.validateSelection(media) == null && idempotencyKey.matches(Regex("[A-Za-z0-9_-]{8,128}")))
        val record = parseRecord(request("/uploads", JSONObject().put("idempotencyKey", idempotencyKey).put("kind", media.kind.wire)
            .put("mimeType", media.mimeType).put("sizeBytes", media.byteCount).put("sha256", media.sha256.lowercase())).getJSONObject("upload"))
        require(record.kind == media.kind && record.mimeType == media.mimeType && record.sizeBytes == media.byteCount)
        record
    }

    suspend fun status(owner: ImportOwner, uploadId: String): ImportUploadRecord = record(owner, uploadId, "", false)
    suspend fun resume(owner: ImportOwner, uploadId: String): ImportUploadRecord = record(owner, uploadId, "/resume", true)
    suspend fun complete(owner: ImportOwner, uploadId: String): ImportUploadRecord = record(owner, uploadId, "/complete", true)
    suspend fun cancel(owner: ImportOwner, uploadId: String): ImportUploadRecord = record(owner, uploadId, "/cancel", true)

    suspend fun prepare(owner: ImportOwner, assetId: String, uploadId: String, intent: ImportPreparationIntent,
                        kind: ImportMediaKind, configuration: ImportConfiguration): ImportPreparationRecord = guarded(true) {
        ensurePreparationOwner(owner); uuid(assetId); uuid(uploadId)
        require(intent.idempotencyKey.matches(Regex("[A-Za-z0-9_-]{8,128}")) && intent.expectedMediaRevision in 0..999998)
        val result = ImportPreparationProtocol.parseRecord(request("/assets/$assetId/prepare", JSONObject()
            .put("uploadId", uploadId).put("idempotencyKey", intent.idempotencyKey).put("expectedMediaRevision", intent.expectedMediaRevision)
            .put("selection", ImportPreparationProtocol.selection(kind, configuration))).getJSONObject("asset"))
        require(result.assetId == assetId && result.uploadId == uploadId && result.kind == kind && result.configuration == configuration &&
            result.mediaRevision == intent.expectedMediaRevision + 1)
        result
    }
    suspend fun preparationStatus(owner: ImportOwner, assetId: String): ImportPreparationRecord = guarded(false) {
        ensurePreparationOwner(owner); uuid(assetId)
        ImportPreparationProtocol.parseRecord(request("/assets/$assetId").getJSONObject("asset")).also { require(it.assetId == assetId) }
    }
    suspend fun preparationPreview(owner: ImportOwner, record: ImportPreparationRecord): ImportPrivatePreview = guarded(false) {
        ensurePreparationOwner(owner); uuid(record.assetId)
        require(record.phase == ImportPreparationPhase.READY && record.mediaRevision == record.currentRevision)
        ImportPreparationProtocol.parsePreview(request("/assets/${record.assetId}/revisions/${record.mediaRevision}/preview").getJSONObject("preview"), record, apiOrigin)
    }

    suspend fun scheduleAvailability(owner: ImportOwner, record: ImportPreparationRecord): ImportScheduleAvailability = guarded(false) {
        ensurePreparationOwner(owner); uuid(record.assetId)
        ImportSchedulingProtocol.parseAvailability(request("/assets/${record.assetId}/schedule-availability").getJSONObject("availability"),
            owner, record, allowLoopbackForTests)
    }
    suspend fun schedule(owner: ImportOwner, binding: ImportScheduleBinding, intent: ImportScheduleIntent): ImportScheduleReceipt = guarded(true) {
        ensureScheduleOwner(owner, binding)
        ImportSchedulingProtocol.parseReceipt(request("/assets/${binding.assetId}/schedule", ImportSchedulingProtocol.body(binding, intent))
            .getJSONObject("schedule"), binding, intent, allowLoopbackForTests)
    }
    /** Lookup only; a 404 is not permission to create a different schedule/key. */
    suspend fun scheduleStatus(owner: ImportOwner, binding: ImportScheduleBinding, intent: ImportScheduleIntent): ImportScheduleReceipt? = guarded(false) {
        ensurePreparationOwner(owner); uuid(binding.assetId)
        require(binding.localSimulation == currentCapabilities?.localSimulation && (!binding.localSimulation || allowLoopbackForTests))
        require(intent.idempotencyKey.matches(Regex("[A-Za-z0-9_-]{8,128}")))
        try { ImportSchedulingProtocol.parseReceipt(request("/assets/${binding.assetId}/schedules/by-key/${intent.idempotencyKey}")
            .getJSONObject("schedule"), binding, intent, allowLoopbackForTests) }
        catch (error: ImportApiFailure) { if (error.status == 404) null else throw error }
    }
    suspend fun adoptGenerated(owner: ImportOwner, intent: ImportGeneratedSourceIntent): ImportGeneratedSource = guarded(true) {
        ensurePreparationOwner(owner)
        val result = request("/sources/generated/${intent.calendarItemId}", JSONObject().put("revision", intent.revision).put("idempotencyKey", intent.idempotencyKey))
        val identity = result.getJSONObject("identity")
        require(identity.getString("companyId") == owner.companyId && identity.getString("userId") == owner.userId)
        val source = result.getJSONObject("source"); val upload = parseRecord(result.getJSONObject("upload"))
        require(source.getString("kind") == "generated_art" && source.getString("calendarItemId") == intent.calendarItemId &&
            source.getLong("revision") == intent.revision && upload.kind == ImportMediaKind.IMAGE && upload.phase == ImportServerPhase.UPLOADED &&
            upload.verifiedSha256 == source.getString("sha256"))
        val selection = ImportSelection("generated-${intent.calendarItemId}", ImportMediaKind.IMAGE, upload.mimeType, upload.sizeBytes,
            source.getInt("width"), source.getInt("height"), null, upload.verifiedSha256!!)
        require(GalleryImportPolicy.validateSelection(selection) == null)
        ImportGeneratedSource(upload, selection, intent)
    }

    private suspend fun record(owner: ImportOwner, uploadId: String, suffix: String, post: Boolean): ImportUploadRecord = guarded(post) {
        ensureOwner(owner); uuid(uploadId)
        val response = request("/uploads/$uploadId$suffix", if (post) JSONObject() else null)
        parseRecord(response.getJSONObject("upload")).also { require(it.uploadId == uploadId) }
    }

    suspend fun authorizePart(owner: ImportOwner, upload: ImportUploadRecord, partNumber: Int, checksums: ImportPartChecksums): ImportPartAuthorization = guarded(true) {
        ensureOwner(owner); uuid(upload.uploadId)
        require(partNumber in 1..upload.partCount && upload.phase == ImportServerPhase.UPLOADING)
        require(checksums.sha256.matches(Regex("[a-f0-9]{64}")) && Base64.getDecoder().decode(checksums.md5Base64).size == 16)
        val json = request("/uploads/${upload.uploadId}/parts/$partNumber/authorize", JSONObject().put("sha256", checksums.sha256)
            .put("md5Base64", checksums.md5Base64)).getJSONObject("part")
        val expectedBytes = minOf(upload.chunkBytes.toLong(), upload.sizeBytes - (partNumber - 1L) * upload.chunkBytes).toInt()
        require(json.getString("uploadId") == upload.uploadId && json.getInt("partNumber") == partNumber && json.getInt("sizeBytes") == expectedBytes)
        val expires = json.getLong("expiresAt"); require(expires > now() && expires <= now() + TimeUnit.MINUTES.toMillis(15))
        ImportPartAuthorization(upload.uploadId, partNumber, expectedBytes, uuid(json.getString("authorizationId")), expires)
    }

    suspend fun resolvePart(owner: ImportOwner, authorization: ImportPartAuthorization, checksums: ImportPartChecksums): ImportPartGrant = guarded(true) {
        ensureOwner(owner); uuid(authorization.uploadId); uuid(authorization.authorizationId)
        require(authorization.partNumber in 1..20 && authorization.expiresAtEpochMs > now())
        val json = request("/uploads/${authorization.uploadId}/parts/${authorization.partNumber}/resolve",
            JSONObject().put("authorizationId", authorization.authorizationId)).getJSONObject("grant")
        require(json.getString("method") == "PUT" && json.getInt("sizeBytes") == authorization.sizeBytes)
        val url = json.getString("url").toHttpUrl()
        val expectedOrigin = currentCapabilities!!.uploadOrigin!!.toHttpUrl()
        require(url.scheme == expectedOrigin.scheme && url.host == expectedOrigin.host && url.port == expectedOrigin.port &&
            url.username.isEmpty() && url.password.isEmpty() && url.fragment == null)
        if (isRenderMediaOrigin(expectedOrigin)) {
            // A grant for our API is restricted to this exact byte transfer. It
            // must never become a credential-free PUT to any other API route.
            require(url.encodedPath == "$path/bytes/${authorization.authorizationId}" && url.encodedQuery == null)
        }
        val expires = json.getLong("expiresAt")
        require(expires > now() && expires <= authorization.expiresAtEpochMs)
        val rawHeaders = json.getJSONObject("headers")
        val headers = mutableMapOf<String, String>()
        rawHeaders.keys().forEach { key ->
            val normalized = key.lowercase()
            require(normalized in setOf("content-length", "content-md5", "x-amz-checksum-sha256", "content-type") && normalized !in headers)
            val value = rawHeaders.getString(key); require(value.none { it == '\r' || it == '\n' })
            when (normalized) {
                "content-length" -> require(value == authorization.sizeBytes.toString())
                "content-md5" -> require(value == checksums.md5Base64)
                "x-amz-checksum-sha256" -> require(value == checksums.sha256Base64)
                "content-type" -> require(value == "application/octet-stream")
            }
            headers[normalized] = value
        }
        require(headers["content-md5"] == checksums.md5Base64)
        ImportPartGrant(url, headers.toMap(), authorization.sizeBytes, expires, sessionToken)
    }

    /** A successful PUT is not a receipt: callers must observe parts with authenticated resume(). */
    suspend fun putPart(grant: ImportPartGrant, bytes: ByteArray, onProgress: (Long, Long) -> Unit = { _, _ -> }): Unit = guarded(true) {
        ensureSession()
        require(grant.sessionBinding == sessionToken && grant.expiresAtEpochMs > now() && bytes.size == grant.sizeBytes)
        val digest = ImportPartChecksums.calculate(bytes)
        require(grant.headers["content-md5"] == digest.md5Base64)
        grant.headers["x-amz-checksum-sha256"]?.let { require(it == digest.sha256Base64) }
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = bytes.size.toLong()
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                var offset = 0
                while (offset < bytes.size) {
                    ensureSession()
                    val count = minOf(64 * 1024, bytes.size - offset)
                    sink.write(bytes, offset, count); offset += count
                    onProgress(offset.toLong(), bytes.size.toLong())
                }
            }
        }
        val request = Request.Builder().url(grant.url).put(body)
        grant.headers.forEach { (key, value) -> request.header(key, value) }
        execute(mediaClient, request.build(), true, parseJson = false)
        Unit
    }

    private fun parseRecord(json: JSONObject): ImportUploadRecord {
        val kind = when (json.getString("kind")) { "image" -> ImportMediaKind.IMAGE; "video" -> ImportMediaKind.VIDEO; else -> error("Invalid media kind") }
        val mime = json.getString("mimeType")
        require(mime in if (kind == ImportMediaKind.IMAGE) setOf("image/jpeg", "image/png", "image/webp") else setOf("video/mp4", "video/quicktime"))
        val size = json.getLong("sizeBytes"); require(size in 1..if (kind == ImportMediaKind.IMAGE) GalleryImportPolicy.IMAGE_MAX_BYTES else GalleryImportPolicy.VIDEO_MAX_BYTES)
        val chunkBytes = json.getInt("chunkBytes"); require(chunkBytes == GalleryImportPolicy.CHUNK_BYTES)
        val partCount = json.getInt("partCount"); require(partCount == ((size + chunkBytes - 1) / chunkBytes).toInt())
        val phase = ImportServerPhase.fromWire(json.getString("state")) ?: throw ImportApiFailure("import_response_invalid")
        require(!json.getBoolean("ready"))
        val verification = json.optJSONObject("verification")
        val verifiedSha = if (phase == ImportServerPhase.UPLOADED) {
            require(verification != null && verification.getLong("sizeBytes") == size && verification.getString("mimeType") == mime)
            verification.getString("sha256").also { require(it.matches(Regex("[a-f0-9]{64}"))) }
        } else { require(verification == null); null }
        val rawParts = json.optJSONArray("completedParts")
        require(rawParts == null || rawParts.length() <= partCount)
        val parts = (0 until (rawParts?.length() ?: 0)).map { index ->
            val part = rawParts!!.getJSONObject(index)
            val number = part.getInt("partNumber"); require(number in 1..partCount)
            val expected = minOf(chunkBytes.toLong(), size - (number - 1L) * chunkBytes).toInt()
            require(part.getInt("sizeBytes") == expected)
            val hash = part.getString("sha256"); require(hash.matches(Regex("[a-f0-9]{64}")))
            ImportPartReceipt.fromServer(number, expected, hash)
        }.sortedBy { it.part }
        require(parts.map { it.part }.distinct().size == parts.size)
        val errorCode = json.optString("errorCode").takeIf { !json.isNull("errorCode") && it.matches(Regex("[a-z0-9_]{1,80}")) }
        return ImportUploadRecord(uuid(json.getString("uploadId")), uuid(json.getString("assetId")), kind, mime, size, chunkBytes, partCount, phase, verifiedSha, parts, errorCode)
    }

    private fun requireOrigin(origin: HttpUrl) {
        require(origin.username.isEmpty() && origin.password.isEmpty() && origin.encodedPath == "/" && origin.query == null && origin.fragment == null)
        require(isRenderMediaOrigin(origin) ||
            (origin.isHttps && origin.port == 443 && origin.host.matches(Regex("[a-z0-9-]{1,63}\\.r2\\.cloudflarestorage\\.com"))) ||
            (allowLoopbackForTests && !origin.isHttps && origin.host in setOf("127.0.0.1", "localhost")))
    }
    private fun isRenderMediaOrigin(origin: HttpUrl) = origin.isHttps && origin.port == 443 && origin.host == "ia4tube-api.onrender.com"
    private fun ensureOwner(owner: ImportOwner) {
        ensureSession()
        if (currentCapabilities?.enabled != true || currentCapabilities?.identity != owner) throw ImportApiFailure("import_owner_unavailable")
    }
    private fun ensurePreparationOwner(owner: ImportOwner) {
        ensureOwner(owner)
        if (currentCapabilities?.preparationEnabled != true) throw ImportApiFailure("import_preparation_unavailable")
    }
    private fun ensureScheduleOwner(owner: ImportOwner, binding: ImportScheduleBinding) {
        ensurePreparationOwner(owner); uuid(binding.assetId)
        if (currentCapabilities?.schedulingEnabled != true || binding.localSimulation != currentCapabilities?.localSimulation ||
            binding.localSimulation && !allowLoopbackForTests) throw ImportApiFailure("import_scheduling_unavailable")
    }
    private fun ensureSession() {
        if (sessionToken.isBlank() || sessionToken.length > 16384 || sessionToken.any { it == '\r' || it == '\n' } || tokenProvider() != sessionToken)
            throw ImportApiFailure("import_session_changed")
    }
    private suspend fun <T> guarded(mutation: Boolean, action: suspend () -> T): T = try { action() }
    catch (error: ImportApiFailure) { throw error }
    catch (error: CancellationException) { throw error }
    catch (_: Exception) { throw ImportApiFailure("import_response_invalid", resultUncertain = mutation) }
    private suspend fun request(suffix: String, body: JSONObject? = null): JSONObject {
        ensureSession()
        val request = Request.Builder().url(apiOrigin.newBuilder().encodedPath(path + suffix).build())
            .header("Authorization", "Bearer $sessionToken").header("Cache-Control", "no-store")
        if (body != null) request.post(body.toString().toRequestBody("application/json".toMediaType()))
        return execute(metadataClient, request.build(), body != null, parseJson = true)
    }
    private suspend fun execute(client: OkHttpClient, request: Request, mutation: Boolean, parseJson: Boolean): JSONObject = suspendCancellableCoroutine { continuation ->
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                if (continuation.isActive) continuation.resumeWithException(ImportApiFailure("import_network_unavailable", resultUncertain = mutation))
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    try {
                        ensureSession()
                        if (!response.isSuccessful) throw ImportApiFailure("import_request_rejected", response.code, mutation && response.code >= 500)
                        val result = if (!parseJson) JSONObject() else {
                            val stream = response.body?.byteStream() ?: throw ImportApiFailure("import_response_invalid", resultUncertain = mutation)
                            val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                            while (true) { val count = stream.read(buffer); if (count < 0) break
                                require(output.size() + count <= 256 * 1024); output.write(buffer, 0, count) }
                            JSONObject(String(output.toByteArray(), Charsets.UTF_8)).also { require(it.getBoolean("ok")) }
                        }
                        if (continuation.isActive) continuation.resume(result)
                    } catch (error: ImportApiFailure) { if (continuation.isActive) continuation.resumeWithException(error) }
                    catch (_: Exception) { if (continuation.isActive) continuation.resumeWithException(ImportApiFailure("import_response_invalid", resultUncertain = mutation)) }
                }
            }
        })
    }

    companion object {
        private val uuidPattern = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")
        internal fun uuid(value: String): String { require(uuidPattern.matches(value)); return value.lowercase() }
        internal fun metadataClient() = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .cookieJar(CookieJar.NO_COOKIES).connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).callTimeout(60, TimeUnit.SECONDS).build()
        internal fun mediaClient() = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .cookieJar(CookieJar.NO_COOKIES).connectTimeout(15, TimeUnit.SECONDS).writeTimeout(60, TimeUnit.SECONDS).callTimeout(90, TimeUnit.SECONDS).build()
    }
}
