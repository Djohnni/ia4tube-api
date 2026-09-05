package br.com.ia4tube.app.feature.instagram

sealed interface InstagramResult<out T> {
    data class Success<T>(val value: T) : InstagramResult<T>
    data class Failure(val error: InstagramError) : InstagramResult<Nothing>
}

enum class InstagramError(val message: String) {
    SESSION_REQUIRED("Entre na IA4Tube novamente para continuar."),
    UNAVAILABLE("O Instagram ainda não está disponível para esta conta no aplicativo oficial."),
    INVALID_RESPONSE("Não foi possível confirmar os dados do Instagram. Tente consultar novamente."),
    INVALID_INPUT("Confira a imagem, a legenda e os dados selecionados."),
    CONFLICT("Já existe uma operação em andamento. Consulte o resultado antes de continuar."),
    BINDING_CONFLICT("A conta ou a revisão da conexão mudou. Atualize a consulta; o envio original não será redirecionado para outra conta."),
    NETWORK("Não foi possível consultar o serviço. Confira sua conexão."),
    RESULT_UNKNOWN("O resultado ainda não foi confirmado. Consulte o histórico antes de tentar publicar novamente."),
    REJECTED("A operação foi recusada. Consulte o estado da conexão antes de continuar.")
}

data class InstagramConnection(
    val connectionId: String,
    val state: String,
    val health: String,
    val username: String?,
    val accountType: String?,
    val externalId: String? = null,
    val connectionRevision: Long? = null
) {
    val binding: InstagramConnectionBinding? get() = if (externalId != null && connectionRevision != null)
        InstagramConnectionBinding(connectionId, externalId, connectionRevision).takeIf { it.valid } else null
    val canPublish: Boolean get() = state == "connected" && health == "healthy" &&
        accountType in setOf("business", "creator") && !username.isNullOrBlank() && binding != null
}

data class InstagramConnectionBinding(val connectionId: String, val externalId: String, val connectionRevision: Long) {
    val valid: Boolean get() = InstagramPolicies.validUuid(connectionId) &&
        InstagramPolicies.validExternalId(externalId) && InstagramPolicies.validConnectionRevision(connectionRevision)
}

data class InstagramAuthorization(
    val connectionId: String,
    val authorizationUrl: String,
    val expiresAt: String
)

data class InstagramAuthorizationStatus(
    val connectionId: String,
    val purpose: String,
    val status: String,
    val expiresAt: String?
)

data class InstagramMedia(
    val id: String,
    val caption: String,
    val width: Int,
    val height: Int,
    val thumbnailUrl: String? = null,
    val fileName: String = "preview_ia4tube.jpg"
)

data class InstagramPublication(
    val publicationId: String,
    val connectionId: String,
    val state: String,
    val mediaId: String,
    val caption: String,
    val username: String?,
    val accountType: String?,
    val providerMediaId: String?,
    val permalink: String?,
    val publishedAt: String?,
    val createdAt: String,
    val updatedAt: String,
    val binding: InstagramConnectionBinding? = null
) {
    val confirmed: Boolean get() = state == "published" && providerMediaId != null &&
        permalink != null && publishedAt != null
    val pending: Boolean get() = state in setOf("ready", "publishing", "sending", "provider_confirming")
}

data class InstagramHistory(
    val publications: List<InstagramPublication>,
    val freshPublicationAvailable: Boolean,
    val independentReview: Boolean
)

interface InstagramGateway {
    suspend fun currentConnection(): InstagramResult<InstagramConnection?>
    suspend fun authorize(purpose: String): InstagramResult<InstagramAuthorization>
    suspend fun authorizationStatus(connectionId: String): InstagramResult<InstagramAuthorizationStatus>
    suspend fun media(): InstagramResult<List<InstagramMedia>>
    suspend fun uploadMedia(jpeg: ByteArray, caption: String): InstagramResult<InstagramMedia>
    suspend fun publications(): InstagramResult<InstagramHistory>
    suspend fun publication(publicationId: String): InstagramResult<InstagramPublication>
    suspend fun publicationIntent(clientRequestId: String): InstagramResult<InstagramPublication?>
    suspend fun publish(mediaId: String, clientRequestId: String, binding: InstagramConnectionBinding): InstagramResult<InstagramPublication>
    suspend fun reconcile(publicationId: String, binding: InstagramConnectionBinding): InstagramResult<InstagramPublication>
}
