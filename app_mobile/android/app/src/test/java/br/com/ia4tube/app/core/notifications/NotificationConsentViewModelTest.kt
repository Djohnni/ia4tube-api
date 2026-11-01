package br.com.ia4tube.app.core.notifications

import androidx.lifecycle.ViewModelStore
import br.com.ia4tube.app.data.api.FcmDeviceBackend
import br.com.ia4tube.app.data.models.ApiResult
import java.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Real coordinator with in-memory state, suspended Firebase/backend fakes, and no Android/HTTP calls. */
@OptIn(ExperimentalCoroutinesApi::class)
class NotificationConsentViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val models = ViewModelStore()
    private var modelCount = 0
    private fun jwt(owner: String) = "synthetic." + Base64.getUrlEncoder().withoutPadding()
        .encodeToString(("{\"sub\":\"" + owner + "\"}").toByteArray()) + ".signature"
    private val tokenA = jwt("notification-owner-a")
    private val tokenB = jwt("notification-owner-b")
    @Before fun before() { Dispatchers.setMain(dispatcher) }
    @After fun after() { models.clear(); dispatcher.scheduler.runCurrent(); Dispatchers.resetMain() }

    private class MemoryStore : FcmRegistrationStateStore {
        var value = FcmRegistrationState()
        override fun load() = value
        override fun save(state: FcmRegistrationState) { value = state }
        override fun clear() { value = FcmRegistrationState() }
    }
    private class FirebaseFake : FcmTokenProvider {
        var autoInit = false; var getCalls = 0; var deleteCalls = 0
        var nextToken = "synthetic-fcm-token"
        var getGate: CompletableDeferred<String>? = null
        var deleteGate: CompletableDeferred<Unit>? = null
        override fun setAutoInitEnabled(enabled: Boolean) { autoInit = enabled }
        override suspend fun getToken(): String { getCalls++; return getGate?.await() ?: nextToken }
        override suspend fun deleteToken() { deleteCalls++; deleteGate?.await() }
    }
    private class BackendFake : FcmDeviceBackend {
        var registerCalls = 0; var deactivateCalls = 0
        var result: ApiResult<Unit> = ApiResult.Success(Unit)
        var gate: CompletableDeferred<ApiResult<Unit>>? = null
        override suspend fun register(authToken: String, fcmToken: String, previousToken: String): ApiResult<Unit> {
            registerCalls++; return gate?.await() ?: result
        }
        override suspend fun deactivate(authToken: String, fcmToken: String): ApiResult<Unit> {
            deactivateCalls++; return ApiResult.Success(Unit)
        }
    }
    private inner class Fixture {
        var token = tokenA
        val store = MemoryStore(); val firebase = FirebaseFake(); val backend = BackendFake()
        val mutex = Mutex()
        var activations = 0; var declines = 0
        val coordinator = FcmRegistrationCoordinator(backend, store, firebase, { token }, FcmRetryPolicy(sleeper = {}))
        fun model(): NotificationConsentViewModel = NotificationConsentViewModel(
            currentToken = { token },
            hasConsentDecision = coordinator::hasConsentDecisionForCurrentAccount,
            activate = { expected ->
                activations++
                withExpectedFcmSession(expected, { token }, mutex,
                    stale = { ApiResult.Failure("synthetic-stale") }) { coordinator.grantConsentAndActivate() }
            },
            decline = { expected ->
                declines++
                withExpectedFcmSession(expected, { token }, mutex, stale = {}) { coordinator.declineConsent() }
            }, worker = dispatcher
        ).also { models.put("notification-consent-" + modelCount++, it) }
    }

    @Test fun constructionDoesNoFcmWorkAndFreshAccountPromptsAfterDecisionRead() = runTest(dispatcher) {
        val f = Fixture(); val vm = f.model()
        assertFalse(vm.state.value.showPrompt); assertEquals(0, f.firebase.getCalls)
        vm.refresh(); runCurrent()
        assertTrue(vm.state.value.showPrompt); assertEquals(0, f.firebase.getCalls)
        assertEquals(0, f.backend.registerCalls)
    }
    @Test fun dismissClosesImmediatelyWhileFreshAccountFirebaseDeletionIsSuspended() = runTest(dispatcher) {
        val f = Fixture(); f.firebase.deleteGate = CompletableDeferred()
        val vm = f.model(); vm.refresh(); runCurrent()
        vm.dismiss()
        assertFalse(vm.state.value.showPrompt)
        runCurrent(); assertEquals(1, f.firebase.deleteCalls)
        vm.refresh(); runCurrent(); assertFalse(vm.state.value.showPrompt)
        f.firebase.deleteGate!!.complete(Unit); runCurrent()
        assertFalse(vm.state.value.showPrompt); assertEquals(0, f.firebase.getCalls)
        assertFalse(f.store.value.consentGranted)
        assertTrue(f.coordinator.hasConsentDecisionForCurrentAccount())
    }
    @Test fun androidDenialKeepsPromptClosedAndDoesNotGenerateOrRegisterAToken() = runTest(dispatcher) {
        val f = Fixture(); f.firebase.deleteGate = CompletableDeferred()
        val vm = f.model(); vm.refresh(); runCurrent()
        val request = requireNotNull(vm.enable(true))
        assertFalse(vm.state.value.showPrompt); assertEquals(0, f.activations)
        vm.permissionResult(request.encode(), false)
        assertFalse(vm.state.value.showPrompt)
        runCurrent(); assertEquals(1, f.declines); assertEquals(1, f.firebase.deleteCalls)
        assertEquals(0, f.firebase.getCalls); assertEquals(0, f.backend.registerCalls)
        f.firebase.deleteGate!!.complete(Unit); runCurrent(); assertFalse(vm.state.value.showPrompt)
    }
    @Test fun allowClosesBeforeSystemPermissionAndBeforeFirebaseAndBackendFinish() = runTest(dispatcher) {
        val f = Fixture(); f.firebase.getGate = CompletableDeferred(); f.backend.gate = CompletableDeferred()
        val vm = f.model(); vm.refresh(); runCurrent()
        val request = requireNotNull(vm.enable(true))
        assertFalse(vm.state.value.showPrompt); runCurrent()
        assertEquals(0, f.firebase.getCalls); assertEquals(0, f.activations)
        vm.permissionResult(request.encode(), true); runCurrent()
        assertEquals(1, f.firebase.getCalls); assertFalse(vm.state.value.showPrompt)
        f.firebase.getGate!!.complete("synthetic-fcm-token"); runCurrent()
        assertEquals(1, f.backend.registerCalls); assertFalse(vm.state.value.showPrompt)
        f.backend.gate!!.complete(ApiResult.Success(Unit)); runCurrent()
        assertTrue(f.coordinator.canReceiveNotifications()); assertFalse(vm.state.value.showPrompt)
    }
    @Test fun alreadyGrantedPermissionNeedsNoLauncherAndDuplicateClicksDoNotQueueOperations() = runTest(dispatcher) {
        val f = Fixture(); f.firebase.getGate = CompletableDeferred()
        val vm = f.model(); vm.refresh(); runCurrent()
        assertNull(vm.enable(false)); assertFalse(vm.state.value.showPrompt)
        assertNull(vm.enable(false)); vm.dismiss(); runCurrent()
        assertEquals(1, f.activations); assertEquals(0, f.declines)
        f.firebase.getGate!!.complete("synthetic-fcm-token"); runCurrent()
        assertEquals(1, f.backend.registerCalls)
    }
    @Test fun activationFailureIsOnlyANonModalMessageAndNeverReopensThePrompt() = runTest(dispatcher) {
        val f = Fixture(); f.backend.result = ApiResult.Failure("synthetic-private-body", 400)
        val vm = f.model(); vm.refresh(); runCurrent(); vm.enable(false); runCurrent()
        assertFalse(vm.state.value.showPrompt); assertNotNull(vm.state.value.message)
        assertFalse(vm.state.value.message!!.contains("synthetic-private-body"))
        vm.refresh(); runCurrent(); assertFalse(vm.state.value.showPrompt)
        assertEquals(1, f.activations)
    }
    @Test fun unavailableFirebaseTokenAlsoKeepsThePromptClosed() = runTest(dispatcher) {
        val f = Fixture(); f.firebase.nextToken = ""
        val vm = f.model(); vm.refresh(); runCurrent(); vm.enable(false); runCurrent()
        assertNotNull(vm.state.value.message); assertFalse(vm.state.value.showPrompt)
        assertEquals(0, f.backend.registerCalls)
        vm.refresh(); runCurrent(); assertFalse(vm.state.value.showPrompt)
    }
    @Test fun rotationReusesTheOriginalRequestWithoutLaunchingOrActivatingTwice() = runTest(dispatcher) {
        val f = Fixture(); val vm = f.model(); vm.refresh(); runCurrent()
        val request = requireNotNull(vm.enable(true)); val saved = request.encode()
        vm.refresh(saved); runCurrent()
        assertNull(vm.enable(true)); assertEquals(0, f.activations)
        vm.permissionResult(saved, true); vm.permissionResult(saved, true); runCurrent()
        assertEquals(1, f.activations); assertEquals(1, f.backend.registerCalls)
    }
    @Test fun recreatedUiCanRestoreOnlyTheHashedPendingDescriptorBeforeDelivery() = runTest(dispatcher) {
        val f = Fixture(); val old = f.model(); old.refresh(); runCurrent()
        val saved = requireNotNull(old.enable(true)).encode()
        assertFalse(saved.contains(f.token)); assertFalse(saved.contains("synthetic-fcm"))
        assertEquals(4, saved.split('|').size)
        val restored = f.model(); restored.refresh(saved); runCurrent()
        assertFalse(restored.state.value.showPrompt); assertNull(restored.enable(true))
        restored.permissionResult(saved, true); runCurrent()
        assertEquals(1, f.activations)
    }
    @Test fun callbackForAccountAInAccountBDoesNotGrantOrDeclineBAndBMayChooseLater() = runTest(dispatcher) {
        val f = Fixture(); val vm = f.model(); vm.refresh(); runCurrent()
        val saved = requireNotNull(vm.enable(true)).encode()
        f.token = tokenB; vm.refresh(saved); runCurrent()
        assertFalse(vm.state.value.showPrompt)
        assertNull(vm.enable(true)) // One Android launcher is outstanding globally.
        vm.permissionResult(saved, true); runCurrent()
        assertEquals(0, f.activations); assertEquals(0, f.declines); assertEquals(0, f.firebase.getCalls)
        assertEquals(ownerHash(tokenB), vm.state.value.ownerKey); assertTrue(vm.state.value.showPrompt)
        vm.enable(false); runCurrent(); assertEquals(1, f.activations)
    }
    @Test fun returningAToBAgainAStillRejectsTheOldPermissionDecision() = runTest(dispatcher) {
        val f = Fixture(); val vm = f.model(); vm.refresh(); runCurrent()
        val saved = requireNotNull(vm.enable(true)).encode()
        f.token = tokenB; vm.refresh(saved); runCurrent()
        f.token = tokenA; vm.refresh(saved); runCurrent()
        vm.permissionResult(saved, true); runCurrent()
        assertEquals(0, f.activations); assertEquals(0, f.declines); assertTrue(vm.state.value.showPrompt)
    }
    @Test fun lateFailureForADoesNotShowAnErrorOrHideTheNewAccountBPrompt() = runTest(dispatcher) {
        val f = Fixture(); f.backend.gate = CompletableDeferred()
        val vm = f.model(); vm.refresh(); runCurrent(); vm.enable(false); runCurrent()
        f.token = tokenB; vm.refresh(); runCurrent()
        assertTrue(vm.state.value.showPrompt)
        f.backend.gate!!.complete(ApiResult.Failure("synthetic-failure", 400)); runCurrent()
        assertEquals(ownerHash(tokenB), vm.state.value.ownerKey)
        assertTrue(vm.state.value.showPrompt); assertNull(vm.state.value.message)
    }
    @Test fun persistedDeclineNeverRestoresTheOldModalVisibility() = runTest(dispatcher) {
        val f = Fixture(); f.store.value = FcmRegistrationState(decisionOwnerHash = ownerHash(tokenA), consentGranted = false)
        val vm = f.model()
        assertFalse(vm.state.value.showPrompt)
        vm.refresh(); runCurrent(); assertFalse(vm.state.value.showPrompt)
        assertEquals(0, f.activations); assertEquals(0, f.declines)
    }
    @Test fun pendingDecisionReadCannotReopenAfterTheUserHasChosen() = runTest(dispatcher) {
        val f = Fixture(); f.firebase.deleteGate = CompletableDeferred()
        val vm = f.model(); vm.refresh(); runCurrent()
        vm.refresh(); vm.dismiss(); runCurrent()
        assertFalse(vm.state.value.showPrompt)
        f.firebase.deleteGate!!.complete(Unit); runCurrent()
    }
    @Test fun launcherFailureIsNonModalAndNeverStartsFcm() = runTest(dispatcher) {
        val f = Fixture(); val vm = f.model(); vm.refresh(); runCurrent()
        val request = requireNotNull(vm.enable(true)); vm.permissionLaunchFailed(request)
        assertFalse(vm.state.value.showPrompt); assertNotNull(vm.state.value.message)
        vm.refresh(); runCurrent(); assertFalse(vm.state.value.showPrompt)
        assertEquals(0, f.activations); assertEquals(0, f.declines)
    }
    @Test fun wrongDecisionIdCannotConsumeTheOutstandingPermissionRequest() = runTest(dispatcher) {
        val f = Fixture(); val vm = f.model(); vm.refresh(); runCurrent()
        val request = requireNotNull(vm.enable(true))
        vm.permissionResult(request.copy(decisionId = "11111111-1111-4111-8111-111111111111").encode(), true)
        vm.permissionResult(null, true); runCurrent()
        assertEquals(0, f.activations)
        vm.permissionResult(request.encode(), true); runCurrent(); assertEquals(1, f.activations)
    }
    @Test fun aWellFormedButUnrequestedResultAloneCannotActivateFcm() = runTest(dispatcher) {
        val f = Fixture(); val vm = f.model(); vm.refresh(); runCurrent()
        val unrequested = NotificationPermissionRequest(ownerHash(f.token), NotificationConsentViewModel.sessionKey(f.token),
            "11111111-1111-4111-8111-111111111111")
        vm.permissionResult(unrequested.encode(), true); runCurrent()
        assertEquals(0, f.activations); assertEquals(0, f.declines)
    }
    @Test fun loggedOutAccountAndMalformedSavedDescriptorsDoNotPromptOrActivate() = runTest(dispatcher) {
        val f = Fixture(); f.token = ""; val vm = f.model()
        vm.refresh("not-a-request"); vm.permissionResult("not-a-request", true); runCurrent()
        assertFalse(vm.state.value.showPrompt); assertEquals(0, f.activations)
        assertNull(NotificationPermissionRequest.decode("1|owner|token|not-a-uuid"))
        assertNull(NotificationPermissionRequest.decode(tokenA))
    }
}
