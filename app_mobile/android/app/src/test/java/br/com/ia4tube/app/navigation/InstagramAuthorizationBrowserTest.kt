package br.com.ia4tube.app.navigation

import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import br.com.ia4tube.app.feature.instagram.InstagramPoliciesTest
import br.com.ia4tube.app.feature.instagram.instagramAuthorizationBrowserIntent
import br.com.ia4tube.app.feature.instagram.instagramAuthorizationBrowsers
import br.com.ia4tube.app.feature.instagram.openInstagramAuthorizationBrowser
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

/** Synthetic package discovery and captured intents only: no browser, OAuth, HTTP or device. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28],
    shadows = [InstagramAuthorizationBrowserTest.BrowserPackageManagerShadow::class])
@LooperMode(LooperMode.Mode.PAUSED)
class InstagramAuthorizationBrowserTest {
    private val pm: PackageManager get() = RuntimeEnvironment.getApplication().packageManager
    private val fixture get() = BrowserPackageManagerShadow.fixture

    @Before fun isolatedPackageManager() {
        BrowserPackageManagerShadow.fixture = PackageFixture()
        assertNull(javaClass.classLoader!!.getResource("com/android/tools/test_config.properties"))
        val application = RuntimeEnvironment.getApplication()
        assertEquals(Application::class.java, application.javaClass)
        assertEquals("org.robolectric.default", application.packageName)
        assertTrue(pm.getPackageInfo(application.packageName, PackageManager.GET_PROVIDERS)
            .providers.isNullOrEmpty())
    }

    @Test fun appBrowserCandidatesExcludeNativeInstagramEvenWhenItOwnsInstagramLinks() {
        browser(CHROME, "Chrome")
        fixture.nativeInstagram = resolved(INSTAGRAM, "Instagram")
        fixture.webDefault = fixture.nativeInstagram
        val result = instagramAuthorizationBrowsers(pm)
        assertEquals(listOf(CHROME), result.choices.map { it.packageName })
        assertEquals(CHROME, result.preferred?.packageName)
        assertTrue(fixture.queries.none { it.first.dataString?.contains("instagram.com") == true })
    }

    @Test fun eligibleHttpsDefaultWinsOverBrowserCategoryDefault() {
        browser(CHROME, "Chrome")
        browser(FIREFOX, "Firefox")
        fixture.webDefault = resolved(FIREFOX)
        fixture.browserDefault = resolved(CHROME)
        assertEquals(FIREFOX, instagramAuthorizationBrowsers(pm).preferred?.packageName)
    }

    @Test fun categoryDefaultIsUsedWhenWebDefaultIsResolverNotBrowser() {
        browser(CHROME, "Chrome")
        browser(FIREFOX, "Firefox")
        fixture.webDefault = resolved("android", "Resolver")
        fixture.browserDefault = resolved(FIREFOX)
        assertEquals(FIREFOX, instagramAuthorizationBrowsers(pm).preferred?.packageName)
    }

    @Test fun singleBrowserIsPreferredWithoutAnyDefault() {
        browser(CHROME, "Chrome")
        assertEquals(CHROME, instagramAuthorizationBrowsers(pm).preferred?.packageName)
    }

    @Test fun severalBrowsersWithoutDefaultsNeverChooseOneArbitrarily() {
        browser(CHROME, "Chrome")
        browser(FIREFOX, "Firefox")
        val result = instagramAuthorizationBrowsers(pm)
        assertEquals(2, result.choices.size)
        assertNull(result.preferred)
    }

    @Test fun severalBrowsersWithResolversRequireAnExplicitChoiceAndAreSortedDeduplicated() {
        browser(FIREFOX, "Firefox")
        browser(CHROME, "Chrome")
        fixture.candidates += resolved(CHROME, "Chrome")
        fixture.webDefault = resolved("android", "Resolver")
        fixture.browserDefault = resolved("android", "Chooser")
        val result = instagramAuthorizationBrowsers(pm)
        assertEquals(listOf(CHROME, FIREFOX), result.choices.map { it.packageName })
        assertNull(result.preferred)
    }

    @Test fun noBrowserDoesNotPromoteNativeInstagramOrResolver() {
        fixture.nativeInstagram = resolved(INSTAGRAM, "Instagram")
        fixture.webDefault = fixture.nativeInstagram
        fixture.browserDefault = resolved("android", "Resolver")
        val result = instagramAuthorizationBrowsers(pm)
        assertTrue(result.choices.isEmpty())
        assertNull(result.preferred)
    }

    @Test fun blankBrowserLabelFallsBackToThePackageName() {
        browser(CHROME, "   ")
        assertEquals(CHROME, instagramAuthorizationBrowsers(pm).choices.single().label)
    }

    @Test fun malformedDisabledUnexportedOrApplicationDisabledCandidatesAreRejected() {
        browser(CHROME, "Chrome")
        fixture.candidates += ResolveInfo()
        fixture.candidates += resolved("")
        fixture.candidates += resolved("test.disabled").apply { activityInfo.enabled = false }
        fixture.candidates += resolved("test.private").apply { activityInfo.exported = false }
        fixture.candidates += resolved("test.app.disabled").apply { activityInfo.applicationInfo.enabled = false }
        fixture.candidates += resolved("test.no.application").apply { activityInfo.applicationInfo = null }
        // HTTPS responses deliberately exist: discovery itself must reject these candidates.
        fixture.candidates.mapNotNull { it.activityInfo?.packageName }.forEach {
            fixture.httpsHandlers.putIfAbsent(it, listOf(resolved(it)))
        }
        assertEquals(listOf(CHROME), instagramAuthorizationBrowsers(pm).choices.map { it.packageName })
    }

    @Test fun browserCandidateMustAlsoHaveAnEnabledExportedHttpsHandlerInItsOwnPackage() {
        fixture.candidates += resolved(CHROME)
        fixture.candidates += resolved(FIREFOX)
        fixture.candidates += resolved("test.disabled.https")
        fixture.candidates += resolved("test.private.https")
        fixture.httpsHandlers[CHROME] = emptyList()
        fixture.httpsHandlers[FIREFOX] = listOf(resolved(INSTAGRAM))
        fixture.httpsHandlers["test.disabled.https"] = listOf(resolved("test.disabled.https")
            .apply { activityInfo.enabled = false })
        fixture.httpsHandlers["test.private.https"] = listOf(resolved("test.private.https")
            .apply { activityInfo.exported = false })
        assertTrue(instagramAuthorizationBrowsers(pm).choices.isEmpty())
        assertTrue(fixture.queries.filter { it.first.dataString == PROBE }
            .all { it.first.`package` != null && it.second == PackageManager.MATCH_DEFAULT_ONLY })
    }

    @Test fun packageDisappearingAfterSelectionIsRecheckedBeforeUrlDispatch() {
        browser(CHROME, "Chrome")
        assertEquals(CHROME, instagramAuthorizationBrowsers(pm).preferred?.packageName)
        fixture.candidates.clear()
        fixture.httpsHandlers.clear()
        var consumed = 0
        var unavailable = 0
        openInstagramAuthorizationBrowser(pm, CHROME, { consumed++; officialUrl() },
            { fail("A vanished package must not launch") }, { unavailable++ })
        assertEquals(1, consumed)
        assertEquals(1, unavailable)
    }

    @Test fun dispatchIntentKeepsOriginalUrlWithViewBrowsableAndExplicitPackageOnly() {
        browser(CHROME, "Chrome")
        val url = officialUrl().replace("scope=instagram_business_basic,", "scope=instagram_business_basic%2C")
        val intent = instagramAuthorizationBrowserIntent(pm, url, CHROME)
        assertNotNull(intent)
        assertEquals(url, intent!!.dataString)
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals(setOf(Intent.CATEGORY_BROWSABLE), intent.categories)
        assertEquals(CHROME, intent.`package`)
        assertNull(intent.selector)
        assertNull(intent.component)
        assertNull(intent.extras)
        assertEquals(0, intent.flags)
    }

    @Test fun invalidAuthorizationUrlsNeverReachPackageDiscoveryOrDispatch() {
        browser(CHROME, "Chrome")
        for (url in listOf("", "http://www.instagram.com/oauth/authorize", "https://example.com/",
            officialUrl() + "&extra=1", officialUrl() + "#fragment", officialUrl().replace("www.instagram.com", "instagram.com"))) {
            assertNull(instagramAuthorizationBrowserIntent(pm, url, CHROME))
        }
        assertTrue(fixture.queries.isEmpty())
        assertTrue(fixture.resolutions.isEmpty())
    }

    @Test fun selectedNativeOrUnknownPackageNeverGetsAnUnqualifiedFallback() {
        browser(CHROME, "Chrome")
        for (packageName in listOf(INSTAGRAM, "test.missing", "")) {
            var unavailable = 0
            openInstagramAuthorizationBrowser(pm, packageName, { officialUrl() },
                { fail("Unknown package must not fall back to an implicit intent") }, { unavailable++ })
            assertEquals(1, unavailable)
        }
    }

    @Test fun launchExceptionConsumesOnceAndDoesNotRetryOrFallback() {
        browser(CHROME, "Chrome")
        var pending: String? = officialUrl()
        var consumes = 0
        var launches = 0
        var unavailable = 0
        val takeUrl = { consumes++; pending.also { pending = null } }
        val launch: (Intent) -> Unit = { intent ->
            launches++
            assertEquals(CHROME, intent.`package`)
            throw ActivityNotFoundException("Synthetic launcher failure")
        }
        openInstagramAuthorizationBrowser(pm, CHROME, takeUrl, launch, { unavailable++ })
        assertEquals(1, consumes)
        assertEquals(1, launches)
        assertEquals(1, unavailable)
        openInstagramAuthorizationBrowser(pm, CHROME, takeUrl, launch, { unavailable++ })
        assertEquals(2, consumes)
        assertEquals(1, launches)
        assertEquals(1, unavailable)
    }

    @Test fun discoveryExceptionIsUnavailableAndNeverLaunchesOrRetakesUrl() {
        fixture.throwOnQuery = true
        var consumes = 0
        var unavailable = 0
        openInstagramAuthorizationBrowser(pm, CHROME, { consumes++; officialUrl() },
            { fail("Discovery failure must not launch") }, { unavailable++ })
        assertEquals(1, consumes)
        assertEquals(1, unavailable)
    }

    @Test fun nullTakenUrlDoesNothingAndDoesNotShowAnError() {
        fixture.throwOnQuery = true
        var consumes = 0
        openInstagramAuthorizationBrowser(pm, CHROME, { consumes++; null },
            { fail("No pending URL") }, { fail("Absence of a pending event is not an error") })
        assertEquals(1, consumes)
        assertTrue(fixture.queries.isEmpty())
        assertTrue(fixture.resolutions.isEmpty())
    }

    @Test fun successfulLaunchDispatchesTheOneConsumedUrlOnce() {
        browser(CHROME, "Chrome")
        var consumes = 0
        val launched = mutableListOf<Intent>()
        openInstagramAuthorizationBrowser(pm, CHROME, { consumes++; officialUrl() },
            { launched += it }, { fail("Available browser should launch") })
        assertEquals(1, consumes)
        assertEquals(1, launched.size)
        assertEquals(officialUrl(), launched.single().dataString)
        assertEquals(CHROME, launched.single().`package`)
    }

    private fun browser(packageName: String, label: String) {
        fixture.candidates += resolved(packageName, label)
        fixture.httpsHandlers[packageName] = listOf(resolved(packageName, label))
    }

    class PackageFixture {
        val candidates = mutableListOf<ResolveInfo>()
        val httpsHandlers = mutableMapOf<String, List<ResolveInfo>>()
        var webDefault: ResolveInfo? = null
        var browserDefault: ResolveInfo? = null
        var nativeInstagram: ResolveInfo? = null
        var throwOnQuery = false
        val queries = mutableListOf<Pair<Intent, Int>>()
        val resolutions = mutableListOf<Pair<Intent, Int>>()
    }

    /** Replace only PackageManager's query/resolve answers; framework Intent behavior stays real. */
    @Implements(className = "android.app.ApplicationPackageManager", isInAndroidSdk = false)
    class BrowserPackageManagerShadow : ShadowApplicationPackageManager() {
        @Implementation public override fun queryIntentActivities(intent: Intent, flags: Int): List<ResolveInfo> {
            fixture.queries += Intent(intent) to flags
            if (fixture.throwOnQuery) throw IllegalStateException("Synthetic package discovery failure")
            return when {
                isBrowserSelector(intent) -> fixture.candidates.toList()
                intent.action == Intent.ACTION_VIEW && intent.dataString == PROBE ->
                    fixture.httpsHandlers[intent.`package`].orEmpty()
                intent.data?.host == "www.instagram.com" -> listOfNotNull(fixture.nativeInstagram)
                else -> emptyList()
            }
        }

        @Implementation public override fun resolveActivity(intent: Intent, flags: Int): ResolveInfo? {
            fixture.resolutions += Intent(intent) to flags
            return when {
                isBrowserSelector(intent) -> fixture.browserDefault
                intent.action == Intent.ACTION_VIEW && intent.dataString == PROBE -> fixture.webDefault
                intent.data?.host == "www.instagram.com" -> fixture.nativeInstagram
                else -> null
            }
        }

        companion object {
            var fixture = PackageFixture()
            private fun isBrowserSelector(intent: Intent): Boolean =
                intent.selector?.let { it.action == Intent.ACTION_MAIN && it.hasCategory(Intent.CATEGORY_APP_BROWSER) } == true
        }
    }

    private companion object {
        const val CHROME = "test.browser.chrome"
        const val FIREFOX = "test.browser.firefox"
        const val INSTAGRAM = "com.instagram.android"
        const val PROBE = "https://example.com/"
        fun officialUrl(): String = InstagramPoliciesTest.authorizationUrl()
        fun resolved(packageName: String, label: String = packageName): ResolveInfo = ResolveInfo().apply {
            nonLocalizedLabel = label
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
