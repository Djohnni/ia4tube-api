package br.com.ia4tube.app.core.notifications

import br.com.ia4tube.app.data.api.FcmDeviceBackend
import br.com.ia4tube.app.data.models.ApiResult
import java.nio.charset.StandardCharsets
import java.util.Base64
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FcmRegistrationCoordinatorTest {
    @Test
    fun noConsentMeansNoTokenGenerationAndNoBackendCall() = runBlocking {
        val fixture = Fixture()

        val result = fixture.coordinator.synchronizeCurrentToken()

        assertTrue(result is ApiResult.Failure)
        assertEquals(0, fixture.provider.getTokenCalls)
        assertTrue(fixture.backend.operations.isEmpty())
        assertFalse(fixture.provider.autoInitState)
    }

    @Test
    fun decliningConsentInvalidatesPossibleLegacyTokenWithoutGeneratingOne() = runBlocking {
        val fixture = Fixture()

        fixture.coordinator.declineConsent()

        assertEquals(0, fixture.provider.getTokenCalls)
        assertEquals(1, fixture.provider.deleteCalls)
        assertTrue(fixture.backend.operations.isEmpty())
        assertFalse(fixture.store.load().consentGranted)
        assertFalse(fixture.provider.autoInitState)
    }

    @Test
    fun decliningAfterRegistrationRevokesAndInvalidatesTheToken() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.grantConsentAndActivate()

        fixture.coordinator.declineConsent()

        assertEquals(
            "deactivate:synthetic-fcm-token-0001",
            fixture.backend.operations.last()
        )
        assertEquals(1, fixture.provider.deleteCalls)
        assertFalse(fixture.store.load().consentGranted)
        assertTrue(fixture.store.load().registeredToken.isBlank())
    }

    @Test
    fun consentRegistersOnceAndRepeatedSyncIsIdempotent() = runBlocking {
        val fixture = Fixture()

        assertTrue(fixture.coordinator.grantConsentAndActivate() is ApiResult.Success)
        assertTrue(fixture.coordinator.synchronizeCurrentToken() is ApiResult.Success)

        assertEquals(
            listOf("register:synthetic-fcm-token-0001:previous="),
            fixture.backend.operations
        )
        assertTrue(fixture.provider.autoInitState)
        assertTrue(fixture.coordinator.canReceiveNotifications())
    }

    @Test
    fun emptyFirebaseTokenFailsWithoutCallingTheBackend() = runBlocking {
        val fixture = Fixture()
        fixture.provider.token = ""

        val result = fixture.coordinator.grantConsentAndActivate()

        assertTrue(result is ApiResult.Failure)
        assertTrue(fixture.backend.operations.isEmpty())
        assertTrue(fixture.coordinator.hasGrantedConsentForCurrentAccount())
    }

    @Test
    fun failedRegistrationCanRecoverOnTheNextBoundedSync() = runBlocking {
        val fixture = Fixture()
        fixture.backend.registerResult = ApiResult.Failure(
            message = "synthetic permanent failure",
            statusCode = 400,
            code = "synthetic_permanent"
        )
        assertTrue(fixture.coordinator.grantConsentAndActivate() is ApiResult.Failure)
        fixture.backend.registerResult = ApiResult.Success(Unit)

        val recovered = fixture.coordinator.synchronizeCurrentToken()

        assertTrue(recovered is ApiResult.Success)
        assertTrue(fixture.coordinator.canReceiveNotifications())
        assertEquals(2, fixture.backend.operations.count { it.startsWith("register:") })
    }

    @Test
    fun tokenRotationDeactivatesOldTokenBeforeRegisteringNewOne() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.grantConsentAndActivate()
        fixture.provider.token = "synthetic-fcm-token-0002"

        val result = fixture.coordinator.onNewToken(fixture.provider.token)

        assertTrue(result is ApiResult.Success)
        assertEquals(
            listOf(
                "register:synthetic-fcm-token-0001:previous=",
                "register:synthetic-fcm-token-0002:previous=synthetic-fcm-token-0001"
            ),
            fixture.backend.operations
        )
    }

    @Test
    fun accountSwitchDeactivatesAndForgetsPreviousAssociation() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.grantConsentAndActivate()

        fixture.coordinator.prepareForAccountChange(syntheticJwt("owner-b"))

        assertEquals(
            "deactivate:synthetic-fcm-token-0001",
            fixture.backend.operations.last()
        )
        assertEquals(FcmRegistrationState(), fixture.store.load())
        assertFalse(fixture.provider.autoInitState)
        assertEquals(1, fixture.provider.deleteCalls)
    }

    @Test
    fun accountSwitchWithoutPreviousSessionInvalidatesResidualLocalToken() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.grantConsentAndActivate()
        fixture.authToken = ""
        fixture.backend.operations.clear()

        fixture.coordinator.prepareForAccountChange(syntheticJwt("owner-b"))

        assertTrue(fixture.backend.operations.isEmpty())
        assertEquals(FcmRegistrationState(), fixture.store.load())
        assertFalse(fixture.provider.autoInitState)
        assertEquals(1, fixture.provider.deleteCalls)
    }

    @Test
    fun logoutIsLocallySafeEvenWhenBackendDeactivationFails() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.grantConsentAndActivate()
        fixture.backend.deactivateResult = ApiResult.Failure(
            message = "synthetic failure",
            statusCode = 503,
            code = "synthetic_transient"
        )

        fixture.coordinator.deactivateForLogout()

        assertEquals(FcmRegistrationState(), fixture.store.load())
        assertFalse(fixture.provider.autoInitState)
        assertEquals(1, fixture.provider.deleteCalls)
        assertEquals(3, fixture.backend.operations.count { it.startsWith("deactivate:") })
    }

    @Test
    fun failedRemoteAndLocalCleanupBlocksASecondAccount() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.grantConsentAndActivate()
        fixture.backend.deactivateResult = ApiResult.Failure(
            message = "synthetic failure",
            statusCode = 503,
            code = "synthetic_transient"
        )
        fixture.provider.deleteFails = true

        fixture.coordinator.deactivateForLogout()
        fixture.authToken = ""
        fixture.coordinator.prepareForAccountChange(syntheticJwt("owner-b"))
        fixture.authToken = syntheticJwt("owner-b")
        val result = fixture.coordinator.grantConsentAndActivate()

        assertTrue(result is ApiResult.Failure)
        assertEquals(
            "fcm_previous_account_cleanup_required",
            (result as ApiResult.Failure).code
        )
        assertFalse(fixture.store.load().consentGranted)
        assertEquals(1, fixture.backend.operations.count { it.startsWith("register:") })
    }

    @Test
    fun ownerIdentityUsesTheProductionWhatsappClaim() {
        val fromSub = ownerHash(syntheticJwt("owner-a"))
        val fromWhatsapp = ownerHash(syntheticWhatsappJwt("OWNER-A"))

        assertTrue(fromSub.isNotBlank())
        assertEquals(fromSub, fromWhatsapp)
    }

    private class Fixture {
        var authToken = syntheticJwt("owner-a")
        val backend = RecordingBackend()
        val store = MemoryStore()
        val provider = FakeTokenProvider()
        val coordinator = FcmRegistrationCoordinator(
            backend = backend,
            store = store,
            tokenProvider = provider,
            authTokenProvider = { authToken },
            retryPolicy = FcmRetryPolicy(sleeper = {})
        )
    }

    private class RecordingBackend : FcmDeviceBackend {
        val operations = mutableListOf<String>()
        var registerResult: ApiResult<Unit> = ApiResult.Success(Unit)
        var deactivateResult: ApiResult<Unit> = ApiResult.Success(Unit)

        override suspend fun register(
            authToken: String,
            fcmToken: String,
            previousToken: String
        ): ApiResult<Unit> {
            operations += "register:$fcmToken:previous=$previousToken"
            return registerResult
        }

        override suspend fun deactivate(
            authToken: String,
            fcmToken: String
        ): ApiResult<Unit> {
            operations += "deactivate:$fcmToken"
            return deactivateResult
        }
    }

    private class MemoryStore : FcmRegistrationStateStore {
        private var state = FcmRegistrationState()
        override fun load(): FcmRegistrationState = state
        override fun save(state: FcmRegistrationState) {
            this.state = state
        }
        override fun clear() {
            state = FcmRegistrationState()
        }
    }

    private class FakeTokenProvider : FcmTokenProvider {
        var token = "synthetic-fcm-token-0001"
        var autoInitState = false
        var getTokenCalls = 0
        var deleteCalls = 0
        var deleteFails = false

        override fun setAutoInitEnabled(enabled: Boolean) {
            autoInitState = enabled
        }

        override suspend fun getToken(): String {
            getTokenCalls += 1
            return token
        }

        override suspend fun deleteToken() {
            deleteCalls += 1
            if (deleteFails) error("synthetic delete failure")
        }
    }
}

private fun syntheticJwt(owner: String): String {
    val encoder = Base64.getUrlEncoder().withoutPadding()
    val header = encoder.encodeToString("{}".toByteArray(StandardCharsets.UTF_8))
    val payload = encoder.encodeToString(
        """{"sub":"$owner"}""".toByteArray(StandardCharsets.UTF_8)
    )
    return "$header.$payload.synthetic-signature"
}

private fun syntheticWhatsappJwt(owner: String): String {
    val encoder = Base64.getUrlEncoder().withoutPadding()
    val header = encoder.encodeToString("{}".toByteArray(StandardCharsets.UTF_8))
    val payload = encoder.encodeToString(
        """{"whatsapp":"$owner"}""".toByteArray(StandardCharsets.UTF_8)
    )
    return "$header.$payload.synthetic-signature"
}
