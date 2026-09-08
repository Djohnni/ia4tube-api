package br.com.ia4tube.app.navigation

import android.app.Application
import android.content.pm.PackageManager
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavDestination
import androidx.navigation.NavGraph
import androidx.navigation.NavGraphNavigator
import androidx.navigation.NavHostController
import androidx.navigation.NavOptions
import androidx.navigation.Navigator
import br.com.ia4tube.app.feature.instagram.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

/**
 * Real NavController/back-stack entries, lifecycle and ViewModelStore ownership. Only the
 * visual destination Navigator and gateways are synthetic: no Compose rendering, product
 * Application, Firebase, HTTP, device or persistence of JPEG/caption participates in this test.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
@OptIn(ExperimentalCoroutinesApi::class)
class InstagramNavigationRetentionTest {
    private val dispatcher = StandardTestDispatcher()
    private val harnesses = mutableListOf<NavigationHarness>()

    @Before fun setUp() {
        // Fail if a build setting silently reintroduces the real app manifest/providers.
        assertNull(javaClass.classLoader!!.getResource("com/android/tools/test_config.properties"))
        val application = RuntimeEnvironment.getApplication()
        assertEquals(Application::class.java, application.javaClass)
        assertEquals("org.robolectric.default", application.packageName)
        assertTrue(application.packageManager.getPackageInfo(application.packageName,
            PackageManager.GET_PROVIDERS).providers.isNullOrEmpty())
        Dispatchers.setMain(dispatcher)
    }

    @After fun tearDown() {
        harnesses.forEach { it.close() }
        Dispatchers.resetMain()
    }

    @Test fun actualPopToHomeAndReentryRetainTheSameOwnerModelAndLocalDraftWithClosedGates() = runTest(dispatcher) {
        val navigation = harness()
        val model = navigation.enterInstagram()
        val jpeg = prepareDraft(model)
        val homeEntry = navigation.controller.getBackStackEntry(Routes.Home)
        val instagramEntry = navigation.controller.currentBackStackEntry!!

        navigation.exitInstagram(model)
        assertSame(homeEntry, navigation.controller.currentBackStackEntry)
        assertEquals(Lifecycle.State.DESTROYED, instagramEntry.lifecycle.currentState)

        val returned = navigation.enterInstagram()
        assertNotSame(instagramEntry, navigation.controller.currentBackStackEntry)
        assertSame("Popping a route must not destroy its authenticated Home-owned draft", model, returned)
        assertSame(homeEntry, navigation.controller.instagramViewModelOwner())
        assertSame(jpeg, returned.uiState.value.draftJpeg)
        assertEquals(CAPTION, returned.uiState.value.draftCaption)
        assertTrue(jpeg.contentEquals(InstagramPoliciesTest.jpegEnvelope()))
        assertBlocked(returned)

        returned.onResume(); returned.awaitIdle()
        assertEquals(2, navigation.gateway.snapshotCalls)
        assertSame(jpeg, returned.uiState.value.draftJpeg)
        assertEquals(CAPTION, returned.uiState.value.draftCaption)
        assertEquals(InstagramOperationalAvailability(false, false), returned.uiState.value.operationalAvailability)
        assertBlocked(returned)
        assertEquals(1, navigation.modelsCreated)
        navigation.assertNoMutations()
    }

    @Test fun reentryCannotReuseEarlierOpenGatesWhileTheNewSnapshotIsPendingOrAfterItClosesThem() = runTest(dispatcher) {
        val navigation = harness().apply {
            gateway.operational = InstagramOperationalAvailability(true, true)
        }
        val model = navigation.enterInstagram()
        val jpeg = prepareDraft(model)
        assertTrue(model.uiState.value.canUpload)
        navigation.exitInstagram(model)
        assertNull(model.uiState.value.operationalAvailability)
        assertBlocked(model)

        val snapshotStarted = CompletableDeferred<Unit>()
        val snapshotFinish = CompletableDeferred<Unit>()
        navigation.gateway.operational = InstagramOperationalAvailability(false, false)
        navigation.gateway.beforeSnapshot = { snapshotStarted.complete(Unit); snapshotFinish.await() }
        val returned = navigation.enterInstagram()
        assertSame(model, returned)
        returned.onResume()
        snapshotStarted.await()
        assertTrue(returned.uiState.value.busy)
        assertNull(returned.uiState.value.operationalAvailability)
        assertSame(jpeg, returned.uiState.value.draftJpeg)
        assertBlocked(returned)
        returned.upload(); returned.connect(); returned.requestPublicationConfirmation(); returned.confirmPublish()
        navigation.assertNoMutations()

        snapshotFinish.complete(Unit); returned.awaitIdle()
        assertSame(jpeg, returned.uiState.value.draftJpeg)
        assertFalse(returned.uiState.value.operationalAvailability!!.publicationAllowed)
        assertBlocked(returned)
        navigation.assertNoMutations()
    }

    @Test fun logoutPopsTheActualHomeOwnerAndZerosItsDraftBeforeAnotherLoginCreatesANewModel() = runTest(dispatcher) {
        val navigation = harness()
        val model = navigation.enterInstagram()
        val jpeg = prepareDraft(model)
        val homeEntry = navigation.controller.getBackStackEntry(Routes.Home)
        navigation.exitInstagram(model)
        assertTrue("An ordinary return to Home must keep draft bytes until logout", jpeg.any { it != 0.toByte() })

        navigation.session = ""
        navigation.controller.navigate(Routes.Login) {
            popUpTo(Routes.Home) { inclusive = true }
        }
        assertEquals(Routes.Login, navigation.controller.currentDestination?.route)
        assertEquals(Lifecycle.State.DESTROYED, homeEntry.lifecycle.currentState)
        assertTrue("Destroying Home must run the real ViewModel.onCleared byte wipe", jpeg.all { it == 0.toByte() })
        assertTrue(navigation.controller.currentBackStack.value.none { it.destination.route == Routes.Home })

        navigation.session = "synthetic-session-after-login"
        navigation.controller.navigate(Routes.Home) { popUpTo(Routes.Login) { inclusive = true } }
        val fresh = navigation.enterInstagram()
        assertNotSame(model, fresh)
        assertNull(fresh.uiState.value.draftJpeg)
        assertEquals("", fresh.uiState.value.draftCaption)
        assertBlocked(fresh)
        fresh.onResume(); fresh.awaitIdle()
        assertNull(fresh.uiState.value.draftJpeg)
        assertEquals("", fresh.uiState.value.draftCaption)
        navigation.assertNoMutations()
    }

    @Test fun changingSessionWhileAtHomeRetainsOwnerButWipesDraftOnAuthoritativeReentry() = runTest(dispatcher) {
        val navigation = harness()
        val model = navigation.enterInstagram()
        val jpeg = prepareDraft(model)
        navigation.exitInstagram(model)
        navigation.session = "synthetic-different-session"

        val returned = navigation.enterInstagram()
        assertSame(model, returned)
        assertBlocked(returned)
        returned.onResume(); returned.awaitIdle()
        assertTrue(jpeg.all { it == 0.toByte() })
        assertNull(returned.uiState.value.draftJpeg)
        assertEquals("", returned.uiState.value.draftCaption)
        assertBlocked(returned)
        assertEquals(2, navigation.gatewayFactories)
        navigation.assertNoMutations()
    }

    @Test fun changedBindingRevisionOnReturnClearsTheOldDraftWithoutCreatingAnotherOwnerOrSending() = runTest(dispatcher) {
        val navigation = harness()
        val model = navigation.enterInstagram()
        val jpeg = prepareDraft(model)
        navigation.exitInstagram(model)
        navigation.gateway.connection = CONNECTION.copy(connectionRevision = 5L)

        val returned = navigation.enterInstagram()
        assertSame(model, returned)
        assertBlocked(returned)
        returned.onResume(); returned.awaitIdle()
        assertEquals(5L, returned.uiState.value.connection?.connectionRevision)
        assertTrue(jpeg.all { it == 0.toByte() })
        assertNull(returned.uiState.value.draftJpeg)
        assertEquals("", returned.uiState.value.draftCaption)
        assertBlocked(returned)
        assertEquals(1, navigation.modelsCreated)
        navigation.assertNoMutations()
    }

    private fun harness() = NavigationHarness().also { harnesses.add(it) }

    @Test fun repeatedBackCallbacksDoNotPopHomeOrClearTheDraft() = runTest(dispatcher) {
        val navigation = harness()
        val model = navigation.enterInstagram()
        val jpeg = prepareDraft(model)
        val entry = navigation.controller.currentBackStackEntry!!
        assertTrue(navigation.controller.leaveInstagram(entry, model))
        assertFalse(navigation.controller.leaveInstagram(entry, model))
        assertEquals(Routes.Home, navigation.controller.currentDestination?.route)
        assertTrue(jpeg.any { it != 0.toByte() })
        assertSame(model, navigation.enterInstagram())
        assertSame(jpeg, model.uiState.value.draftJpeg)
        navigation.assertNoMutations()
    }

    @Test fun aBackCallbackFromAnOldEntryCannotCloseOrPauseTheReturnedEntry() = runTest(dispatcher) {
        val navigation = harness()
        val model = navigation.enterInstagram()
        val jpeg = prepareDraft(model)
        val oldEntry = navigation.controller.currentBackStackEntry!!
        assertTrue(navigation.controller.leaveInstagram(oldEntry, model))
        val returned = navigation.enterInstagram()
        returned.onResume(); returned.awaitIdle()
        val newEntry = navigation.controller.currentBackStackEntry!!
        val before = returned.uiState.value
        assertFalse(navigation.controller.leaveInstagram(oldEntry, model))
        assertSame(newEntry, navigation.controller.currentBackStackEntry)
        assertSame(before, returned.uiState.value)
        assertSame(jpeg, returned.uiState.value.draftJpeg)
        navigation.assertNoMutations()
    }

    private suspend fun prepareDraft(model: InstagramViewModel): ByteArray {
        model.onResume(); model.awaitIdle()
        val jpeg = InstagramPoliciesTest.jpegEnvelope()
        model.acceptJpeg(jpeg, model.pickerSessionKey()!!)
        model.updateCaption(CAPTION)
        assertSame(jpeg, model.uiState.value.draftJpeg)
        assertEquals(CAPTION, model.uiState.value.draftCaption)
        return jpeg
    }

    private suspend fun InstagramViewModel.awaitIdle() { uiState.first { !it.busy } }

    private fun assertBlocked(model: InstagramViewModel) {
        assertFalse(model.uiState.value.canAuthorize)
        assertFalse(model.uiState.value.canUpload)
        assertFalse(model.uiState.value.canPublish)
        assertFalse(model.uiState.value.canContinueConfirmation)
        assertFalse(model.uiState.value.confirmationOpen)
    }

    /** No fake owner/store map: push and pop use NavController's attached NavigatorState. */
    @Navigator.Name("retention_test")
    private class LeafNavigator : Navigator<NavDestination>() {
        override fun createDestination() = NavDestination(this)
        override fun navigate(entries: List<NavBackStackEntry>, navOptions: NavOptions?, navigatorExtras: Extras?) {
            entries.forEach { state.push(it) }
        }
        override fun popBackStack(popUpTo: NavBackStackEntry, savedState: Boolean) {
            state.pop(popUpTo, savedState)
        }
    }

    private class NavigationHarness {
        var session = "synthetic-session-original"
        val gateway = SyntheticGateway()
        var modelsCreated = 0
        var gatewayFactories = 0
        private var storeMutations = 0
        private val rootStore = ViewModelStore()
        private val lifecycleOwner = object : LifecycleOwner {
            val registry = LifecycleRegistry(this)
            override val lifecycle: Lifecycle get() = registry
        }
        val controller = NavHostController(RuntimeEnvironment.getApplication()).apply {
            setLifecycleOwner(lifecycleOwner)
            setViewModelStore(rootStore)
            val leaf = LeafNavigator()
            navigatorProvider.addNavigator(leaf)
            graph = NavGraph(navigatorProvider.getNavigator<NavGraphNavigator>("navigation")).apply {
                route = "retention_test_root"
                addDestination(leaf.createDestination().apply { route = Routes.Home })
                addDestination(leaf.createDestination().apply { route = Routes.Instagram })
                addDestination(leaf.createDestination().apply { route = Routes.Login })
                setStartDestination(Routes.Home)
            }
            lifecycleOwner.registry.currentState = Lifecycle.State.RESUMED
        }
        private val factory = object : ViewModelProvider.Factory {
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                require(modelClass == InstagramViewModel::class.java)
                modelsCreated += 1
                @Suppress("UNCHECKED_CAST")
                return InstagramViewModel(
                    tokenProvider = { session },
                    intentStore = object : InstagramPublicationIntentStore {
                        override fun read(contextKey: String): InstagramPublicationIntent? = null
                        override fun create(contextKey: String, intent: InstagramPublicationIntent): Boolean = mutationRefused()
                        override fun update(contextKey: String, intent: InstagramPublicationIntent): Boolean = mutationRefused()
                        override fun removeConfirmed(contextKey: String, clientRequestId: String): Boolean = mutationRefused()
                    },
                    apiOrigin = "https://ia4tube-api.onrender.com",
                    gatewayFactory = { gatewayFactories += 1; gateway },
                    authorizationStore = object : InstagramAuthorizationWitnessStore {
                        override fun read(contextKey: String): InstagramAuthorizationWitness? = null
                        override fun create(contextKey: String, witness: InstagramAuthorizationWitness): Boolean = mutationRefused()
                        override fun update(contextKey: String, witness: InstagramAuthorizationWitness): Boolean = mutationRefused()
                        override fun clear(contextKey: String, id: String): Boolean = mutationRefused()
                    },
                    uploadStore = inMemoryUploadWitnessStore()
                ) as T
            }
        }

        private fun mutationRefused(): Boolean { storeMutations += 1; return false }

        fun enterInstagram(): InstagramViewModel {
            check(controller.currentDestination?.route == Routes.Home)
            controller.navigate(Routes.Instagram)
            // This exact production function is also consumed by IA4TubeNavHost.
            return ViewModelProvider(controller.instagramViewModelOwner(), factory)[InstagramViewModel::class.java]
        }

        fun exitInstagram(model: InstagramViewModel) {
            check(controller.currentDestination?.route == Routes.Instagram)
            check(controller.leaveInstagram(controller.currentBackStackEntry!!, model))
            check(controller.currentDestination?.route == Routes.Home)
        }

        fun assertNoMutations() {
            assertEquals(0, gateway.mutationCalls)
            assertEquals(0, storeMutations)
        }

        fun close() {
            lifecycleOwner.registry.currentState = Lifecycle.State.DESTROYED
            rootStore.clear()
        }
    }

    private class SyntheticGateway : InstagramGateway {
        var connection = CONNECTION
        var operational = InstagramOperationalAvailability(false, false)
        var beforeSnapshot: suspend () -> Unit = {}
        var snapshotCalls = 0
        var mutationCalls = 0
        override suspend fun currentConnection(): InstagramResult<InstagramConnection?> = InstagramResult.Success(connection)
        override suspend fun currentSnapshot(): InstagramResult<InstagramConnectionSnapshot> {
            snapshotCalls += 1
            beforeSnapshot()
            return InstagramResult.Success(InstagramConnectionSnapshot(connection, operational))
        }
        override suspend fun authorizationStatus(connectionId: String): InstagramResult<InstagramAuthorizationStatus> =
            InstagramResult.Success(InstagramAuthorizationStatus(connectionId, "connect", "authorization_completed", null))
        override suspend fun media(): InstagramResult<List<InstagramMedia>> = InstagramResult.Success(emptyList())
        override suspend fun publications(): InstagramResult<InstagramHistory> =
            InstagramResult.Success(InstagramHistory(emptyList(), true, true))
        override suspend fun publication(publicationId: String): InstagramResult<InstagramPublication> =
            InstagramResult.Failure(InstagramError.REJECTED)
        override suspend fun publicationIntent(clientRequestId: String): InstagramResult<InstagramPublication?> =
            InstagramResult.Success(null)
        override suspend fun authorize(purpose: String): InstagramResult<InstagramAuthorization> = mutationRefused()
        override suspend fun uploadMedia(jpeg: ByteArray, caption: String): InstagramResult<InstagramMedia> = mutationRefused()
        override suspend fun publish(mediaId: String, clientRequestId: String, binding: InstagramConnectionBinding): InstagramResult<InstagramPublication> = mutationRefused()
        override suspend fun reconcile(publicationId: String, binding: InstagramConnectionBinding): InstagramResult<InstagramPublication> = mutationRefused()
        private fun mutationRefused(): InstagramResult.Failure {
            mutationCalls += 1
            return InstagramResult.Failure(InstagramError.REJECTED)
        }
    }

    private companion object {
        const val CAPTION = "Legenda sintética mantida apenas na memória"
        val CONNECTION = InstagramConnection("11111111-1111-4111-8111-111111111111", "connected", "healthy",
            "@synthetic", "business", "123456789012345", 4L)
    }
}
