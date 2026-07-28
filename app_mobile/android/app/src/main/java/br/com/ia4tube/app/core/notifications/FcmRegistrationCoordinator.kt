package br.com.ia4tube.app.core.notifications

import br.com.ia4tube.app.data.api.FcmDeviceBackend
import br.com.ia4tube.app.data.models.ApiResult
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import java.util.Locale

internal data class FcmRegistrationState(
    val decisionOwnerHash: String = "",
    val consentGranted: Boolean = false,
    val currentToken: String = "",
    val registeredOwnerHash: String = "",
    val registeredToken: String = ""
)

internal interface FcmRegistrationStateStore {
    fun load(): FcmRegistrationState
    fun save(state: FcmRegistrationState)
    fun clear()
}

internal interface FcmTokenProvider {
    fun setAutoInitEnabled(enabled: Boolean)
    suspend fun getToken(): String
    suspend fun deleteToken()
}

internal class FcmRegistrationCoordinator(
    private val backend: FcmDeviceBackend,
    private val store: FcmRegistrationStateStore,
    private val tokenProvider: FcmTokenProvider,
    private val authTokenProvider: () -> String,
    private val retryPolicy: FcmRetryPolicy = FcmRetryPolicy()
) {
    fun hasConsentDecisionForCurrentAccount(): Boolean {
        val ownerHash = ownerHash(authTokenProvider())
        if (ownerHash.isBlank()) return true
        return store.load().decisionOwnerHash == ownerHash
    }

    fun canReceiveNotifications(): Boolean {
        val ownerHash = ownerHash(authTokenProvider())
        if (ownerHash.isBlank()) return false
        val state = store.load()
        return state.consentGranted &&
            state.decisionOwnerHash == ownerHash &&
            state.registeredOwnerHash == ownerHash &&
            state.registeredToken.isNotBlank()
    }

    fun hasGrantedConsentForCurrentAccount(): Boolean {
        val ownerHash = ownerHash(authTokenProvider())
        if (ownerHash.isBlank()) return false
        val state = store.load()
        return state.consentGranted && state.decisionOwnerHash == ownerHash
    }

    suspend fun grantConsentAndActivate(): ApiResult<Unit> {
        val authToken = authTokenProvider()
        val ownerHash = ownerHash(authToken)
        if (authToken.isBlank() || ownerHash.isBlank()) {
            return ApiResult.Failure("Sessao invalida.", statusCode = 401, code = "session_invalid")
        }

        val existing = store.load()
        if (
            existing.registeredToken.isNotBlank() &&
            existing.registeredOwnerHash.isNotBlank() &&
            existing.registeredOwnerHash != ownerHash
        ) {
            deactivateAndForget("")
            if (store.load().registeredToken.isNotBlank()) {
                return ApiResult.Failure(
                    "Limpeza anterior pendente.",
                    code = "fcm_previous_account_cleanup_required"
                )
            }
        }

        store.save(
            store.load().copy(
                decisionOwnerHash = ownerHash,
                consentGranted = true
            )
        )
        val token = runCatching {
            tokenProvider.setAutoInitEnabled(true)
            tokenProvider.getToken().trim()
        }.getOrDefault("")
        if (token.isBlank()) {
            return ApiResult.Failure("Token indisponivel.", code = "fcm_token_unavailable")
        }
        return synchronize(authToken, ownerHash, token)
    }

    suspend fun declineConsent() {
        val ownerHash = ownerHash(authTokenProvider())
        val state = store.load()
        if (
            state.currentToken.isNotBlank() ||
            state.registeredToken.isNotBlank()
        ) {
            deactivateAndForget(
                authToken = authTokenProvider(),
                forceLocalInvalidation = true
            )
        } else {
            // A versao anterior podia ter criado um token antes do consentimento.
            // Invalidar sem ler nem reutilizar o valor legado evita mantê-lo ativo.
            deactivateAndForget(
                authToken = "",
                forceLocalInvalidation = true
            )
        }
        val remaining = store.load()
        store.save(
            remaining.copy(
                decisionOwnerHash = ownerHash,
                consentGranted = false
            )
        )
    }

    suspend fun synchronizeCurrentToken(): ApiResult<Unit> {
        val authToken = authTokenProvider()
        val ownerHash = ownerHash(authToken)
        val state = store.load()
        if (
            authToken.isBlank() ||
            ownerHash.isBlank() ||
            !state.consentGranted ||
            state.decisionOwnerHash != ownerHash
        ) {
            return ApiResult.Failure("Consentimento ausente.", code = "fcm_consent_required")
        }

        val token = runCatching {
            tokenProvider.setAutoInitEnabled(true)
            tokenProvider.getToken().trim()
        }.getOrDefault("")
        if (token.isBlank()) {
            return ApiResult.Failure("Token indisponivel.", code = "fcm_token_unavailable")
        }
        return synchronize(authToken, ownerHash, token)
    }

    suspend fun onNewToken(token: String): ApiResult<Unit> {
        val authToken = authTokenProvider()
        val ownerHash = ownerHash(authToken)
        val state = store.load()
        val cleanToken = token.trim()
        if (
            cleanToken.isBlank() ||
            authToken.isBlank() ||
            ownerHash.isBlank() ||
            !state.consentGranted ||
            state.decisionOwnerHash != ownerHash
        ) {
            return ApiResult.Failure("Registro bloqueado.", code = "fcm_registration_blocked")
        }
        return synchronize(authToken, ownerHash, cleanToken)
    }

    suspend fun prepareForAccountChange(newAuthToken: String) {
        val currentAuthToken = authTokenProvider()
        val currentOwnerHash = ownerHash(currentAuthToken)
        val newOwnerHash = ownerHash(newAuthToken)
        if (currentAuthToken.isBlank()) {
            deactivateAndForget("")
            return
        }
        if (
            currentOwnerHash.isNotBlank() &&
            newOwnerHash.isNotBlank() &&
            currentOwnerHash == newOwnerHash
        ) return
        deactivateAndForget(currentAuthToken)
    }

    suspend fun deactivateForLogout() {
        deactivateAndForget(authTokenProvider())
    }

    private suspend fun synchronize(
        authToken: String,
        ownerHash: String,
        token: String
    ): ApiResult<Unit> {
        var state = store.load()
        store.save(state.copy(currentToken = token))

        if (
            state.registeredOwnerHash == ownerHash &&
            state.registeredToken == token
        ) {
            return ApiResult.Success(Unit)
        }

        if (
            state.registeredToken.isNotBlank() &&
            state.registeredOwnerHash != ownerHash
        ) {
            return ApiResult.Failure(
                "Limpeza anterior pendente.",
                code = "fcm_previous_account_cleanup_required"
            )
        }

        val registration = retryPolicy.execute {
            backend.register(
                authToken = authToken,
                fcmToken = token,
                previousToken = state.registeredToken
            )
        }
        if (registration is ApiResult.Success) {
            store.save(
                store.load().copy(
                    currentToken = token,
                    registeredOwnerHash = ownerHash,
                    registeredToken = token
                )
            )
        }
        return registration
    }

    private suspend fun deactivateAndForget(
        authToken: String,
        forceLocalInvalidation: Boolean = false
    ) {
        val state = store.load()
        val registeredToken = state.registeredToken
        val backendSafe = if (authToken.isNotBlank() && registeredToken.isNotBlank()) {
            retryPolicy.execute {
                backend.deactivate(authToken = authToken, fcmToken = registeredToken)
            } is ApiResult.Success
        } else {
            registeredToken.isBlank()
        }

        val localSafe = if (
            forceLocalInvalidation ||
            state.consentGranted ||
            state.currentToken.isNotBlank() ||
            state.registeredToken.isNotBlank()
        ) {
            runCatching {
                tokenProvider.setAutoInitEnabled(false)
                tokenProvider.deleteToken()
                true
            }.getOrDefault(false)
        } else {
            true
        }

        if (backendSafe || localSafe) {
            store.clear()
        } else {
            store.save(
                state.copy(
                    decisionOwnerHash = "",
                    consentGranted = false,
                    currentToken = ""
                )
            )
        }
    }
}

internal fun ownerHash(authToken: String): String {
    val account = runCatching {
        val payload = authToken.split('.').getOrNull(1).orEmpty()
        if (payload.isBlank()) return@runCatching ""
        val json = String(
            Base64.getUrlDecoder().decode(payload),
            StandardCharsets.UTF_8
        )
        fun claim(name: String): String {
            return Regex("\"$name\"\\s*:\\s*\"([^\"]+)\"")
                .find(json)
                ?.groupValues
                ?.getOrNull(1)
                .orEmpty()
        }
        claim("sub").ifBlank { claim("whatsapp") }
    }.getOrDefault("")
        .trim()
        .lowercase(Locale.ROOT)
    if (account.isBlank()) return ""

    return MessageDigest.getInstance("SHA-256")
        .digest(account.toByteArray(StandardCharsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
