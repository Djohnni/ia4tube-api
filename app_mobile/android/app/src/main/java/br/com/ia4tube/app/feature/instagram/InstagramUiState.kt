package br.com.ia4tube.app.feature.instagram

enum class InstagramAvailability { CHECKING, AVAILABLE, UNAVAILABLE, SESSION_REQUIRED }

fun instagramUsernameLabel(username: String): String =
    username.trimStart('@').takeIf { it.isNotBlank() }?.let { "@$it" } ?: "Conta não confirmada"

data class InstagramUiState(
    val availability: InstagramAvailability = InstagramAvailability.CHECKING,
    val busy: Boolean = false,
    val connection: InstagramConnection? = null,
    val authorizationStatus: String? = null,
    val authorizationUrlToOpen: String? = null,
    val media: List<InstagramMedia> = emptyList(),
    val history: List<InstagramPublication> = emptyList(),
    val historyLoaded: Boolean = false,
    val freshPublicationAvailable: Boolean = false,
    val draftJpeg: ByteArray? = null,
    val draftCaption: String = "",
    val selectedMediaId: String? = null,
    val intent: InstagramPublicationIntent? = null,
    val storageAvailable: Boolean = true,
    val confirmationOpen: Boolean = false,
    val reconciliationConfirmationOpen: Boolean = false,
    val message: String? = null,
    val error: String? = null
) {
    val selectedMedia: InstagramMedia? get() = media.firstOrNull { it.id == selectedMediaId }
    val hasUnresolvedIntent: Boolean get() = intent != null && !intent.confirmed
    val canAuthorize: Boolean get() = !busy && availability == InstagramAvailability.AVAILABLE &&
        authorizationStatus !in setOf("authorization_pending", "authorization_processing") &&
        (connection == null || connection.state in setOf("disconnected", "reconnect_required", "failed") ||
            (connection.state == "connected" && connection.health == "reconnect_required"))
    val canEditDraft: Boolean get() = !busy && availability == InstagramAvailability.AVAILABLE &&
        connection?.canPublish == true && intent == null && storageAvailable
    val canUpload: Boolean get() = canEditDraft && draftJpeg != null &&
        InstagramPolicies.validCaption(draftCaption.trim())
    val canPublish: Boolean get() = canEditDraft && selectedMedia != null && historyLoaded &&
        freshPublicationAvailable && authorizationUrlToOpen == null
    val pendingPublication: InstagramPublication? get() = intent?.let { saved ->
        history.firstOrNull { it.publicationId == saved.publicationId &&
            it.connectionId == saved.connectionId && it.mediaId == saved.mediaId }
    }
    val canContinueConfirmation: Boolean get() = !busy && storageAvailable &&
        availability == InstagramAvailability.AVAILABLE && connection?.canPublish == true && hasUnresolvedIntent &&
        intent?.let { InstagramIntentPolicy.matchesAccount(it, connection) } == true &&
        pendingPublication?.state == "provider_confirming"
}
