package br.com.ia4tube.app.navigation

import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import br.com.ia4tube.app.feature.instagram.InstagramPoliciesTest
import br.com.ia4tube.app.feature.instagram.instagramAuthorizationAppAvailable
import br.com.ia4tube.app.feature.instagram.instagramAuthorizationAppDomainVerified
import br.com.ia4tube.app.feature.instagram.instagramAuthorizationAppIntent
import br.com.ia4tube.app.feature.instagram.openInstagramAuthorizationApp
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowApplicationPackageManager

/** Synthetic package/domain answers and captured Intents only: no product providers or OAuth. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28],
    shadows = [InstagramAuthorizationAppTest.AppPackageManagerShadow::class])
@LooperMode(LooperMode.Mode.PAUSED)
class InstagramAuthorizationAppTest {
    private val pm: PackageManager get() = RuntimeEnvironment.getApplication().packageManager
    private val fixture get() = AppPackageManagerShadow.fixture

    @Before fun isolatedPackageManager() {
        AppPackageManagerShadow.fixture = PackageFixture()
        assertNull(javaClass.classLoader!!.getResource("com/android/tools/test_config.properties"))
        val application = RuntimeEnvironment.getApplication()
        assertEquals(Application::class.java, application.javaClass)
        assertEquals("org.robolectric.default", application.packageName)
        assertTrue(pm.getPackageInfo(application.packageName, PackageManager.GET_PROVIDERS)
            .providers.isNullOrEmpty())
    }

    @Test fun olderAndroidDoesNotLoadDomainVerificationApiOrDiscoverTheApp() {
        fixture.handlers += resolved()
        assertFalse(instagramAuthorizationAppAvailable(RuntimeEnvironment.getApplication()))
        assertTrue(fixture.queries.isEmpty())
    }

    @Test fun onlyVerifiedOfficialDomainAndEnabledInstagramHandlerPassPreflight() {
        fixture.handlers += resolved()
        var verificationCalls = 0
        assertTrue(instagramAuthorizationAppAvailable(pm) { verificationCalls++; true })
        assertEquals(1, verificationCalls)
        val query = fixture.queries.single()
        assertEquals(Intent.ACTION_VIEW, query.first.action)
        assertEquals(PUBLIC_PROBE, query.first.dataString)
        assertEquals(setOf(Intent.CATEGORY_BROWSABLE), query.first.categories)
        assertEquals(INSTAGRAM, query.first.`package`)
        assertEquals(PackageManager.MATCH_DEFAULT_ONLY, query.second)
        assertNull(query.first.selector)
        assertNull(query.first.component)
        assertNull(query.first.extras)
    }

    @Test fun packageNameAloneIsInsufficientWithoutDomainVerification() {
        fixture.handlers += resolved()
        assertFalse(instagramAuthorizationAppAvailable(pm) { false })
        assertNull(instagramAuthorizationAppIntent(pm, officialUrl()) { false })
    }

    @Test fun userSelectedUnverifiedOrDifferentDomainCannotEstablishOfficialAppIdentity() {
        // Android DomainVerificationUserState constants: NONE=0, SELECTED=1, VERIFIED=2.
        assertTrue(instagramAuthorizationAppDomainVerified(INSTAGRAM, mapOf("www.instagram.com" to 2)))
        for (state in listOf(0, 1, -1, 99)) {
            assertFalse(instagramAuthorizationAppDomainVerified(INSTAGRAM, mapOf("www.instagram.com" to state)))
        }
        assertFalse(instagramAuthorizationAppDomainVerified(INSTAGRAM, emptyMap()))
        assertFalse(instagramAuthorizationAppDomainVerified(INSTAGRAM, mapOf("instagram.com" to 2)))
        assertFalse(instagramAuthorizationAppDomainVerified(INSTAGRAM, mapOf("*.instagram.com" to 2)))
        assertFalse(instagramAuthorizationAppDomainVerified(INSTAGRAM, mapOf("www.instagram.com.example.com" to 2)))
        assertFalse(instagramAuthorizationAppDomainVerified("test.imposter", mapOf("www.instagram.com" to 2)))
    }

    @Test fun missingAppDoesNotRequestDomainProofOrPromoteAnotherHandler() {
        fixture.handlers += resolved("test.browser.chrome")
        fixture.handlers += resolved("android")
        var verificationCalls = 0
        assertFalse(instagramAuthorizationAppAvailable(pm) { verificationCalls++; true })
        assertEquals(0, verificationCalls)
    }

    @Test fun malformedDisabledUnexportedAndMismatchedApplicationHandlersAreRejected() {
        fixture.handlers += ResolveInfo()
        fixture.handlers += resolved().apply { activityInfo.name = "" }
        fixture.handlers += resolved().apply { activityInfo.enabled = false }
        fixture.handlers += resolved().apply { activityInfo.exported = false }
        fixture.handlers += resolved().apply { activityInfo.applicationInfo.enabled = false }
        fixture.handlers += resolved().apply { activityInfo.applicationInfo.packageName = "test.imposter" }
        fixture.handlers += resolved().apply { activityInfo.applicationInfo = null }
        assertFalse(instagramAuthorizationAppAvailable(pm) { fail("No eligible handler"); true })
    }

    @Test fun packageDiscoveryFailureIsUnavailableWithoutDomainProof() {
        fixture.throwOnQuery = true
        assertFalse(instagramAuthorizationAppAvailable(pm) { fail("Query failed"); true })
    }

    @Test fun domainVerificationFailureIsUnavailable() {
        fixture.handlers += resolved()
        assertFalse(instagramAuthorizationAppAvailable(pm) { throw IllegalStateException("Synthetic verifier failure") })
    }

    @Test fun dispatchPreservesOriginalAuthorizationUrlAndOnlySetsExplicitPackage() {
        fixture.handlers += resolved()
        val url = officialUrl().replace("scope=instagram_business_basic,", "scope=instagram_business_basic%2C")
        val intent = instagramAuthorizationAppIntent(pm, url) { true }
        assertNotNull(intent)
        assertEquals(url, intent!!.dataString)
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals(setOf(Intent.CATEGORY_BROWSABLE), intent.categories)
        assertEquals(INSTAGRAM, intent.`package`)
        assertNull(intent.component)
        assertNull(intent.selector)
        assertNull(intent.extras)
        assertEquals(0, intent.flags)
        assertTrue(fixture.queries.all { it.first.dataString == PUBLIC_PROBE })
    }

    @Test fun invalidUrlsNeverReachPackageOrDomainDiscovery() {
        fixture.handlers += resolved()
        for (url in listOf("", "instagram://oauth/authorize", "http://www.instagram.com/oauth/authorize",
            "https://example.com/", officialUrl() + "&extra=1", officialUrl() + "#fragment",
            officialUrl().replace("www.instagram.com", "instagram.com"))) {
            assertNull(instagramAuthorizationAppIntent(pm, url) { fail("Invalid URL"); true })
        }
        assertTrue(fixture.queries.isEmpty())
    }

    @Test fun removedPackageIsRecheckedAndConsumesOnePendingEventWithoutFallback() {
        fixture.handlers += resolved()
        assertTrue(instagramAuthorizationAppAvailable(pm) { true })
        fixture.handlers.clear()
        var consumed = 0
        var unavailable = 0
        openInstagramAuthorizationApp(pm, { true }, { consumed++; officialUrl() },
            { fail("A removed package must not launch") }, { unavailable++ })
        assertEquals(1, consumed)
        assertEquals(1, unavailable)
    }

    @Test fun lostDomainVerificationIsRecheckedBeforeDispatch() {
        fixture.handlers += resolved()
        var verified = true
        assertTrue(instagramAuthorizationAppAvailable(pm) { verified })
        verified = false
        var unavailable = 0
        openInstagramAuthorizationApp(pm, { verified }, { officialUrl() },
            { fail("A package without current proof must not launch") }, { unavailable++ })
        assertEquals(1, unavailable)
    }

    @Test fun nullPendingUrlDoesNotDiscoverOrDispatchAnything() {
        fixture.throwOnQuery = true
        var consumed = 0
        openInstagramAuthorizationApp(pm, { fail("No pending event"); true }, { consumed++; null },
            { fail("No pending event") }, { fail("Absence is not a launch failure") })
        assertEquals(1, consumed)
        assertTrue(fixture.queries.isEmpty())
    }

    @Test fun successfulLaunchConsumesAndDispatchesExactlyOneEvent() {
        fixture.handlers += resolved()
        var pending: String? = officialUrl()
        var consumed = 0
        val launched = mutableListOf<Intent>()
        val takeUrl = { consumed++; pending.also { pending = null } }
        repeat(2) {
            openInstagramAuthorizationApp(pm, { true }, takeUrl,
                { launched += it }, { fail("Available Instagram package") })
        }
        assertEquals(2, consumed)
        assertEquals(1, launched.size)
        assertEquals(officialUrl(), launched.single().dataString)
        assertEquals(INSTAGRAM, launched.single().`package`)
    }

    @Test fun launchExceptionDoesNotRetryCreateAnotherIntentOrFallBackToBrowser() {
        fixture.handlers += resolved()
        var pending: String? = officialUrl()
        var launches = 0
        var unavailable = 0
        val takeUrl = { pending.also { pending = null } }
        val launch: (Intent) -> Unit = {
            launches++
            assertEquals(INSTAGRAM, it.`package`)
            throw ActivityNotFoundException("Synthetic native launch failure")
        }
        repeat(2) { openInstagramAuthorizationApp(pm, { true }, takeUrl, launch, { unavailable++ }) }
        assertEquals(1, launches)
        assertEquals(1, unavailable)
        assertEquals(1, fixture.queries.size)
    }

    @Test fun domainProofExceptionConsumesWithoutDispatchOrSecondRead() {
        fixture.handlers += resolved()
        var consumed = 0
        var unavailable = 0
        openInstagramAuthorizationApp(pm, { throw SecurityException("Synthetic verifier failure") },
            { consumed++; officialUrl() }, { fail("Failed identity proof must not launch") }, { unavailable++ })
        assertEquals(1, consumed)
        assertEquals(1, unavailable)
    }

    @Test fun reportingAnUnavailableAppDoesNotInvokeTheCallbackTwice() {
        var unavailable = 0
        try {
            openInstagramAuthorizationApp(pm, { false }, { officialUrl() }, { fail("Missing handler") }, {
                unavailable++
                throw IllegalStateException("Synthetic UI callback failure")
            })
            fail("Callback exception remains the caller's concern")
        } catch (_: IllegalStateException) {
            assertEquals(1, unavailable)
        }
    }

    class PackageFixture {
        val handlers = mutableListOf<ResolveInfo>()
        val queries = mutableListOf<Pair<Intent, Int>>()
        var throwOnQuery = false
    }

    @Implements(className = "android.app.ApplicationPackageManager", isInAndroidSdk = false)
    class AppPackageManagerShadow : ShadowApplicationPackageManager() {
        @Implementation public override fun queryIntentActivities(intent: Intent, flags: Int): List<ResolveInfo> {
            fixture.queries += Intent(intent) to flags
            if (fixture.throwOnQuery) throw IllegalStateException("Synthetic package discovery failure")
            return if (intent.action == Intent.ACTION_VIEW && intent.dataString == PUBLIC_PROBE &&
                intent.`package` == INSTAGRAM) fixture.handlers.toList() else emptyList()
        }

        companion object { var fixture = PackageFixture() }
    }

    private companion object {
        const val INSTAGRAM = "com.instagram.android"
        const val PUBLIC_PROBE = "https://www.instagram.com/oauth/authorize"
        fun officialUrl(): String = InstagramPoliciesTest.authorizationUrl()
        fun resolved(packageName: String = INSTAGRAM) = ResolveInfo().apply {
            activityInfo = ActivityInfo().apply {
                this.packageName = packageName
                name = "$packageName.SyntheticActivity"
                enabled = true
                exported = true
                applicationInfo = ApplicationInfo().apply {
                    this.packageName = packageName
                    enabled = true
                }
            }
        }
    }
}
