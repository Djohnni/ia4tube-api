package br.com.ia4tube.app.feature.instagram

enum class InstagramAvailability { CHECKING, AVAILABLE, UNAVAILABLE, SESSION_REQUIRED }

fun instagramUsernameLabel(username: String): String =
    username.trimStart('@').takeIf { it.isNotBlank() }?.let { "@$it" } ?: "Conta não confirmada"

data class InstagramUiState(
    val availability: InstagramAvailability = InstagramAvailability.CHECKING,
    val busy: Boolean = false,
    val connection: InstagramConnection? = null,
    val operationalAvailability: InstagramOperationalAvailability? = null,
    val authorizationStatus: String? = null,
    val authorization: InstagramAuthorizationStatus? = null,
    val authorizationChecked: Boolean = false,
    val authorizationOutcomeUnknown: Boolean = false,
    val authorizationUrlToOpen: String? = null,
    val media: List<InstagramMedia> = emptyList(),
    val history: List<InstagramPublication> = emptyList(),
    val historyLoaded: Boolean = false,
    val freshPublicationAvailable: Boolean = false,
    val draftJpeg: ByteArray? = null,
    val jpegSelectionPending: Boolean = false,
    val draftCaption: String = "",
    val selectedMediaId: String? = null,
    val uploadWitness: InstagramUploadWitness? = null,
    val uploadStorageAvailable: Boolean = true,
    val uploadDraftMatches: Boolean = false,
    val uploadFeedback: String? = null,
    val uploadLocalDiagnostic: InstagramRequestDiagnostic? = null,
    val intent: InstagramPublicationIntent? = null,
    val storageAvailable: Boolean = true,
    val confirmationOpen: Boolean = false,
    val reconciliationConfirmationOpen: Boolean = false,
    val message: String? = null,
    val error: String? = null
) {
    val selectedMedia: InstagramMedia? get() = media.firstOrNull { it.id == selectedMediaId }
    val hasUnresolvedIntent: Boolean get() = intent != null && !intent.confirmed
    // Authorization lifecycle, connection lifecycle and operational permission are independent.
    // Only an authoritative terminal snapshot may release an unfinished connection record.
    val authorizationPurpose: String? get() {
        if (!authorizationChecked || authorizationOutcomeUnknown || authorizationUrlToOpen != null ||
            authorizationStatus in setOf("authorization_pending", "authorization_processing")) return null
        val current = connection ?: return "connect"
        val observed = authorization?.takeIf { it.connectionId == current.connectionId && it.status == authorizationStatus }
        val terminal = observed?.status in setOf("authorization_expired", "authorization_cancelled", "authorization_failed")
        return when {
            current.state == "authorization_pending" && terminal ->
                observed?.purpose?.takeIf { it == "reconnect" || (it == "connect" && current.externalId == null && current.username == null) }
            current.state == "failed" && terminal && observed?.purpose == "connect" &&
                current.externalId == null && current.username == null -> "connect"
            current.state in setOf("disconnected", "reconnect_required") ||
                (current.state == "connected" && current.health == "reconnect_required") -> "reconnect"
            else -> null
        }
    }
    val canAuthorize: Boolean get() = !busy && availability == InstagramAvailability.AVAILABLE &&
        operationalAvailability?.connectionAllowed == true && authorizationPurpose != null
    val canEditDraft: Boolean get() = !busy && availability == InstagramAvailability.AVAILABLE &&
        connection?.canPublish == true && intent == null && storageAvailable
    val hasUnresolvedUpload: Boolean get() = uploadWitness?.let { !InstagramUploadWitnessPolicy.isResolved(it) } == true
    val uploadBlockReason: String? get() = when {
        busy -> uploadWitness?.takeIf { it.phase == InstagramUploadPhase.IN_FLIGHT }
            ?.let(::instagramUploadPhaseLabel) ?: "Há uma consulta ou operação em andamento. Aguarde."
        availability == InstagramAvailability.SESSION_REQUIRED -> InstagramError.SESSION_REQUIRED.message
        availability != InstagramAvailability.AVAILABLE -> "A disponibilidade ainda não foi confirmada. Use Atualizar."
        connection?.canPublish != true -> "A conta profissional não está pronta para este envio. Confira a conexão e use Atualizar."
        !storageAvailable || !uploadStorageAvailable -> "Não foi possível confirmar o registro local. Não reenvie; use Atualizar."
        intent != null -> "Há uma publicação registrada. Consulte seu resultado antes de preparar outro envio."
        hasUnresolvedUpload -> "O resultado do envio anterior ainda é desconhecido. Não reenvie; use Atualizar para consultar o estado."
        uploadWitness != null && uploadWitness.binding != connection?.binding -> "A conta vinculada ao envio mudou. O registro anterior foi preservado; não reenvie."
        operationalAvailability?.publicationAllowed != true -> InstagramError.UNAVAILABLE.message
        jpegSelectionPending -> "A seleção da imagem ainda está sendo conferida. Aguarde ou use Atualizar."
        draftJpeg == null -> "Escolha uma imagem JPEG antes de enviar."
        !InstagramPolicies.validCaption(draftCaption) -> "Revise a legenda: use de 1 a 2150 caracteres, sem espaços no início ou no fim."
        uploadWitness?.phase == InstagramUploadPhase.CONFIRMED && uploadDraftMatches -> "Esta imagem e legenda já foram enviadas. Revise a prévia antes de publicar."
        else -> null
    }
    val canUpload: Boolean get() = uploadBlockReason == null
    val uploadMessages: List<String> get() = listOfNotNull(uploadBlockReason, uploadFeedback).distinct()
    val canPublish: Boolean get() = canEditDraft && !jpegSelectionPending && selectedMedia != null && historyLoaded &&
        uploadStorageAvailable && uploadDraftMatches && uploadWitness?.phase == InstagramUploadPhase.CONFIRMED &&
        uploadWitness.binding == connection?.binding && uploadWitness.mediaId == selectedMediaId &&
        operationalAvailability?.publicationAllowed == true &&
        freshPublicationAvailable && authorizationUrlToOpen == null
    val pendingPublication: InstagramPublication? get() = intent?.let { saved ->
        history.firstOrNull { it.publicationId == saved.publicationId &&
            it.connectionId == saved.connectionId && it.mediaId == saved.mediaId &&
            (!InstagramIntentPolicy.hasAccountBinding(saved) || it.binding == saved.binding) }
    }
    val canContinueConfirmation: Boolean get() = !busy && storageAvailable &&
        operationalAvailability?.publicationAllowed == true &&
        availability == InstagramAvailability.AVAILABLE && connection?.canPublish == true && hasUnresolvedIntent &&
        intent?.let { InstagramIntentPolicy.matchesAccount(it, connection) } == true &&
        pendingPublication?.state == "provider_confirming"
}
