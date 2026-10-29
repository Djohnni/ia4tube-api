package br.com.ia4tube.app.navigation

import android.app.Application
import android.content.pm.PackageManager
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavDestination
import androidx.navigation.NavGraph
import androidx.navigation.NavGraphNavigator
import androidx.navigation.NavHostController
import androidx.navigation.NavOptions
import androidx.navigation.NavArgument
import androidx.navigation.NavType
import androidx.navigation.Navigator
import br.com.ia4tube.app.feature.orders.OrderListFilter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
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

/** Real navigation entries, lifecycle and stores; only destination rendering is synthetic. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
@OptIn(ExperimentalCoroutinesApi::class)
class PlannedArtsNavigationTest {
    private val dispatcher = StandardTestDispatcher()
    private val harnesses = mutableListOf<NavigationHarness>()

    @Before fun setUp() {
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

    @Test fun twoQueuedHomeTapsOpenOnlyOneGalleryAndOneBackReturnsHome() = runTest(dispatcher) {
        val controller = harness().controller
        val home = controller.currentBackStackEntry!!
        assertTrue(controller.openPlannedArts(home, authenticated = true) { fail("Authenticated shortcut must not request login") })
        val gallery = controller.currentBackStackEntry!!
        assertFalse(controller.openPlannedArts(home, authenticated = true) { fail("A queued tap must be ignored") })
        assertSame(gallery, controller.currentBackStackEntry)
        assertEquals(1, controller.currentBackStack.value.count { it.destination.route == Routes.PlannedArts })
        assertTrue(controller.leavePlannedArts(gallery))
        assertSame(home, controller.currentBackStackEntry)
    }

    @Test fun visitorShortcutRequestsLoginWithoutOpeningGalleryAndCanContinueAfterAuthentication() = runTest(dispatcher) {
        val controller = harness().controller
        val home = controller.currentBackStackEntry!!
        var loginRequests = 0
        assertFalse(controller.openPlannedArts(home, authenticated = false) { loginRequests++ })
        assertEquals(1, loginRequests)
        assertSame(home, controller.currentBackStackEntry)
        assertTrue(controller.currentBackStack.value.none { it.destination.route == Routes.PlannedArts })
        assertTrue(controller.openPlannedArts(home, authenticated = true) { loginRequests++ })
        assertEquals(1, loginRequests)
        assertEquals(Routes.PlannedArts, controller.currentDestination?.route)
    }

    @Test fun staleHomeOrWrongOriginCannotOpenGalleryOrRequestLogin() = runTest(dispatcher) {
        val controller = harness().controller
        val oldHome = controller.currentBackStackEntry!!
        controller.navigate(Routes.Instagram)
        val instagram = controller.currentBackStackEntry!!
        assertFalse(controller.openPlannedArts(oldHome, authenticated = false) { fail("Stale tap must not request login") })
        assertFalse(controller.openPlannedArts(instagram, authenticated = true) { fail("Wrong route must be ignored") })
        assertSame(instagram, controller.currentBackStackEntry)
        controller.navigate(Routes.Home)
        val newHome = controller.currentBackStackEntry!!
        assertNotSame(oldHome, newHome)
        assertFalse(controller.openPlannedArts(oldHome, authenticated = true) { fail("Old Home must not open a route") })
        assertSame(newHome, controller.currentBackStackEntry)
        assertTrue(controller.currentBackStack.value.none { it.destination.route == Routes.PlannedArts })
    }

    @Test fun leavingPlannedArtsReturnsToTheSameHomeEntryAndStore() = runTest(dispatcher) {
        val controller = harness().controller
        val home = controller.currentBackStackEntry!!
        val homeStore = home.viewModelStore
        val before = controller.currentBackStack.value.toList()
        controller.navigate(Routes.PlannedArts)
        val gallery = controller.currentBackStackEntry!!

        assertEquals(Routes.PlannedArts, gallery.destination.route)
        assertTrue(controller.leavePlannedArts(gallery))

        assertSame(home, controller.currentBackStackEntry)
        assertSame(homeStore, controller.currentBackStackEntry!!.viewModelStore)
        assertEquals(before, controller.currentBackStack.value)
        assertEquals(Lifecycle.State.RESUMED, home.lifecycle.currentState)
        assertEquals(Lifecycle.State.DESTROYED, gallery.lifecycle.currentState)
    }

    @Test fun repeatedBackCannotPopHome() = runTest(dispatcher) {
        val controller = harness().controller
        val home = controller.currentBackStackEntry!!
        controller.navigate(Routes.PlannedArts)
        val gallery = controller.currentBackStackEntry!!
        assertTrue(controller.leavePlannedArts(gallery))
        val before = controller.currentBackStack.value.toList()

        assertFalse(controller.leavePlannedArts(gallery))
        assertFalse(controller.leavePlannedArts(gallery))
        assertFalse(controller.leavePlannedArts(home))

        assertSame(home, controller.currentBackStackEntry)
        assertEquals(before, controller.currentBackStack.value)
        assertEquals(Lifecycle.State.RESUMED, home.lifecycle.currentState)
    }

    @Test fun oldBackCallbackCannotCloseANewPlannedArtsEntry() = runTest(dispatcher) {
        val controller = harness().controller
        val home = controller.currentBackStackEntry!!
        controller.navigate(Routes.PlannedArts)
        val oldGallery = controller.currentBackStackEntry!!
        assertTrue(controller.leavePlannedArts(oldGallery))
        controller.navigate(Routes.PlannedArts)
        val newGallery = controller.currentBackStackEntry!!
        val before = controller.currentBackStack.value.toList()
        assertNotSame(oldGallery, newGallery)

        assertFalse(controller.leavePlannedArts(oldGallery))

        assertSame(newGallery, controller.currentBackStackEntry)
        assertEquals(before, controller.currentBackStack.value)
        assertEquals(Lifecycle.State.RESUMED, newGallery.lifecycle.currentState)
        assertTrue(controller.leavePlannedArts(newGallery))
        assertSame(home, controller.currentBackStackEntry)
    }

    @Test fun staleOrWrongRouteCallbacksPreserveInstagramAndMonthlyPlanning() = runTest(dispatcher) {
        listOf(Routes.Instagram, Routes.MonthlyPlanning).forEach { route ->
            val controller = harness().controller
            val home = controller.currentBackStackEntry!!
            controller.navigate(Routes.PlannedArts)
            val oldGallery = controller.currentBackStackEntry!!
            assertTrue(controller.leavePlannedArts(oldGallery))
            controller.navigate(route)
            val destination = controller.currentBackStackEntry!!
            val before = controller.currentBackStack.value.toList()

            assertFalse(controller.leavePlannedArts(oldGallery))
            assertFalse(controller.leavePlannedArts(destination))

            assertEquals(route, controller.currentDestination?.route)
            assertSame(destination, controller.currentBackStackEntry)
            assertEquals(before, controller.currentBackStack.value)
            assertEquals(Lifecycle.State.RESUMED, destination.lifecycle.currentState)
            assertTrue(controller.popBackStack())
            assertSame(home, controller.currentBackStackEntry)
        }
    }

    @Test fun coveredPlannedArtsEntryCannotPopAnotherDestination() = runTest(dispatcher) {
        listOf(Routes.Instagram, Routes.MonthlyPlanning).forEach { route ->
            val controller = harness().controller
            val home = controller.currentBackStackEntry!!
            controller.navigate(Routes.PlannedArts)
            val gallery = controller.currentBackStackEntry!!
            controller.navigate(route)
            val destination = controller.currentBackStackEntry!!
            val before = controller.currentBackStack.value.toList()

            assertFalse(controller.leavePlannedArts(gallery))

            assertSame(destination, controller.currentBackStackEntry)
            assertEquals(before, controller.currentBackStack.value)
            assertTrue(controller.popBackStack())
            assertSame(gallery, controller.currentBackStackEntry)
            assertTrue(controller.leavePlannedArts(gallery))
            assertSame(home, controller.currentBackStackEntry)
        }
    }

    @Test fun historyFromOrdersIgnoresQueuedTapAndReturnsToSameOrderFilterAndStore() = runTest(dispatcher) {
        val controller = harness().controller
        controller.navigate(Routes.orders(OrderListFilter.Ready))
        val orders = controller.currentBackStackEntry!!
        val store = orders.viewModelStore
        val filter = orders.arguments?.getString("filter")
        assertTrue(controller.openArtHistory(orders, authenticated = true) { fail("Owner is logged in") })
        val history = controller.currentBackStackEntry!!
        assertEquals(Routes.ArtHistory, history.destination.route)
        assertFalse(controller.openArtHistory(orders, authenticated = true) { fail("Queued tap") })
        assertEquals(1, controller.currentBackStack.value.count { it.destination.route == Routes.ArtHistory })
        assertTrue(controller.leaveArtHistory(history))
        assertSame(orders, controller.currentBackStackEntry)
        assertSame(store, controller.currentBackStackEntry!!.viewModelStore)
        assertEquals(filter, controller.currentBackStackEntry!!.arguments?.getString("filter"))
        assertFalse(controller.leaveArtHistory(history))
        assertSame(orders, controller.currentBackStackEntry)
    }

    @Test fun historyRequiresLoginAndResumesOverOrdersAfterAuthentication() = runTest(dispatcher) {
        val controller = harness().controller
        controller.navigate(Routes.orders())
        val oldOrders = controller.currentBackStackEntry!!
        var requests = 0
        assertFalse(controller.openArtHistory(oldOrders, authenticated = false) {
            requests++
            controller.navigate(Routes.Home)
        })
        assertEquals(1, requests)
        assertTrue(controller.currentBackStack.value.none { it.destination.route == Routes.ArtHistory })
        val beforeLogin = controller.currentBackStackEntry!!
        assertFalse(controller.openArtHistoryAfterAuth(authenticated = false))
        assertSame(beforeLogin, controller.currentBackStackEntry)
        assertTrue(controller.openArtHistoryAfterAuth(authenticated = true))
        val history = controller.currentBackStackEntry!!
        assertEquals(Routes.ArtHistory, history.destination.route)
        assertTrue(controller.leaveArtHistory(history))
        assertEquals(Routes.Orders, controller.currentDestination?.route)
    }

    @Test fun staleOrdersAndWrongOriginCannotOpenHistoryOrRequestLogin() = runTest(dispatcher) {
        val controller = harness().controller
        val home = controller.currentBackStackEntry!!
        assertFalse(controller.openArtHistory(home, authenticated = false) { fail("Wrong origin") })
        controller.navigate(Routes.orders())
        val orders = controller.currentBackStackEntry!!
        controller.navigate(Routes.Instagram)
        val instagram = controller.currentBackStackEntry!!
        assertFalse(controller.openArtHistory(orders, authenticated = false) { fail("Covered Orders") })
        assertFalse(controller.openArtHistory(instagram, authenticated = true) { fail("Wrong origin") })
        assertSame(instagram, controller.currentBackStackEntry)
    }

    @Test fun staleHistoryBackCannotCloseAnotherRouteOrANewHistoryEntry() = runTest(dispatcher) {
        val controller = harness().controller
        controller.navigate(Routes.orders())
        val orders = controller.currentBackStackEntry!!
        assertTrue(controller.openArtHistory(orders, authenticated = true) {})
        val old = controller.currentBackStackEntry!!
        controller.navigate(Routes.Instagram)
        val instagram = controller.currentBackStackEntry!!
        assertFalse(controller.leaveArtHistory(old))
        assertFalse(controller.leaveArtHistory(instagram))
        assertSame(instagram, controller.currentBackStackEntry)
        assertTrue(controller.popBackStack())
        assertTrue(controller.leaveArtHistory(old))
        assertTrue(controller.openArtHistory(orders, authenticated = true) {})
        val current = controller.currentBackStackEntry!!
        assertFalse(controller.leaveArtHistory(old))
        assertSame(current, controller.currentBackStackEntry)
        assertTrue(controller.leaveArtHistory(current))
        assertSame(orders, controller.currentBackStackEntry)
    }

    private fun harness() = NavigationHarness().also { harnesses.add(it) }

    @Navigator.Name("planned_arts_test")
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
                route = "planned_arts_test_root"
                listOf(Routes.Home, Routes.PlannedArts, Routes.ArtHistory, Routes.Orders,
                    Routes.Instagram, Routes.MonthlyPlanning).forEach { path ->
                    addDestination(leaf.createDestination().apply {
                        route = path
                        if (path == Routes.Orders) addArgument("filter", NavArgument.Builder()
                            .setType(NavType.StringType).setDefaultValue(OrderListFilter.All.routeValue).build())
                    })
                }
                setStartDestination(Routes.Home)
            }
            lifecycleOwner.registry.currentState = Lifecycle.State.RESUMED
        }

        fun close() {
            lifecycleOwner.registry.currentState = Lifecycle.State.DESTROYED
            rootStore.clear()
        }
    }
}
