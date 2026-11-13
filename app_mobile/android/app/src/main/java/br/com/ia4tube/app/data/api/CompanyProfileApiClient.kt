package br.com.ia4tube.app.data.api

import br.com.ia4tube.app.core.company.CompanyProfile
import br.com.ia4tube.app.core.config.AppConfig
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.UploadFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

internal data class CompanyProfileSnapshot(
    val profile: CompanyProfile,
    val hasLogo: Boolean,
    val updatedAt: String?,
    val account: CompanyAccountIdentity? = null
)

internal data class CompanyAccountIdentity(val provider: String, val login: String)

internal interface CompanyProfileBackend {
    suspend fun read(token: String): ApiResult<CompanyProfileSnapshot>
    suspend fun save(token: String, profile: CompanyProfile, logo: UploadFile?, removeLogo: Boolean): ApiResult<CompanyProfileSnapshot>
    suspend fun logo(token: String): ApiResult<UploadFile>
}

internal class CompanyProfileApiClient(
    baseUrl: String = AppConfig.apiBase,
    client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(45, TimeUnit.SECONDS).build()
) : CompanyProfileBackend {
    private val http = client.newBuilder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).build()
    private val origin = baseUrl.trimEnd('/').toHttpUrl().also {
        require((it.isHttps || it.host in setOf("localhost", "127.0.0.1", "::1")) &&
            it.username.isEmpty() && it.password.isEmpty() && it.query == null &&
            it.fragment == null && it.encodedPath == "/")
    }.toString().trimEnd('/')

    override suspend fun read(token: String): ApiResult<CompanyProfileSnapshot> =
        metadata(token, request(token, "/company/profile").get().build())

    override suspend fun save(
        token: String, profile: CompanyProfile, logo: UploadFile?, removeLogo: Boolean
    ): ApiResult<CompanyProfileSnapshot> {
        if (logo != null && (removeLogo || logo.bytes.isEmpty() || logo.bytes.size > MAX_LOGO_BYTES ||
                logo.contentType !in setOf("image/png", "image/jpeg", "image/webp"))) {
            return ApiResult.Failure("Escolha uma imagem PNG, JPEG ou WebP de até 5 MB.")
        }
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("profile", encode(profile).toString())
        if (removeLogo) body.addFormDataPart("remove_logo", "true")
        if (logo != null) body.addFormDataPart(
            "logo", "logo." + when (logo.contentType) { "image/png" -> "png"; "image/webp" -> "webp"; else -> "jpg" },
            logo.bytes.toRequestBody(logo.contentType.toMediaType())
        )
        return metadata(token, request(token, "/company/profile").put(body.build()).build())
    }

    override suspend fun logo(token: String): ApiResult<UploadFile> = withContext(Dispatchers.IO) {
        if (token.isBlank()) return@withContext authFailure()
        try {
            http.newCall(request(token, "/company/profile/logo").get().build()).execute().use { response ->
                if (response.code == 401) return@withContext authFailure()
                if (!response.isSuccessful) return@withContext failure(response.code)
                val source = response.body?.source() ?: return@withContext failure()
                source.request(MAX_LOGO_BYTES.toLong() + 1)
                if (source.buffer.size > MAX_LOGO_BYTES) return@withContext failure()
                val bytes = source.readByteArray()
                if (response.body?.contentType()?.let { it.type + "/" + it.subtype } != "image/png" ||
                    bytes.size < 8 || !bytes.copyOfRange(0, 8).contentEquals(PNG_SIGNATURE)) {
                    return@withContext failure()
                }
                ApiResult.Success(UploadFile("company-logo.png", "image/png", bytes))
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { failure() }
    }

    private fun request(token: String, path: String): Request.Builder = Request.Builder()
        .url(origin + path).header("Authorization", "Bearer $token")
        .header("Cache-Control", "no-store")

    private suspend fun metadata(token: String, request: Request): ApiResult<CompanyProfileSnapshot> =
        withContext(Dispatchers.IO) {
            if (token.isBlank()) return@withContext authFailure()
            try {
                http.newCall(request).execute().use { response ->
                    if (response.code == 401) return@withContext authFailure()
                    if (!response.isSuccessful) return@withContext failure(response.code)
                    val source = response.body?.source() ?: return@withContext failure()
                    source.request(131_073)
                    if (source.buffer.size > 131_072) return@withContext failure()
                    ApiResult.Success(parse(source.readUtf8()))
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { failure() }
        }

    companion object {
        const val MAX_LOGO_BYTES = 5 * 1024 * 1024
        private val PNG_SIGNATURE = byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)

        internal fun encode(profile: CompanyProfile): JSONObject = JSONObject()
            .put("nome_empresa", profile.nomeEmpresa).put("ramo", profile.ramo)
            .put("whatsapp", profile.whatsapp).put("instagram", profile.instagram)
            .put("facebook", profile.facebook).put("outros_links", profile.outrosLinks)
            .put("historia", profile.historia).put("endereco", profile.endereco)
            .put("cidade", profile.cidade).put("estado", profile.estado).put("cep", profile.cep)
            .put("email", profile.email).put("site", profile.site)

        internal fun parse(text: String): CompanyProfileSnapshot {
            val response = JSONObject(text)
            require(response.opt("ok") == true)
            val value = response.getJSONObject("profile")
            fun field(key: String): String = (value.get(key) as? String)
                ?: throw IllegalArgumentException("invalid_profile")
            val hasLogo = value.get("has_logo") as? Boolean
                ?: throw IllegalArgumentException("invalid_profile")
            val updated = value.get("updated_at")
            require(updated == JSONObject.NULL || updated is String)
            return CompanyProfileSnapshot(CompanyProfile(
                nomeEmpresa = field("nome_empresa"), ramo = field("ramo"), whatsapp = field("whatsapp"),
                instagram = field("instagram"), facebook = field("facebook"), outrosLinks = field("outros_links"),
                historia = field("historia"), endereco = field("endereco"), cidade = field("cidade"),
                estado = field("estado"), cep = field("cep"), email = field("email"), site = field("site")
            ), hasLogo, (updated as? String), parseAccount(response.optJSONObject("account")))
        }

        private fun parseAccount(value: JSONObject?): CompanyAccountIdentity? {
            val fields = value ?: return null
            val provider = fields.opt("provider") as? String ?: return null
            val login = fields.opt("login") as? String ?: return null
            if (login.isBlank() || login.length > 254 || login.any { it <= '\u0020' || it == '\u007f' }) return null
            return when (provider) {
                "google" -> if (Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$").matches(login)) CompanyAccountIdentity(provider, login) else null
                "whatsapp" -> if (login.length <= 200 && !Regex("^(google|facebook|apple|microsoft)_").containsMatchIn(login)) CompanyAccountIdentity(provider, login) else null
                else -> null
            }
        }

        private fun authFailure() = ApiResult.Failure("Entre novamente para acessar o perfil.", 401, "company_profile_session_required")
        private fun failure(status: Int? = null) = ApiResult.Failure(
            if (status == 413) "A imagem é muito grande. Escolha outra de até 5 MB."
            else "Não foi possível acessar o perfil. Suas alterações foram mantidas.", status, "company_profile_unavailable"
        )
    }
}
